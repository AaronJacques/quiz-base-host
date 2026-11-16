import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { createLogger, sleep } from '../core/logger.ts';
import { encodeWav, resample, toMono, type Pcm } from './audio.ts';
import { killOnExit } from './children.ts';
import { extractAnswer } from './commands.ts';

const log = createLogger('stt');

export interface SttOptions {
  /** Aborted when the caller gives up (cloud timeout): stop the request, its result is not used any more. */
  signal?: AbortSignal;
  /**
   * Measurement only (`⏱ … rueckfall=ja`): another engine heard this utterance instead of the one asked.
   * `tried` = the first engine ran and failed (false: it was skipped, e.g. paused after errors). Never throws.
   */
  onFallback?: (engine: string, tried: boolean) => void;
}

export interface SpeechToText {
  /** `prompt` = vocabulary hints (categories, names). Never put the solution in there. */
  transcribe(pcm: Pcm, prompt?: string, opts?: SttOptions): Promise<string>;
  /** Gets the engine ready (load the model, open a connection) so the first utterance is not delayed. */
  warmup?(): Promise<void>;
  close(): Promise<void>;
  /** Engine and model for `⏱` lines, e.g. `whisper:large-v3-turbo-q5_0`. */
  readonly engine?: string;
  /** The audio leaves this machine (a cloud provider, or a route that may use one). Local engines leave it out. */
  readonly cloud?: boolean;
}

/**
 * An engine that never sends audio away. Where only local recognition is allowed (`VoiceHostDeps.localStt`,
 * `SttRoutes.localStt`), the type rules out a cloud engine: `cloud: true` does not compile there.
 */
export type LocalStt = SpeechToText & { readonly cloud?: false };

/**
 * The engine is not ready (starting, loading its model, restarting) and does not let the utterance wait:
 * whoever routes it takes another local engine right away (`VoiceHost.listen`, `FallbackStt.standIn`).
 * Its message never holds what was said.
 */
export class SttNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttNotReady';
  }
}

const ANSWERS_ONLY = new WeakSet<object>();

/**
 * Marks a local engine whose text counts only as a spoken answer (Parakeet next to whisper): an utterance
 * it hears without the answer keyword is heard again by whisper, and only whisper's text is taken as a
 * command, wake word, yes/no or card (`VoiceHost`). Set by `createSttRoutes`; never on the only engine.
 */
export function markAnswersOnly(stt: SpeechToText): void {
  ANSWERS_ONLY.add(stt);
}

export function isAnswersOnly(stt: SpeechToText | null | undefined): boolean {
  return !!stt && ANSWERS_ONLY.has(stt);
}

/** Does this engine (maybe) send audio to a cloud provider? */
export function isCloud(stt: SpeechToText): boolean {
  return stt.cloud === true;
}

/**
 * The vocabulary prompt (`QuizBot.voicePrompt()`, comma-separated) as single terms for engines that take a
 * list (Deepgram `keyterm`): trimmed, without empty or duplicate entries (case ignored), at most `max`.
 * Only splits – what is in the prompt (never the solution) is decided by the bot alone.
 */
export function promptTerms(prompt: string, max = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompt.split(',')) {
    const term = raw.replace(/\s+/g, ' ').trim();
    const k = term.toLowerCase();
    if (!term || seen.has(k)) continue;
    seen.add(k);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Phrases Whisper invents on silence, noise or music (it was trained on subtitled videos).
 * Matched against the whole transcript after normalisation: only an utterance that is nothing but such a
 * phrase is dropped, never one that merely contains a word of it ("Leonardo", "Meine Antwort ist die ARD").
 */
const HALLUCINATIONS = [
  /^vielen dank( fürs zuschauen| für ihre aufmerksamkeit)?$/,
  /^danke( schön| fürs zuschauen)?$/,
  /^tschüss$/,
  /^untertitel.*$/,
  // Subtitle credits as the whole utterance: "Untertitel der Amara.org-Community", "Copyright WDR 2021",
  // "ZDF für funk, 2017", "SWR 2020", "www.zdf.de". Dots are gone after normalisation ("amaraorg", "wwwzdfde").
  /^.*amara ?org.*$/,
  /^copyright\b.*$/,
  /^(?:(?:im auftrag )?(?:des|der|vom|von|das|die) )?(?:zdf|swr|ard|wdr|ndr|mdr|br|funk)(?: (?:für|und) (?:funk|zdf|ard))*(?: \d{4})?$/,
  /^www\S*$/,
  /^bis zum nächsten mal$/,
  /^(musik|applaus|lachen|stille|piepen)$/,
  /^thank you( for watching)?$/,
];

/**
 * Strips stage directions and known hallucinations; returns '' if nothing real is left. An utterance with
 * the answer keyword ("Meine Antwort ist Danke", "… die ARD", "… WWW") is never a hallucination – no
 * subtitle credit starts like that – so it is kept whatever follows.
 */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const norm = text.toLowerCase().replace(/[.!?,;:…"„“]+/g, '').trim();
  if (!norm) return '';
  if (extractAnswer(text) === null && HALLUCINATIONS.some((r) => r.test(norm))) return '';
  return text;
}

/**
 * whisper.cpp's `whisper-server`, started once and kept warm (model loading takes seconds).
 * If it dies (crash, `pkill`), the next `transcribe` starts it again – like Piper.
 * `model`/`port` default to `whisperModel`/`whisperPort`; the fast second model gets its own instance.
 */
export class WhisperServerStt implements SpeechToText {
  private proc: ChildProcess | null = null;
  /** A server left behind by an earlier run of ours (killed with SIGKILL) that we took over. */
  private adoptedPid: number | null = null;
  private ready: Promise<void> | null = null;
  private readonly url: string;
  private readonly model: string;
  readonly port: number;
  readonly engine: string;

  constructor(private cfg: Config['voice'], opts: { model?: string; port?: number } = {}) {
    this.model = opts.model ?? cfg.whisperModel;
    this.port = opts.port ?? cfg.whisperPort;
    this.engine = `whisper:${path.basename(this.model, '.bin').replace(/^ggml-/, '')}`;
    this.url = `http://127.0.0.1:${this.port}`;
  }

  get modelPath(): string {
    return path.resolve(this.cfg.dir, this.model);
  }

  /** Arguments for whisper-server – `-ac` only with a reduced audio window (`voice.whisperAudioCtx`). */
  get args(): string[] {
    const ac = this.cfg.whisperAudioCtx > 0 ? ['-ac', String(this.cfg.whisperAudioCtx)] : [];
    return ['-m', this.modelPath, '-l', this.cfg.language, '--host', '127.0.0.1', '--port', String(this.port), '-nt', ...ac];
  }

  /** Remembers which server we started, so a later run can take an orphan over and stop it. */
  private get pidFile(): string {
    return path.resolve(this.cfg.dir, `whisper-server-${this.port}.pid`);
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (await this.alive()) {
        this.adoptedPid = this.proc ? null : this.orphanPid();
        return void log.info(`whisper-server (${path.basename(this.model)}) läuft bereits auf ${this.url}${this.adoptedPid ? ` (aus einem früheren Lauf, PID ${this.adoptedPid} – wird beim Beenden gestoppt)` : ''}`);
      }
      if (!existsSync(this.modelPath)) throw new Error(`Whisper-Modell fehlt: ${this.modelPath} – \`npx qbhost voice-setup\` ausführen`);
      log.info(`Starte whisper-server (${path.basename(this.model)}, Port ${this.port}) …`);
      const proc = spawn(this.cfg.whisperBin, this.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      this.adoptedPid = null;
      killOnExit(proc); // never leave an orphaned server behind
      this.writePid(proc.pid);
      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      // Crash or kill after start: forget it, the next transcribe() starts a fresh one.
      proc.once('exit', (code, signal) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        rmSync(this.pidFile, { force: true });
        // Code 0: an orderly stop (Ctrl+C reaches it with the whole process group) – no reason to worry.
        (code === 0 ? log.info : log.warn)(`whisper-server beendet (${code ?? signal}) – starte ihn bei der nächsten Erkennung neu`);
      });
      const exited = new Promise<never>((_, reject) => {
        proc.once('error', (e) => reject(new Error(`whisper-server nicht startbar (${e.message}) – \`brew install whisper-cpp\``)));
        proc.once('exit', (code) => reject(new Error(`whisper-server beendet (${code}): ${stderr.slice(-300)}`)));
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
    const ready = this.ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  private writePid(pid: number | undefined): void {
    if (!pid) return;
    try {
      mkdirSync(path.dirname(this.pidFile), { recursive: true });
      writeFileSync(this.pidFile, String(pid));
    } catch {
      /* best effort */
    }
  }

  /**
   * PID of a whisper-server on our port that an earlier run of ours started (pid file) and left behind:
   * its parent is gone (re-parented to PID 1). A server of another running qbhost process is left alone.
   */
  private orphanPid(): number | null {
    try {
      const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
      if (!pid) return null;
      const [ppid = '', ...cmd] = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], { encoding: 'utf8' }).trim().split(/\s+/);
      const command = cmd.join(' ');
      return ppid === '1' && command.includes('whisper-server') && command.includes(`--port ${this.port}`) ? pid : null;
    } catch {
      return null;
    }
  }

  private async alive(): Promise<boolean> {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(1000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  warmup(): Promise<void> {
    return this.start();
  }

  async transcribe(pcm: Pcm, prompt = '', opts: SttOptions = {}): Promise<string> {
    try {
      return await this.infer(pcm, prompt, opts.signal);
    } catch (e) {
      if (!isConnectionError(e) || opts.signal?.aborted) throw e;
      // The server is gone (crashed, killed, not ours any more): start it again and retry once.
      log.warn(`whisper-server nicht erreichbar (${(e as Error).message}) – starte neu`);
      const stale = this.proc;
      this.proc = null; // its exit must not reset the new start
      this.ready = null;
      stale?.kill();
      return this.infer(pcm, prompt, opts.signal);
    }
  }

  private async infer(pcm: Pcm, prompt: string, signal?: AbortSignal): Promise<string> {
    await this.start();
    const wav = encodeWav(resample(toMono(pcm), 16000));
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    form.set('response_format', 'json');
    form.set('language', this.cfg.language);
    form.set('temperature', '0');
    if (prompt) form.set('prompt', prompt);
    const t0 = Date.now();
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`whisper-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = String(((await res.json()) as { text?: string }).text ?? '');
    const text = cleanTranscript(raw);
    log.debug(`STT ${Date.now() - t0} ms (${path.basename(this.model, '.bin').replace(/^ggml-/, '')}): "${raw.trim()}"${text !== raw.trim() ? ` → "${text}"` : ''}`);
    return text;
  }

  async close(): Promise<void> {
    const proc = this.proc;
    const adopted = this.adoptedPid;
    this.proc = null;
    this.adoptedPid = null;
    this.ready = null;
    proc?.kill();
    if (adopted) {
      try {
        process.kill(adopted);
      } catch {
        /* already gone */
      }
    }
    if (proc || adopted) rmSync(this.pidFile, { force: true });
  }
}

/** fetch() could not reach the server at all (as opposed to an HTTP error from it). */
function isConnectionError(e: unknown): boolean {
  const err = e as Error & { cause?: { code?: string } };
  return err instanceof TypeError || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(err?.cause?.code ?? '');
}
