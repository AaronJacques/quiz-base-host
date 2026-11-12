import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { WhisperServerStt } from './stt.ts';
import { createTts } from './tts.ts';

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
  tts: ReturnType<typeof createTts>;
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
  const tts = createTts(v);
  return {
    stt,
    fastStt,
    tts,
    warmup: async () => {
      await Promise.all([stt.start(), fastStt?.start(), tts.synth('Hallo.')]);
    },
    close: async () => {
      await Promise.all([stt.close(), fastStt?.close(), tts.close()]);
    },
  };
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

