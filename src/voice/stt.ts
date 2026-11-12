import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { createLogger, sleep } from '../core/logger.ts';
import { encodeWav, resample, toMono, type Pcm } from './audio.ts';

const log = createLogger('stt');

export interface SpeechToText {
  /** `prompt` = vocabulary hints (categories, names). Never put the solution in there. */
  transcribe(pcm: Pcm, prompt?: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Phrases Whisper invents on silence, noise or music (it was trained on subtitled videos).
 * Matched against the whole transcript after normalisation.
 */
const HALLUCINATIONS = [
  /^vielen dank( fürs zuschauen| für ihre aufmerksamkeit)?$/,
  /^danke( schön| fürs zuschauen)?$/,
  /^tschüss$/,
  /^untertitel.*$/,
  /^.*(amara\.org|zdf|swr|ard|copyright|www\.).*$/,
  /^bis zum nächsten mal$/,
  /^(musik|applaus|lachen|stille|piepen)$/,
  /^thank you( for watching)?$/,
];

/** Strips stage directions and known hallucinations; returns '' if nothing real is left. */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const norm = text.toLowerCase().replace(/[.!?,;:…"„“]+/g, '').trim();
  if (!norm || HALLUCINATIONS.some((r) => r.test(norm))) return '';
  return text;
}

/** whisper.cpp's `whisper-server`, started once and kept warm (model loading takes seconds). */
export class WhisperServerStt implements SpeechToText {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly url: string;

  constructor(private cfg: Config['voice']) {
    this.url = `http://127.0.0.1:${cfg.whisperPort}`;
  }

  get modelPath(): string {
    return path.resolve(this.cfg.dir, this.cfg.whisperModel);
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (await this.alive()) return void log.info(`whisper-server läuft bereits auf ${this.url}`);
      if (!existsSync(this.modelPath)) throw new Error(`Whisper-Modell fehlt: ${this.modelPath} – \`npx qbhost voice-setup\` ausführen`);
      log.info('Starte whisper-server …');
      this.proc = spawn(this.cfg.whisperBin, ['-m', this.modelPath, '-l', this.cfg.language, '--host', '127.0.0.1', '--port', String(this.cfg.whisperPort), '-nt'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      this.proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      const proc = this.proc;
      process.once('exit', () => proc.kill()); // never leave an orphaned server behind
      const exited = new Promise<never>((_, reject) => {
        this.proc!.once('error', (e) => reject(new Error(`whisper-server nicht startbar (${e.message}) – \`brew install whisper-cpp\``)));
        this.proc!.once('exit', (code) => reject(new Error(`whisper-server beendet (${code}): ${stderr.slice(-300)}`)));
      });
      const up = (async () => {
        for (let i = 0; i < 120; i++) {
          if (await this.alive()) return;
          await sleep(500);
        }
        throw new Error('whisper-server antwortet nicht');
      })();
      await Promise.race([up, exited]);
      log.info('whisper-server bereit');
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  private async alive(): Promise<boolean> {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(1000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async transcribe(pcm: Pcm, prompt = ''): Promise<string> {
    await this.start();
    const wav = encodeWav(resample(toMono(pcm), 16000));
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    form.set('response_format', 'json');
    form.set('language', this.cfg.language);
    form.set('temperature', '0');
    if (prompt) form.set('prompt', prompt);
    const t0 = Date.now();
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`whisper-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = String(((await res.json()) as { text?: string }).text ?? '');
    const text = cleanTranscript(raw);
    log.debug(`STT ${Date.now() - t0} ms: "${raw.trim()}"${text !== raw.trim() ? ` → "${text}"` : ''}`);
    return text;
  }

  async close(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
