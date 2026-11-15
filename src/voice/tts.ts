import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { decodeWav, pcmFromBuffer, pcmToBuffer, type Pcm } from './audio.ts';
import { killOnExit } from './children.ts';

const log = createLogger('tts');
const run = promisify(execFile);

export interface SynthOptions {
  /**
   * The engine really starts on this text now – later than the call when it first finishes other work
   * (a pre-warm line). Only for `⏱` measurement; engines may leave it out. Must not throw.
   */
  onStart?: () => void;
}

export interface TextToSpeech {
  synth(text: string, opts?: SynthOptions): Promise<Pcm>;
  close(): Promise<void>;
  /** Engine and voice for `⏱` lines, e.g. `piper:de_DE-thorsten-high`. */
  readonly engine?: string;
  /** Would `synth(text)` be served from a cache (no new synthesis)? For `⏱ ansage cache=ja`. */
  cached?(text: string): boolean;
  /**
   * The voice path is busy (queue, playback, recognition): background work such as pre-warming waits.
   * Synchronous, never throws; call the returned function once the work is over.
   */
  hold?(): () => void;
}

/**
 * How long one synthesis may take before it is given up: 10 s + 60 ms per character. Why: Piper
 * (thorsten-high) needs up to ~8 s for 246 characters on a 1-vCPU server (~33 ms per character); with
 * Whisper running next to it that can double. 246 characters get 24.8 s, three times the measured worst
 * case – a slow engine is never cut off, but an engine that lost an answer (hung worker, lost JSON line)
 * no longer blocks every later line: the queue moves on and the next synthesis gets a fresh engine.
 */
export function synthDeadlineMs(chars: number): number {
  return 10_000 + 60 * chars;
}

/** A synthesis ran past `synthDeadlineMs` and was given up (the warning is logged already, without the text). */
export class SynthTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthTimeout';
  }
}

export function createTts(cfg: Config['voice']): TextToSpeech {
  return new CachedTts(createEngine(cfg));
}

/** The configured engine alone, without any cache. */
export function createEngine(cfg: Config['voice']): TextToSpeech {
  return cfg.tts === 'piper' ? new PiperTts(cfg) : new SayTts(cfg.sayVoice);
}

/** What a cached sound depends on besides its text: engine, voice and speed. */
export function ttsIdentity(cfg: Config['voice']): string {
  return cfg.tts === 'piper' ? `piper|${cfg.piperVoice}|${cfg.piperLengthScale}` : `say|${cfg.sayVoice}|`;
}

/** Fixed phrases ("Buzzer frei!", "deine Antwort?") repeat all game – synthesise them once. */
export class CachedTts implements TextToSpeech {
  private cache = new Map<string, Promise<Pcm>>();
  constructor(private inner: TextToSpeech) {}
  get engine(): string | undefined {
    return this.inner.engine;
  }
  cached(text: string): boolean {
    return this.cache.has(text) || !!this.inner.cached?.(text);
  }
  hold(): () => void {
    return this.inner.hold?.() ?? (() => {});
  }
  synth(text: string, opts?: SynthOptions): Promise<Pcm> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const p = this.inner.synth(text, opts);
    p.catch(() => this.cache.delete(text));
    this.cache.set(text, p);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface DiskCacheOptions {
  /** Folder of the cache files (`.qbhost/voice/tts-cache`). */
  dir: string;
  /** Engine, voice and speed (`ttsIdentity`) – part of every key, so another voice never hits. */
  identity: string;
  /** Only these exact texts go to disk: fixed lines without game content (`FIXED_LINES`). */
  allow: (text: string) => boolean;
  now?: () => number;
}

const MAGIC = 'QBTTS1\n';

/**
 * Keeps the sound of fixed lines on disk, so they survive restarts and need no synthesis. Everything
 * else passes straight through to the engine – a sentence with game content never lands on disk (rule 5).
 * Files: `<sha256>.pcm` = magic, a JSON header line (key, rate, channels, samples) and s16le samples,
 * written to a `.part` file first and renamed. Broken or foreign files are ignored and written anew.
 */
export class DiskCachedTts implements TextToSpeech {
  /** Keys of the files on disk – read once, so `cached()` needs no file system call. */
  private index = new Set<string>();
  private holds = 0;
  /** Foreground syntheses in flight (not pre-warming). */
  private running = 0;
  private lastActive: number;
  private readonly now: () => number;
  private warming = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  /** The pre-warm synthesis in the engine right now – a real line waits for it visibly (`onStart`). */
  private warmJob: Promise<unknown> | null = null;
  private n = 0;

  constructor(
    private inner: TextToSpeech,
    private o: DiskCacheOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.lastActive = this.now();
    try {
      for (const f of readdirSync(o.dir)) {
        const key = f.slice(0, 64);
        // Only files with a sound header count as stored: a broken one is no `cache=ja` and is made anew.
        if (/^[0-9a-f]{64}\.pcm$/.test(f) && checkCacheFile(path.join(o.dir, f), key)) this.index.add(key);
      }
    } catch {
      /* no cache yet */
    }
  }

  get engine(): string | undefined {
    return this.inner.engine;
  }

  key(text: string): string {
    return createHash('sha256').update(`${this.o.identity}|${text}`).digest('hex');
  }

  /** Is this text's sound on disk? */
  stored(text: string): boolean {
    return this.o.allow(text) && this.index.has(this.key(text));
  }

  cached(text: string): boolean {
    return this.stored(text) || !!this.inner.cached?.(text);
  }

  hold(): () => void {
    this.holds++;
    this.lastActive = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.lastActive = this.now();
    };
  }

  async synth(text: string, opts?: SynthOptions): Promise<Pcm> {
    this.running++;
    this.lastActive = this.now();
    try {
      return await this.load(text, opts);
    } finally {
      this.running--;
      this.lastActive = this.now();
    }
  }

  /**
   * Pre-warms the given fixed lines that are not on disk yet, in the background: one at a time, and each
   * only after `quietMs` without any voice activity (no hold, no foreground synthesis, no other pre-warm
   * line). A sentence that comes during a pre-warm synthesis waits for at most that one (short) line.
   * Runs once; `close` stops it.
   */
  warm(texts: string[], opts: { quietMs: number }): Promise<void> {
    if (this.warming) return Promise.resolve();
    this.warming = true;
    return this.warmLoop(texts, opts.quietMs).catch((e) => log.debug(`Vorwärmen: ${(e as Error).message}`));
  }

  close(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    return this.inner.close();
  }

  private async warmLoop(texts: string[], quietMs: number): Promise<void> {
    const todo = [...new Set(texts)].filter((t) => this.o.allow(t) && !this.index.has(this.key(t)));
    let made = 0;
    for (const text of todo) {
      while (!this.stopped && !this.quiet(quietMs)) await this.pause(Math.max(50, quietMs - (this.now() - this.lastActive)));
      if (this.stopped) return;
      if (this.index.has(this.key(text))) continue; // spoken (and stored) in the meantime
      const job = this.load(text, undefined, true);
      this.warmJob = job;
      try {
        await job;
        made++;
      } catch (e) {
        log.debug(`Vorwärmen „${text.slice(0, 30)}“: ${(e as Error).message}`);
      } finally {
        this.warmJob = null;
        this.lastActive = this.now(); // the next line waits for a full quiet period again
      }
    }
    if (made) log.info(`TTS-Cache: ${made} feste Sätze vorab erzeugt`);
  }

  private quiet(quietMs: number): boolean {
    return this.holds === 0 && this.running === 0 && this.now() - this.lastActive >= quietMs;
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      t.unref?.();
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async load(text: string, opts?: SynthOptions, warm = false): Promise<Pcm> {
    const allowed = this.o.allow(text);
    const key = allowed ? this.key(text) : '';
    if (allowed && this.index.has(key)) {
      const pcm = await this.read(key);
      if (pcm) return pcm;
      this.index.delete(key); // changed or vanished since the start: no longer a hit
    }
    if (!warm && this.warmJob) {
      // The engine finishes the one pre-warm line first. Waiting here (instead of inside the engine) lets
      // `onStart` tell the real start, so the wait shows as `warte`, not as `tts`.
      await this.warmJob.catch(() => {});
      try {
        opts?.onStart?.();
      } catch {
        /* measurement only */
      }
    }
    const pcm = await this.inner.synth(text, opts);
    if (allowed) void this.write(key, pcm);
    return pcm;
  }

  private file(key: string): string {
    return path.join(this.o.dir, `${key}.pcm`);
  }

  private async read(key: string): Promise<Pcm | null> {
    try {
      return decodeCacheFile(await readFile(this.file(key)), key);
    } catch {
      return null;
    }
  }

  private async write(key: string, pcm: Pcm): Promise<void> {
    const part = path.join(this.o.dir, `${key}.${process.pid}.${++this.n}.part`);
    try {
      await mkdir(this.o.dir, { recursive: true });
      await writeFile(part, encodeCacheFile(pcm, key));
      await rename(part, this.file(key));
      this.index.add(key);
    } catch (e) {
      log.debug(`TTS-Cache schreiben: ${(e as Error).message}`);
      await rm(part, { force: true }).catch(() => {});
    }
  }
}

export function encodeCacheFile(pcm: Pcm, key: string): Buffer {
  const head = `${MAGIC}${JSON.stringify({ key, rate: pcm.rate, channels: pcm.channels, samples: pcm.samples.length })}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), pcmToBuffer(pcm)]);
}

/** Quick check of a cache file without reading its samples: header readable, key and length fit. */
function checkCacheFile(file: string, key: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(512);
    const n = readSync(fd, head, 0, head.length, 0);
    const nl = head.indexOf(10, MAGIC.length);
    if (head.toString('latin1', 0, MAGIC.length) !== MAGIC || nl < 0 || nl >= n) return false;
    const h = JSON.parse(head.toString('utf8', MAGIC.length, nl)) as { key?: unknown; samples?: unknown };
    return h.key === key && Number.isInteger(h.samples) && (h.samples as number) > 0 && fstatSync(fd).size === nl + 1 + (h.samples as number) * 2;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** The cached sound, or null for a broken, truncated or foreign file. */
export function decodeCacheFile(buf: Buffer, key: string): Pcm | null {
  if (buf.toString('latin1', 0, MAGIC.length) !== MAGIC) return null;
  const nl = buf.indexOf(10, MAGIC.length);
  if (nl < 0) return null;
  let h: { key?: unknown; rate?: unknown; channels?: unknown; samples?: unknown };
  try {
    h = JSON.parse(buf.toString('utf8', MAGIC.length, nl));
  } catch {
    return null;
  }
  const { rate, channels, samples } = h;
  if (h.key !== key || !Number.isInteger(rate) || !Number.isInteger(channels) || !Number.isInteger(samples)) return null;
  if ((rate as number) < 8000 || (rate as number) > 96000 || ![1, 2].includes(channels as number) || (samples as number) <= 0) return null;
  const body = buf.subarray(nl + 1);
  if (body.length !== (samples as number) * 2) return null;
  return pcmFromBuffer(body, rate as number, channels as number);
}

interface PiperJob {
  text: string;
  /** Answered, failed or given up – it is skipped or its late line ignored. */
  settled: boolean;
  /** Its deadline, from when the worker takes it on; cleared once it is settled. */
  timer?: ReturnType<typeof setTimeout>;
  resolve: (p: Pcm) => void;
  reject: (e: Error) => void;
}

/**
 * Piper with the voice kept loaded in a small Python worker (≈0.2–0.5 s per sentence). Piper works one
 * text at a time, so the worker gets one job at a time from our own queue: a job's deadline
 * (`synthDeadlineMs`) runs only while the worker is busy with it (including a worker start), never while
 * it waits behind a long question. Past the deadline the job is rejected and the worker – hung, or lost
 * the answer – is killed; the next job starts a fresh one. Nothing queued is lost by that.
 */
export class PiperTts implements TextToSpeech {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  /** Jobs not yet handed to the worker, in order. */
  private queue: PiperJob[] = [];
  /** The one job the worker (or its start) is busy with now; only its deadline runs. */
  private current: { id: number; job: PiperJob } | null = null;
  private nextId = 1;
  readonly engine: string;
  private readonly deadline: (chars: number) => number;

  constructor(
    private cfg: Config['voice'],
    opts: { deadlineMs?: (chars: number) => number } = {},
  ) {
    this.engine = `piper:${path.basename(cfg.piperVoice, '.onnx')}`;
    this.deadline = opts.deadlineMs ?? synthDeadlineMs;
  }

  private get python(): string {
    return path.resolve(this.cfg.dir, 'venv/bin/python');
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const model = path.resolve(this.cfg.dir, this.cfg.piperVoice);
      if (!existsSync(this.python) || !existsSync(model)) {
        return reject(new Error(`Piper fehlt (${existsSync(this.python) ? model : this.python}) – \`npx qbhost voice-setup\` ausführen`));
      }
      const worker = fileURLToPath(new URL('./piper_worker.py', import.meta.url));
      const proc = spawn(this.python, [worker, model, String(this.cfg.piperLengthScale)], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      killOnExit(proc);
      let stderr = '';
      proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      proc.stdin!.on('error', () => {}); // EPIPE after a kill: the exit handler reports it
      proc.once('error', (e) => reject(e));
      proc.once('exit', (code) => {
        const err = new Error(`Piper beendet (${code}): ${stderr.split('\n').filter((l) => !/telemetry/.test(l)).join(' ').slice(-300)}`);
        reject(err);
        if (this.proc !== proc) return; // killed on purpose (deadline, close): already handled
        this.proc = null;
        this.ready = null;
        const cur = this.current;
        this.current = null;
        cur?.job.reject(err);
        this.pump(); // the rest goes to a fresh worker
      });
      createInterface({ input: proc.stdout! }).on('line', (line) => {
        let msg: { ready?: boolean; id?: number; wav?: string; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready) {
          log.info('Piper bereit');
          return resolve();
        }
        const cur = this.current;
        if (this.proc !== proc || !cur || cur.id !== msg.id) return; // a late line of a given-up job
        this.current = null;
        if (msg.error || !msg.wav) cur.job.reject(new Error(`Piper: ${msg.error ?? 'keine Audiodaten'}`));
        else cur.job.resolve(decodeWav(Buffer.from(msg.wav, 'base64')));
        this.pump();
      });
    });
    // Only forget the start that failed – a restart may have begun a new one meanwhile.
    const ready = this.ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  synth(text: string): Promise<Pcm> {
    return new Promise<Pcm>((resolve, reject) => {
      const job: PiperJob = {
        text,
        settled: false,
        resolve: (p) => {
          if (job.settled) return;
          job.settled = true;
          clearTimeout(job.timer);
          resolve(p);
        },
        reject: (e) => {
          if (job.settled) return;
          job.settled = true;
          clearTimeout(job.timer);
          reject(e);
        },
      };
      // The deadline starts when the job reaches the worker (`pump`), see the class comment.
      this.queue.push(job);
      this.pump();
    });
  }

  /** Hands the next job to the worker if it is free; starts the worker if needed. */
  private pump(): void {
    if (this.current) return;
    let job: PiperJob | undefined;
    while ((job = this.queue.shift()) && job.settled);
    if (!job) return;
    const cur = { id: this.nextId++, job };
    this.current = cur;
    const ms = this.deadline(job.text.length);
    job.timer = setTimeout(() => {
      if (this.current !== cur) return;
      this.current = null;
      log.warn(`Sprachausgabe: Piper lieferte nach ${Math.round(ms / 1000)} s keinen Ton – Ansage übersprungen, starte Piper neu`);
      job.reject(new SynthTimeout(`Piper: keine Antwort nach ${Math.round(ms / 1000)} s`));
      this.kill();
      this.pump();
    }, ms);
    job.timer.unref?.();
    this.start().then(
      () => {
        if (this.current !== cur) return;
        this.proc?.stdin?.write(JSON.stringify({ id: cur.id, text: job.text }) + '\n');
      },
      (e) => {
        if (this.current !== cur) return;
        this.current = null;
        job.reject(e as Error);
        this.pump();
      },
    );
  }

  /** Kills the worker (also while it starts); the next job starts a new one. */
  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    proc?.kill('SIGKILL');
  }

  /** Stops the worker; every sentence not spoken yet is rejected. No Piper process is left running. */
  async close(): Promise<void> {
    const err = new Error('Piper beendet');
    const cur = this.current;
    const queued = this.queue;
    this.current = null;
    this.queue = [];
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    proc?.stdin?.end();
    proc?.kill();
    cur?.job.reject(err);
    for (const j of queued) j.reject(err);
  }
}

/** macOS `say` – no setup, noticeably more robotic. A `say` running past `synthDeadlineMs` is killed. */
export class SayTts implements TextToSpeech {
  private dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-say-'));
  private n = 0;
  readonly engine: string;
  constructor(private voice: string) {
    this.engine = `say:${voice}`;
  }
  async synth(text: string): Promise<Pcm> {
    const file = path.join(this.dir, `${++this.n}.wav`);
    const ms = synthDeadlineMs(text.length);
    try {
      await run('say', ['-v', this.voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', text], { timeout: ms, killSignal: 'SIGKILL' });
    } catch (e) {
      rmSync(file, { force: true });
      if (!(e as { killed?: boolean }).killed) throw e;
      log.warn(`Sprachausgabe: say lieferte nach ${Math.round(ms / 1000)} s keinen Ton – Ansage übersprungen`);
      throw new SynthTimeout(`say: keine Antwort nach ${Math.round(ms / 1000)} s`);
    }
    const pcm = decodeWav(readFileSync(file));
    rmSync(file, { force: true });
    return pcm;
  }
  async close(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
