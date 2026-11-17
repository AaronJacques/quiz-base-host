import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, loadConfig, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { durationMs, type Pcm } from '../src/voice/audio.ts';
import { apiKey, CloudError, cloudFetch, redact } from '../src/voice/http.ts';
import { createVoiceKit, piperVoiceUrl, setupPiperVoice, voiceProblems, voiceWarnings } from '../src/voice/index.ts';
import { LatencyMeter } from '../src/voice/latency.ts';
import { Breaker, createSttRoutes, FallbackStt, sttNeeds, sttPlan, SttTrouble, type SttRouteDeps } from '../src/voice/providers.ts';
import { DeepgramStt } from '../src/voice/stt-deepgram.ts';
import { isCloud, promptTerms, WhisperServerStt, type LocalStt, type SpeechToText, type SttOptions } from '../src/voice/stt.ts';
import type { PlayOptions, Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import { PiperTts, SynthTimeout, synthDeadlineMs } from '../src/voice/tts.ts';
import { VoiceHost, type Attention, type VoiceHostDeps } from '../src/voice/voice-host.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel('error');

const KEY = 'dg-test-SECRET-4f1c2a9b7e';
const ENV = { DEEPGRAM_API_KEY: KEY };
const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const BEN: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };

afterEach(() => {
  vi.useRealTimers();
  setLogLevel('error');
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p));

function voiceCfg(over: Record<string, unknown> = {}): Config['voice'] {
  return ConfigSchema.parse({ voice: over }).voice;
}

/** Collects everything the logger writes (all levels) while `fn` runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const chunks: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => (chunks.push(String(c).replace(/\x1b\[[0-9;]*m/g, '')), true)) as typeof process.stderr.write;
  setLogLevel('debug');
  try {
    const result = await fn();
    return { out: chunks.join(''), result };
  } finally {
    process.stderr.write = write;
    setLogLevel('error');
  }
}

// ─────────────── fakes ───────────────

/** Utterances carry an id in their first sample; recognisers look the text up. */
class Texts {
  private map = new Map<number, string>();
  private n = 1000;
  pcm(text: string, ms = 1000): Pcm {
    const id = ++this.n;
    this.map.set(id, text);
    const samples = new Int16Array((16000 * ms) / 1000).fill(4000);
    samples[0] = id;
    return { rate: 16000, channels: 1, samples };
  }
  of(p: Pcm): string {
    return this.map.get(p.samples[0]!) ?? '';
  }
}

interface FakeStt extends LocalStt {
  calls: { text: string; prompt: string; signal?: AbortSignal }[];
}

/** A recogniser that answers with the utterance's text (or does what `behave` says). */
function fakeStt(engine: string, texts: Texts, behave?: (call: number, opts: SttOptions) => Promise<string> | string | undefined): FakeStt {
  const calls: FakeStt['calls'] = [];
  return {
    engine,
    calls,
    async transcribe(pcm, prompt = '', opts = {}) {
      calls.push({ text: texts.of(pcm), prompt, signal: opts.signal });
      const r = behave?.(calls.length, opts);
      if (r !== undefined) return r;
      return texts.of(pcm);
    },
    async close() {},
  };
}

class FakeTransport implements VoiceTransport {
  readonly label = 'fake';
  played: Pcm[] = [];
  private handlers: ((u: Utterance) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  async play(pcm: Pcm, opts?: PlayOptions): Promise<void> {
    this.played.push(pcm);
    opts?.onStart?.();
    await new Promise((r) => setTimeout(r, Math.min(20, durationMs(pcm))));
  }
  stop(): void {}
  onUtterance(h: (u: Utterance) => void): void {
    this.handlers.push(h);
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  async close(): Promise<void> {
    this.closeHandlers.forEach((h) => h());
  }
  speak(speaker: Speaker, pcm: Pcm): void {
    const endedAt = Date.now();
    for (const h of this.handlers) h({ speaker, pcm, startedAt: endedAt - durationMs(pcm), endedAt });
  }
}

const silentTts = {
  engine: 'piper:test',
  synth: async () => ({ rate: 16000, channels: 1, samples: new Int16Array(16) }),
  close: async () => {},
};

/** A voice host on cloud routes with fake engines; who is on turn decides the attention. */
function cloudRig(o: { voice?: Record<string, unknown>; cloud?: (texts: Texts) => FakeStt; attention?: (s: Speaker) => Attention; cloudAllowed?: ((s: Speaker, startedAt: number) => boolean) | null; onSpeech?: (s: Speaker, t: string, used: () => void) => void } = {}) {
  const texts = new Texts();
  const cfg = voiceCfg({ stt: 'deepgram', minRms: 0, minSpeechMs: 0, ignoreWhileSpeaking: false, ...o.voice });
  const cloud = o.cloud?.(texts) ?? fakeStt('deepgram:nova-3', texts);
  const locals: Record<string, FakeStt> = {};
  const deps: SttRouteDeps = {
    env: ENV,
    cloud: () => cloud,
    local: ({ model }) => (locals[path.basename(model)] = fakeStt(`whisper:${path.basename(model, '.bin')}`, texts)),
  };
  const routes = createSttRoutes(cfg, deps);
  const transport = new FakeTransport();
  const heard: string[] = [];
  const lines: string[] = [];
  const trouble: string[] = [];
  const host = new VoiceHost({
    transport,
    stt: routes.stt,
    fastStt: routes.fastStt,
    confirmStt: routes.confirmStt,
    wakeStt: routes.wakeStt,
    localStt: routes.localStt,
    localFastStt: routes.localFastStt,
    // The bot's answer; null = none passed at all (then nothing goes to the cloud, F10).
    cloudAllowed: o.cloudAllowed === null ? undefined : (o.cloudAllowed ?? (() => true)),
    tts: silentTts,
    cfg,
    prompt: () => 'Quizmaster, Sport, Anna, Ben',
    attention: o.attention ?? ((s) => (s.id === ANNA.id ? 'answer' : 'wake')),
    onSpeech: (s, t, used) => {
      heard.push(t);
      used();
      o.onSpeech?.(s, t, used);
    },
    onTrouble: (m) => trouble.push(m),
    latencyLog: (l) => lines.push(l),
  });
  return { texts, cfg, cloud, locals, routes, transport, host, heard, lines, trouble };
}

/** A tiny cloud adapter over `cloudFetch`, like T3's will be: JSON `{ text }` back. */
class HttpStt implements SpeechToText {
  readonly engine = 'deepgram:nova-3';
  constructor(
    private url: string,
    private key: string,
  ) {}
  async transcribe(_pcm: Pcm, prompt = '', opts: SttOptions = {}): Promise<string> {
    const res = await cloudFetch(`${this.url}/v1/listen?model=nova-3&keyterm=${encodeURIComponent(prompt)}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.key}`, 'Content-Type': 'audio/wav' },
      body: 'RIFF',
      timeoutMs: 10_000,
      signal: opts.signal,
      service: 'Deepgram',
    });
    return ((await res.json()) as { text: string }).text;
  }
  async close() {}
}

/** Fake Deepgram: answers per `mode` – a text, an HTTP status (echoing the request's Authorization header), or never. */
async function fakeCloud() {
  const state = { mode: 'ok' as 'ok' | 'hang' | number, requests: 0, aborted: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    req.resume();
    res.on('close', () => {
      if (!res.writableEnded) state.aborted++;
    });
    req.on('end', () => {
      if (state.mode === 'hang') return;
      if (state.mode === 'ok') return res.end(JSON.stringify({ text: 'aus der Cloud' }));
      res.statusCode = state.mode;
      res.end(`{"err_msg":"bad credentials ${req.headers.authorization}"}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, url, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

// ─────────────── defaults = today ───────────────

describe('T2 providers: defaults are today', () => {
  it('ConfigSchema.parse({}) keeps the local engines exactly as before', () => {
    const v = ConfigSchema.parse({}).voice;
    expect(v).toMatchObject({ stt: 'whisper', sttCloudFor: ['answer', 'confirm', 'full'], cloudFallback: 'local', warmFallback: true, sttTimeoutMs: 2500, cloudCooldownSec: 300 });
    expect(v.deepgram).toEqual({ baseUrl: 'https://api.eu.deepgram.com', keyEnv: 'DEEPGRAM_API_KEY', sttModel: 'nova-3', language: 'de', keyterms: true });
    for (const a of ['answer', 'confirm', 'full', 'wake'] as const) expect(sttPlan(v)[a].cloud).toBe(false);
    expect(sttNeeds(v)).toEqual({ required: [v.whisperModel], fallback: [], cloud: false });
  });

  it('the kit is built as before: WhisperServerStt, the two-model rule, no wrapper, no extra routes', async () => {
    const dir = tmp('qbprov-');
    const kit = createVoiceKit(ConfigSchema.parse({ voice: { dir } }));
    expect(kit.stt).toBeInstanceOf(WhisperServerStt);
    expect((kit.stt as WhisperServerStt).port).toBe(8178);
    expect(kit.fastStt).toBeUndefined();
    expect(kit.confirmStt).toBeUndefined();
    expect(kit.wakeStt).toBeUndefined();
    const two = createVoiceKit(ConfigSchema.parse({ voice: { dir, whisperFastModel: 'models/ggml-base-q5_1.bin' } }));
    expect(two.stt).toBeInstanceOf(WhisperServerStt);
    expect(two.fastStt).toBeInstanceOf(WhisperServerStt);
    expect((two.fastStt as WhisperServerStt).port).toBe(8179);
    expect(two.fastStt!.engine).toBe('whisper:base-q5_1');
    expect(two.confirmStt).toBeUndefined();
    expect(two.wakeStt).toBeUndefined();
    await Promise.all([kit.close(), two.close()]);
  });

  it('a cloud key in the environment changes nothing while voice.stt is whisper', () => {
    const r = createSttRoutes(voiceCfg(), { env: ENV, cloud: () => expect.fail('no cloud engine') });
    expect(r.stt).toBeInstanceOf(WhisperServerStt);
    expect(r.breaker).toBeUndefined();
  });
});

// ─────────────── routing ───────────────

describe('T2 providers: routing per attention', () => {
  const deps = (texts = new Texts()): SttRouteDeps & { made: string[] } => {
    const made: string[] = [];
    return {
      made,
      env: ENV,
      cloud: () => fakeStt('deepgram:nova-3', texts),
      local: ({ model }) => (made.push(path.basename(model)), fakeStt(`whisper:${path.basename(model)}`, texts)),
    };
  };
  const fb = (s: SpeechToText | undefined) => (s instanceof FallbackStt ? `cloud→${s.fallback?.engine ?? 'none'}` : s?.engine);

  it('default list: answer/confirm/full in the cloud with the local engine of the same attention as fallback, wake local', () => {
    const r = createSttRoutes(voiceCfg({ stt: 'deepgram', whisperFastModel: 'models/fast.bin' }), deps());
    expect([fb(r.stt), fb(r.confirmStt), fb(r.fastStt), fb(r.wakeStt)]).toEqual([
      'cloud→whisper:ggml-large-v3-turbo-q5_0.bin',
      'cloud→whisper:fast.bin',
      'cloud→whisper:fast.bin',
      'whisper:fast.bin',
    ]);
    expect(r.confirmStt).toBe(r.fastStt); // same pair → one wrapper
    // Without a fast model, wake hears with the main model, like today.
    const one = createSttRoutes(voiceCfg({ stt: 'deepgram' }), deps());
    expect(fb(one.wakeStt)).toBe('whisper:ggml-large-v3-turbo-q5_0.bin');
  });

  it('what is not in sttCloudFor stays local by today’s rule', () => {
    const r = createSttRoutes(voiceCfg({ stt: 'deepgram', whisperFastModel: 'models/fast.bin', sttCloudFor: ['answer'] }), deps());
    expect([fb(r.stt), fb(r.confirmStt), fb(r.fastStt), fb(r.wakeStt)]).toEqual(['cloud→whisper:ggml-large-v3-turbo-q5_0.bin', 'whisper:fast.bin', 'whisper:fast.bin', 'whisper:fast.bin']);
    const c = createSttRoutes(voiceCfg({ stt: 'deepgram', sttCloudFor: ['confirm'] }), deps());
    expect([fb(c.stt), fb(c.confirmStt), fb(c.fastStt)]).toEqual(['whisper:ggml-large-v3-turbo-q5_0.bin', 'cloud→whisper:ggml-large-v3-turbo-q5_0.bin', 'whisper:ggml-large-v3-turbo-q5_0.bin']);
  });

  it('cloudFallback none, wake in the cloud too: no local engine at all', () => {
    const d = deps();
    const r = createSttRoutes(voiceCfg({ stt: 'deepgram', cloudFallback: 'none', sttCloudFor: ['answer', 'confirm', 'full', 'wake'] }), d);
    expect([fb(r.stt), fb(r.fastStt), fb(r.wakeStt)]).toEqual(['cloud→none', 'cloud→none', 'cloud→none']);
    expect(d.made).toEqual([]);
  });

  it('warmFallback decides whether the local fallbacks start on join', async () => {
    const texts = new Texts();
    const started: string[] = [];
    const local = ({ model }: { model: string }) => ({ ...fakeStt(path.basename(model), texts), warmup: async () => void started.push(path.basename(model)) });
    const v = voiceCfg({ stt: 'deepgram', whisperFastModel: 'models/fast.bin' });
    for (const warmFallback of [true, false]) {
      started.length = 0;
      const r = createSttRoutes({ ...v, warmFallback }, { env: ENV, cloud: () => fakeStt('deepgram:nova-3', texts), local });
      await Promise.all([...r.warm, ...r.warmFallback].map((s) => s.warmup?.()));
      expect(started.sort()).toEqual(warmFallback ? ['fast.bin', 'ggml-large-v3-turbo-q5_0.bin'] : ['fast.bin']); // wake (fast) always
    }
  });

  it('privacy: side talk of people not on turn never reaches the cloud – only after the local wake check heard the wake word', async () => {
    const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' } });
    r.transport.speak(BEN, r.texts.pcm('Und dann hat er gesagt, das sei Paris gewesen', 3000));
    r.transport.speak(BEN, r.texts.pcm('Hm, keine Ahnung', 1000));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.cloud.calls).toEqual([]);
    expect(r.locals['fast.bin']!.calls).toHaveLength(2);
    expect(r.heard).toEqual([]);
    // Short: the local wake check heard all of it – still nothing to the cloud.
    r.transport.speak(BEN, r.texts.pcm('Quizmaster, Stand', 1500));
    await until(() => r.heard.length === 1);
    expect(r.cloud.calls).toEqual([]);
    // Long: wake word heard locally in the first 2 s, then the whole utterance goes the 'full' route.
    r.transport.speak(BEN, r.texts.pcm('Quizmaster, wie ist eigentlich der Stand', 3000));
    await until(() => r.heard.length === 2);
    expect(r.cloud.calls.map((c) => c.text)).toEqual(['Quizmaster, wie ist eigentlich der Stand']);
    // Anna is on turn ('answer'): her utterances go to the cloud.
    r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
    await until(() => r.heard.length === 3);
    expect(r.cloud.calls).toHaveLength(2);
  });

  it('privacy: with wake in sttCloudFor (the operator’s choice) the wake check goes to the cloud', async () => {
    const r = cloudRig({ voice: { sttCloudFor: ['answer', 'confirm', 'full', 'wake'] } });
    r.transport.speak(BEN, r.texts.pcm('Und dann hat er gesagt', 3000));
    await until(() => r.cloud.calls.length === 1);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.heard).toEqual([]);
  });

  it('the confirm pass asks the main route again only if it is another engine', async () => {
    // confirm and answer both in the cloud: one engine – no second request for the same audio.
    const r = cloudRig({ attention: () => 'confirm' });
    r.transport.speak(ANNA, r.texts.pcm('Nein, meine Antwort ist Rom'));
    await until(() => r.heard.length === 1);
    expect(r.cloud.calls).toHaveLength(1);
    // Only the answer in the cloud: confirm hears locally first, a new answer goes to the cloud.
    const s = cloudRig({ attention: () => 'confirm', voice: { sttCloudFor: ['answer'], whisperFastModel: 'models/fast.bin' } });
    s.transport.speak(ANNA, s.texts.pcm('Nein, meine Antwort ist Rom'));
    await until(() => s.heard.length === 1);
    expect([s.locals['fast.bin']!.calls.length, s.cloud.calls.length]).toEqual([1, 1]);
  });

  it('promptTerms splits the bot’s prompt only: trimmed, no duplicates, at most 50', () => {
    expect(promptTerms('Quizmaster, Meine Antwort ist,  Hier , Sport für 100, 100, Sport, sport, ,Anna')).toEqual(['Quizmaster', 'Meine Antwort ist', 'Hier', 'Sport für 100', '100', 'Sport', 'Anna']);
    expect(promptTerms('')).toEqual([]);
    expect(promptTerms(Array.from({ length: 80 }, (_, i) => `w${i}`).join(', '))).toHaveLength(50);
    expect(promptTerms('a, b, c', 2)).toEqual(['a', 'b']);
  });
});

// ─────────────── review T2+T3: F1/F2 – nothing goes out on a failed local check or for people not allowed ───────────────

describe('T2 review F1/F2: no cloud when the local check fails or the speaker is not allowed', () => {
  const failing = (s: FakeStt) => {
    s.transcribe = async (_pcm, prompt = '') => {
      s.calls.push({ text: 'x', prompt });
      throw new Error('whisper-server 500');
    };
  };

  it('F1: the fast wake model fails → the local main model checks, never the cloud', async () => {
    const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' } });
    failing(r.locals['fast.bin']!);
    r.transport.speak(BEN, r.texts.pcm('Quizmaster, wie ist der Stand', 4000));
    await until(() => r.heard.length === 1);
    // Wake word heard locally by the main model: then (and only then) the command may go to the cloud.
    expect(r.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.map((c) => c.text)).toEqual(['Quizmaster, wie ist der Stand']);
    expect(r.cloud.calls.map((c) => c.text)).toEqual(['Quizmaster, wie ist der Stand']);
    r.transport.speak(BEN, r.texts.pcm('Mein Bruder hat heute Geburtstag', 4000));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.cloud.calls).toHaveLength(1); // side talk: never
  });

  it('F1: every local wake engine fails → the utterance is dropped (0 cloud calls), one warning a minute, counted', async () => {
    const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' } });
    failing(r.locals['fast.bin']!);
    failing(r.locals['ggml-large-v3-turbo-q5_0.bin']!);
    const { out } = await captureLog(async () => {
      r.transport.speak(BEN, r.texts.pcm('Quizmaster, Hilfe, mein Bruder hat Geburtstag', 4000));
      r.transport.speak(BEN, r.texts.pcm('Und noch mehr Nebengespräch', 4000));
      await until(() => r.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.length === 2);
      await new Promise((res) => setTimeout(res, 30));
    });
    expect(r.cloud.calls).toEqual([]);
    expect(r.heard).toEqual([]);
    expect(out.match(/Rufnamen-Prüfung gescheitert \(lokale Erkennung nicht bereit\) – Äußerung verworfen/g)).toHaveLength(1);
    expect(out).not.toMatch(/warn.*(Bruder|Nebengespräch)/);
    r.host.latencySummary();
    // Only dropped checks: no summary line of its own (T1-F10), the count waits for the next one.
    expect(r.lines.filter((l) => l.startsWith('⏱ bilanz'))).toEqual([]);
    r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
    await until(() => r.heard.length === 1);
    r.host.latencySummary();
    expect(r.lines.at(-1)).toMatch(/^⏱ bilanz n=1 .* verworfen=2 /);
  });

  it('F1: cloudFallback none, local wake engine fails → dropped, not sent', async () => {
    const r = cloudRig({ voice: { cloudFallback: 'none' } });
    failing(r.locals['ggml-large-v3-turbo-q5_0.bin']!);
    r.transport.speak(BEN, r.texts.pcm('Quizmaster, Stand', 1500));
    await until(() => r.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.length === 1);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.cloud.calls).toEqual([]);
  });

  it('F1: a local route (full not in sttCloudFor) that fails falls back to the local main model, not the cloud', async () => {
    const r = cloudRig({ voice: { sttCloudFor: ['answer'], whisperFastModel: 'models/fast.bin' }, attention: () => 'full' });
    failing(r.locals['fast.bin']!);
    r.transport.speak(ANNA, r.texts.pcm('Geschichte für dreihundert'));
    await until(() => r.heard.length === 1);
    expect(r.cloud.calls).toEqual([]);
    expect(r.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.map((c) => c.text)).toEqual(['Geschichte für dreihundert']);
    expect(r.lines[0]).toMatch(/engine=whisper:fast\+whisper:ggml-large-v3-turbo-q5_0 attention=full .* rueckfall=ja$/);
  });

  it('F2: someone the bot does not clearly let speak is heard locally in every attention – 0 cloud calls', async () => {
    for (const attention of ['answer', 'confirm', 'full'] as const) {
      const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' }, attention: () => attention, cloudAllowed: () => false });
      r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
      await until(() => r.heard.length === 1);
      expect(r.cloud.calls).toEqual([]);
      const used = attention === 'answer' ? 'ggml-large-v3-turbo-q5_0.bin' : 'fast.bin';
      expect(r.locals[used]!.calls).toHaveLength(1);
    }
    // In doubt (the check throws) also local.
    const t = cloudRig({ cloudAllowed: () => {
      throw new Error('kaputt');
    } });
    t.transport.speak(ANNA, t.texts.pcm('Meine Antwort ist Paris'));
    await until(() => t.heard.length === 1);
    expect(t.cloud.calls).toEqual([]);
  });

  it('F2: not allowed and no local engine at all (cloudFallback none, wake in the cloud) → dropped, not sent', async () => {
    const r = cloudRig({ voice: { cloudFallback: 'none', sttCloudFor: ['answer', 'confirm', 'full', 'wake'] }, attention: () => 'full', cloudAllowed: () => false });
    expect(r.routes.localStt).toBeNull();
    r.transport.speak(ANNA, r.texts.pcm('Ich bin nur Zuschauer'));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.cloud.calls).toEqual([]);
    expect(r.heard).toEqual([]);
  });
});

// ─────────────── delta review F10/F12: VoiceHost closes safely on its own ───────────────

describe('T2 delta review F10/F12: only cloudAllowed === true sends audio out; a local-only route never is a cloud one', () => {
  it('F10: cloudAllowed undefined, truthy but not true, throwing or missing → 0 cloud calls, heard locally', async () => {
    const answers: [string, ((s: Speaker, t: number) => boolean) | null][] = [
      ['undefined', () => undefined as unknown as boolean],
      ['"ja"', () => 'ja' as unknown as boolean],
      ['1', () => 1 as unknown as boolean],
      ['{}', () => ({}) as unknown as boolean],
      ['throws', () => {
        throw new Error('kaputt');
      }],
      ['missing', null],
    ];
    for (const [label, cloudAllowed] of answers) {
      for (const attention of ['answer', 'confirm', 'full'] as const) {
        const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' }, attention: () => attention, cloudAllowed });
        r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
        await until(() => r.heard.length === 1);
        expect(r.cloud.calls, `${label} ${attention}`).toEqual([]);
      }
    }
  });

  it('F10: the utterance begin goes to cloudAllowed; without a known begin it stays local', async () => {
    const asked: number[] = [];
    const r = cloudRig({ cloudAllowed: (_s, startedAt) => (asked.push(startedAt), true) });
    const pcm = r.texts.pcm('Meine Antwort ist Paris', 1000);
    const endedAt = Date.now();
    r.transport.speak(ANNA, pcm); // FakeTransport: startedAt = endedAt − 1000 ms
    await until(() => r.heard.length === 1);
    expect(asked).toHaveLength(1);
    expect(Math.abs(asked[0]! - (endedAt - 1000))).toBeLessThan(50);
    expect(r.cloud.calls).toHaveLength(1);
    // A transport start later than end − audio length: the earlier one counts (at most the audio length).
    const s = cloudRig({ cloudAllowed: (_s, startedAt) => (asked.push(startedAt), true) });
    let h: (u: Utterance) => void = () => {};
    const t: VoiceTransport = { label: 't', play: async () => {}, stop() {}, onUtterance: (f) => void (h = f), onClose() {}, close: async () => {} };
    const host = new VoiceHost({ transport: t, stt: s.routes.stt, localStt: s.routes.localStt, tts: silentTts, cfg: s.cfg, prompt: () => '', attention: () => 'answer', onSpeech: () => {}, cloudAllowed: (_x, startedAt) => (asked.push(startedAt), true) });
    const now = Date.now();
    h({ speaker: ANNA, pcm: s.texts.pcm('Paris', 1000), startedAt: now - 10, endedAt: now });
    await until(() => asked.length === 2);
    expect(Math.abs(asked[1]! - (now - 1000))).toBeLessThan(5);
    h({ speaker: ANNA, pcm: s.texts.pcm('Rom', 1000), startedAt: Number.NaN, endedAt: now });
    await until(() => s.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.some((c) => c.text === 'Rom'));
    expect(asked).toHaveLength(2); // not even asked
    expect(s.cloud.calls.map((c) => c.text)).toEqual(['Paris']); // "Rom" stayed local
    await host.close();
  });

  it('F10/F12: a kit without local engines: the local-only route never reaches the cloud adapter – dropped, counted, warned rarely', async () => {
    // Cloud routes wired, but localStt/localFastStt not passed (a careless new channel, a test kit).
    const r = cloudRig({ voice: { whisperFastModel: 'models/fast.bin' } });
    const transport = new FakeTransport();
    const heard: string[] = [];
    const lines: string[] = [];
    let allowed = false;
    const host = new VoiceHost({
      transport,
      stt: r.routes.stt,
      fastStt: r.routes.fastStt,
      confirmStt: r.routes.confirmStt,
      wakeStt: r.routes.wakeStt,
      tts: silentTts,
      cfg: r.cfg,
      prompt: () => '',
      attention: (sp) => (sp.id === ANNA.id ? 'full' : 'wake'),
      cloudAllowed: () => allowed,
      onSpeech: (_s, t, used) => (heard.push(t), used()),
      latencyLog: (l) => lines.push(l),
    });
    const { out } = await captureLog(async () => {
      transport.speak(ANNA, r.texts.pcm('Ich bin nicht dran'));
      transport.speak(ANNA, r.texts.pcm('Ich auch nicht'));
      // Wake check: the fast model fails – no local main to fall back to (stt is a cloud route) → dropped.
      r.locals['fast.bin']!.transcribe = async () => {
        throw new Error('whisper-server 500');
      };
      transport.speak(BEN, r.texts.pcm('Quizmaster, Hilfe', 4000));
      await new Promise((res) => setTimeout(res, 80));
    });
    expect(r.cloud.calls).toEqual([]);
    expect(heard).toEqual([]);
    expect(out.match(/Keine lokale Spracherkennung für eine Äußerung, die nicht in die Cloud darf – verworfen/g)).toHaveLength(1);
    expect(out).toContain('Rufnamen-Prüfung gescheitert');
    expect(out).not.toMatch(/warn.*(nicht dran|auch nicht)/);
    host.latencySummary();
    expect(lines).toEqual([]); // only drops: no summary of its own (T1-F10), they wait in `verworfen`
    allowed = true; // now Anna may: the cloud hears her, the next summary counts the three drops
    transport.speak(ANNA, r.texts.pcm('Jetzt bin ich dran'));
    await until(() => heard.length === 1);
    host.latencySummary();
    expect(lines.at(-1)).toMatch(/^⏱ bilanz n=1 .* verworfen=3 /);
    expect(r.cloud.calls.map((c) => c.text)).toEqual(['Jetzt bin ich dran']);
    await host.close();
  });

  it('F14: without wakeStt in the deps the wake check of people not on turn never goes to the cloud', async () => {
    for (const voice of [{ whisperFastModel: 'models/fast.bin' }, {}]) {
      const r = cloudRig({ voice });
      // a) no wakeStt and no local engine passed: dropped, warned rarely.
      const t1 = new FakeTransport();
      const heard: string[] = [];
      new VoiceHost({ transport: t1, stt: r.routes.stt, fastStt: r.routes.fastStt, tts: silentTts, cfg: r.cfg, prompt: () => '', attention: () => 'wake', cloudAllowed: () => true, onSpeech: (_s, t) => void heard.push(t) });
      const { out } = await captureLog(async () => {
        t1.speak(BEN, r.texts.pcm('Quizmaster, Hilfe, und noch mehr', 4000));
        t1.speak(BEN, r.texts.pcm('Nur Nebengespräch', 4000));
        await new Promise((res) => setTimeout(res, 60));
      });
      expect(r.cloud.calls).toEqual([]);
      expect(heard).toEqual([]);
      expect(out.match(/Keine lokale Spracherkennung für eine Äußerung, die nicht in die Cloud darf – verworfen/g)).toHaveLength(1);
      // b) no wakeStt, but the local main engine: it checks; only after the wake word may the command go out.
      const t2 = new FakeTransport();
      new VoiceHost({ transport: t2, stt: r.routes.stt, fastStt: r.routes.fastStt, localStt: r.routes.localStt, tts: silentTts, cfg: r.cfg, prompt: () => '', attention: () => 'wake', cloudAllowed: () => true, onSpeech: (_s, t) => void heard.push(t) });
      t2.speak(BEN, r.texts.pcm('Nur Nebengespräch, zweiter Teil', 4000));
      await until(() => r.locals['ggml-large-v3-turbo-q5_0.bin']!.calls.length === 1);
      await new Promise((res) => setTimeout(res, 30));
      expect(r.cloud.calls).toEqual([]);
    }
    // An explicit cloud wakeStt (`wake` in sttCloudFor) is the operator's choice and still goes out.
    const c = cloudRig({ voice: { sttCloudFor: ['answer', 'confirm', 'full', 'wake'] }, attention: () => 'wake' });
    c.transport.speak(BEN, c.texts.pcm('Nebengespräch', 3000));
    await until(() => c.cloud.calls.length === 1);
  });

  it('F10: types – a cloud route does not compile where only local engines are allowed', () => {
    const r = cloudRig();
    const deps: Pick<VoiceHostDeps, 'localStt'> = {
      // @ts-expect-error FallbackStt has cloud: true – not a LocalStt
      localStt: r.routes.stt as FallbackStt,
    };
    expect(isCloud(deps.localStt!)).toBe(true);
    expect(isCloud(r.locals['ggml-large-v3-turbo-q5_0.bin']!)).toBe(false);
    expect(new DeepgramStt({ baseUrl: 'https://api.eu.deepgram.com', apiKey: KEY, model: 'nova-3', language: 'de', keyterms: true }).cloud).toBe(true);
  });
});

// ─────────────── fallback, timeout, breaker ───────────────

describe('T2 providers: cloudFetch error classes (fake HTTP)', () => {
  it('maps 5xx, 429, 401, 403, 400, 413, timeout and network errors – and never puts the key in a message', async () => {
    const fake = await fakeCloud();
    try {
      const call = (timeoutMs = 2000, url = fake.url) =>
        cloudFetch(`${url}/v1/listen?keyterm=Paris`, { method: 'POST', headers: { Authorization: `Token ${KEY}` }, body: 'x', timeoutMs, service: 'Deepgram' }).then(
          () => null,
          (e: CloudError) => e,
        );
      const kinds: Record<string, unknown> = {};
      for (const status of [500, 503, 429, 401, 403, 400, 413]) {
        fake.state.mode = status;
        const e = await call();
        expect(e).toBeInstanceOf(CloudError);
        kinds[status] = [e!.kind, e!.status];
        expect(e!.message).not.toContain(KEY);
        expect(e!.message).not.toContain('Paris'); // no URL (keyterms) in messages
        expect(e!.message).toContain(`HTTP ${status}`);
      }
      expect(kinds).toEqual({ 500: ['server', 500], 503: ['server', 503], 429: ['rate', 429], 401: ['auth', 401], 403: ['auth', 403], 400: ['request', 400], 413: ['request', 413] });
      fake.state.mode = 'hang';
      const t = await call(80);
      expect([t!.kind, t!.message]).toEqual(['timeout', 'Deepgram: keine Antwort innerhalb von 80 ms']);
      await until(() => fake.state.aborted === 1); // the request is really cut off
      fake.state.mode = 'ok';
      expect(await call()).toBeNull();
    } finally {
      await fake.close();
    }
    const dead = await fakeCloud();
    await dead.close();
    const e = await cloudFetch(`${dead.url}/v1/listen`, { timeoutMs: 1000 }).catch((x: CloudError) => x);
    expect((e as CloudError).kind).toBe('network');
  });

  it('apiKey reads only the environment and names the variable, never a value', () => {
    expect(apiKey('DEEPGRAM_API_KEY', ENV)).toBe(KEY);
    expect(() => apiKey('DEEPGRAM_API_KEY', {})).toThrow('Kein Schlüssel: DEEPGRAM_API_KEY ist nicht gesetzt (in .env eintragen)');
    expect(redact(`x Token ${KEY} y ${KEY}`, [`Token ${KEY}`])).toBe('x *** y ***');
  });
});

describe('T2 providers: fallback to local (fake HTTP cloud)', () => {
  async function rig(timeoutMs = 2500) {
    const fake = await fakeCloud();
    const texts = new Texts();
    const local = fakeStt('whisper:main', texts);
    const breaker = new Breaker({ cooldownMs: 300_000, service: 'Deepgram' });
    const stt = new FallbackStt(new HttpStt(fake.url, KEY), local, { timeoutMs, breaker, secrets: [KEY] });
    const fallbacks: [string, boolean][] = [];
    const hear = (text: string) => stt.transcribe(texts.pcm(text), 'Sport, Anna', { onFallback: (e, tried) => fallbacks.push([e, tried]) });
    return { fake, local, breaker, stt, fallbacks, hear };
  }

  it('5xx, 429 and timeout: the same utterance is heard locally at once, and the breaker counts', async () => {
    const r = await rig(150);
    try {
      expect(await r.hear('Paris')).toBe('aus der Cloud');
      r.fake.state.mode = 503;
      expect(await r.hear('Rom')).toBe('Rom');
      r.fake.state.mode = 429;
      expect(await r.hear('Bern')).toBe('Bern');
      expect(r.breaker.state).toBe('closed');
      r.fake.state.mode = 'hang';
      const t0 = Date.now();
      expect(await r.hear('Wien')).toBe('Wien');
      expect(Date.now() - t0).toBeLessThan(1000);
      await until(() => r.fake.state.aborted === 1);
      expect(r.breaker.state).toBe('open'); // three in a row
      expect(r.local.calls.map((c) => c.text)).toEqual(['Rom', 'Bern', 'Wien']);
      expect(r.local.calls[0]!.prompt).toBe('Sport, Anna'); // the same prompt
      expect(r.fallbacks).toEqual([['whisper:main', true], ['whisper:main', true], ['whisper:main', true]]);
      // Paused: straight to local, the cloud is not asked.
      const before = r.fake.state.requests;
      expect(await r.hear('Oslo')).toBe('Oslo');
      expect(r.fake.state.requests).toBe(before);
      expect(r.fallbacks.at(-1)).toEqual(['whisper:main', false]);
    } finally {
      await r.fake.close();
    }
  });

  it('401/403: fallback, one warning, cloud off until restart', async () => {
    const r = await rig();
    try {
      r.fake.state.mode = 401;
      const { out } = await captureLog(async () => {
        expect(await r.hear('Paris')).toBe('Paris');
        r.fake.state.mode = 'ok';
        expect(await r.hear('Rom')).toBe('Rom'); // not asked any more
        expect(await r.hear('Bern')).toBe('Bern');
      });
      expect(r.fake.state.requests).toBe(1);
      expect(r.breaker.state).toBe('off');
      expect(out.match(/Deepgram-Schlüssel ungültig/g)).toHaveLength(1);
      expect(out).not.toContain(KEY);
    } finally {
      await r.fake.close();
    }
  });

  it('F4: 402 (credit used up): fallback, one warning, then no audio goes out any more', async () => {
    const r = await rig();
    try {
      r.fake.state.mode = 402;
      const { out } = await captureLog(async () => {
        expect(await r.hear('Paris')).toBe('Paris');
        r.fake.state.mode = 'ok';
        for (const t of ['Rom', 'Bern', 'Wien']) expect(await r.hear(t)).toBe(t);
      });
      expect(r.fake.state.requests).toBe(1);
      expect(r.breaker.state).toBe('off');
      expect(out.match(/Deepgram-Guthaben aufgebraucht – Cloud-Erkennung bis zum Neustart aus, höre lokal/g)).toHaveLength(1);
      expect(out).not.toMatch(/HTTP 402.*höre lokal/); // no warning per utterance
    } finally {
      await r.fake.close();
    }
  });

  it('400/413: only this request goes local, the breaker does not count', async () => {
    const r = await rig();
    try {
      for (const status of [400, 413, 400, 413]) {
        r.fake.state.mode = status;
        expect(await r.hear('Paris')).toBe('Paris');
      }
      expect(r.breaker.state).toBe('closed');
      r.fake.state.mode = 'ok';
      expect(await r.hear('Rom')).toBe('aus der Cloud');
    } finally {
      await r.fake.close();
    }
  });
});

describe('T2 providers: breaker, timeout and hanging adapters (fake timers)', () => {
  it('pauses after 3 failures in a row, tries again after the cooldown, pauses again on the next failure', () => {
    let now = 0;
    const b = new Breaker({ cooldownMs: 300_000, now: () => now });
    b.fail('server');
    b.fail('timeout');
    expect(b.allow()).toBe(true);
    b.fail('rate');
    expect([b.allow(), b.state]).toEqual([false, 'open']);
    now += 299_999;
    expect(b.allow()).toBe(false);
    now += 1;
    expect(b.allow()).toBe(true); // the new try
    b.fail('network');
    expect(b.allow()).toBe(false); // failed again: another cooldown
    now += 300_000;
    expect(b.allow()).toBe(true);
    b.ok();
    b.fail('server');
    expect(b.allow()).toBe(true); // count starts afresh after a success
    b.fail('request');
    b.fail('request');
    expect(b.allow()).toBe(true); // bad requests never count
    b.fail('auth');
    now += 10 ** 9;
    expect([b.allow(), b.state]).toEqual([false, 'off']);
  });

  it('sttTimeoutMs per try: the cloud request is aborted, the late answer dropped, onSpeech runs once', async () => {
    vi.useFakeTimers();
    let late: (t: string) => void = () => {};
    const r = cloudRig({
      cloud: (texts) => fakeStt('deepgram:nova-3', texts, () => new Promise<string>((res) => (late = res))),
    });
    r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
    await vi.advanceTimersByTimeAsync(2499);
    expect(r.heard).toEqual([]);
    expect(r.cloud.calls[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.cloud.calls[0]!.signal!.aborted).toBe(true);
    expect(r.heard).toEqual(['Meine Antwort ist Paris']); // the local fallback
    late('Meine Antwort ist London'); // the cloud answers after all
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.heard).toEqual(['Meine Antwort ist Paris']);
    expect(r.lines.filter((l) => l.startsWith('⏱ erkennung'))).toEqual([expect.stringMatching(/^⏱ erkennung engine=deepgram:nova-3\+whisper:ggml-large-v3-turbo-q5_0 attention=answer audio=1000ms stt=2500ms rueckfall=ja$/)]);
  });

  it('a hanging adapter that ignores its signal does not block recognition', async () => {
    vi.useFakeTimers();
    const r = cloudRig({ cloud: (texts) => fakeStt('deepgram:nova-3', texts, () => new Promise<string>(() => {})) });
    r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
    r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Rom'));
    await vi.advanceTimersByTimeAsync(2500);
    expect(r.heard.sort()).toEqual(['Meine Antwort ist Paris', 'Meine Antwort ist Rom']);
  });

  it('a throwing adapter (sync or async, also with errors in onTrouble) leaves no handler: no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sync: FakeStt = { engine: 'deepgram:nova-3', calls: [], transcribe: () => { throw new Error('kaputt'); }, close: async () => {} };
      const r = cloudRig({ cloud: () => sync });
      r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
      await until(() => r.heard.length === 1);
      const none = cloudRig({ voice: { cloudFallback: 'none' }, cloud: (t) => fakeStt('deepgram:nova-3', t, () => Promise.reject(new Error('weg'))) });
      const bad = new VoiceHost({
        transport: none.transport,
        stt: none.routes.stt,
        tts: silentTts,
        cfg: none.cfg,
        prompt: () => '',
        attention: () => 'answer',
        onSpeech: () => {},
        onTrouble: () => {
          throw new Error('Hinweis kaputt');
        },
      });
      none.transport.speak(ANNA, none.texts.pcm('Meine Antwort ist Rom'));
      await until(() => none.trouble.length === 1);
      await new Promise((res) => setTimeout(res, 50));
      expect(bad).toBeDefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('without fallback: errors as today plus onTrouble; with the local fallback failing too, also onTrouble', async () => {
    const r = cloudRig({ voice: { cloudFallback: 'none' }, cloud: (t) => fakeStt('deepgram:nova-3', t, () => Promise.reject(new CloudError('server', 'Deepgram: HTTP 503', 503))) });
    const { out } = await captureLog(async () => {
      r.transport.speak(ANNA, r.texts.pcm('Meine Antwort ist Paris'));
      await until(() => r.trouble.length === 1);
    });
    expect(out).toContain('Erkennung: Cloud-Erkennung gestört (Deepgram: HTTP 503), kein lokaler Rückfall');
    expect(r.heard).toEqual([]);
    // Local whisper not set up (fails): the fallback fails – the same notice.
    const s = cloudRig({ cloud: (t) => fakeStt('deepgram:nova-3', t, () => Promise.reject(new Error('weg'))) });
    s.locals['ggml-large-v3-turbo-q5_0.bin'] = s.locals['ggml-large-v3-turbo-q5_0.bin']!;
    const main = s.locals['ggml-large-v3-turbo-q5_0.bin']!;
    main.transcribe = async () => {
      throw new Error('Whisper-Modell fehlt');
    };
    s.transport.speak(ANNA, s.texts.pcm('Meine Antwort ist Paris'));
    await until(() => s.trouble.length === 1);
    expect(s.trouble[0]).toContain('lokaler Rückfall gescheitert: Whisper-Modell fehlt');
    // With default whisper a local failure stays as today: no notice.
    const texts = new Texts();
    const transport = new FakeTransport();
    const trouble: string[] = [];
    new VoiceHost({
      transport,
      stt: fakeStt('whisper:x', texts, () => Promise.reject(new Error('kaputt'))),
      tts: silentTts,
      cfg: voiceCfg({ minRms: 0, minSpeechMs: 0 }),
      prompt: () => '',
      attention: () => 'answer',
      onSpeech: () => {},
      onTrouble: (m) => trouble.push(m),
    });
    transport.speak(ANNA, texts.pcm('Paris'));
    await new Promise((res) => setTimeout(res, 50));
    expect(trouble).toEqual([]);
  });

  it('rueckfall=ja: cloud → local and fast → main model show in ⏱ erkennung and in rueckfaelle (T1 review F4)', async () => {
    const r = cloudRig({ cloud: (t) => fakeStt('deepgram:nova-3', t, () => Promise.reject(new Error('weg'))), attention: () => 'full' });
    r.transport.speak(ANNA, r.texts.pcm('Sport für hundert'));
    await until(() => r.heard.length === 1);
    expect(r.lines).toEqual([expect.stringMatching(/^⏱ erkennung engine=deepgram:nova-3\+whisper:ggml-large-v3-turbo-q5_0 attention=full .* rueckfall=ja$/)]);
    // Local only: the fast model fails, the main model takes over.
    const texts = new Texts();
    const transport = new FakeTransport();
    const lines: string[] = [];
    const heard: string[] = [];
    const host = new VoiceHost({
      transport,
      stt: fakeStt('whisper:main', texts),
      fastStt: fakeStt('whisper:fast', texts, () => Promise.reject(new Error('nicht gestartet'))),
      tts: silentTts,
      cfg: voiceCfg({ minRms: 0, minSpeechMs: 0 }),
      prompt: () => '',
      attention: () => 'full',
      onSpeech: (_s, t, used) => (heard.push(t), used()),
      latencyLog: (l) => lines.push(l),
    });
    transport.speak(ANNA, texts.pcm('Sport für hundert'));
    await until(() => heard.length === 1);
    expect(lines[0]).toMatch(/^⏱ erkennung engine=whisper:fast\+whisper:main attention=full .* rueckfall=ja$/);
    host.latencySummary();
    expect(lines.at(-1)).toMatch(/ rueckfaelle=1$/);
    r.host.latencySummary();
    expect(r.lines.at(-1)).toMatch(/^⏱ bilanz n=1 .* rueckfaelle=1$/);
  });

  it('no summary with n=0 that only holds dropped wake checks (T1 review F10)', () => {
    const lines: string[] = [];
    const m = new LatencyMeter({ enabled: true, log: (l) => lines.push(l) });
    m.wakeDropped();
    m.wakeDropped();
    m.summary();
    expect(lines).toEqual([]);
    const h = m.recognised({ endedAt: 0, heardAt: 0, sttDoneAt: 300, attention: 'answer', audioMs: 900, passes: [{ engine: 'whisper:x' }], toBot: true });
    m.used(h);
    m.handled(h);
    m.summary();
    expect(lines.at(-1)).toMatch(/^⏱ bilanz n=1 .* verworfen=2 rueckfaelle=0$/);
  });
});

// ─────────────── voiceProblems / setup ───────────────

describe('T2 providers: voiceProblems and setup follow the routing', () => {
  function whisperDir() {
    const dir = tmp('qbprovw-');
    mkdirSync(path.join(dir, 'models'));
    writeFileSync(path.join(dir, 'models/main.bin'), 'x');
    const bin = path.join(dir, 'whisper-server');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    return { dir, bin };
  }
  const cfg = (voice: Record<string, unknown>) => ConfigSchema.parse({ voice: { tts: 'say', ...voice } });

  it('F5: deepgram.baseUrl must be https (http only to 127.0.0.1/localhost); a bad one is a clear config error', () => {
    for (const ok of ['https://api.eu.deepgram.com', 'https://api.deepgram.com/', 'http://127.0.0.1:1234', 'http://localhost:9', 'http://[::1]:80']) {
      expect(ConfigSchema.parse({ voice: { deepgram: { baseUrl: ok } } }).voice.deepgram.baseUrl).toBe(ok);
    }
    for (const bad of ['http://api.eu.deepgram.com', 'api.eu.deepgram.com', 'http://10.0.0.5:8080', 'ftp://x', '']) {
      expect(() => ConfigSchema.parse({ voice: { deepgram: { baseUrl: bad } } }), bad).toThrow(/muss mit https:\/\/ beginnen/);
    }
    const dir = tmp('qbcfg-');
    const file = path.join(dir, 'qbhost.config.json');
    writeFileSync(file, JSON.stringify({ voice: { stt: 'deepgram', deepgram: { baseUrl: 'api.eu.deepgram.com' } } }));
    expect(() => loadConfig(file)).toThrow(
      `Konfiguration ungültig (${file}): voice.deepgram.baseUrl: muss mit https:// beginnen (http:// nur zu 127.0.0.1 oder localhost), z.B. https://api.eu.deepgram.com`,
    );
  });

  it('F6: a missing fallback model is a warning, not a blocker – and warmup still lets the bot join', async () => {
    const { dir, bin } = whisperDir();
    writeFileSync(path.join(dir, 'models/fast.bin'), 'x');
    const c = cfg({ dir, whisperBin: bin, stt: 'deepgram', whisperFastModel: 'models/fast.bin', whisperModel: 'models/missing.bin' });
    expect(await voiceProblems(c, ENV)).toEqual([]);
    expect(await voiceWarnings(c)).toEqual(['Rückfall nicht verfügbar: Whisper-Modell fehlt (models/missing.bin)']);
    expect(await voiceWarnings(cfg({ dir, whisperBin: bin, whisperModel: 'models/main.bin' }))).toEqual([]); // local only: nothing
    expect(await voiceWarnings(cfg({ dir, whisperBin: '/nope/x', stt: 'deepgram', cloudFallback: 'none' }))).toEqual([]);
    const texts = new Texts();
    const kit = createVoiceKit(c, {
      env: ENV,
      tts: silentTts,
      cloud: () => fakeStt('deepgram:nova-3', texts),
      local: ({ model }) => ({
        ...fakeStt(`whisper:${path.basename(model)}`, texts),
        warmup: async () => {
          if (model.includes('missing')) throw new Error(`Whisper-Modell fehlt: ${model} – \`npx qbhost voice-setup\` ausführen`);
        },
      }),
    });
    const { out } = await captureLog(() => kit.warmup());
    expect(out).toContain('Rückfall nicht verfügbar (whisper:missing.bin): Whisper-Modell fehlt: models/missing.bin');
    // What hears on its own must still start: a broken wake model fails the join as before.
    const broken = createVoiceKit(c, {
      env: ENV,
      tts: silentTts,
      cloud: () => fakeStt('deepgram:nova-3', texts),
      local: ({ model }) => ({ ...fakeStt(model, texts), warmup: async () => Promise.reject(new Error(`kaputt ${path.basename(model)}`)) }),
    });
    await expect(captureLog(() => broken.warmup())).rejects.toThrow('kaputt fast.bin');
  });

  it('a missing key is a clear problem, no crash', async () => {
    const { dir, bin } = whisperDir();
    expect(await voiceProblems(cfg({ dir, whisperBin: bin, whisperModel: 'models/main.bin', stt: 'deepgram' }), {})).toEqual([
      'Deepgram-Schlüssel fehlt: DEEPGRAM_API_KEY in .env setzen (oder voice.stt: "whisper")',
    ]);
    expect(await voiceProblems(cfg({ dir, whisperBin: bin, whisperModel: 'models/main.bin', stt: 'deepgram' }), ENV)).toEqual([]);
    expect(await voiceProblems(cfg({ dir, whisperBin: bin, whisperModel: 'models/main.bin', stt: 'deepgram', deepgram: { keyEnv: 'MEIN_KEY' } }), ENV)).toEqual([
      'Deepgram-Schlüssel fehlt: MEIN_KEY in .env setzen (oder voice.stt: "whisper")',
    ]);
  });

  it('cloud with cloudFallback none and wake in the cloud needs no whisper at all', async () => {
    const v = { dir: tmp('qbprovn-'), whisperBin: '/nope/whisper-server', stt: 'deepgram', cloudFallback: 'none', sttCloudFor: ['answer', 'confirm', 'full', 'wake'] };
    expect(sttNeeds(cfg(v).voice)).toEqual({ required: [], fallback: [], cloud: true });
    expect(await voiceProblems(cfg(v), ENV)).toEqual([]);
  });

  it('default cloud list: the local wake check needs whisper; models that only stand in are no blocker', async () => {
    const dir = tmp('qbprovd-');
    const v = { dir, whisperBin: '/nope/whisper-server', stt: 'deepgram', whisperFastModel: 'models/fast.bin' };
    expect(sttNeeds(cfg(v).voice)).toEqual({ required: ['models/fast.bin'], fallback: ['models/ggml-large-v3-turbo-q5_0.bin'], cloud: true });
    expect(await voiceProblems(cfg(v), ENV)).toEqual(['/nope/whisper-server fehlt (' + (process.platform === 'darwin' ? 'brew install whisper.cpp' : 'whisper.cpp bauen (cmake --build … --target whisper-server) oder das Docker-Image nutzen, siehe docs/INSTALL.md') + ')', 'Whisper-Modell fehlt (models/fast.bin)']);
  });

  it('the key never shows in any log line or message', async () => {
    const fake = await fakeCloud();
    fake.state.mode = 401;
    try {
      const { out } = await captureLog(async () => {
        const texts = new Texts();
        const leaky: SpeechToText = { engine: 'deepgram:nova-3', transcribe: async () => Promise.reject(new Error(`kaputt mit Token ${KEY}`)), close: async () => {} };
        const a = new FallbackStt(leaky, fakeStt('whisper:x', texts), { timeoutMs: 1000, breaker: new Breaker({ cooldownMs: 1000 }), secrets: [KEY] });
        await a.transcribe(texts.pcm('Paris'));
        const b = new FallbackStt(new HttpStt(fake.url, KEY), null, { timeoutMs: 1000, breaker: new Breaker({ cooldownMs: 1000 }), secrets: [KEY] });
        const e = await b.transcribe(texts.pcm('Paris')).catch((x: Error) => x);
        expect(e).toBeInstanceOf(SttTrouble);
        expect((e as Error).message).not.toContain(KEY);
        const deepgram = new DeepgramStt({ baseUrl: fake.url, apiKey: KEY, model: 'nova-3', language: 'de', keyterms: true });
        expect(((await deepgram.transcribe(texts.pcm('x')).catch((x: Error) => x)) as Error).message).not.toContain(KEY);
        await voiceProblems(cfg({ stt: 'deepgram', whisperBin: '/nope/x' }), ENV);
        createSttRoutes(voiceCfg({ stt: 'deepgram' }), { env: ENV, local: () => fakeStt('whisper:x', texts) });
      });
      expect(out).toContain('Cloud-Erkennung (deepgram:nova-3): kaputt mit Token ***');
      expect(out).not.toContain(KEY);
      expect(out).not.toContain(KEY.slice(0, 12));
    } finally {
      await fake.close();
    }
  });

  it('Piper voices by the standard scheme are downloaded from rhasspy/piper-voices (thorsten-medium and others)', async () => {
    expect(piperVoiceUrl('models/de_DE-thorsten-medium.onnx')).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx');
    expect(piperVoiceUrl('models/de_DE-thorsten-high.onnx')).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx');
    expect(piperVoiceUrl('models/de_DE-thorsten_emotional-medium.onnx')).toBe('https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx');
    expect(piperVoiceUrl('en_GB-alba-x_low.onnx')).toContain('/en/en_GB/alba/x_low/en_GB-alba-x_low.onnx');
    for (const bad of ['models/meine-stimme.onnx', 'models/de_DE-thorsten.onnx', 'models/de_DE-thorsten-ultra.onnx', 'models/de-thorsten-high.onnx']) expect(piperVoiceUrl(bad)).toBeNull();

    const served: string[] = [];
    const server = http.createServer((req, res) => {
      served.push(req.url!);
      if (req.url === '/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx') return res.end('ONNX');
      if (req.url === '/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json') return res.end('{"audio":{}}');
      res.statusCode = 404;
      res.end('nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const dir = tmp('qbpiper-');
      await setupPiperVoice(voiceCfg({ dir, piperVoice: 'models/de_DE-thorsten-medium.onnx' }), base);
      expect(readFileSync(path.join(dir, 'models/de_DE-thorsten-medium.onnx'), 'utf8')).toBe('ONNX');
      expect(readFileSync(path.join(dir, 'models/de_DE-thorsten-medium.onnx.json'), 'utf8')).toBe('{"audio":{}}');
      await setupPiperVoice(voiceCfg({ dir, piperVoice: 'models/de_DE-thorsten-medium.onnx' }), base); // there already: nothing loaded
      expect(served).toHaveLength(2);
      await expect(setupPiperVoice(voiceCfg({ dir, piperVoice: 'models/de_DE-gibtsnicht-low.onnx' }), base)).rejects.toThrow(
        'Piper-Stimme de_DE-gibtsnicht-low.onnx konnte nicht geladen werden (HTTP 404). Name prüfen: https://huggingface.co/rhasspy/piper-voices',
      );
      expect(existsSync(path.join(dir, 'models/de_DE-gibtsnicht-low.onnx'))).toBe(false);
      await expect(setupPiperVoice(voiceCfg({ dir, piperVoice: 'models/meine-stimme.onnx' }), base)).rejects.toThrow('passt nicht zum Schema <sprache>_<REGION>-<name>-<qualität>.onnx');
      writeFileSync(path.join(dir, 'models/meine-stimme.onnx'), 'x'); // an own voice that is there: fine, as before
      await setupPiperVoice(voiceCfg({ dir, piperVoice: 'models/meine-stimme.onnx' }), base);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ─────────────── TTS deadline (T5 review F9) ───────────────

/**
 * A fake Piper worker (Node behind `venv/bin/python`): answers with a WAV whose first sample is the text
 * length; loses the first request with "Hänger". Serial like Piper: `msPerChar` per character, one job
 * after the other; `loadMs` until ready. Each started worker appends its PID to `pids.txt`.
 */
function fakePiper(o: { loadMs?: number; msPerChar?: number } = {}) {
  const dir = tmp('qbfakepiper-');
  mkdirSync(path.join(dir, 'venv/bin'), { recursive: true });
  mkdirSync(path.join(dir, 'models'));
  writeFileSync(path.join(dir, 'models/de_DE-test-high.onnx'), 'x');
  const py = path.join(dir, 'venv/bin/python');
  writeFileSync(
    py,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs'); const path = require('path'); const rl = require('readline');",
      "const here = path.dirname(process.argv[1]); const flag = path.join(here, 'hung');",
      `const LOAD = ${o.loadMs ?? 0}, PER_CHAR = ${o.msPerChar ?? 0};`,
      "fs.appendFileSync(path.join(here, 'pids.txt'), process.pid + '\\n');",
      'function wav(first) { const n = 1600; const b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); b.writeInt16LE(first, 44); return b.toString("base64"); }',
      'const jobs = []; let busy = false;',
      'function next() { if (busy || !jobs.length) return; const m = jobs.shift(); busy = true; setTimeout(() => { busy = false; process.stdout.write(JSON.stringify({ id: m.id, wav: wav(m.text.length) }) + "\\n"); next(); }, PER_CHAR * m.text.length); }',
      'setTimeout(() => {',
      '  console.log(JSON.stringify({ ready: true }));',
      "  rl.createInterface({ input: process.stdin }).on('line', (l) => {",
      '    const m = JSON.parse(l);',
      "    if (m.text.includes('Hänger') && !fs.existsSync(flag)) { fs.writeFileSync(flag, ''); return; }",
      '    jobs.push(m); next();',
      '  });',
      '}, LOAD);',
      "process.stdin.on('end', () => process.exit(0));",
    ].join('\n'),
  );
  chmodSync(py, 0o755);
  const cfg = voiceCfg({ dir, piperVoice: 'models/de_DE-test-high.onnx' });
  const pids = () => (existsSync(path.join(dir, 'venv/bin/pids.txt')) ? readFileSync(path.join(dir, 'venv/bin/pids.txt'), 'utf8').trim().split('\n').map(Number) : []);
  const alive = () => pids().filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  return Object.assign(cfg, { pids, alive });
}

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('T2: synthesis deadline keeps the voice alive when Piper loses an answer (T5 review F9)', () => {
  it('the deadline is generous: 10 s + 60 ms per character (246 characters → 24.8 s, ~3× the server’s 8 s)', () => {
    expect(synthDeadlineMs(246)).toBe(24_760);
    expect(synthDeadlineMs(0)).toBe(10_000);
  });

  it('a hung synthesis is given up after the deadline, the worker restarted, the next line spoken; no text in the warning', async () => {
    const tts = new PiperTts(fakePiper(), { deadlineMs: () => 400 });
    try {
      expect((await tts.synth('Hallo.')).samples[0]).toBe(6);
      const idle = timers();
      expect((await tts.synth('Hallo du.')).samples[0]).toBe(9);
      expect(timers()).toBeLessThanOrEqual(idle); // the deadline timer is cleared after success, none is left behind
      const { out, result } = await captureLog(async () => {
        const hung = await tts.synth('Ein Hänger mit Lösung Paris').catch((e) => e);
        return { hung, next: await tts.synth('Die nächste Ansage.') };
      });
      expect(result.hung).toBeInstanceOf(SynthTimeout);
      expect(result.next.samples[0]).toBe('Die nächste Ansage.'.length);
      expect(out).toMatch(/Sprachausgabe: Piper lieferte nach 0 s keinen Ton – Ansage übersprungen, starte Piper neu/);
      expect(out).not.toMatch(/Hänger|Paris/);
    } finally {
      await tts.close();
    }
  });

  it('split sentences: the engine loses part 2, the group is cleared – the next line still plays', async () => {
    const cfg = { ...fakePiper(), ttsSplitSentences: true, minRms: 0, minSpeechMs: 0 };
    const tts = new PiperTts(cfg, { deadlineMs: () => 400 });
    const transport = new FakeTransport();
    const host = new VoiceHost({ transport, stt: fakeStt('whisper:x', new Texts()), tts, cfg, prompt: () => '', onSpeech: () => {} });
    try {
      const P1 = 'Der erste Satz ist lang genug.';
      const P2 = 'Danach kommt ein Hänger in der Lösung.';
      const { out } = await captureLog(async () => {
        void host.say(`${P1} ${P2}`);
        await until(() => transport.played.length === 1);
        await new Promise((r) => setTimeout(r, 50)); // in the gap: part 2 is lost in the engine
        host.clear();
        await host.say('Noch keine Punkte bisher.');
      });
      expect(transport.played.map((p) => p.samples[0])).toEqual([P1.length, 'Noch keine Punkte bisher.'.length]);
      expect(out).toContain('Sprachausgabe: Piper lieferte nach 0 s keinen Ton');
      expect(out).not.toMatch(/warn.*Hänger|TTS „/);
    } finally {
      await host.close();
      await tts.close();
    }
  }, 10000);

  it('F3: the deadline runs only while the worker is busy with the job – a short line behind a long question never kills it', async () => {
    // About 1:20 of the real numbers: deadline 300 ms + 4 ms/character, Piper 3.3 ms/character (66 ms real
    // under load). The short line's deadline (380 ms) is far below the long line's synthesis (~810 ms).
    // The warm-up line includes the worker start (slow under test load): a generous deadline for it.
    const cfg = fakePiper({ msPerChar: 3.3 });
    const tts = new PiperTts(cfg, { deadlineMs: (c) => (c < 10 ? 10_000 : 300 + 4 * c) });
    try {
      await tts.synth('Hallo.');
      const { out, result } = await captureLog(async () =>
        Promise.allSettled([tts.synth(`Geschichte für 300. ${'x'.repeat(226)}`), tts.synth('Anna, deine Antwort?')]),
      );
      expect(result.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(result.map((r) => (r as PromiseFulfilledResult<Pcm>).value.samples[0])).toEqual([246, 20]);
      expect(cfg.pids()).toHaveLength(1); // no restart
      expect(out).not.toContain('keinen Ton');
    } finally {
      await tts.close();
    }
  });

  it('F3: without ttsSplitSentences the question and "deine Antwort?" both play, in order', async () => {
    const cfg = { ...fakePiper({ msPerChar: 3.3 }), minRms: 0, minSpeechMs: 0 };
    const tts = new PiperTts(cfg, { deadlineMs: (c) => (c < 10 ? 10_000 : 300 + 4 * c) });
    const transport = new FakeTransport();
    const host = new VoiceHost({ transport, stt: fakeStt('whisper:x', new Texts()), tts, cfg, prompt: () => '', onSpeech: () => {} });
    try {
      await tts.synth('Hallo.'); // the worker start (slow under test load) is not what this test is about
      const q = `Geschichte für 300. ${'x'.repeat(226)}`;
      const a = host.say(q);
      await host.say('Anna, deine Antwort?');
      await a;
      expect(transport.played.map((p) => p.samples[0])).toEqual([q.length, 20]);
    } finally {
      await host.close();
      await tts.close();
    }
  });

  it('F7: a restart while Piper starts loses no waiting line and leaves exactly one worker; after close() none', async () => {
    const cfg = fakePiper({ loadMs: 800 });
    const tts = new PiperTts(cfg, { deadlineMs: (c) => (c < 10 ? 300 : 3000) });
    try {
      const t0 = Date.now();
      const { result } = await captureLog(async () => {
        const a = tts.synth('kurz').then(() => 'ok', (e: Error) => e.message); // deadline 300 ms < 800 ms start
        const b = tts.synth('Ein längerer Satz wartet auf denselben Start.').then((p) => p.samples[0]);
        await new Promise((r) => setTimeout(r, 320)); // right after the restart
        const c = tts.synth('Gleich nach dem Neustart.').then((p) => p.samples[0]);
        const results = await Promise.all([a, b, c]);
        const d = await tts.synth('Später noch ein Satz.').then((p) => p.samples[0]);
        return [...results, d];
      });
      expect(result).toEqual(['Piper: keine Antwort nach 0 s', 'Ein längerer Satz wartet auf denselben Start.'.length, 'Gleich nach dem Neustart.'.length, 'Später noch ein Satz.'.length]);
      expect(Date.now() - t0).toBeLessThan(3000);
      await until(() => cfg.alive().length === 1); // the killed one is gone
      expect(cfg.pids()).toHaveLength(2); // the hung start + exactly one fresh worker
    } finally {
      await tts.close();
    }
    await until(() => cfg.alive().length === 0);
  }, 10000);

  it('F7: close() during a start rejects the waiting lines and leaves no Piper process', async () => {
    const cfg = fakePiper({ loadMs: 500 });
    const tts = new PiperTts(cfg);
    const a = tts.synth('Erster Satz.').catch((e: Error) => e.message);
    const b = tts.synth('Zweiter Satz.').catch((e: Error) => e.message);
    await until(() => cfg.pids().length === 1);
    await tts.close();
    expect(await Promise.all([a, b])).toEqual(['Piper beendet', 'Piper beendet']);
    await until(() => cfg.alive().length === 0);
    await new Promise((r) => setTimeout(r, 600));
    expect(cfg.pids()).toHaveLength(1); // nothing started again
  });
});

// ─────────────── the bot with voice.stt: deepgram ───────────────

/** Real controller + fake quiz-base page (as in discord-bot.test.ts). */
class FakeSession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  page: FakeTafelquizPage;
  private ac = new AbortController();
  board = '';
  constructor(private config: Config) {
    this.page = new FakeTafelquizPage(
      ['Anna', 'Ben'],
      [
        [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
        [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine' }],
      ],
    );
    this.rules = { ...config.game };
  }
  async createLobby(board: string) {
    this.board = board;
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

/** Voice room: utterances carry their text id; the bot's speech is recorded by text. */
class Room implements VoiceTransport {
  label = 'room';
  played: string[] = [];
  private handlers: ((u: Utterance) => void)[] = [];
  constructor(private texts: Map<number, string>) {}
  async play(pcm: Pcm) {
    this.played.push(this.texts.get(pcm.samples[0]!) ?? '?');
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

/** Room utterances are 0.5 s long: wait until one begun now starts after the last change of permission. */
const settle = () => new Promise((r) => setTimeout(r, 600));

/** A local port nobody listens on: the real adapter fails at once – never the real endpoint, no network. */
async function closedUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

function botRig(voice: Record<string, unknown>, deps: Omit<SttRouteDeps, 'local' | 'env'> = {}) {
  const dir = tmp('qbprovbot-');
  const config = ConfigSchema.parse({
    game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 5, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, minPlayers: 2 },
    judge: { cacheFile: path.join(dir, 'cache.json'), strategy: 'fuzzy' },
    llm: { provider: 'none' },
    discord: { dataDir: dir },
    voice: { ignoreWhileSpeaking: false, dir, ...voice },
  });
  const texts = new Map<number, string>();
  const room = new Room(texts);
  const local: string[] = [];
  const kit = createVoiceKit(config, {
    ...deps,
    env: ENV,
    // Fake whisper: hears the utterance's text.
    local: ({ model }) => ({ engine: `whisper:${path.basename(model, '.bin').replace(/^ggml-/, '')}`, transcribe: async (p) => (local.push(texts.get(p.samples[0]!) ?? ''), texts.get(p.samples[0]!) ?? ''), close: async () => {} }),
  });
  // The routes are the kit's; speech and warm-up are fakes (no Piper, no whisper-server).
  const voiceKit: VoiceKit = {
    stt: kit.stt,
    fastStt: kit.fastStt,
    confirmStt: kit.confirmStt,
    wakeStt: kit.wakeStt,
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
  let handler: (m: ChatMessage) => Promise<void> | void = () => {};
  const sent: string[] = [];
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
    handler({ id: String(++n), channelId: 'chan', guildId: 'guild', author: { ...ANNA, isBot: false }, content, mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc' });
  const bot = new QuizBot({ gateway: gw, config, store: new GuildStore(dir), createSession: (cfg) => new FakeSession(cfg), listBoards: async (q) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())), voice: voiceKit });
  return { bot, room, sent, type, local, kit };
}

describe('T2: the bot with voice.stt deepgram and a fake key, Deepgram unreachable', () => {
  it('starts, the cloud fails, and every utterance is heard locally through the fallback', async () => {
    const r = botRig({ stt: 'deepgram', deepgram: { baseUrl: await closedUrl() } });
    expect(r.kit.stt).toBeInstanceOf(FallbackStt);
    expect((r.kit.stt as FallbackStt).primary).toBeInstanceOf(DeepgramStt);
    const lines: string[] = [];
    const { out } = await captureLog(async () => {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      r.room.speak(ANNA, 'Quizmaster, neues Quiz Board'); // wake check: local only
      await until(() => r.room.played.some((t) => t.includes('Dazu passen 2 Boards')));
      await settle(); // an utterance counts for the cloud only if it began after the permission (F11)
      r.room.speak(ANNA, 'Nummer eins'); // menu ('full'): cloud → unreachable → local
      await until(() => !!r.bot.activeGame?.turn, 8000);
      await settle();
      r.room.speak(ANNA, 'Sport für hundert');
      await until(() => r.room.played.some((t) => t.includes('Wie viele Pins')));
      await until(() => !!r.bot.activeGame?.awaiting);
      await settle();
      r.room.speak(ANNA, 'Meine Antwort ist zehn.');
      await until(() => r.room.played.includes('zehn?'));
      await settle();
      r.room.speak(ANNA, 'Ja, genau.');
      await until(() => r.room.played.some((t) => t.startsWith('Richtig')));
      await r.bot.shutdown();
    });
    for (const l of out.split('\n')) {
      const m = l.match(/\[voice\] (⏱ erkennung .*)$/);
      if (m) lines.push(m[1]!);
    }
    expect(out).not.toContain(KEY);
    expect(out).toContain('Cloud-Erkennung (deepgram:nova-3): Deepgram: nicht erreichbar (ECONNREFUSED) – höre lokal');
    expect(r.local).toEqual(['Quizmaster, neues Quiz Board', 'Nummer eins', 'Sport für hundert', 'Meine Antwort ist zehn.', 'Ja, genau.']);
    expect(lines[0]).toMatch(/engine=whisper:large-v3-turbo-q5_0 attention=wake .* rueckfall=nein$/);
    for (const l of lines.slice(1)) expect(l).toMatch(/rueckfall=ja$/);
    expect(r.sent.join('\n')).not.toContain('Sprache gestört'); // the fallback worked
  }, 30000);

  it('without a fallback: "⚠️ Sprache gestört – bitte tippen" once per game', async () => {
    const r = botRig({ stt: 'deepgram', cloudFallback: 'none', deepgram: { baseUrl: await closedUrl() } });
    const trouble = () => r.sent.filter((t) => t.includes('⚠️ Sprache gestört – bitte tippen')).length;
    await r.type('!quiz voice');
    await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
    await r.type('!quiz neu Test Board');
    await until(() => !!r.bot.activeGame?.turn, 8000);
    await settle();
    r.room.speak(ANNA, 'Sport für hundert'); // on turn ('full') → cloud unreachable, nothing local
    r.room.speak(ANNA, 'Sport für hundert');
    await until(() => trouble() === 1);
    r.room.speak(ANNA, 'Sport für hundert');
    await new Promise((res) => setTimeout(res, 800)); // the outbox flushes after 600 ms
    expect(trouble()).toBe(1);
    await r.type('!quiz ende');
    await until(() => !r.bot.activeGame);
    await r.type('!quiz neu Test Board');
    await until(() => !!r.bot.activeGame?.turn, 8000);
    await settle();
    r.room.speak(ANNA, 'Sport für hundert');
    await until(() => trouble() === 2);
    await r.bot.shutdown();
  }, 30000);
});
