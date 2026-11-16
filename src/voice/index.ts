import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { FIXED_LINES } from './narration.ts';
import { createSttRoutes, fastWhisperPort, sttNeeds, type SttRouteDeps } from './providers.ts';
import { isAnswersOnly, WhisperServerStt, type LocalStt, type SpeechToText } from './stt.ts';
import { PARAKEET_FILES, PARAKEET_MODEL, parakeetModelReady, ParakeetStt, readIntoPageCache, SHERPA_ONNX_VERSION } from './stt-sherpa.ts';
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
  /** `voice.parakeet.preload: cache` – the background read of the model files (bytes read); undefined = none. */
  preloading?: Promise<number>;
}

export interface VoiceKitDeps extends SttRouteDeps {
  tts?: TextToSpeech;
  /** Before the background read starts (default 2 s: the bot logs in first). */
  preloadDelayMs?: number;
}

/**
 * Shared STT/TTS for all voice sessions; servers start lazily on first use (or in `warmup`). The
 * recognisers per attention come from `createSttRoutes` – with `voice.stt: whisper` exactly the local
 * models as before. Throws if a cloud engine is configured without its key (`voiceProblems` says so first).
 */
export function createVoiceKit(config: Config, deps: VoiceKitDeps = {}): VoiceKitImpl {
  const v = config.voice;
  const routes = createSttRoutes(v, deps);
  // Parakeet next to whisper (answers-only) never holds up joining: it starts in the background, whisper
  // hears the answers until it is ready. Alone (no whisper) it is waited for, as any engine.
  const background = (s: SpeechToText) => isAnswersOnly(s);
  const startLater = (s: SpeechToText) =>
    void Promise.resolve(s.warmup?.()).catch((e) => log.warn(`Parakeet startet nicht: ${(e as Error).message.split('\n')[0]} – whisper hört die Antworten`));
  const stop = new AbortController();
  const parakeets = routes.all.filter((s) => s.engine?.startsWith('parakeet:'));
  let preloading: Promise<number> | undefined;
  if (v.localStt === 'parakeet' && parakeets.length) {
    if (v.parakeet.preload === 'start') parakeets.forEach(startLater);
    else if (v.parakeet.preload === 'cache') preloading = preloadParakeet(v, stop.signal, deps.preloadDelayMs ?? 2000);
  }
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
      const fallbacks = routes.warmFallback.filter((s) => !background(s)).map((s) =>
        Promise.resolve(s.warmup?.()).catch((e) => log.warn(`Rückfall nicht verfügbar (${s.engine ?? 'lokal'}): ${(e as Error).message.split('\n')[0]} – bei Cloud-Ausfall gibt es nur den Hinweis im Chat`)),
      );
      // Parakeet in the mixed mode starts now, right with the greeting, but nobody waits for it.
      for (const s of [...routes.warm, ...routes.warmFallback]) if (background(s)) startLater(s);
      await Promise.all([...routes.warm.filter((s) => !background(s)).map((s) => s.warmup?.()), tts.synth('Hallo.'), ...fallbacks]);
      // Missing short fixed lines are made in the background, only while the voice path is quiet.
      if (disk && !warming) {
        warming = true;
        void disk.warm(warmLines(v), { quietMs: WARM_QUIET_MS });
      }
    },
    close: async () => {
      stop.abort();
      await Promise.all([...routes.all.map((s) => s.close()), tts.close(), preloading?.catch(() => 0)]);
    },
    preloading,
  };
}

/**
 * `parakeet.preload: cache`: after `delayMs`, reads the model files once in the background (throttled), so
 * the first worker start after a server restart loads from the page cache, not the disk. Never throws.
 */
async function preloadParakeet(v: Config['voice'], signal: AbortSignal, delayMs: number): Promise<number> {
  const dir = path.resolve(v.dir, v.parakeet.model);
  if (!parakeetModelReady(dir)) return 0;
  try {
    if (delayMs) await new Promise<void>((r) => {
      const t = setTimeout(r, delayMs);
      t.unref?.();
      signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
    if (signal.aborted) return 0;
    const t0 = Date.now();
    const bytes = await readIntoPageCache(PARAKEET_FILES.map((f) => path.join(dir, f)), { signal });
    if (!signal.aborted) log.info(`Parakeet-Modell vorgewärmt (${Math.round(bytes / 1e6)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s, Seitencache)`);
    return bytes;
  } catch (e) {
    log.debug(`Parakeet vorwärmen: ${(e as Error).message}`);
    return 0;
  }
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
  if (needs.parakeet === 'required') out.push(...(await parakeetProblems(v)));
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
  const out: string[] = [];
  // Parakeet that only stands in for the cloud: the same checks as `voiceProblems`, as warnings.
  if (needs.parakeet === 'fallback') out.push(...(await parakeetProblems(v)).map((p) => `Rückfall nicht verfügbar: ${p}`));
  if (!needs.fallback.length) return out;
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

/** What Parakeet is missing: the Python environment, the sherpa-onnx package, the complete model folder. */
export async function parakeetProblems(v: Config['voice']): Promise<string[]> {
  const py = path.resolve(v.dir, 'venv/bin/python');
  const model = path.resolve(v.dir, v.parakeet.model);
  const out: string[] = [];
  if (!existsSync(py)) out.push(`Python-Umgebung für Parakeet fehlt (${path.join(v.dir, 'venv')})`);
  else if (!(await sherpaInstalled(py))) out.push(`Python-Paket sherpa-onnx fehlt (für Parakeet, Version ${SHERPA_ONNX_VERSION})`);
  if (!parakeetModelReady(model)) out.push(`Parakeet-Modell fehlt oder ist unvollständig (${v.parakeet.model})`);
  return out;
}

/** Is sherpa-onnx importable in this interpreter, in the pinned version? */
async function sherpaInstalled(py: string): Promise<boolean> {
  try {
    const { stdout } = await run(py, ['-c', 'import sherpa_onnx; print(sherpa_onnx.__version__)'], { timeout: 30_000 });
    return stdout.trim() === SHERPA_ONNX_VERSION;
  } catch {
    return false;
  }
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/**
 * Members of a tar listing (`tar -tvf`) that may be unpacked: plain files and folders below `root/`, no
 * absolute path, no `..`, no links or devices. Throws on anything else – the archive is not used at all then.
 */
export function safeTarMembers(listing: string, names: string[], root: string): string[] {
  const out: string[] = [];
  for (const line of listing.split('\n').filter((l) => l.trim())) {
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`Archiv enthält einen Link oder Sondereintrag: ${line.slice(0, 120)}`);
  }
  for (const name of names.filter((n) => n.trim())) {
    const n = name.replace(/\/$/, '');
    if (path.isAbsolute(n) || n.split(/[\\/]/).includes('..') || (n !== root && !n.startsWith(`${root}/`))) throw new Error(`Archiv enthält einen Pfad außerhalb von ${root}/: ${n.slice(0, 120)}`);
    out.push(n);
  }
  return out;
}

/**
 * Downloads the official Parakeet model (once), checks its SHA-256 before anything is unpacked, unpacks
 * only the model files into a temporary folder and renames that into place – an interrupted download or
 * unpack never counts as done. A wrong checksum deletes the file. An own model folder (other name) must be
 * there already.
 */
export async function setupParakeetModel(v: Config['voice'], src: { url: string; sha256: string; name: string } = PARAKEET_MODEL): Promise<void> {
  const target = path.resolve(v.dir, v.parakeet.model);
  if (parakeetModelReady(target)) return;
  if (path.basename(target) !== src.name) throw new Error(`Eigenes Parakeet-Modell ${target} fehlt oder ist unvollständig (${PARAKEET_FILES.join(', ')}).`);
  const parent = path.dirname(target);
  const archive = path.join(parent, `${src.name}.tar.bz2`);
  const tmp = path.join(parent, `.${src.name}.unpack`);
  mkdirSync(parent, { recursive: true });
  await download(src.url, archive);
  const sum = await sha256File(archive);
  if (sum !== src.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`Parakeet-Modell: Prüfsumme stimmt nicht (erwartet ${src.sha256}, erhalten ${sum}) – Datei gelöscht, nichts entpackt.`);
  }
  const wanted = PARAKEET_FILES.map((f) => `${src.name}/${f}`);
  const { stdout: names } = await run('tar', ['-tjf', archive], { maxBuffer: 16 * 1024 * 1024 });
  const { stdout: listing } = await run('tar', ['-tvjf', archive], { maxBuffer: 16 * 1024 * 1024 });
  const members = safeTarMembers(listing, names.split('\n'), src.name);
  const missing = wanted.filter((w) => !members.includes(w));
  if (missing.length) throw new Error(`Parakeet-Archiv unvollständig: ${missing.join(', ')} fehlt`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    log.info(`Entpacke ${src.name} …`);
    // Only the named model files: nothing else of the archive lands on disk.
    await run('tar', ['-xjf', archive, '-C', tmp, ...wanted], { maxBuffer: 16 * 1024 * 1024 });
    if (!parakeetModelReady(path.join(tmp, src.name))) throw new Error('Parakeet-Modell nach dem Entpacken unvollständig');
    rmSync(target, { recursive: true, force: true });
    renameSync(path.join(tmp, src.name), target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  rmSync(archive, { force: true }); // ~490 MB – the unpacked folder is all that is needed
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

  const parakeet = !!needs.parakeet;
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

  if (v.tts === 'piper' || parakeet) {
    const py = path.resolve(v.dir, 'venv/bin/python');
    if (!existsSync(py)) {
      log.info(`Erstelle Python-Umgebung für ${[v.tts === 'piper' && 'Piper', parakeet && 'Parakeet'].filter(Boolean).join(' und ')} …`);
      await run('python3', ['-m', 'venv', path.resolve(v.dir, 'venv')]).catch((e) => {
        throw new Error(`Python-venv nicht möglich (${(e as Error).message.split('\n')[0]}). Debian/Ubuntu: sudo apt install python3-venv`);
      });
    }
  }
  if (v.tts === 'piper') {
    const py = path.resolve(v.dir, 'venv/bin/python');
    log.info(`Installiere ${PIPER_VERSION} …`);
    await run(py, ['-m', 'pip', 'install', '-q', PIPER_VERSION], { maxBuffer: 64 * 1024 * 1024 });
    await setupPiperVoice(v);
  }
  if (parakeet) {
    const py = path.resolve(v.dir, 'venv/bin/python');
    // Pre-installed in the Docker image (its venv is read-only for the container user): only install if missing.
    if (await sherpaInstalled(py)) log.info(`sherpa-onnx ${SHERPA_ONNX_VERSION} ✓`);
    else {
      log.info(`Installiere sherpa-onnx==${SHERPA_ONNX_VERSION} …`);
      await run(py, ['-m', 'pip', 'install', '-q', `sherpa-onnx==${SHERPA_ONNX_VERSION}`], { maxBuffer: 64 * 1024 * 1024 }).catch((e) => {
        throw new Error(`sherpa-onnx konnte nicht installiert werden (${(e as Error).message.split('\n')[0]})`);
      });
    }
    await setupParakeetModel(v);
  }

  // Self-test of the local engines only: no cloud call (no cost, works without a key).
  log.info('Selbsttest: Sprechen → Erkennen …');
  const tts = createEngine(v);
  const local: (readonly [string, SpeechToText])[] = [
    ...models.map((m) => [m === v.whisperModel ? 'Hauptmodell' : 'schnelles Modell', m === v.whisperModel ? new WhisperServerStt(v) : new WhisperServerStt(v, { model: m, port: fastWhisperPort(v) })] as const),
    ...(parakeet ? [['Parakeet', new ParakeetStt(v)] as const] : []),
  ];
  try {
    const pcm = await tts.synth('Willkommen zum Tafelquiz. Anna, du bist dran.');
    for (const [label, stt] of local) {
      const text = await stt.transcribe(pcm);
      log.info(`Erkannt (${label}): „${text}“`);
      // Parakeet has no prompt and may write the rare word "Tafelquiz" otherwise ("Tafelquets"): the greeting counts.
      const ok = label === 'Parakeet' ? /tafel|willkommen/i.test(text) : /tafel\s?quiz/i.test(text);
      if (!ok) log.warn(`Die Erkennung (${label}) klingt ungewöhnlich – Modell/Stimme prüfen.`);
    }
  } finally {
    await Promise.all([tts.close(), ...local.map(([, s]) => s.close())]);
  }
  log.info('Sprachsteuerung ist eingerichtet ✓');
}

