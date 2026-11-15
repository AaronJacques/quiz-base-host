import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { FIXED_LINES } from './narration.ts';
import { createSttRoutes, fastWhisperPort, sttNeeds, type SttRouteDeps } from './providers.ts';
import { WhisperServerStt, type LocalStt, type SpeechToText } from './stt.ts';
import { CachedTts, createEngine, DiskCachedTts, ttsIdentity, type TextToSpeech } from './tts.ts';
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
/** Official Piper voices: `<lang>/<lang>_<REGION>/<name>/<quality>/<file>` below this. */
export const PIPER_VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const PIPER_VERSION = 'piper-tts==1.3.0';

export { fastWhisperPort };

export interface VoiceKitImpl {
  /** Spoken answers ('answer'): the precise main model, or the cloud (`voice.stt`). */
  stt: SpeechToText;
  /** Everything else ('full'; also 'confirm'/'wake' unless set below); undefined = `stt` hears all. */
  fastStt?: SpeechToText;
  /** 'confirm', when it differs from `fastStt` (cloud routing). */
  confirmStt?: SpeechToText;
  /** The wake-word check of everyone not on turn – local unless `wake` is in `voice.sttCloudFor`. */
  wakeStt?: SpeechToText;
  /** Cloud routing: the local engines for whatever must not go to the cloud (see `SttRoutes`). */
  localStt?: LocalStt | null;
  localFastStt?: LocalStt | null;
  tts: CachedTts;
  warmup(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Shared STT/TTS for all voice sessions; servers start lazily on first use (or in `warmup`). The
 * recognisers per attention come from `createSttRoutes` – with `voice.stt: whisper` exactly the local
 * models as before. Throws if a cloud engine is configured without its key (`voiceProblems` says so first).
 */
export function createVoiceKit(config: Config, deps: SttRouteDeps & { tts?: TextToSpeech } = {}): VoiceKitImpl {
  const v = config.voice;
  const routes = createSttRoutes(v, deps);
  const engine = deps.tts ?? createEngine(v);
  const disk = v.ttsDiskCache ? new DiskCachedTts(engine, { dir: ttsCacheDir(v), identity: ttsIdentity(v), allow: isFixedSpeech }) : null;
  const tts = new CachedTts(disk ?? engine);
  let warming = false;
  return {
    stt: routes.stt,
    fastStt: routes.fastStt,
    confirmStt: routes.confirmStt,
    wakeStt: routes.wakeStt,
    localStt: routes.localStt,
    localFastStt: routes.localFastStt,
    tts,
    warmup: async () => {
      // A local engine that only stands in for the cloud may fail to start (model missing): voice still
      // works, a cloud failure then gets the chat notice. It never stops joining.
      const fallbacks = routes.warmFallback.map((s) =>
        Promise.resolve(s.warmup?.()).catch((e) => log.warn(`Rückfall nicht verfügbar (${s.engine ?? 'lokal'}): ${(e as Error).message.split('\n')[0]} – bei Cloud-Ausfall gibt es nur den Hinweis im Chat`)),
      );
      await Promise.all([...routes.warm.map((s) => s.warmup?.()), tts.synth('Hallo.'), ...fallbacks]);
      // Missing short fixed lines are made in the background, only while the voice path is quiet.
      if (disk && !warming) {
        warming = true;
        void disk.warm(warmLines(v), { quietMs: WARM_QUIET_MS });
      }
    },
    close: async () => {
      await Promise.all([...routes.all.map((s) => s.close()), tts.close()]);
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

/**
 * What is missing for voice; empty = ready. Checks only what the routing needs (`sttNeeds`): the key of a
 * cloud engine, whisper.cpp and the models that hear on their own. Local models that only stand in for the
 * cloud are no blocker – without them a cloud failure is reported in the chat (`onTrouble`) instead.
 */
export async function voiceProblems(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const v = config.voice;
  const out: string[] = [];
  const needs = sttNeeds(v);
  if (needs.cloud && !env[v.deepgram.keyEnv]?.trim()) out.push(`Deepgram-Schlüssel fehlt: ${v.deepgram.keyEnv} in .env setzen (oder voice.stt: "whisper")`);
  if (needs.required.length) {
    try {
      await run(v.whisperBin, ['--help']);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') out.push(`${v.whisperBin} fehlt (${whisperInstallHint()})`);
    }
  }
  for (const m of needs.required) if (!existsSync(path.resolve(v.dir, m))) out.push(`Whisper-Modell fehlt (${m})`);
  if (v.tts === 'piper') {
    if (!existsSync(path.resolve(v.dir, 'venv/bin/python'))) out.push('Piper-Umgebung fehlt');
    if (!existsSync(path.resolve(v.dir, v.piperVoice))) out.push(`Piper-Stimme fehlt (${v.piperVoice})`);
  }
  return out;
}

/**
 * What works but is missing for the cloud fallback (`cloudFallback: local`): models or whisper.cpp that
 * only stand in for the cloud. Not a blocker – a cloud failure then gets the chat notice instead.
 */
export async function voiceWarnings(config: Config): Promise<string[]> {
  const v = config.voice;
  const needs = sttNeeds(v);
  if (!needs.fallback.length) return [];
  const out: string[] = [];
  if (!needs.required.length) {
    try {
      await run(v.whisperBin, ['--help']);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') out.push(`Rückfall nicht verfügbar: ${v.whisperBin} fehlt (${whisperInstallHint()})`);
    }
  }
  for (const m of needs.fallback) if (!existsSync(path.resolve(v.dir, m))) out.push(`Rückfall nicht verfügbar: Whisper-Modell fehlt (${m})`);
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

/**
 * Where an official Piper voice lives, from its file name `<lang>_<REGION>-<name>-<quality>.onnx`
 * (e.g. `de_DE-thorsten-medium.onnx` → `de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx`); null if the
 * name does not follow that scheme.
 */
export function piperVoiceUrl(voice: string, base = PIPER_VOICES_BASE): string | null {
  const file = path.basename(voice);
  const m = /^(([a-z]{2,3})_[A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)\.onnx$/.exec(file);
  if (!m) return null;
  const [, locale, lang, name, quality] = m;
  return `${base}${lang}/${locale}/${name}/${quality}/${file}`;
}

/** Downloads the configured Piper voice (`.onnx` + `.onnx.json`) unless it is there already. */
export async function setupPiperVoice(v: Config['voice'], base = PIPER_VOICES_BASE): Promise<void> {
  const voice = path.resolve(v.dir, v.piperVoice);
  const url = piperVoiceUrl(v.piperVoice, base);
  // An own voice outside the scheme is used as it is (as before); an official one gets its missing part.
  if (existsSync(voice) && (!url || existsSync(`${voice}.json`))) return;
  if (!url) {
    throw new Error(
      `Piper-Stimme ${voice} fehlt. Der Name passt nicht zum Schema <sprache>_<REGION>-<name>-<qualität>.onnx (z.B. models/de_DE-thorsten-medium.onnx); eigene Stimmen bitte samt .onnx.json selbst ablegen.`,
    );
  }
  try {
    await download(url, voice);
    await download(`${url}.json`, `${voice}.json`);
  } catch (e) {
    throw new Error(`Piper-Stimme ${path.basename(voice)} konnte nicht geladen werden (${(e as Error).message.replace(/^Download \S+: /, '')}). Name prüfen: https://huggingface.co/rhasspy/piper-voices`);
  }
}

/** `qbhost voice-setup`: installs whisper.cpp (Homebrew on macOS), downloads models, creates the Piper venv. */
export async function setupVoice(config: Config): Promise<void> {
  const v = config.voice;
  mkdirSync(v.dir, { recursive: true });
  const needs = sttNeeds(v);
  // Local models: those that hear on their own and those that stand in for the cloud.
  const models = [...needs.required, ...needs.fallback];
  if (needs.cloud && !process.env[v.deepgram.keyEnv]?.trim()) log.warn(`Deepgram-Schlüssel fehlt: ${v.deepgram.keyEnv} in .env setzen – bis dahin startet die Sprachsteuerung nicht.`);

  if (models.length) {
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
  }
  for (const m of models) {
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
    await setupPiperVoice(v);
  }

  // Self-test of the local engines only: no cloud call (no cost, works without a key).
  log.info('Selbsttest: Sprechen → Erkennen …');
  const tts = createEngine(v);
  const local = models.map((m) => [m === v.whisperModel ? 'Hauptmodell' : 'schnelles Modell', m === v.whisperModel ? new WhisperServerStt(v) : new WhisperServerStt(v, { model: m, port: fastWhisperPort(v) })] as const);
  try {
    const pcm = await tts.synth('Willkommen zum Tafelquiz. Anna, du bist dran.');
    for (const [label, stt] of local) {
      const text = await stt.transcribe(pcm);
      log.info(`Erkannt (${label}): „${text}“`);
      if (!/tafel\s?quiz/i.test(text)) log.warn(`Die Erkennung (${label}) klingt ungewöhnlich – Modell/Stimme prüfen.`);
    }
  } finally {
    await Promise.all([tts.close(), ...local.map(([, s]) => s.close())]);
  }
  log.info('Sprachsteuerung ist eingerichtet ✓');
}

