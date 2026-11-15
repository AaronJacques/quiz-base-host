import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { FIXED_LINES } from './narration.ts';
import { WhisperServerStt } from './stt.ts';
import { CachedTts, createEngine, DiskCachedTts, ttsIdentity } from './tts.ts';
import { forSpeech, splitSentences } from './voice-host.ts';

const log = createLogger('voice');
const run = promisify(execFile);

/** Official whisper.cpp models ("ggml-<name>.bin") – any of them can be configured as `voice.whisperModel`. */
const WHISPER_MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

/** How to get whisper-server on this system. */
function whisperInstallHint(): string {
  return process.platform === 'darwin'
    ? 'brew install whisper.cpp'
    : 'whisper.cpp bauen (cmake --build … --target whisper-server) oder das Docker-Image nutzen, siehe docs/INSTALL.md';
}
const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high';
const PIPER_VERSION = 'piper-tts==1.3.0';

export interface VoiceKitImpl {
  /** The precise main model – spoken answers. */
  stt: WhisperServerStt;
  /** The fast second model (`voice.whisperFastModel`) for everything else; undefined = the main model hears all. */
  fastStt?: WhisperServerStt;
  tts: CachedTts;
  warmup(): Promise<void>;
  close(): Promise<void>;
}

/** The fast model's own whisper-server, next to the main one. */
export function fastWhisperPort(v: Config['voice']): number {
  return v.whisperPort + 1;
}

/** Shared STT/TTS for all voice sessions; servers start lazily on first use. */
export function createVoiceKit(config: Config): VoiceKitImpl {
  const v = config.voice;
  const stt = new WhisperServerStt(v);
  const fastStt = v.whisperFastModel ? new WhisperServerStt(v, { model: v.whisperFastModel, port: fastWhisperPort(v) }) : undefined;
  const engine = createEngine(v);
  const disk = v.ttsDiskCache ? new DiskCachedTts(engine, { dir: ttsCacheDir(v), identity: ttsIdentity(v), allow: isFixedSpeech }) : null;
  const tts = new CachedTts(disk ?? engine);
  let warming = false;
  return {
    stt,
    fastStt,
    tts,
    warmup: async () => {
      await Promise.all([stt.start(), fastStt?.start(), tts.synth('Hallo.')]);
      // Missing short fixed lines are made in the background, only while the voice path is quiet.
      if (disk && !warming) {
        warming = true;
        void disk.warm(warmLines(v), { quietMs: WARM_QUIET_MS });
      }
    },
    close: async () => {
      await Promise.all([stt.close(), fastStt?.close(), tts.close()]);
    },
  };
}

/** Pre-warming starts only after this long without speaking, hearing or synthesising. */
export const WARM_QUIET_MS = 3000;

/** Longer fixed lines are not pre-warmed (one of them could hold up a real line); they are stored when first spoken. */
export const WARM_MAX_CHARS = 80;

export function ttsCacheDir(v: Config['voice']): string {
  return path.resolve(v.dir, 'tts-cache');
}

/** Every exact text that may go to disk: each fixed line as spoken, and each of its sentence parts. */
const FIXED_SPEECH = new Set(
  FIXED_LINES.flatMap((line) => {
    const clean = forSpeech(line);
    return [clean, ...splitSentences(clean)];
  }),
);

/** May this exact text be kept on disk? Only fixed lines and their parts – never anything with game content. */
export function isFixedSpeech(text: string): boolean {
  return FIXED_SPEECH.has(text);
}

/** What pre-warming makes: the texts `say` will hand to the engine, short ones only, most frequent first. */
export function warmLines(v: Config['voice']): string[] {
  const texts = FIXED_LINES.flatMap((line) => {
    const clean = forSpeech(line);
    return v.ttsSplitSentences ? splitSentences(clean) : [clean];
  });
  return [...new Set(texts)].filter((t) => t.length <= WARM_MAX_CHARS);
}

/** The configured Whisper models: the main one and, if set, the fast one. */
function whisperModels(v: Config['voice']): string[] {
  return [v.whisperModel, ...(v.whisperFastModel ? [v.whisperFastModel] : [])];
}

/** What is missing for voice; empty = ready. */
export async function voiceProblems(config: Config): Promise<string[]> {
  const v = config.voice;
  const out: string[] = [];
  try {
    await run(v.whisperBin, ['--help']);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') out.push(`${v.whisperBin} fehlt (${whisperInstallHint()})`);
  }
  for (const m of whisperModels(v)) if (!existsSync(path.resolve(v.dir, m))) out.push(`Whisper-Modell fehlt (${m})`);
  if (v.tts === 'piper') {
    if (!existsSync(path.resolve(v.dir, 'venv/bin/python'))) out.push('Piper-Umgebung fehlt');
    if (!existsSync(path.resolve(v.dir, v.piperVoice))) out.push(`Piper-Stimme fehlt (${v.piperVoice})`);
  }
  return out;
}

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  log.info(`Lade ${path.basename(file)} …`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let done = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    done += c.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct;
      log.info(`  ${path.basename(file)}: ${pct} %`);
    }
  });
  await pipeline(body, createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
}

/** `qbhost voice-setup`: installs whisper.cpp (Homebrew on macOS), downloads models, creates the Piper venv. */
export async function setupVoice(config: Config): Promise<void> {
  const v = config.voice;
  mkdirSync(v.dir, { recursive: true });

  try {
    await run(v.whisperBin, ['--help']);
    log.info('whisper.cpp ✓');
  } catch {
    if (process.platform !== 'darwin') throw new Error(`${v.whisperBin} fehlt: ${whisperInstallHint()}`);
    log.info('Installiere whisper.cpp (brew install whisper.cpp) …');
    await run('brew', ['install', 'whisper.cpp'], { maxBuffer: 64 * 1024 * 1024 }).catch((e) => {
      throw new Error(`whisper.cpp konnte nicht installiert werden (${(e as Error).message.split('\n')[0]}). Manuell: brew install whisper.cpp`);
    });
  }
  for (const m of whisperModels(v)) {
    const model = path.resolve(v.dir, m);
    const modelName = path.basename(m);
    if (/^ggml-[\w.-]+\.bin$/.test(modelName)) await download(WHISPER_MODEL_BASE + modelName, model);
    else if (!existsSync(model)) throw new Error(`Eigenes Whisper-Modell ${model} fehlt.`);
  }

  if (v.tts === 'piper') {
    const py = path.resolve(v.dir, 'venv/bin/python');
    if (!existsSync(py)) {
      log.info('Erstelle Python-Umgebung für Piper …');
      await run('python3', ['-m', 'venv', path.resolve(v.dir, 'venv')]).catch((e) => {
        throw new Error(`Python-venv nicht möglich (${(e as Error).message.split('\n')[0]}). Debian/Ubuntu: sudo apt install python3-venv`);
      });
    }
    log.info(`Installiere ${PIPER_VERSION} …`);
    await run(py, ['-m', 'pip', 'install', '-q', PIPER_VERSION], { maxBuffer: 64 * 1024 * 1024 });
    const voice = path.resolve(v.dir, v.piperVoice);
    if (v.piperVoice === 'models/de_DE-thorsten-high.onnx') {
      await download(`${PIPER_VOICE_BASE}.onnx`, voice);
      await download(`${PIPER_VOICE_BASE}.onnx.json`, `${voice}.json`);
    } else if (!existsSync(voice)) throw new Error(`Eigene Piper-Stimme ${voice} fehlt.`);
  }

  log.info('Selbsttest: Sprechen → Erkennen …');
  const kit = createVoiceKit(config);
  try {
    const pcm = await kit.tts.synth('Willkommen zum Tafelquiz. Anna, du bist dran.');
    for (const [label, stt] of [['Hauptmodell', kit.stt], ['schnelles Modell', kit.fastStt]] as const) {
      if (!stt) continue;
      const text = await stt.transcribe(pcm);
      log.info(`Erkannt (${label}): „${text}“`);
      if (!/tafel\s?quiz/i.test(text)) log.warn(`Die Erkennung (${label}) klingt ungewöhnlich – Modell/Stimme prüfen.`);
    }
  } finally {
    await kit.close();
  }
  log.info('Sprachsteuerung ist eingerichtet ✓');
}

