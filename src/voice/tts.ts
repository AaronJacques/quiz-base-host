import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { decodeWav, type Pcm } from './audio.ts';
import { killOnExit } from './children.ts';

const log = createLogger('tts');
const run = promisify(execFile);

export interface TextToSpeech {
  synth(text: string): Promise<Pcm>;
  close(): Promise<void>;
  /** Engine and voice for `⏱` lines, e.g. `piper:de_DE-thorsten-high`. */
  readonly engine?: string;
  /** Would `synth(text)` be served from a cache (no new synthesis)? For `⏱ ansage cache=ja`. */
  cached?(text: string): boolean;
}

export function createTts(cfg: Config['voice']): TextToSpeech {
  return new CachedTts(cfg.tts === 'piper' ? new PiperTts(cfg) : new SayTts(cfg.sayVoice));
}

/** Fixed phrases ("Buzzer frei!", "deine Antwort?") repeat all game – synthesise them once. */
export class CachedTts implements TextToSpeech {
  private cache = new Map<string, Promise<Pcm>>();
  constructor(private inner: TextToSpeech) {}
  get engine(): string | undefined {
    return this.inner.engine;
  }
  cached(text: string): boolean {
    return this.cache.has(text);
  }
  synth(text: string): Promise<Pcm> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const p = this.inner.synth(text);
    p.catch(() => this.cache.delete(text));
    this.cache.set(text, p);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Piper with the voice kept loaded in a small Python worker (≈0.2–0.5 s per sentence). */
export class PiperTts implements TextToSpeech {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, { resolve: (p: Pcm) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  readonly engine: string;

  constructor(private cfg: Config['voice']) {
    this.engine = `piper:${path.basename(cfg.piperVoice, '.onnx')}`;
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
      proc.once('error', (e) => reject(e));
      proc.once('exit', (code) => {
        const err = new Error(`Piper beendet (${code}): ${stderr.split('\n').filter((l) => !/telemetry/.test(l)).join(' ').slice(-300)}`);
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
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
        const p = this.pending.get(msg.id!);
        if (!p) return;
        this.pending.delete(msg.id!);
        if (msg.error || !msg.wav) p.reject(new Error(`Piper: ${msg.error ?? 'keine Audiodaten'}`));
        else p.resolve(decodeWav(Buffer.from(msg.wav, 'base64')));
      });
    });
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async synth(text: string): Promise<Pcm> {
    await this.start();
    const id = this.nextId++;
    return new Promise<Pcm>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ id, text }) + '\n');
    });
  }

  async close(): Promise<void> {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}

/** macOS `say` – no setup, noticeably more robotic. */
export class SayTts implements TextToSpeech {
  private dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-say-'));
  private n = 0;
  readonly engine: string;
  constructor(private voice: string) {
    this.engine = `say:${voice}`;
  }
  async synth(text: string): Promise<Pcm> {
    const file = path.join(this.dir, `${++this.n}.wav`);
    await run('say', ['-v', this.voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', text]);
    const pcm = decodeWav(readFileSync(file));
    rmSync(file, { force: true });
    return pcm;
  }
  async close(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
