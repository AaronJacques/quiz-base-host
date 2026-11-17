import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, loadConfig, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { FakeTafelquizPage } from './fake-page.ts';
import type { Pcm } from '../src/voice/audio.ts';
import { createVoiceKit, parakeetProblems, safeTarMembers, setupParakeetModel, voiceProblems, voiceWarnings } from '../src/voice/index.ts';
import { createSttRoutes, FallbackStt, sttNeeds, sttPlan, type SttRouteDeps } from '../src/voice/providers.ts';
import { normalizeParakeet, PARAKEET_FILES, PARAKEET_MODEL, parakeetThreads, ParakeetStt, readIntoPageCache, SHERPA_ONNX_VERSION, SttTimeout } from '../src/voice/stt-sherpa.ts';
import { cleanTranscript, isCloud, SttNotReady, WhisperServerStt, type LocalStt, type SpeechToText } from '../src/voice/stt.ts';
import { CloudError } from '../src/voice/http.ts';
import type { Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import type { TextToSpeech } from '../src/voice/tts.ts';
import { VoiceHost, type Attention } from '../src/voice/voice-host.ts';

setLogLevel('error');

const FAKE = fileURLToPath(new URL('./fixtures/fake-sherpa-worker.mjs', import.meta.url));
const WORKER_PY = fileURLToPath(new URL('../src/voice/sherpa_worker.py', import.meta.url));
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p));
const pcm = (samples: number, rate = 16000): Pcm => ({ rate, channels: 1, samples: new Int16Array(samples) });
const voiceCfg = (over: Record<string, unknown> = {}): Config['voice'] => ConfigSchema.parse({ voice: over }).voice;

const open: ParakeetStt[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  setLogLevel('error');
});

/** ParakeetStt on the fake worker; `env` steers it (see the fixture). */
function fake(env: Record<string, string> = {}, o: { deadlineMs?: number; startTimeoutMs?: number } = {}) {
  const state = tmp('qbsherpa-');
  const stt = new ParakeetStt(voiceCfg(), {
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_STATE: state, ...env },
    deadlineMs: () => o.deadlineMs ?? 5000,
    startTimeoutMs: o.startTimeoutMs ?? 5000,
  });
  open.push(stt);
  const pids = () => (existsSync(path.join(state, 'starts')) ? readFileSync(path.join(state, 'starts'), 'utf8').split('\n').filter(Boolean).map(Number) : []);
  const overlaps = () => existsSync(path.join(state, 'overlap'));
  return { stt, state, pids, overlaps };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ParakeetStt (fake worker, no model)', () => {
  it('recognises: 16 kHz mono s16le to the worker, the text back through cleanTranscript; a local engine without prompt', async () => {
    const { stt, pids } = fake();
    expect(stt.engine).toBe('parakeet:tdt-0.6b-v3-int8');
    expect(isCloud(stt)).toBe(false);
    const local: LocalStt = stt; // compiles: never a cloud engine
    expect(await local.transcribe(pcm(16000), 'Geschichte, Sport')).toBe('Text 16000');
    // 48 kHz stereo (Discord) arrives resampled: 1 s → 16 000 samples.
    expect(await stt.transcribe({ rate: 48000, channels: 2, samples: new Int16Array(96000) })).toBe('Text 16000');
    expect(pids()).toHaveLength(1);
    expect(stt.coldStartMs).toBeGreaterThanOrEqual(0);
    expect(stt.loadMs).toBe(7);
    expect(await stt.stats()).toBe(123);
  });

  it('drops hallucinated or empty output like whisper does', async () => {
    const { stt } = fake({ FAKE_TEXT: 'Untertitel im Auftrag des ZDF, 2021' });
    expect(await stt.transcribe(pcm(800))).toBe('');
  });

  it('several utterances: one at a time, answers in order', async () => {
    const { stt, overlaps, pids } = fake({ FAKE_DELAY: '30' });
    const out = await Promise.all([1600, 3200, 4800, 6400].map((n) => stt.transcribe(pcm(n))));
    expect(out).toEqual(['Text 1600', 'Text 3200', 'Text 4800', 'Text 6400']);
    expect(overlaps()).toBe(false); // the worker never got a second job while busy
    expect(pids()).toHaveLength(1);
  });

  it('deadline: a hung worker is killed, the utterance goes to a fresh one – whose model load does not count against the deadline', async () => {
    // Deadline 150 ms, loading 400 ms: the retry would fail at once if the deadline included the start.
    const { stt, pids } = fake({ FAKE_HANG: '1', FAKE_READY_MS: '400' }, { deadlineMs: 150 });
    const first = stt.transcribe(pcm(1600));
    const second = stt.transcribe(pcm(3200)); // waits behind it, never fails because of it
    expect(await first).toBe('Text 1600');
    expect(await second).toBe('Text 3200');
    const [hung, fresh] = pids();
    expect(pids()).toHaveLength(2);
    await until(() => !alive(hung!));
    expect(alive(fresh!)).toBe(true);
  });

  it('two failures of the same utterance drop it (SttTimeout, no content in the message); the next one is heard', async () => {
    const { stt, pids } = fake({ FAKE_HANG: '2', FAKE_TEXT: 'Meine Antwort ist Paris' }, { deadlineMs: 100 });
    const dropped = stt.transcribe(pcm(1600));
    const next = stt.transcribe(pcm(1600));
    const err = await dropped.catch((e) => e);
    expect(err).toBeInstanceOf(SttTimeout);
    expect(String(err.message)).not.toContain('Paris');
    expect(await next).toBe('Meine Antwort ist Paris');
    expect(pids()).toHaveLength(3);
  });

  it('a crashing worker: the utterance is retried once on a new worker; crashing twice rejects it', async () => {
    const once = fake({ FAKE_CRASH: '1' });
    expect(await once.stt.transcribe(pcm(1600))).toBe('Text 1600');
    expect(once.pids()).toHaveLength(2);
    const twice = fake({ FAKE_CRASH: '2' });
    await expect(twice.stt.transcribe(pcm(1600))).rejects.toBeInstanceOf(SttTimeout);
    expect(await twice.stt.transcribe(pcm(1600))).toBe('Text 1600');
  });

  it('a worker that cannot start rejects with its reason (no retry loop); the next call tries a new start', async () => {
    const { stt, pids } = fake({ FAKE_DIE: '1' });
    await expect(stt.transcribe(pcm(1600))).rejects.toThrow(/Parakeet beendet \(3\).*No module named sherpa_onnx/);
    expect(pids()).toHaveLength(1);
    await expect(stt.warmup()).rejects.toThrow(/sherpa_onnx/);
    expect(pids()).toHaveLength(2);
  });

  it('a worker that never gets ready fails after startTimeoutMs and is killed', async () => {
    const { stt, pids } = fake({ FAKE_NO_READY: '1' }, { startTimeoutMs: 200 });
    await expect(stt.transcribe(pcm(1600))).rejects.toThrow(/lädt nicht/);
    await until(() => !alive(pids()[0]!));
  });

  it('abort: a queued utterance is dropped at once, the one in the worker keeps its slot', async () => {
    const { stt, overlaps } = fake({ FAKE_DELAY: '100' });
    const first = stt.transcribe(pcm(1600));
    const ac = new AbortController();
    const second = stt.transcribe(pcm(3200), '', { signal: ac.signal });
    const third = stt.transcribe(pcm(4800));
    ac.abort(new Error('gave up'));
    await expect(second).rejects.toThrow('gave up');
    expect(await first).toBe('Text 1600');
    expect(await third).toBe('Text 4800');
    expect(overlaps()).toBe(false);
  });

  it('close(): every open utterance is rejected, no worker process is left, later calls fail', async () => {
    const { stt, pids } = fake({ FAKE_DELAY: '5000' });
    await stt.warmup();
    const a = expect(stt.transcribe(pcm(1600))).rejects.toThrow('Parakeet beendet');
    const b = expect(stt.transcribe(pcm(1600))).rejects.toThrow('Parakeet beendet');
    await stt.close();
    await a;
    await b;
    expect(alive(pids()[0]!)).toBe(false);
    await expect(stt.transcribe(pcm(1600))).rejects.toThrow('Parakeet beendet');
    await stt.close(); // twice is fine
  });

  it('without venv or model: a clear German message, nothing is started', async () => {
    const dir = tmp('qbsherpa-dir-');
    const stt = new ParakeetStt(voiceCfg({ dir }));
    open.push(stt);
    await expect(stt.transcribe(pcm(1600))).rejects.toThrow(/Python-Umgebung für Parakeet fehlt .*voice-setup/);
    mkdirSync(path.join(dir, 'venv/bin'), { recursive: true });
    writeFileSync(path.join(dir, 'venv/bin/python'), '');
    await expect(stt.transcribe(pcm(1600))).rejects.toThrow(/Parakeet-Modell fehlt oder ist unvollständig .*voice-setup/);
    expect(stt.starts).toBe(0);
  });

  it('threads: 0 = cores, at most 4, at least 1', () => {
    expect(parakeetThreads(0, 1)).toBe(1);
    expect(parakeetThreads(0, 10)).toBe(4);
    expect(parakeetThreads(2, 10)).toBe(2);
  });

  it('normalisation: thousands separators only; no guessing of English words', () => {
    expect(normalizeParakeet('Geschichte 1.000')).toBe('Geschichte 1000');
    expect(normalizeParakeet('Meine Antwort ist 1989.')).toBe('Meine Antwort ist 1989.');
    expect(normalizeParakeet('Yeah.')).toBe('Yeah.');
    expect(normalizeParakeet('Nine.')).toBe('Nine.');
  });
});

describe('cleanTranscript: only a whole utterance is a hallucination', () => {
  it('keeps names and words that contain "ard", drops the subtitle credits', () => {
    for (const t of ['Meine Antwort ist Leonardo da Vinci.', 'Richard Wagner', 'Bernhard', 'Eduard', 'Standard', 'Milliarde', 'Swrl', 'Lombard', 'SWR3']) expect(cleanTranscript(t), t).toBe(t);
    for (const t of ['Untertitel im Auftrag des ZDF, 2021', 'Untertitel im Auftrag des ZDF für funk, 2017', 'Copyright WDR 2021', 'SWR 2020', 'ZDF, 2020', 'Untertitel der Amara.org-Community', 'www.zdf.de', 'Vielen Dank fürs Zuschauen.']) {
      expect(cleanTranscript(t), t).toBe('');
    }
  });

  it('F2: an utterance with the answer keyword is never dropped, whatever the answer (reviewer examples)', () => {
    for (const t of ['Meine Antwort ist die ARD.', 'Meine Antwort ist das ZDF', 'Meine Antwort ist der SWR', 'Meine Antwort ist Copyright', 'Meine Antwort ist WWW', 'Meine Antwort ist Danke', 'Meine Antwort ist Musik', 'Meine Antwort ist Untertitel', 'Musik für 200']) {
      expect(cleanTranscript(t), t).toBe(t);
    }
    // Alone (no answer expected without the keyword) they stay what Whisper invents on silence.
    for (const t of ['Danke', 'Musik', 'Tschüss', 'Untertitel', 'WWW', 'ARD']) expect(cleanTranscript(t), t).toBe('');
  });
});

// ─────────────── routing ───────────────

const fakeStt = (engine: string): LocalStt => ({ engine, transcribe: async () => engine, close: async () => {} });

function built(v: Config['voice']) {
  const made: { model: string; port: number; engine: string }[] = [];
  const deps: SttRouteDeps = {
    env: { DEEPGRAM_API_KEY: 'k' },
    local: (o) => (made.push(o), fakeStt(`${o.engine}:${path.basename(o.model)}`)),
    cloud: () => ({ engine: 'deepgram:nova-3', cloud: true, transcribe: async () => 'cloud', close: async () => {} }),
  };
  return { routes: createSttRoutes(v, deps), made };
}

describe('localStt / parakeetFor: engine choice and routes', () => {
  it('defaults = today: whisper only, parakeetFor only answers, no Parakeet anywhere', () => {
    const v = voiceCfg();
    expect(v.localStt).toBe('whisper');
    expect(v.parakeetFor).toEqual(['answer']);
    expect(v.parakeet).toEqual({ model: 'models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', threads: 0, deadlineMs: 8000, deadlinePerSecMs: 500, startTimeoutMs: 150000, preload: 'cache' });
    expect(sttNeeds(v)).toEqual({ required: [v.whisperModel], fallback: [], cloud: false });
    expect(sttNeeds(v).parakeet).toBeUndefined();
    const { made } = built(voiceCfg({ whisperFastModel: 'models/fast.bin' }));
    expect(made.map((m) => m.engine)).toEqual(['whisper', 'whisper']);
    // parakeetFor alone changes nothing while localStt is whisper.
    expect(built(voiceCfg({ parakeetFor: ['answer', 'confirm', 'full', 'wake'] })).made.map((m) => m.engine)).toEqual(['whisper']);
  });

  it('hybrid (default parakeetFor): answers Parakeet, the rest the fast whisper model – exactly two engines, the main whisper model never built', () => {
    const v = voiceCfg({ localStt: 'parakeet', whisperFastModel: 'models/fast.bin' });
    const { routes, made } = built(v);
    expect(made.map((m) => `${m.engine}:${m.model}`)).toEqual(['parakeet:models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'whisper:models/fast.bin']);
    expect(routes.stt.engine).toMatch(/^parakeet:/);
    expect(routes.fastStt?.engine).toBe('whisper:fast.bin');
    expect(routes.confirmStt).toBeUndefined(); // = fastStt
    expect(routes.wakeStt).toBeUndefined();
    expect(routes.all).toHaveLength(2);
    expect(sttNeeds(v)).toEqual({ required: ['models/fast.bin'], fallback: [], cloud: false, parakeet: 'required' });
    expect(sttPlan(v).answer.local).toBe('parakeet');
  });

  it('hybrid without whisperFastModel: the rest the main whisper model', () => {
    const v = voiceCfg({ localStt: 'parakeet' });
    const { routes, made } = built(v);
    expect(made.map((m) => m.engine)).toEqual(['parakeet', 'whisper']);
    expect(routes.fastStt?.engine).toBe(`whisper:${path.basename(v.whisperModel)}`);
    expect(sttNeeds(v)).toEqual({ required: [v.whisperModel], fallback: [], cloud: false, parakeet: 'required' });
  });

  it('parakeetFor = all four: one Parakeet engine for everything, no whisper at all (also with whisperFastModel set)', () => {
    const v = voiceCfg({ localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'], whisperFastModel: 'models/fast.bin', whisperAudioCtx: 512 });
    const { routes, made } = built(v);
    expect(made.map((m) => m.engine)).toEqual(['parakeet']);
    expect(routes.fastStt).toBeUndefined();
    expect(routes.all).toEqual([routes.stt]);
    expect(sttNeeds(v)).toEqual({ required: [], fallback: [], cloud: false, parakeet: 'required' });
    expect(v.maxSpeechSec).toBe(15); // no whisper window to fit into
    expect(voiceCfg({ localStt: 'parakeet', whisperAudioCtx: 512 }).maxSpeechSec).toBe(10); // whisper still hears something
  });

  it('F10: parakeetFor is ["answer"] or all four phases – any other set is a clear config error', () => {
    for (const ok of [['answer'], ['answer', 'confirm', 'full', 'wake'], ['wake', 'full', 'confirm', 'answer']]) expect(ConfigSchema.safeParse({ voice: { parakeetFor: ok } }).success, ok.join('+')).toBe(true);
    for (const bad of [['answer', 'wake'], ['full'], ['answer', 'confirm'], ['answer', 'full', 'wake'], [], ['answer', 'answer'], ['answer', 'confirm', 'full', 'wake', 'wake']]) {
      const r = ConfigSchema.safeParse({ voice: { localStt: 'parakeet', parakeetFor: bad } });
      expect(r.success, bad.join('+')).toBe(false);
      expect(r.error!.issues[0]!.message).toContain('nur ["answer"]');
      expect(r.error!.issues[0]!.path).toEqual(['voice', 'parakeetFor']);
    }
    const dir = tmp('qbsherpa-cfg-');
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ voice: { localStt: 'parakeet', parakeetFor: ['answer', 'full'] } }));
    expect(() => loadConfig(path.join(dir, 'c.json'))).toThrow(/Konfiguration ungültig .*voice\.parakeetFor: nur \["answer"\]/);
  });

  it('as cloud fallback: Deepgram hears answers with Parakeet behind it; local routes and localStt follow localStt', () => {
    const v = voiceCfg({ stt: 'deepgram', localStt: 'parakeet', whisperFastModel: 'models/fast.bin' });
    const { routes, made } = built(v);
    expect(made.map((m) => m.engine)).toEqual(['parakeet', 'whisper']);
    expect((routes.stt as unknown as { fallback: SpeechToText }).fallback.engine).toMatch(/^parakeet:/);
    expect(routes.localStt?.engine).toMatch(/^parakeet:/);
    expect(routes.localFastStt?.engine).toBe('whisper:fast.bin');
    expect(routes.wakeStt?.engine).toBe('whisper:fast.bin'); // wake stays local
    expect(isCloud(routes.wakeStt!)).toBe(false);
    expect(sttNeeds(v)).toEqual({ required: ['models/fast.bin'], fallback: [], cloud: true, parakeet: 'fallback' });
    // All on Parakeet, all phases in the cloud but wake: Parakeet is required (wake hears on its own).
    const all = voiceCfg({ stt: 'deepgram', localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'] });
    expect(sttNeeds(all)).toEqual({ required: [], fallback: [], cloud: true, parakeet: 'required' });
    expect(built(all).made.map((m) => m.engine)).toEqual(['parakeet']);
    expect(built(all).routes.localFastStt).toBeNull();
  });
});

// ─────────────── kit: real engines, one process each ───────────────

/** A voice dir whose `venv/bin/python` runs the fake worker, a complete model folder, and a whisper-server that logs its starts. */
function kitDir() {
  const dir = tmp('qbsherpa-kit-');
  const state = tmp('qbsherpa-kitstate-');
  mkdirSync(path.join(dir, 'venv/bin'), { recursive: true });
  const py = path.join(dir, 'venv/bin/python');
  writeFileSync(py, `#!/bin/sh\nif [ "$1" = "-c" ]; then echo ${SHERPA_ONNX_VERSION}; exit 0; fi\nshift\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(py, 0o755);
  const model = path.join(dir, 'models', PARAKEET_MODEL.name);
  mkdirSync(model, { recursive: true });
  for (const f of PARAKEET_FILES) writeFileSync(path.join(model, f), 'x');
  mkdirSync(path.join(dir, 'models'), { recursive: true });
  for (const f of ['main.bin', 'fast.bin']) writeFileSync(path.join(dir, 'models', f), 'x');
  const whisper = path.join(dir, 'whisper-server');
  writeFileSync(whisper, `#!/bin/sh\necho "$@" >> "${state}/whisper"\nexit 1\n`);
  chmodSync(whisper, 0o755);
  return { dir, state, whisper, whisperStarts: () => (existsSync(path.join(state, 'whisper')) ? readFileSync(path.join(state, 'whisper'), 'utf8').split('\n').filter(Boolean) : []) };
}
const silentTts: TextToSpeech = { synth: async () => pcm(160), close: async () => {} };

describe('createVoiceKit with Parakeet: the real engines, counted processes', () => {
  it('parakeetFor = all: warm-up starts exactly one recogniser (the sherpa worker), never whisper-server', async () => {
    const k = kitDir();
    const prev = process.env.FAKE_STATE;
    process.env.FAKE_STATE = k.state;
    try {
      const config = ConfigSchema.parse({ voice: { dir: k.dir, tts: 'say', whisperBin: k.whisper, localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'], whisperFastModel: 'models/fast.bin' } });
      const kit = createVoiceKit(config, { tts: silentTts });
      await kit.warmup();
      expect(kit.stt).toBeInstanceOf(ParakeetStt);
      expect(kit.fastStt).toBeUndefined();
      expect(await kit.stt.transcribe(pcm(1600))).toBe('Text 1600');
      const starts = readFileSync(path.join(k.state, 'starts'), 'utf8').split('\n').filter(Boolean);
      expect(starts).toHaveLength(1);
      expect(k.whisperStarts()).toEqual([]);
      await kit.close();
      expect(alive(Number(starts[0]))).toBe(false);
      expect(await voiceProblems(config)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.FAKE_STATE;
      else process.env.FAKE_STATE = prev;
    }
  });

  it('hybrid: exactly two recognisers – the sherpa worker and one whisper-server (fast model), the main whisper model is never started', async () => {
    const k = kitDir();
    const prev = process.env.FAKE_STATE;
    process.env.FAKE_STATE = k.state;
    try {
      const config = ConfigSchema.parse({ voice: { dir: k.dir, tts: 'say', whisperBin: k.whisper, whisperModel: 'models/main.bin', whisperFastModel: 'models/fast.bin', whisperPort: 18980, localStt: 'parakeet' } });
      const kit = createVoiceKit(config, { tts: silentTts });
      expect(kit.stt).toBeInstanceOf(ParakeetStt);
      expect(kit.fastStt).toBeInstanceOf(WhisperServerStt);
      await kit.warmup().catch(() => {}); // the fake whisper-server exits at once
      expect(readFileSync(path.join(k.state, 'starts'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(k.whisperStarts()).toHaveLength(1);
      expect(k.whisperStarts()[0]).toContain('fast.bin');
      expect(k.whisperStarts()[0]).not.toContain('main.bin');
      await kit.close();
    } finally {
      if (prev === undefined) delete process.env.FAKE_STATE;
      else process.env.FAKE_STATE = prev;
    }
  });

  it('localStt whisper never starts a sherpa worker, whatever parakeetFor says', () => {
    const k = kitDir();
    const kit = createVoiceKit(ConfigSchema.parse({ voice: { dir: k.dir, tts: 'say', parakeetFor: ['answer', 'confirm', 'full', 'wake'], whisperFastModel: 'models/fast.bin' } }), { tts: silentTts });
    for (const s of [kit.stt, kit.fastStt]) expect(s).toBeInstanceOf(WhisperServerStt);
    expect(existsSync(path.join(k.state, 'starts'))).toBe(false);
  });
});

// ─────────────── voiceProblems / setup ───────────────

describe('voiceProblems and setup for Parakeet', () => {
  const cfg = (voice: Record<string, unknown>) => ConfigSchema.parse({ voice: { tts: 'say', ...voice } });

  it('missing venv, package or model: clear German messages; whisper-server is only checked where whisper hears', async () => {
    const dir = tmp('qbsherpa-p-');
    const all = { dir, whisperBin: '/nope/whisper-server', localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'] };
    expect(await voiceProblems(cfg(all))).toEqual([
      `Python-Umgebung für Parakeet fehlt (${path.join(dir, 'venv')})`,
      'Parakeet-Modell fehlt oder ist unvollständig (models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8)',
    ]);
    mkdirSync(path.join(dir, 'venv/bin'), { recursive: true });
    writeFileSync(path.join(dir, 'venv/bin/python'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(dir, 'venv/bin/python'), 0o755);
    expect((await voiceProblems(cfg(all)))[0]).toBe(`Python-Paket sherpa-onnx fehlt (für Parakeet, Version ${SHERPA_ONNX_VERSION})`);
    writeFileSync(path.join(dir, 'venv/bin/python'), `#!/bin/sh\necho ${SHERPA_ONNX_VERSION}\n`);
    const model = path.join(dir, 'models', PARAKEET_MODEL.name);
    mkdirSync(model, { recursive: true });
    for (const f of PARAKEET_FILES.slice(0, 3)) writeFileSync(path.join(model, f), 'x'); // tokens.txt missing: not ready
    expect(await voiceProblems(cfg(all))).toEqual(['Parakeet-Modell fehlt oder ist unvollständig (models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8)']);
    writeFileSync(path.join(model, 'tokens.txt'), 'x');
    expect(await voiceProblems(cfg(all))).toEqual([]);
    expect(await parakeetProblems(cfg(all).voice)).toEqual([]);
    // Hybrid: whisper hears the rest – its binary and model count again.
    expect(await voiceProblems(cfg({ ...all, parakeetFor: ['answer'] }))).toEqual([
      `/nope/whisper-server fehlt (${process.platform === 'darwin' ? 'brew install whisper.cpp' : 'whisper.cpp bauen (cmake --build … --target whisper-server) oder das Docker-Image nutzen, siehe docs/INSTALL.md'})`,
      'Whisper-Modell fehlt (models/ggml-large-v3-turbo-q5_0.bin)',
    ]);
  });

  it('default config: no Parakeet check at all (no Python call, same messages as before)', async () => {
    const dir = tmp('qbsherpa-d-');
    const problems = await voiceProblems(cfg({ dir, whisperBin: '/nope/whisper-server' }));
    expect(problems.join(' ')).not.toMatch(/Parakeet|sherpa/);
  });

  it('Parakeet only as cloud fallback: a warning, no blocker', async () => {
    const dir = tmp('qbsherpa-w-');
    const c = cfg({ dir, stt: 'deepgram', localStt: 'parakeet', sttCloudFor: ['answer', 'confirm', 'full'], whisperFastModel: 'models/fast.bin', whisperBin: process.execPath });
    mkdirSync(path.join(dir, 'models'), { recursive: true });
    writeFileSync(path.join(dir, 'models/fast.bin'), 'x');
    expect(await voiceProblems(c, { DEEPGRAM_API_KEY: 'k' })).toEqual([]);
    expect(await voiceWarnings(c)).toEqual([
      `Rückfall nicht verfügbar: Python-Umgebung für Parakeet fehlt (${path.join(dir, 'venv')})`,
      'Rückfall nicht verfügbar: Parakeet-Modell fehlt oder ist unvollständig (models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8)',
    ]);
  });

  /** A small archive shaped like the official one (or not). */
  function archive(dir: string, name: string, files: string[], extra?: (root: string) => void): { file: string; sha256: string } {
    const src = tmp('qbsherpa-src-');
    mkdirSync(path.join(src, name), { recursive: true });
    for (const f of files) writeFileSync(path.join(src, name, f), `content of ${f}`);
    extra?.(src);
    const file = path.join(dir, 'models', `${name}.tar.bz2`);
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('tar', ['-cjf', file, '-C', src, name]);
    return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  }
  const name = PARAKEET_MODEL.name;
  const offline = (sha256: string) => ({ url: 'http://127.0.0.1:9/never-fetched', sha256, name });

  it('setup: checks the SHA-256 before unpacking, unpacks only the model files into place, deletes the archive', async () => {
    const dir = tmp('qbsherpa-s-');
    const a = archive(dir, name, [...PARAKEET_FILES, 'README.md']);
    await setupParakeetModel(voiceCfg({ dir }), offline(a.sha256));
    const target = path.join(dir, 'models', name);
    expect(readdirSync(target).sort()).toEqual([...PARAKEET_FILES].sort()); // no README, no test_wavs
    expect(existsSync(a.file)).toBe(false);
    expect(readdirSync(path.join(dir, 'models')).filter((f) => f.startsWith('.'))).toEqual([]); // no unpack leftovers
    await setupParakeetModel(voiceCfg({ dir }), offline('0'.repeat(64))); // ready: nothing to do, no download
  });

  it('setup: a wrong checksum deletes the file and unpacks nothing', async () => {
    const dir = tmp('qbsherpa-x-');
    const a = archive(dir, name, [...PARAKEET_FILES]);
    await expect(setupParakeetModel(voiceCfg({ dir }), offline('f'.repeat(64)))).rejects.toThrow(/Prüfsumme stimmt nicht .*gelöscht, nichts entpackt/);
    expect(existsSync(a.file)).toBe(false);
    expect(existsSync(path.join(dir, 'models', name))).toBe(false);
  });

  it('setup: an archive with a missing file or a link is refused, nothing lands in place', async () => {
    const dir = tmp('qbsherpa-m-');
    const a = archive(dir, name, PARAKEET_FILES.slice(0, 3));
    await expect(setupParakeetModel(voiceCfg({ dir }), offline(a.sha256))).rejects.toThrow(/unvollständig: .*tokens\.txt fehlt/);
    expect(existsSync(path.join(dir, 'models', name))).toBe(false);
    const dir2 = tmp('qbsherpa-l-');
    const b = archive(dir2, name, [...PARAKEET_FILES], (root) => execFileSync('ln', ['-s', '/etc/passwd', path.join(root, name, 'evil')]));
    await expect(setupParakeetModel(voiceCfg({ dir: dir2 }), offline(b.sha256))).rejects.toThrow(/Link oder Sondereintrag/);
    expect(existsSync(path.join(dir2, 'models', name))).toBe(false);
  });

  it('safeTarMembers: no absolute paths, no "..", nothing outside the root folder', () => {
    const ok = `-rw-r--r-- 0 u g 1 Nov 7 06:49 ${name}/tokens.txt`;
    expect(safeTarMembers(ok, [`${name}/`, `${name}/tokens.txt`], name)).toEqual([name, `${name}/tokens.txt`]);
    expect(() => safeTarMembers(ok, ['/etc/passwd'], name)).toThrow(/außerhalb/);
    expect(() => safeTarMembers(ok, [`${name}/../../x`], name)).toThrow(/außerhalb/);
    expect(() => safeTarMembers(ok, ['other/tokens.txt'], name)).toThrow(/außerhalb/);
    expect(() => safeTarMembers(`lrwxr-xr-x 0 u g 0 Nov 7 ${name}/x -> /etc`, [`${name}/x`], name)).toThrow(/Link/);
  });

  it('an own model folder (other name) is never downloaded', async () => {
    await expect(setupParakeetModel(voiceCfg({ dir: tmp('qbsherpa-o-'), parakeet: { model: 'models/mein-parakeet' } }))).rejects.toThrow(/Eigenes Parakeet-Modell/);
  });
});

// ─────────────── the Python worker itself (stub sherpa_onnx, no model) ───────────────

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

describe.skipIf(!python)('sherpa_worker.py with a stub sherpa_onnx', () => {
  it('loads once, answers JSON lines in order, reports errors and peak memory, never writes text to stderr', () => {
    const stub = tmp('qbsherpa-py-');
    writeFileSync(
      path.join(stub, 'sherpa_onnx.py'),
      [
        'class _R:',
        '    def __init__(self): self.text = ""',
        'class _S:',
        '    def __init__(self): self.result = _R()',
        '    def accept_waveform(self, rate, samples):',
        '        if rate != 16000: raise ValueError("rate")',
        '        if not samples: raise ValueError("leer")',
        '        self.result.text = "Hallo %d %.2f" % (len(samples), max(samples))',
        'class OfflineRecognizer:',
        '    @staticmethod',
        '    def from_transducer(**kw):',
        '        assert kw["model_type"] == "nemo_transducer" and kw["num_threads"] == 2, kw',
        '        assert kw["encoder"].endswith("encoder.int8.onnx")',
        '        return OfflineRecognizer()',
        '    def create_stream(self): return _S()',
        '    def decode_stream(self, s): pass',
      ].join('\n'),
    );
    const half = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) half.writeInt16LE(16384, i * 2);
    const input = [
      JSON.stringify({ id: 1, pcm: half.toString('base64') }),
      'kein json',
      JSON.stringify({ id: 2, pcm: '' }),
      JSON.stringify({ id: 3, op: 'stats' }),
      '',
    ].join('\n');
    const r = spawnSync(python!, [WORKER_PY, '/models/pk', '2'], { input, env: { ...process.env, PYTHONPATH: stub }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ ready: true });
    expect(typeof lines[0].loadMs).toBe('number');
    expect(lines[1]).toEqual({ id: 1, text: 'Hallo 1600 0.50' });
    expect(lines[2]).toEqual({ id: 2, error: 'ValueError: leer' });
    expect(lines[3].id).toBe(3);
    expect(lines[3].peakMb).toBeGreaterThan(0);
    expect(r.stderr).not.toContain('Hallo');
  });
});

describe('pinned versions', () => {
  it('the Docker image installs the same sherpa-onnx version as voice-setup', () => {
    const dockerfile = readFileSync(fileURLToPath(new URL('../deploy/Dockerfile', import.meta.url)), 'utf8');
    expect(dockerfile).toContain(`ARG SHERPA_ONNX_VERSION=${SHERPA_ONNX_VERSION}`);
    expect(dockerfile).toContain('"sherpa-onnx==${SHERPA_ONNX_VERSION}"');
    expect(PARAKEET_MODEL.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/asr-models\//);
    expect(PARAKEET_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hybrid in the voice host: "Ja" is never heard by Parakeet', () => {
  /** Utterances carry their text in the first sample (as in test/voice.test.ts). */
  class Room implements VoiceTransport {
    label = 'fake';
    private handlers: ((u: Utterance) => void)[] = [];
    constructor(private texts: Map<number, string>) {}
    async play() {}
    stop() {}
    onUtterance(h: (u: Utterance) => void) {
      this.handlers.push(h);
    }
    onClose() {}
    async close() {}
    speak(speaker: Speaker, text: string) {
      const id = 1000 + this.texts.size;
      this.texts.set(id, text);
      const samples = new Int16Array(8000).fill(4000);
      samples[0] = id;
      const now = Date.now();
      for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
    }
  }

  it('confirm ("Paris?" → "Ja", the "Ja" window of the stop question) goes to whisper; answers to Parakeet; a new answer in the confirm is heard again by Parakeet', async () => {
    const texts = new Map<number, string>();
    const used: string[] = [];
    // Parakeet turns a lone "Ja" into "Yeah." (measured) – if it ever heard the confirmation, the bot would get "Yeah.".
    const engine = (o: { engine: string; model: string }): LocalStt => ({
      engine: `${o.engine}:${path.basename(o.model)}`,
      transcribe: async (p) => {
        const t = texts.get(p.samples[0]!) ?? '';
        used.push(`${o.engine}: ${t}`);
        return o.engine === 'parakeet' && /^ja\.?$/i.test(t) ? 'Yeah.' : t;
      },
      close: async () => {},
    });
    const v = voiceCfg({ localStt: 'parakeet', whisperFastModel: 'models/fast.bin' }); // parakeetFor default: ['answer']
    const routes = createSttRoutes(v, { local: engine });
    const room = new Room(texts);
    const heard: string[] = [];
    let attention: Attention = 'full';
    new VoiceHost({
      transport: room,
      stt: routes.stt,
      fastStt: routes.fastStt,
      confirmStt: routes.confirmStt,
      wakeStt: routes.wakeStt,
      tts: silentTts,
      cfg: v,
      prompt: () => '',
      onSpeech: (_s, t) => void heard.push(t),
      attention: () => attention,
    });
    const anna: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
    const say = async (a: Attention, text: string) => {
      attention = a;
      used.length = 0;
      const n = heard.length;
      room.speak(anna, text);
      await until(() => heard.length > n, 2000);
      await new Promise((r) => setTimeout(r, 20));
      return [...used];
    };
    expect(await say('full', 'Geschichte 300')).toEqual(['whisper: Geschichte 300']);
    expect(await say('answer', 'Meine Antwort ist Paris')).toEqual(['parakeet: Meine Antwort ist Paris']);
    expect(await say('confirm', 'Ja')).toEqual(['whisper: Ja']);
    expect(heard.at(-1)).toBe('Ja');
    expect(await say('confirm', 'Nein, meine Antwort ist London')).toEqual(['whisper: Nein, meine Antwort ist London', 'parakeet: Nein, meine Antwort ist London']);
    expect(await say('wake', 'Quizmaster, stopp')).toEqual(['whisper: Quizmaster, stopp']);
    // The bot maps the asker's "Ja" window of "Soll ich das Spiel beenden?" to 'confirm' (voice-cloud-privacy.test.ts,
    // "the leader in the Ja window …"): that is the whisper route above.
    expect(heard).not.toContain('Yeah.');
  });
});

/** What the fake Parakeet makes of German short phrases (measured with the real model, speaker Reed). */
function parakeetSays(t: string): string {
  return /^ja\.?$/i.test(t) ? 'Yeah.' : t.replace(/quizmaster/i, 'This muster');
}

describe('hybrid in the bot: the leader on turn answers "Soll ich das Spiel beenden?"', () => {
  const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
  const BEN: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };

  class FakeSession implements SessionLike {
    bus = new EventBus();
    meter = new UsageMeter();
    rules: Config['game'];
    page: FakeTafelquizPage;
    private ac = new AbortController();
    constructor(
      private config: Config,
      names: string[],
    ) {
      this.page = new FakeTafelquizPage(names, [[{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }], [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine' }]]);
      this.rules = { ...config.game };
    }
    async createLobby() {
      return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
    }
    async run() {
      const judge = createJudge(this.config, this.bus, null, this.meter);
      await new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: 20 }).run(this.ac.signal);
    }
    async endGame() {
      this.ac.abort();
      await this.page.endGame();
    }
    async close() {
      this.ac.abort();
    }
  }

  class Room implements VoiceTransport {
    label = 'room';
    played: string[] = [];
    private handlers: ((u: Utterance) => void)[] = [];
    constructor(private texts: Map<number, string>) {}
    async play(p: Pcm) {
      this.played.push(this.texts.get(p.samples[0]!) ?? '?');
    }
    stop() {}
    onUtterance(h: (u: Utterance) => void) {
      this.handlers.push(h);
    }
    onClose() {}
    async close() {}
    speak(speaker: Speaker, text: string) {
      const id = 1000 + this.texts.size;
      this.texts.set(id, text);
      const samples = new Int16Array(8000).fill(4000);
      samples[0] = id;
      const now = Date.now();
      for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
    }
  }

  /** Hybrid: Parakeet hears answers (and writes a lone "Ja" as "Yeah."), whisper the rest. Anna leads and is on turn first. */
  function rig(parakeet: (t: string) => string = parakeetSays) {
    const dir = tmp('qbsherpa-bot-');
    const config = ConfigSchema.parse({
      game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 30, buzzWindowSec: 6, buzzAnswerTimeoutSec: 5, minPlayers: 2 },
      judge: { cacheFile: path.join(dir, 'cache.json'), strategy: 'fuzzy' },
      llm: { provider: 'none' },
      discord: { dataDir: dir, autoStart: false },
      voice: { dir, ignoreWhileSpeaking: false, localStt: 'parakeet', whisperFastModel: 'models/ggml-base-q5_1.bin', leaveOnGameEnd: false },
    });
    const texts = new Map<number, string>();
    const room = new Room(texts);
    const heard: string[] = [];
    const kit = createVoiceKit(config, {
      local: ({ engine }) => ({
        engine: `${engine}:fake`,
        transcribe: async (p) => {
          const t = texts.get(p.samples[0]!) ?? '';
          heard.push(`${engine}: ${t}`);
          return engine === 'parakeet' ? parakeet(t) : t;
        },
        close: async () => {},
      }),
    });
    const voice: VoiceKit = {
      stt: kit.stt,
      fastStt: kit.fastStt,
      confirmStt: kit.confirmStt,
      wakeStt: kit.wakeStt,
      localStt: kit.localStt,
      localFastStt: kit.localFastStt,
      tts: {
        engine: 'piper:test',
        synth: async (text: string) => {
          const id = 1000 + texts.size;
          texts.set(id, text);
          return { rate: 16000, channels: 1, samples: Int16Array.from([id, 0, 0]) };
        },
        close: async () => {},
      },
      warmup: async () => {},
    };
    const sent: string[] = [];
    let handler: (m: ChatMessage) => Promise<void> | void = () => {};
    const gw: ChatGateway = {
      botUserId: 'bot',
      onMessage: (h) => (handler = h),
      send: async (_c, text) => void sent.push(text),
      sendDirect: async () => {},
      react: async () => {},
      joinVoice: async () => room,
      voiceMembers: () => [ANNA, BEN],
    };
    let n = 0;
    const type = (content: string) =>
      handler({ id: String(++n), channelId: 'chan', guildId: 'guild', author: { ...ANNA, isBot: false }, content, mentionsBot: false, mentions: [], canManage: true, voiceChannelId: 'vc' });
    const bot = new QuizBot({ gateway: gw, config, store: new GuildStore(dir), createSession: (cfg) => new FakeSession(cfg, ['Anna', 'Ben']), listBoards: async () => ['Test Board'], voice });
    const b = bot as unknown as { attention(id: string): Attention };
    const g = () => bot.activeGame as unknown as { awaiting: { player: string } | null; pending: { player: string } | null; endAsk: { until: number } | null } | null;
    /** Anna is asked the question and says "Quizmaster, stopp": Parakeet first (no answer keyword), then whisper. */
    /** Anna is on turn, picks a card, and is asked the question (attention 'answer'). */
    const toAnswer = async () => {
      await type('!quiz voice');
      await until(() => room.played.some((t) => t.includes('Quizmaster')));
      await type('!quiz neu Test Board');
      await until(() => !!bot.activeGame);
      await type('!quiz los');
      await until(() => room.played.some((t) => t.includes('Welche Karte')), 8000);
      room.speak(ANNA, 'Sport für 100');
      await until(() => g()?.awaiting?.player === 'Anna', 8000);
      await new Promise((r) => setTimeout(r, 100));
      expect(b.attention(ANNA.id)).toBe('answer');
    };
    const toStopWindow = async () => {
      await toAnswer();
      room.speak(ANNA, 'Quizmaster, stopp');
      await until(() => !!g()?.endAsk);
      expect(heard.slice(-2)).toEqual(['parakeet: Quizmaster, stopp', 'whisper: Quizmaster, stopp']);
      expect(b.attention(ANNA.id)).toBe('confirm');
    };
    return { bot, b, g, room, heard, sent, toAnswer, toStopWindow };
  }

  it('F1: the answerer\'s command is heard by whisper although Parakeet mishears the wake word', async () => {
    const r = rig();
    try {
      await r.toStopWindow(); // "Quizmaster, stopp" worked although Parakeet wrote "This muster, stopp"
      r.g()!.endAsk = null;
      r.room.speak(ANNA, 'Quizmaster, Spiel beenden');
      await until(() => !r.bot.activeGame, 8000);
      expect(r.heard.slice(-2)).toEqual(['parakeet: Quizmaster, Spiel beenden', 'whisper: Quizmaster, Spiel beenden']);
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('"Ja" is heard by whisper and ends the game', async () => {
    const r = rig();
    try {
      await r.toStopWindow();
      r.room.speak(ANNA, 'Ja');
      await until(() => !r.bot.activeGame, 8000);
      expect(r.heard.at(-1)).toBe('whisper: Ja');
      expect(r.heard).not.toContain('parakeet: Ja');
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('an answer in the window: heard again by Parakeet, handled once, the window is gone', async () => {
    const r = rig();
    try {
      await r.toStopWindow();
      r.room.speak(ANNA, 'Meine Antwort ist zehn');
      await until(() => r.g()?.pending?.player === 'Anna', 8000);
      expect(r.heard.slice(-2)).toEqual(['whisper: Meine Antwort ist zehn', 'parakeet: Meine Antwort ist zehn']);
      expect(r.g()!.endAsk).toBeNull();
      await new Promise((res) => setTimeout(res, 300));
      expect(r.room.played.filter((t) => t === 'zehn?')).toHaveLength(1);
      r.room.speak(ANNA, 'Ja'); // now the "Ja" of "zehn?" (attention confirm → whisper)
      await until(() => r.room.played.some((t) => t.startsWith('Richtig')), 8000);
      await new Promise((res) => setTimeout(res, 300));
      expect(r.room.played.filter((t) => t.startsWith('Richtig'))).toHaveLength(1);
      expect(r.bot.activeGame).not.toBeNull(); // the game goes on
      await new Promise((res) => setTimeout(res, 1500)); // the chat queue has posted everything
      const chat = r.sent.join('\n');
      expect(chat.split('Meine Antwort ist zehn').length - 1).toBe(1); // the transcript once
      expect(chat).not.toContain('Spiel wird beendet');
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('F8: "Genau, meine Antwort ist neun" replaces the old answer although Parakeet loses the keyword; unclear talk confirms nothing', async () => {
    const r = rig((t) => parakeetSays(t).replace('meine Antwort', 'mein Antwort'));
    try {
      await r.toAnswer();
      r.room.speak(ANNA, 'Meine Antwort ist zehn'); // Parakeet loses the keyword here too → whisper hears it again
      await until(() => r.room.played.includes('zehn?'), 8000);
      r.room.speak(ANNA, 'Genau, meine Antwort ist neun');
      await until(() => r.room.played.includes('neun?'), 8000); // the new answer is asked back, the old one not given
      expect(r.room.played.some((t) => /^(Richtig|Leider)/.test(t))).toBe(false);
      r.room.speak(ANNA, 'Hm, äh, warte mal');
      await new Promise((res) => setTimeout(res, 600));
      expect(r.room.played.some((t) => /^(Richtig|Leider)/.test(t))).toBe(false); // nothing confirmed
      expect(r.g()!.pending?.player).toBe('Anna');
      r.room.speak(ANNA, 'Ja');
      await until(() => r.room.played.some((t) => /^(Richtig|Leider)/.test(t)), 8000);
      expect(r.room.played.find((t) => /^(Richtig|Leider)/.test(t))).toMatch(/^Leider/); // "neun" was judged, not "zehn"
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('after the window (20 s) the answer engine hears the answerer again', async () => {
    const r = rig();
    try {
      await r.toStopWindow();
      r.g()!.endAsk!.until = Date.now() - 1; // 20 s are over
      expect(r.b.attention(ANNA.id)).toBe('answer');
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);
});

describe('F1/F3/F4: Parakeet first, whisper for everything that is no answer (voice host)', () => {
  class Room implements VoiceTransport {
    label = 'fake';
    private handlers: ((u: Utterance) => void)[] = [];
    constructor(private texts: Map<number, string>) {}
    async play() {}
    stop() {}
    onUtterance(h: (u: Utterance) => void) {
      this.handlers.push(h);
    }
    onClose() {}
    async close() {}
    speak(speaker: Speaker, text: string) {
      const id = 1000 + this.texts.size;
      this.texts.set(id, text);
      const samples = new Int16Array(8000).fill(4000);
      samples[0] = id;
      const now = Date.now();
      for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
    }
  }
  const anna: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };

  /**
   * A voice host on the real routes (`createSttRoutes`) with fake engines: `parakeet` mishears like the real
   * model (Reed), `fast`/`main` = whisper, `cloud` = Deepgram. `used` lists every recognition in order.
   */
  function hostRig(over: Record<string, unknown>, o: { cloudAllowed?: boolean; fail?: string[]; parakeet?: (t: string) => string } = {}) {
    const v = voiceCfg({ latencyLog: true, ...over });
    const texts = new Map<number, string>();
    const used: string[] = [];
    const heard: string[] = [];
    const fail = new Set(o.fail ?? []);
    const local = (e: { model: string; engine: string }): LocalStt => {
      const kind = e.engine === 'parakeet' ? 'parakeet' : e.model === v.whisperFastModel ? 'fast' : 'main';
      return {
        engine: `${kind}:x`,
        transcribe: async (p) => {
          const t = texts.get(p.samples[0]!) ?? '';
          used.push(`${kind}: ${t}`);
          if (fail.has(kind)) throw new Error(`${kind} kaputt`);
          return kind === 'parakeet' ? (o.parakeet ?? parakeetSays)(t) : t;
        },
        close: async () => {},
      };
    };
    const routes = createSttRoutes(v, {
      env: { DEEPGRAM_API_KEY: 'k' },
      local,
      cloud: () => ({
        engine: 'deepgram:nova-3',
        cloud: true,
        transcribe: async (p) => {
          const t = texts.get(p.samples[0]!) ?? '';
          used.push(`cloud: ${t}`);
          if (fail.has('cloud')) throw new CloudError('server', 'HTTP 503');
          return t;
        },
        close: async () => {},
      }),
    });
    const room = new Room(texts);
    let attention: Attention = 'answer';
    new VoiceHost({
      transport: room,
      stt: routes.stt,
      fastStt: routes.fastStt,
      confirmStt: routes.confirmStt,
      wakeStt: routes.wakeStt,
      localStt: routes.localStt,
      localFastStt: routes.localFastStt,
      ...(o.cloudAllowed === undefined ? {} : { cloudAllowed: () => o.cloudAllowed! }),
      tts: silentTts,
      cfg: v,
      prompt: () => '',
      onSpeech: (_s, t, used) => {
        heard.push(t);
        used?.();
      },
      attention: () => attention,
    });
    /** Says `text` in phase `a`; resolves with the recognitions it took and what reached the bot (null = nothing). */
    const say = async (a: Attention, text: string) => {
      attention = a;
      used.length = 0;
      const n = heard.length;
      room.speak(anna, text);
      await until(() => heard.length > n, 1500).catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      return { used: [...used], bot: heard.length > n ? heard.at(-1)! : null };
    };
    return { say, routes };
  }

  /** Captures the logger output (all levels) while `fn` runs. */
  async function captureLog<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
    const chunks: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((c: string | Uint8Array) => (chunks.push(String(c).replace(/\x1b\[[0-9;]*m/g, '')), true)) as typeof process.stderr.write;
    setLogLevel('info');
    try {
      const result = await fn();
      return { out: chunks.join(''), result };
    } finally {
      process.stderr.write = write;
      setLogLevel('error');
    }
  }

  const hybrid = { localStt: 'parakeet', whisperFastModel: 'models/fast.bin' };

  it('the flow per case (hybrid, default parakeetFor): which engines, in which order, whose text counts', async () => {
    const r = hostRig(hybrid, { parakeet: (t) => parakeetSays(t).replace('meine Antwort ist Ähm', 'Ähm') });
    // Answer with the keyword: Parakeet only (fast path).
    expect(await r.say('answer', 'Meine Antwort ist George Washington')).toEqual({ used: ['parakeet: Meine Antwort ist George Washington'], bot: 'Meine Antwort ist George Washington' });
    // Command with the wake word: Parakeet, then whisper – whisper's text counts (Parakeet wrote "This muster, …").
    expect(await r.say('answer', 'Quizmaster, wiederhole die Frage')).toEqual({ used: ['parakeet: Quizmaster, wiederhole die Frage', 'fast: Quizmaster, wiederhole die Frage'], bot: 'Quizmaster, wiederhole die Frage' });
    // Thinking aloud: Parakeet, then whisper.
    expect(await r.say('answer', 'Hm, das war doch der erste Präsident')).toEqual({ used: ['parakeet: Hm, das war doch der erste Präsident', 'fast: Hm, das war doch der erste Präsident'], bot: 'Hm, das war doch der erste Präsident' });
    // "Ja" to "Washington?": whisper only.
    expect(await r.say('confirm', 'Ja')).toEqual({ used: ['fast: Ja'], bot: 'Ja' });
    // A new answer in the confirm: whisper, then Parakeet (as before) – never a third pass, even if Parakeet lost the keyword.
    expect(await r.say('confirm', 'Nein, meine Antwort ist Adams')).toEqual({ used: ['fast: Nein, meine Antwort ist Adams', 'parakeet: Nein, meine Antwort ist Adams'], bot: 'Nein, meine Antwort ist Adams' });
    expect(await r.say('confirm', 'Genau, meine Antwort ist Ähm Rom')).toEqual({ used: ['fast: Genau, meine Antwort ist Ähm Rom', 'parakeet: Genau, meine Antwort ist Ähm Rom'], bot: 'Genau, meine Antwort ist Ähm Rom' }); // Parakeet lost the keyword: whisper's text
    // Card choice and wake check: whisper only.
    expect((await r.say('full', 'Geschichte für 200')).used).toEqual(['fast: Geschichte für 200']);
    expect((await r.say('wake', 'Quizmaster, Stand')).used).toEqual(['fast: Quizmaster, Stand']);
  });

  it('the ⏱ line names both engines and sums their time', async () => {
    const r = hostRig(hybrid);
    const { out } = await captureLog(() => r.say('answer', 'Quizmaster, Stand'));
    expect(out).toMatch(/⏱ erkennung engine=parakeet:x\+fast:x attention=answer audio=500ms stt=\d+ms rueckfall=nein/);
  });

  it('whisper only (defaults): no extra recognition anywhere, also not in the answer phase', async () => {
    for (const over of [{}, { whisperFastModel: 'models/fast.bin' }]) {
      const r = hostRig(over);
      expect((await r.say('answer', 'Quizmaster, wiederhole die Frage')).used).toEqual(['main: Quizmaster, wiederhole die Frage']);
      expect((await r.say('answer', 'Hm, mal überlegen')).used).toEqual(['main: Hm, mal überlegen']);
      expect((await r.say('answer', 'Meine Antwort ist Paris')).used).toEqual(['main: Meine Antwort ist Paris']);
    }
  });

  it('parakeetFor = all four (no whisper): Parakeet\'s text counts for everything, one pass', async () => {
    const r = hostRig({ localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'] });
    expect(await r.say('answer', 'Quizmaster, Stand')).toEqual({ used: ['parakeet: Quizmaster, Stand'], bot: 'This muster, Stand' });
    expect(await r.say('confirm', 'Ja')).toEqual({ used: ['parakeet: Ja'], bot: 'Yeah.' });
  });

  it('F3: a local "Ja" never ends at Parakeet in the mixed mode – cloud allowed or not, local or Deepgram', async () => {
    const sets: Attention[][] = [['answer']]; // the only mixed mode (F10)
    for (const parakeetFor of sets) {
      for (const stt of ['whisper', 'deepgram']) {
        for (const cloudAllowed of [true, false]) {
          const r = hostRig({ ...hybrid, parakeetFor, stt }, { cloudAllowed });
          const res = await r.say('confirm', 'Ja');
          const label = `${parakeetFor.join('+')} ${stt} cloud=${cloudAllowed}: ${res.used.join(' | ')}`;
          expect(res.bot, label).toBe('Ja');
          if (!parakeetFor.includes('confirm')) expect(res.used.some((u) => u.startsWith('parakeet')), label).toBe(false);
          if (stt === 'deepgram' && !cloudAllowed) expect(res.used.some((u) => u.startsWith('cloud')), label).toBe(false);
        }
      }
    }
  });

  it('F8: in the confirmation Parakeet\'s text counts only with the keyword – whisper\'s text stays otherwise, at most two recognitions', async () => {
    // The reviewer's case: Parakeet writes "mein Antwort ist" – that would be a "Genau" (yes to the old answer).
    const lost = hostRig(hybrid, { parakeet: (t) => t.replace('meine Antwort', 'mein Antwort') });
    expect(await lost.say('confirm', 'Genau, meine Antwort ist Rom')).toEqual({ used: ['fast: Genau, meine Antwort ist Rom', 'parakeet: Genau, meine Antwort ist Rom'], bot: 'Genau, meine Antwort ist Rom' });
    expect(await lost.say('confirm', 'Nein, meine Antwort ist London')).toEqual({ used: ['fast: Nein, meine Antwort ist London', 'parakeet: Nein, meine Antwort ist London'], bot: 'Nein, meine Antwort ist London' });
    const r = hostRig(hybrid, { parakeet: (t) => t.replace('zehn', '10') });
    expect(await r.say('confirm', 'Ja')).toEqual({ used: ['fast: Ja'], bot: 'Ja' });
    expect(await r.say('confirm', 'Nein')).toEqual({ used: ['fast: Nein'], bot: 'Nein' });
    expect(await r.say('confirm', 'Hm, äh, warte mal')).toEqual({ used: ['fast: Hm, äh, warte mal'], bot: 'Hm, äh, warte mal' });
    // A new answer with the keyword: Parakeet's text counts (it has the keyword).
    expect(await r.say('confirm', 'Genau, meine Antwort ist zehn')).toEqual({ used: ['fast: Genau, meine Antwort ist zehn', 'parakeet: Genau, meine Antwort ist zehn'], bot: 'Genau, meine Antwort ist 10' });
    // Parakeet empty, or failing: whisper's text, two recognitions, never a third.
    const empty = hostRig(hybrid, { parakeet: () => '' });
    expect(await empty.say('confirm', 'Genau, meine Antwort ist Rom')).toEqual({ used: ['fast: Genau, meine Antwort ist Rom', 'parakeet: Genau, meine Antwort ist Rom'], bot: 'Genau, meine Antwort ist Rom' });
    const broken = hostRig(hybrid, { fail: ['parakeet'] });
    const res = await broken.say('confirm', 'Genau, meine Antwort ist Rom');
    expect(res).toEqual({ used: ['fast: Genau, meine Antwort ist Rom', 'parakeet: Genau, meine Antwort ist Rom'], bot: 'Genau, meine Antwort ist Rom' });
    expect(res.used.length).toBeLessThanOrEqual(2);
  });

  it('F4: a failing whisper never hands "Ja" or the wake check to Parakeet; a failing Parakeet hands the answer to whisper', async () => {
    const r = hostRig(hybrid, { fail: ['fast'] });
    expect(await r.say('confirm', 'Ja')).toEqual({ used: ['fast: Ja'], bot: null }); // dropped, not "Yeah."
    expect(await r.say('wake', 'Quizmaster, Stand')).toEqual({ used: ['fast: Quizmaster, Stand'], bot: null });
    const p = hostRig(hybrid, { fail: ['parakeet'] });
    expect(await p.say('answer', 'Meine Antwort ist Paris')).toEqual({ used: ['parakeet: Meine Antwort ist Paris', 'fast: Meine Antwort ist Paris'], bot: 'Meine Antwort ist Paris' });
    // Without a hybrid nothing changes: whisper's fast model fails → the main model takes over, as before.
    const w = hostRig({ whisperFastModel: 'models/fast.bin' }, { fail: ['fast'] });
    expect(await w.say('confirm', 'Ja')).toEqual({ used: ['fast: Ja', 'main: Ja'], bot: 'Ja' });
  });

  it('F12: Deepgram for answers only, cloud down – Parakeet as its fallback counts in the confirmation only with the keyword', async () => {
    const dg = { ...hybrid, stt: 'deepgram', sttCloudFor: ['answer'] };
    const lost = (t: string) => t.replace('meine Antwort', 'mein Antwort');
    // Cloud fails → Parakeet stands in and loses the keyword ("Genau, mein Antwort ist" = a yes to the old answer): whisper's text counts.
    // After 3 failures the cloud pauses: Parakeet hears without a cloud try – same rule.
    const r = hostRig(dg, { cloudAllowed: true, fail: ['cloud'], parakeet: lost });
    for (let i = 0; i < 4; i++) {
      const res = await r.say('confirm', 'Genau, meine Antwort ist Rom');
      expect(res.bot, `Durchgang ${i + 1}`).toBe('Genau, meine Antwort ist Rom');
      expect(res.used, `Durchgang ${i + 1}`).toEqual(['fast: Genau, meine Antwort ist Rom', ...(i < 3 ? ['cloud: Genau, meine Antwort ist Rom'] : []), 'parakeet: Genau, meine Antwort ist Rom']);
    }
    // Cloud and Parakeet both fail: whisper's text stays (no "Sprache gestört", no lost answer).
    const both = hostRig(dg, { cloudAllowed: true, fail: ['cloud', 'parakeet'] });
    expect((await both.say('confirm', 'Genau, meine Antwort ist Rom')).bot).toBe('Genau, meine Antwort ist Rom');
    // Parakeet keeps the keyword: its text counts, as with the cloud's own text.
    const kept = hostRig(dg, { cloudAllowed: true, fail: ['cloud'], parakeet: (t) => t.replace('Rom', 'Rohm') });
    expect((await kept.say('confirm', 'Genau, meine Antwort ist Rom')).bot).toBe('Genau, meine Antwort ist Rohm');
    const ok = hostRig(dg, { cloudAllowed: true, parakeet: lost });
    expect(await ok.say('confirm', 'Genau, meine Antwort ist Rom')).toEqual({ used: ['fast: Genau, meine Antwort ist Rom', 'cloud: Genau, meine Antwort ist Rom'], bot: 'Genau, meine Antwort ist Rom' });
  });

  it('with Deepgram: the extra whisper pass is local and never another cloud call', async () => {
    const dg = { ...hybrid, stt: 'deepgram' };
    // The cloud heard it: its text counts as it is – no second pass at all.
    const ok = hostRig(dg, { cloudAllowed: true });
    expect((await ok.say('answer', 'Quizmaster, Stand')).used).toEqual(['cloud: Quizmaster, Stand']);
    // Cloud down → Parakeet stands in → no keyword → whisper (local) hears it again; the cloud was asked once.
    const down = hostRig(dg, { cloudAllowed: true, fail: ['cloud'] });
    const res = await down.say('answer', 'Quizmaster, Stand');
    expect(res.used).toEqual(['cloud: Quizmaster, Stand', 'parakeet: Quizmaster, Stand', 'fast: Quizmaster, Stand']);
    expect(res.bot).toBe('Quizmaster, Stand');
    // Not allowed to the cloud: Parakeet, then whisper – both local.
    const no = hostRig(dg, { cloudAllowed: false });
    expect((await no.say('answer', 'Quizmaster, Stand')).used).toEqual(['parakeet: Quizmaster, Stand', 'fast: Quizmaster, Stand']);
  });
});

describe('F7 (a): setupVoice with the defaults never touches Parakeet', () => {
  it('no Python environment, no sherpa-onnx, no model download, no Parakeet folder', async () => {
    const dir = tmp('qbsherpa-setup-');
    mkdirSync(path.join(dir, 'models'), { recursive: true });
    writeFileSync(path.join(dir, 'models', 'own-model.bin'), 'x'); // an own model: nothing is downloaded
    const bin = path.join(dir, 'whisper-server');
    // `--help` succeeds (so setupVoice never tries to install whisper.cpp – no brew in a test), a start fails at once.
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nexit 1\n');
    chmodSync(bin, 0o755);
    const { setupVoice } = await import('../src/voice/index.ts');
    const config = ConfigSchema.parse({ voice: { dir, tts: 'say', whisperBin: bin, whisperModel: 'models/own-model.bin', whisperPort: 18997 } });
    // The self-test fails (no real whisper-server / `say`) – everything Parakeet would do comes before it.
    await setupVoice(config).catch(() => {});
    expect(existsSync(path.join(dir, 'venv'))).toBe(false);
    expect(readdirSync(path.join(dir, 'models'))).toEqual(['own-model.bin']);
  }, 30000);
});

describe('slow Parakeet start: answers never wait in the mixed mode', () => {
  class Room implements VoiceTransport {
    label = 'fake';
    private handlers: ((u: Utterance) => void)[] = [];
    constructor(private texts: Map<number, string>) {}
    async play() {}
    stop() {}
    onUtterance(h: (u: Utterance) => void) {
      this.handlers.push(h);
    }
    onClose() {}
    async close() {}
    speak(speaker: Speaker, text: string) {
      const id = 1000 + this.texts.size;
      this.texts.set(id, text);
      const samples = new Int16Array(8000).fill(4000);
      samples[0] = id;
      const now = Date.now();
      for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
    }
  }
  const anna: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };

  async function captureLog<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
    const chunks: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((c: string | Uint8Array) => (chunks.push(String(c).replace(/\x1b\[[0-9;]*m/g, '')), true)) as typeof process.stderr.write;
    setLogLevel('info');
    try {
      const result = await fn();
      return { out: chunks.join(''), result };
    } finally {
      process.stderr.write = write;
      setLogLevel('error');
    }
  }

  /**
   * The real ParakeetStt on the fake worker (it answers "Text <samples>"), whisper a fake that repeats the
   * spoken text; the real routes and the real voice host. `env` steers the worker (FAKE_READY_MS …).
   */
  function rig(over: Record<string, unknown>, env: Record<string, string>, o: { deadlineMs?: number; retryDelaysMs?: number[] } = {}) {
    const v = voiceCfg({ latencyLog: true, ...over });
    const texts = new Map<number, string>();
    const used: string[] = [];
    const heard: string[] = [];
    const state = tmp('qbsherpa-slow-');
    let parakeet: ParakeetStt | null = null;
    const routes = createSttRoutes(v, {
      local: (e) => {
        if (e.engine === 'parakeet') {
          parakeet = new ParakeetStt(v, { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_STATE: state, FAKE_TEXT: 'Meine Antwort ist Parakeet', ...env }, deadlineMs: () => o.deadlineMs ?? 5000, startTimeoutMs: 5000, retryDelaysMs: o.retryDelaysMs ?? [150, 300] });
          open.push(parakeet);
          return parakeet;
        }
        return {
          engine: 'whisper:fast',
          transcribe: async (p) => {
            const t = texts.get(p.samples[0]!) ?? '';
            used.push(`whisper: ${t}`);
            return t;
          },
          close: async () => {},
        };
      },
    });
    const room = new Room(texts);
    new VoiceHost({
      transport: room,
      stt: routes.stt,
      fastStt: routes.fastStt,
      confirmStt: routes.confirmStt,
      wakeStt: routes.wakeStt,
      tts: silentTts,
      cfg: v,
      prompt: () => '',
      onSpeech: (_s, t, u) => {
        heard.push(t);
        u?.();
      },
      attention: () => 'answer',
    });
    const say = async (text: string, waitMs = 3000) => {
      used.length = 0;
      const n = heard.length;
      const t0 = Date.now();
      room.speak(anna, text);
      await until(() => heard.length > n, waitMs);
      return { ms: Date.now() - t0, used: [...used], bot: heard.at(-1)! };
    };
    const starts = () => (existsSync(path.join(state, 'starts')) ? readFileSync(path.join(state, 'starts'), 'utf8').split('\n').filter(Boolean).map(Number) : []);
    return { say, routes, stt: () => parakeet!, starts };
  }
  const hybrid = { localStt: 'parakeet', whisperFastModel: 'models/fast.bin' };

  it('while the helper loads, whisper hears the answer at once (rueckfall=ja); once ready, Parakeet hears', async () => {
    const r = rig(hybrid, { FAKE_READY_MS: '800' });
    expect(r.stt().failFast).toBe(true);
    const { out, result: first } = await captureLog(() => r.say('Meine Antwort ist Paris'));
    expect(first.bot).toBe('Meine Antwort ist Paris'); // whisper's text, processed
    expect(first.used).toEqual(['whisper: Meine Antwort ist Paris']);
    expect(first.ms).toBeLessThan(500); // not the 800 ms load
    expect(out).toMatch(/⏱ erkennung engine=parakeet:tdt-0\.6b-v3-int8\+whisper:fast attention=answer .* rueckfall=ja/);
    expect(out).toMatch(/\[voice\] Erkennung mit parakeet:.*noch nicht bereit/); // info, not a warning per utterance
    expect(out).not.toContain('Paris"'); // no transcript in the log
    expect(r.stt().starts).toBe(1); // the first answer started it in the background
    await until(() => r.stt().readyNow(), 5000);
    const later = await r.say('Meine Antwort ist Rom');
    expect(later.used).toEqual([]); // Parakeet alone
    expect(later.bot).toBe('Meine Antwort ist Parakeet');
    expect(r.stt().starts).toBe(1);
  });

  it('a crash mid-game: the next answer goes to whisper at once and starts a new helper in the background', async () => {
    const r = rig(hybrid, { FAKE_READY_MS: '300' });
    await r.stt().warmup();
    expect((await r.say('Meine Antwort ist Rom')).bot).toBe('Meine Antwort ist Parakeet');
    process.kill(r.starts()[0]!, 'SIGKILL');
    await until(() => !r.stt().readyNow());
    const during = await r.say('Meine Antwort ist Paris');
    expect(during.used).toEqual(['whisper: Meine Antwort ist Paris']);
    expect(during.ms).toBeLessThan(250);
    expect(r.stt().starts).toBe(1); // pausing after the crash (150 ms here, 5 s by default): no new start yet
    await new Promise((res) => setTimeout(res, 200));
    await r.say('Meine Antwort ist Rom'); // whisper again – and now it starts a new helper
    await until(() => r.stt().readyNow(), 5000);
    expect(r.starts()).toHaveLength(2);
    expect((await r.say('Meine Antwort ist Bern')).bot).toBe('Meine Antwort ist Parakeet');
  });

  it('a hung helper mid-answer: after its deadline whisper hears that very answer – no wait for the restart', async () => {
    const r = rig(hybrid, { FAKE_HANG: '1', FAKE_READY_MS: '600' }, { deadlineMs: 200 });
    await r.stt().warmup();
    const res = await r.say('Meine Antwort ist Paris', 3000);
    expect(res.used).toEqual(['whisper: Meine Antwort ist Paris']);
    expect(res.bot).toBe('Meine Antwort ist Paris');
    expect(res.ms).toBeLessThan(500); // deadline 200 ms, not deadline + 600 ms restart
    expect(r.stt().starts).toBe(1); // no restart loop by itself …
    await new Promise((res) => setTimeout(res, 200)); // (the pause after the hang)
    await r.say('Meine Antwort ist Rom'); // … the next answer (whisper again) starts it
    await until(() => r.stt().readyNow(), 5000);
    expect((await r.say('Meine Antwort ist Bern')).bot).toBe('Meine Antwort ist Parakeet');
  });

  it('K1: a helper that never starts – growing pauses, no start per answer, one warning per longer pause, whisper hears all', async () => {
    let now = 0;
    const v = voiceCfg({ ...hybrid });
    const state = tmp('qbsherpa-k1-');
    const p = new ParakeetStt(v, { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_STATE: state, FAKE_DIE: '1' }, startTimeoutMs: 5000, retryDelaysMs: [5_000, 15_000, 60_000, 300_000], now: () => now });
    open.push(p);
    p.failFast = true;
    const { out } = await captureLog(async () => {
      // 20 answers, 30 s apart (fake clock, 9.5 min) – each is rejected at once, so whisper hears it.
      for (let i = 0; i < 20; i++) {
        await expect(p.transcribe(pcm(1600))).rejects.toBeInstanceOf(SttNotReady);
        await until(() => !(p as unknown as { ready: unknown }).ready, 3000); // a running start has failed
        now += 30_000;
      }
    });
    // Starts at 0 s, 30 s (after 5 s), 60 s (after 15 s), 120 s (after 60 s), 420 s (after 5 min) – not 20.
    expect(p.starts).toBe(5);
    const warns = out.split('\n').filter((l) => /Parakeet startet nicht/.test(l));
    // One warning per longer pause; the 5-min pause repeats without a new one.
    expect(warns.map((l) => l.match(/in (\d+) s/)![1])).toEqual(['5', '15', '60', '300']);
    expect(out).toMatch(/whisper hört die Antworten, nächster Versuch frühestens in 5 s/);
  });

  it('K1: after a successful recognition the pauses start short again', async () => {
    const r = rig(hybrid, { FAKE_READY_MS: '100' }, { retryDelaysMs: [100, 5000] });
    await r.stt().warmup();
    expect((await r.say('Meine Antwort ist Rom')).bot).toBe('Meine Antwort ist Parakeet'); // resets the count
    process.kill(r.starts()[0]!, 'SIGKILL');
    await until(() => !r.stt().readyNow());
    await new Promise((res) => setTimeout(res, 150)); // first pause (100 ms) – not the 5 s one
    await r.say('Meine Antwort ist Paris');
    await until(() => r.stt().readyNow(), 3000);
    expect(r.starts()).toHaveLength(2);
  });

  it('K3: a stats() request waiting behind a crashed recognition is rejected, not left open', async () => {
    const r = rig(hybrid, { FAKE_READY_MS: '50', FAKE_DELAY: '2000' });
    await r.stt().warmup();
    const job = r.stt().transcribe(pcm(1600)).catch((e) => e);
    const stats = r.stt().stats().catch((e) => e);
    await new Promise((res) => setTimeout(res, 100));
    process.kill(r.starts()[0]!, 'SIGKILL');
    expect(await job).toBeInstanceOf(SttNotReady);
    expect(await stats).toBeInstanceOf(SttNotReady);
  });

  it('K2: closing while Parakeet loads is no failure – no warning', async () => {
    const state = tmp('qbsherpa-k2-');
    const config = ConfigSchema.parse({ voice: { ...hybrid, parakeet: { preload: 'start' } } });
    const { out } = await captureLog(async () => {
      const kit = createVoiceKit(config, {
        tts: silentTts,
        local: (e) =>
          e.engine === 'parakeet'
            ? new ParakeetStt(config.voice, { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_STATE: state, FAKE_READY_MS: '3000' }, startTimeoutMs: 5000 })
            : { engine: 'whisper:fast', warmup: async () => {}, transcribe: async () => '', close: async () => {} },
      });
      await kit.warmup();
      await new Promise((res) => setTimeout(res, 100));
      await kit.close();
      await new Promise((res) => setTimeout(res, 100));
    });
    expect(out).not.toMatch(/startet nicht|whisper hört die Antworten/);
  });

  it('Parakeet alone (all four phases, no whisper): the answer waits for the helper, with one clear warning', async () => {
    const r = rig({ localStt: 'parakeet', parakeetFor: ['answer', 'confirm', 'full', 'wake'] }, { FAKE_READY_MS: '500' });
    expect(r.stt().failFast).toBe(false);
    const { out, result } = await captureLog(async () => {
      const a = await r.say('Meine Antwort ist Paris', 4000);
      await r.say('Meine Antwort ist Rom', 4000);
      return a;
    });
    expect(result.bot).toBe('Meine Antwort ist Parakeet');
    expect(result.ms).toBeGreaterThanOrEqual(450);
    expect(out.match(/Parakeet lädt noch – Äußerungen warten, bis es bereit ist \(höchstens 5 s\)/g)).toHaveLength(1);
  });

  it('with Deepgram: cloud down and Parakeet still loading – whisper stands in, no extra pass, no "Sprache gestört"', async () => {
    const v = voiceCfg({ ...hybrid, stt: 'deepgram', sttCloudFor: ['answer'] });
    const used: string[] = [];
    const texts = new Map<number, string>();
    const routes = createSttRoutes(v, {
      env: { DEEPGRAM_API_KEY: 'k' },
      local: (e) => ({
        engine: `${e.engine}:x`,
        ...(e.engine === 'parakeet' ? { failFast: false } : {}),
        transcribe: async (p) => {
          const t = texts.get(p.samples[0]!) ?? '';
          used.push(`${e.engine}: ${t}`);
          if (e.engine === 'parakeet') throw new SttNotReady('lädt');
          return t;
        },
        close: async () => {},
      }),
      cloud: () => ({ engine: 'deepgram:nova-3', cloud: true, transcribe: async () => (used.push('cloud'), Promise.reject(new CloudError('server', 'HTTP 503'))), close: async () => {} }),
    });
    expect((routes.stt as FallbackStt).standIn?.engine).toBe('whisper:x');
    const heard: string[] = [];
    const room = new Room(texts);
    new VoiceHost({ transport: room, stt: routes.stt, fastStt: routes.fastStt, confirmStt: routes.confirmStt, wakeStt: routes.wakeStt, localStt: routes.localStt, localFastStt: routes.localFastStt, cloudAllowed: () => true, tts: silentTts, cfg: v, prompt: () => '', onSpeech: (_s, t) => void heard.push(t), attention: () => 'answer' });
    room.speak(anna, 'Quizmaster, Stand');
    await until(() => heard.length > 0);
    await new Promise((res) => setTimeout(res, 30));
    expect(used).toEqual(['cloud', 'parakeet: Quizmaster, Stand', 'whisper: Quizmaster, Stand']); // whisper once
    expect(heard).toEqual(['Quizmaster, Stand']);
  });

  it('joining voice never waits for Parakeet in the mixed mode (it starts with the greeting)', async () => {
    const state = tmp('qbsherpa-join-');
    let p: ParakeetStt | null = null;
    const config = ConfigSchema.parse({ voice: { ...hybrid, parakeet: { preload: 'off' } } });
    const kit = createVoiceKit(config, {
      tts: silentTts,
      local: (e) => {
        if (e.engine !== 'parakeet') return { engine: 'whisper:fast', warmup: async () => {}, transcribe: async () => '', close: async () => {} };
        p = new ParakeetStt(config.voice, { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_STATE: state, FAKE_READY_MS: '1500' }, startTimeoutMs: 5000 });
        return p;
      },
    });
    expect(p!.starts).toBe(0); // preload off: nothing at bot start
    const t0 = Date.now();
    await kit.warmup();
    expect(Date.now() - t0).toBeLessThan(800);
    expect(p!.starts).toBe(1); // started, loading in the background
    expect(p!.readyNow()).toBe(false);
    await until(() => p!.readyNow(), 5000);
    await kit.close();
  });
});

describe('preload at bot start (voice.parakeet.preload)', () => {
  function modelDir(sizes: number[]) {
    const dir = tmp('qbsherpa-pre-');
    const model = path.join(dir, 'models', PARAKEET_MODEL.name);
    mkdirSync(model, { recursive: true });
    PARAKEET_FILES.forEach((f, i) => writeFileSync(path.join(model, f), Buffer.alloc(sizes[i] ?? 10, 1)));
    return dir;
  }
  const fakeLocal = (starts: string[]) => (e: { engine: string }) => ({ engine: `${e.engine}:x`, warmup: async () => void starts.push(e.engine), transcribe: async () => `${e.engine} hört`, close: async () => {} });

  it('cache (default): reads the model files once in the background – the kit is there at once, recognition does not wait, nothing is started', async () => {
    const dir = modelDir([6_000_000, 1_000_000, 500_000, 10_000]);
    const starts: string[] = [];
    const t0 = Date.now();
    const kit = createVoiceKit(ConfigSchema.parse({ voice: { dir, tts: 'say', localStt: 'parakeet', whisperFastModel: 'models/fast.bin' } }), { tts: silentTts, local: fakeLocal(starts), preloadDelayMs: 0 });
    expect(Date.now() - t0).toBeLessThan(100); // the bot start is not delayed
    expect(kit.preloading).toBeDefined();
    let done = false;
    void kit.preloading!.then(() => (done = true));
    expect(await kit.fastStt!.transcribe(pcm(800))).toBe('whisper hört'); // recognition right away, during the read
    expect(await kit.preloading).toBe(7_510_000);
    expect(done).toBe(true);
    expect(starts).toEqual([]); // no helper process for the cache read
    await kit.close();
  });

  it('close() stops a running read at once; a missing model is no error', async () => {
    const dir = modelDir([40_000_000, 10, 10, 10]);
    const kit = createVoiceKit(ConfigSchema.parse({ voice: { dir, tts: 'say', localStt: 'parakeet', whisperFastModel: 'models/fast.bin' } }), { tts: silentTts, local: fakeLocal([]), preloadDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 15));
    await kit.close();
    expect(await kit.preloading).toBeLessThan(40_000_030);
    const none = createVoiceKit(ConfigSchema.parse({ voice: { dir: tmp('qbsherpa-none-'), tts: 'say', localStt: 'parakeet', whisperFastModel: 'models/fast.bin' } }), { tts: silentTts, local: fakeLocal([]), preloadDelayMs: 0 });
    expect(await none.preloading).toBe(0);
  });

  it('start: the helper is started at bot start; off: nothing; whisper (default): no preload at all', async () => {
    const dir = modelDir([10, 10, 10, 10]);
    const starts: string[] = [];
    createVoiceKit(ConfigSchema.parse({ voice: { dir, tts: 'say', localStt: 'parakeet', whisperFastModel: 'models/fast.bin', parakeet: { preload: 'start' } } }), { tts: silentTts, local: fakeLocal(starts) });
    expect(starts).toEqual(['parakeet']);
    const off = createVoiceKit(ConfigSchema.parse({ voice: { dir, tts: 'say', localStt: 'parakeet', whisperFastModel: 'models/fast.bin', parakeet: { preload: 'off' } } }), { tts: silentTts, local: fakeLocal(starts) });
    expect(off.preloading).toBeUndefined();
    expect(starts).toEqual(['parakeet']);
    const whisper = createVoiceKit(ConfigSchema.parse({ voice: { dir, tts: 'say', whisperFastModel: 'models/fast.bin' } }), { tts: silentTts, local: fakeLocal(starts) });
    expect(whisper.preloading).toBeUndefined();
    expect(starts).toEqual(['parakeet']);
  });

  it('readIntoPageCache: every byte once, stops on abort', async () => {
    const dir = tmp('qbsherpa-read-');
    writeFileSync(path.join(dir, 'a'), Buffer.alloc(9_000_000));
    writeFileSync(path.join(dir, 'b'), Buffer.alloc(123));
    expect(await readIntoPageCache([path.join(dir, 'a'), path.join(dir, 'b')], { pauseMs: 0 })).toBe(9_000_123);
    const ac = new AbortController();
    ac.abort();
    expect(await readIntoPageCache([path.join(dir, 'a')], { signal: ac.signal })).toBe(0);
    // K2: an abort ends a pause at once – close() never waits for (or depends on) the pause timer.
    const mid = new AbortController();
    const t0 = Date.now();
    const reading = readIntoPageCache([path.join(dir, 'a')], { signal: mid.signal, chunkBytes: 1_000_000, pauseMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    mid.abort();
    expect(await reading).toBe(1_000_000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
