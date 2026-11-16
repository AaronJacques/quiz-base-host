import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { pcmToBuffer, resample, toMono, type Pcm } from './audio.ts';
import { killOnExit } from './children.ts';
import { cleanTranscript, SttNotReady, type SpeechToText, type SttOptions } from './stt.ts';

const log = createLogger('stt');

/**
 * NVIDIA Parakeet TDT 0.6b v3 (int8) through sherpa-onnx – the second local engine next to whisper.cpp
 * (`voice.localStt: parakeet`, docs/VOICE.md "Parakeet statt whisper.cpp").
 * Package and model are pinned: the version below goes into `voice-setup` and the Docker image alike,
 * the archive is checked against its SHA-256 before anything is unpacked.
 */
export const SHERPA_ONNX_VERSION = '2.0.1';
export const PARAKEET_MODEL = {
  /** Folder name inside the archive = default `voice.parakeet.model` basename. */
  name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
  /** As GitHub lists it for the release asset (and as measured after download). */
  sha256: '1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9',
  bytes: 487_211_443,
} as const;
/** The files the worker loads; a model folder without all of them is not ready. */
export const PARAKEET_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] as const;

/** Is the model folder complete? `voice-setup` renames it into place only after a full, checked unpack. */
export function parakeetModelReady(dir: string, exists: (f: string) => boolean = existsSync): boolean {
  return PARAKEET_FILES.every((f) => exists(path.join(dir, f)));
}

export interface CacheReadOptions {
  signal?: AbortSignal;
  /** Bytes per read (default 4 MiB). */
  chunkBytes?: number;
  /** Pause after each read, so the read never hogs the one CPU or the disk (default 10 ms). */
  pauseMs?: number;
}

/**
 * Reads the files once, chunk by chunk with pauses, and drops the data: the system keeps it in its page
 * cache, so a later worker start loads the model from memory (~3–5 s on 1 vCPU) instead of the disk
 * (measured 53 s cold). No own memory (one reused buffer), no child process; stops at once on `signal`.
 * The cache is the system's: under memory pressure it may be evicted again. Resolves with the bytes read.
 */
export async function readIntoPageCache(files: string[], o: CacheReadOptions = {}): Promise<number> {
  const buf = Buffer.allocUnsafe(o.chunkBytes ?? 4 * 1024 * 1024);
  const pause = o.pauseMs ?? 10;
  let total = 0;
  for (const file of files) {
    if (o.signal?.aborted) break;
    const fh = await openFile(file, 'r');
    try {
      for (;;) {
        if (o.signal?.aborted) break;
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (pause) await new Promise((r) => setTimeout(r, pause).unref?.());
      }
    } finally {
      await fh.close();
    }
  }
  return total;
}

/** Threads for the worker: the configured number, or the cores (at most 4, like whisper.cpp). */
export function parakeetThreads(n: number, cores = os.availableParallelism()): number {
  return n > 0 ? n : Math.max(1, Math.min(4, cores));
}

/** A recognition was given up after its second try (hung or crashed worker); nothing of its content is logged. */
export class SttTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttTimeout';
  }
}

/**
 * Parakeet writes like a subtitler: capitals, punctuation, numbers mostly as digits ("1989", "Geschichte
 * 300"). The command parsers already take all of that (they compare lower case without punctuation, and
 * `spokenToDigits` turns spoken point values into digits). Here only what differs from whisper: a
 * thousands separator inside a number ("1.000" → "1000") would split a point value.
 */
export function normalizeParakeet(raw: string): string {
  return cleanTranscript(raw.replace(/(\d)[.\u00a0\u202f](\d{3})(?!\d)/g, '$1$2'));
}

interface Job {
  kind: 'stt' | 'stats';
  /** base64 s16le 16 kHz mono (stt only). */
  pcm: string;
  audioSec: number;
  /** Failed tries so far (deadline or worker crash); the second one gives the job up. */
  fails: number;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (v: string | number) => void;
  reject: (e: Error) => void;
}

export interface ParakeetOptions {
  /** Interpreter and worker script; tests pass a fake worker. Default: `<dir>/venv/bin/python` + sherpa_worker.py. */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Deadline per recognition from hand-over to the ready worker. Default from `voice.parakeet`. */
  deadlineMs?: (audioSec: number) => number;
  startTimeoutMs?: number;
}

/**
 * Parakeet kept loaded in one Python worker (`sherpa_worker.py`, JSON lines over stdin/stdout). The worker
 * hears one utterance at a time from our own queue, in order. A job's deadline runs only from when the
 * ready worker has it – never while it waits in the queue or while a (re)started worker loads the model
 * (that has its own `startTimeoutMs`). Past the deadline, or when the worker dies, the worker is killed
 * and the job goes first to a fresh one; a second failure of the same utterance drops it (warning without
 * content). A local engine (`LocalStt`): the audio never leaves this machine. Ignores the prompt – the
 * model has none.
 */
export class ParakeetStt implements SpeechToText {
  readonly engine: string;
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private queue: Job[] = [];
  private current: { id: number; job: Job } | null = null;
  private nextId = 1;
  private closed = false;
  /** Time from spawn to "ready" of the last worker start (ms), and the model load the worker measured. */
  coldStartMs: number | null = null;
  loadMs: number | null = null;
  /** Workers started so far (tests, measurement). */
  starts = 0;
  /**
   * Mixed mode (whisper next to it, set by `createSttRoutes`): while the worker is not ready – starting,
   * loading, restarting – an utterance is not kept waiting but rejected at once with `SttNotReady`, and
   * whisper hears it; the worker (re)starts in the background. Without whisper (Parakeet alone) utterances
   * wait for the worker, with a warning.
   */
  failFast = false;
  /** The worker that said "ready" – `readyNow()` while it is the running one. */
  private upProc: ChildProcess | null = null;
  private warnedWaiting = false;

  constructor(
    private cfg: Config['voice'],
    private o: ParakeetOptions = {},
  ) {
    this.engine = `parakeet:${path.basename(cfg.parakeet.model).replace(/^sherpa-onnx-nemo-parakeet-/, '')}`;
  }

  get modelDir(): string {
    return path.resolve(this.cfg.dir, this.cfg.parakeet.model);
  }

  get python(): string {
    return path.resolve(this.cfg.dir, 'venv/bin/python');
  }

  /** PID of the running worker (measurement, tests). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  private deadline(audioSec: number): number {
    if (this.o.deadlineMs) return this.o.deadlineMs(audioSec);
    return this.cfg.parakeet.deadlineMs + Math.ceil(audioSec * this.cfg.parakeet.deadlinePerSecMs);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Parakeet beendet'));
    if (this.ready) return this.ready;
    const ready = new Promise<void>((resolve, reject) => {
      let command = this.o.command;
      let args = this.o.args;
      if (!command) {
        if (!existsSync(this.python)) return reject(new Error(`Python-Umgebung für Parakeet fehlt (${this.python}) – \`npx qbhost voice-setup\` ausführen`));
        if (!parakeetModelReady(this.modelDir)) return reject(new Error(`Parakeet-Modell fehlt oder ist unvollständig (${this.modelDir}) – \`npx qbhost voice-setup\` ausführen`));
        command = this.python;
        args = [fileURLToPath(new URL('./sherpa_worker.py', import.meta.url)), this.modelDir, String(parakeetThreads(this.cfg.parakeet.threads))];
      }
      const t0 = Date.now();
      const proc = spawn(command, args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: this.o.env ?? process.env });
      this.proc = proc;
      this.starts++;
      killOnExit(proc);
      let stderr = '';
      let up = false;
      proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      proc.stdin!.on('error', () => {}); // EPIPE after a kill: the exit handler reports it
      const startTimer = setTimeout(() => {
        if (up) return;
        reject(new Error(`Parakeet lädt nicht (nach ${Math.round(this.startTimeout / 1000)} s kein „bereit“)`));
        if (this.proc === proc) this.kill();
      }, this.startTimeout);
      startTimer.unref?.();
      proc.once('error', (e) => {
        clearTimeout(startTimer);
        reject(new Error(`Parakeet nicht startbar (${e.message})`));
      });
      proc.once('exit', (code, signal) => {
        clearTimeout(startTimer);
        // The worker's stderr may hold a traceback, never a transcript (the worker logs none).
        const why = stderr.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(-300);
        reject(new Error(`Parakeet beendet (${code ?? signal})${why ? `: ${why}` : ''}`));
        if (this.proc !== proc) return; // killed on purpose (deadline, close): handled there
        this.proc = null;
        this.ready = null;
        this.upProc = null;
        if (up) log.warn(`Parakeet-Worker beendet (${code ?? signal}) – starte ihn neu`);
        if (up) this.failed('abgestürzt');
      });
      createInterface({ input: proc.stdout! }).on('line', (line) => {
        let msg: { ready?: boolean; loadMs?: number; id?: number; text?: string; error?: string; peakMb?: number };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready) {
          up = true;
          if (this.proc === proc) this.upProc = proc;
          this.warnedWaiting = false;
          clearTimeout(startTimer);
          this.coldStartMs = Date.now() - t0;
          this.loadMs = typeof msg.loadMs === 'number' ? msg.loadMs : null;
          log.info(`Parakeet bereit (${(this.coldStartMs / 1000).toFixed(1)} s)`);
          return resolve();
        }
        const cur = this.current;
        if (this.proc !== proc || !cur || cur.id !== msg.id) return; // a late line of a given-up job
        this.current = null;
        clearTimeout(cur.job.timer);
        if (msg.error) cur.job.reject(new Error(`Parakeet: ${msg.error}`));
        else if (cur.job.kind === 'stats') cur.job.resolve(Number(msg.peakMb ?? NaN));
        else cur.job.resolve(normalizeParakeet(String(msg.text ?? '')));
        this.pump();
      });
    });
    this.ready = ready;
    // Only forget the start that failed – a restart may have begun a new one meanwhile.
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  private get startTimeout(): number {
    return this.o.startTimeoutMs ?? this.cfg.parakeet.startTimeoutMs;
  }

  warmup(): Promise<void> {
    return this.start();
  }

  /** `prompt` is ignored: Parakeet has no vocabulary prompt. */
  /** Is the worker running and ready for an utterance now (no start, load or restart in between)? */
  readyNow(): boolean {
    return !this.closed && !!this.proc && this.upProc === this.proc;
  }

  /** Starts the worker in the background if it is not running or starting; a failure is only logged. */
  private startInBackground(): void {
    if (this.closed || this.ready) return;
    this.start().catch((e) => log.warn(`Parakeet startet nicht: ${(e as Error).message.split('\n')[0]} – whisper hört die Antworten`));
  }

  transcribe(pcm: Pcm, _prompt = '', opts: SttOptions = {}): Promise<string> {
    if (!this.readyNow()) {
      if (this.failFast) {
        this.startInBackground();
        return Promise.reject(new SttNotReady('Parakeet ist noch nicht bereit (lädt das Modell)'));
      }
      if (!this.warnedWaiting && !this.closed) {
        this.warnedWaiting = true;
        log.warn(`Parakeet lädt noch – Äußerungen warten, bis es bereit ist (höchstens ${Math.round(this.startTimeout / 1000)} s)`);
      }
    }
    const mono = resample(toMono(pcm), 16000);
    const job = this.enqueue('stt', pcmToBuffer(mono).toString('base64'), mono.samples.length / 16000, opts.signal);
    return job as Promise<string>;
  }

  /** Peak memory of the worker in MB (`ru_maxrss`); starts it if needed. */
  stats(): Promise<number> {
    return this.enqueue('stats', '', 0) as Promise<number>;
  }

  private enqueue(kind: Job['kind'], pcm: string, audioSec: number, signal?: AbortSignal): Promise<string | number> {
    return new Promise<string | number>((resolve, reject) => {
      if (this.closed) return reject(new Error('Parakeet beendet'));
      if (signal?.aborted) return reject(signal.reason ?? new Error('abgebrochen'));
      const job: Job = {
        kind,
        pcm,
        audioSec,
        fails: 0,
        settled: false,
        resolve: (v) => {
          if (job.settled) return;
          job.settled = true;
          clearTimeout(job.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          if (job.settled) return;
          job.settled = true;
          clearTimeout(job.timer);
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      };
      // The caller gave up: settle now. A job in the worker keeps its slot until the worker answers
      // (or its deadline), so the next one never queues up behind it unseen.
      const onAbort = () => job.reject(signal?.reason instanceof Error ? signal.reason : new Error('abgebrochen'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  /** Hands the next job to the worker once it is ready; starts the worker if needed. */
  private pump(): void {
    if (this.current || this.closed) return;
    let job: Job | undefined;
    while ((job = this.queue.shift()) && job.settled);
    if (!job) return;
    const cur = { id: this.nextId++, job };
    this.current = cur;
    this.start().then(
      () => {
        if (this.current !== cur) return;
        if (job.settled) {
          // Given up while the worker loaded: nothing was sent, the slot is free again.
          this.current = null;
          return this.pump();
        }
        const ms = this.deadline(job.audioSec);
        job.timer = setTimeout(() => {
          if (this.current !== cur) return;
          log.warn(`Parakeet lieferte nach ${(ms / 1000).toFixed(1)} s kein Ergebnis – starte den Worker neu`);
          this.kill();
          this.failed(`keine Antwort nach ${(ms / 1000).toFixed(1)} s`);
        }, ms);
        job.timer.unref?.();
        const msg = job.kind === 'stats' ? { id: cur.id, op: 'stats' } : { id: cur.id, pcm: job.pcm };
        this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
      },
      (e) => {
        if (this.current !== cur) return;
        // The worker does not start (package or model missing, load failed): this job fails, the next
        // one tries a new start. No retry of the same job – a broken setup would only repeat.
        this.current = null;
        job.reject(e as Error);
        this.pump();
      },
    );
  }

  /**
   * The job in the worker failed (deadline, crash). First failure: it goes first to a fresh worker, whose
   * start does not count against its deadline. Second failure: dropped.
   */
  private failed(why: string): void {
    const cur = this.current;
    this.current = null;
    if (this.failFast) {
      // Mixed mode: nothing waits for the restart – the utterance in the worker and all waiting ones go to
      // whisper now (`SttNotReady`). The next utterance starts a new worker in the background (and is heard by
      // whisper meanwhile) – a worker that keeps crashing never restarts in a loop by itself.
      const err = new SttNotReady(`Parakeet startet neu (${why})`);
      if (cur) clearTimeout(cur.job.timer);
      cur?.job.reject(err);
      for (const j of this.queue.splice(0)) if (j.kind === 'stt') j.reject(err);
      return this.pump();
    }
    if (cur && !cur.job.settled) {
      clearTimeout(cur.job.timer);
      cur.job.timer = undefined;
      cur.job.fails++;
      if (cur.job.fails >= 2) {
        log.warn(`Parakeet: Äußerung nach zwei Fehlversuchen verworfen (${why})`);
        cur.job.reject(new SttTimeout(`Parakeet: zweimal gescheitert (${why})`));
      } else {
        this.queue.unshift(cur.job);
      }
    }
    this.pump();
  }

  /** Kills the worker (also while it loads); the next job starts a new one. */
  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.upProc = null;
    proc?.kill('SIGKILL');
  }

  /** Stops the worker and rejects what is not heard yet. Resolves once the worker process is gone. */
  async close(): Promise<void> {
    this.closed = true;
    const err = new Error('Parakeet beendet');
    const cur = this.current;
    const queued = this.queue;
    this.current = null;
    this.queue = [];
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.upProc = null;
    cur?.job.reject(err);
    for (const j of queued) j.reject(err);
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const hard = setTimeout(() => proc.kill('SIGKILL'), 2000);
      hard.unref?.();
      proc.once('exit', () => {
        clearTimeout(hard);
        resolve();
      });
      proc.stdin?.end();
      proc.kill();
    });
  }
}
