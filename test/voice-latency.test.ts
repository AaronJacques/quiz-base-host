import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { durationMs, type Pcm } from '../src/voice/audio.ts';
import { percentile } from '../src/voice/latency.ts';
import type { SpeechToText } from '../src/voice/stt.ts';
import type { PlayOptions, Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import { CachedTts, type TextToSpeech } from '../src/voice/tts.ts';
import { VoiceHost, type Attention } from '../src/voice/voice-host.ts';
import { formatReport, parseLatency, summarize } from '../tools/voice-latency.ts';

setLogLevel((process.env.QB_LOG as any) ?? 'error');

const ERKENNUNG = /^⏱ erkennung engine=[\w.:+-]+ attention=(answer|confirm|full|wake) audio=\d+ms stt=\d+ms rueckfall=(ja|nein)$/;
const ANSAGE = /^⏱ ansage engine=[\w.:+-]+ zeichen=\d+ tts=\d+ms cache=(ja|nein) warte=\d+ms$/;
const REAKTION = /^⏱ reaktion gesamt=(\d+)ms pause=(\d+)ms stt=(\d+)ms logik=(\d+)ms tts=(\d+)ms start=(\d+)ms$/;
const BILANZ = /^⏱ bilanz n=\d+ stt_p50=(\d+ms|-) stt_p90=(\d+ms|-) tts_p50=(\d+ms|-) tts_p90=(\d+ms|-) reaktion_p50=(\d+ms|-) reaktion_p90=(\d+ms|-) verworfen=\d+ rueckfaelle=\d+$/;

const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const tone = (ms: number, rate = 16000): Pcm => ({ rate, channels: 1, samples: Int16Array.from({ length: (rate * ms) / 1000 }, (_, i) => Math.round(Math.sin(i / 5) * 8000)) });

class FakeTransport implements VoiceTransport {
  readonly label = 'fake';
  private handlers: ((u: Utterance) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  /** Delay between `play` and the sound starting (Discord's player needs a moment). */
  constructor(private startDelay = 0) {}
  play(pcm: Pcm, opts?: PlayOptions): Promise<void> {
    return new Promise((resolve) => {
      const start = () => {
        opts?.onStart?.();
        setTimeout(resolve, durationMs(pcm));
      };
      if (this.startDelay) setTimeout(start, this.startDelay);
      else start();
    });
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
  /** Someone spoke `ms` long and stopped `pauseMs` ago (the silence detection). */
  speak(ms = 1000, pauseMs = 900): void {
    const endedAt = Date.now() - pauseMs;
    const u: Utterance = { speaker: ANNA, pcm: tone(ms), startedAt: endedAt - ms, endedAt };
    this.handlers.forEach((h) => h(u));
  }
}

/** Answers after `delay` ms with whatever is next in `texts`. */
function fakeStt(engine: string, delay: number, texts: string[]): SpeechToText {
  return {
    engine,
    transcribe: () => new Promise((r) => setTimeout(() => r(texts.shift() ?? ''), delay)),
    close: async () => {},
  };
}

/** One sentence at a time, like the Piper worker: `delay` ms each, 500 ms of audio. */
function serialTts(delay: number): TextToSpeech {
  let busy: Promise<unknown> = Promise.resolve();
  return {
    engine: 'piper:de_DE-thorsten-high',
    synth: () => {
      const p = busy.then(() => new Promise<Pcm>((r) => setTimeout(() => r(tone(500, 22050)), delay)));
      busy = p;
      return p;
    },
    close: async () => {},
  };
}

interface Rig {
  host: VoiceHost;
  transport: { speak(ms?: number, pauseMs?: number): void };
  lines: string[];
}

function rig(opts: {
  texts: string[];
  sttDelay?: number;
  ttsDelay?: number;
  startDelay?: number;
  attention?: Attention;
  cfg?: Partial<Config['voice']>;
  /** Does the bot act on this text (posts its transcript → `used()`)? Default: yes. */
  use?: (text: string) => boolean;
  onSpeech?: (host: VoiceHost, text: string, used: () => void) => void | Promise<void>;
  stt?: SpeechToText;
  fastStt?: SpeechToText;
  tts?: TextToSpeech;
  transport?: VoiceTransport & { speak(ms?: number, pauseMs?: number): void };
}): Rig {
  const cfg = { ...ConfigSchema.parse({}).voice, minRms: 0, minSpeechMs: 0, ...opts.cfg };
  const transport = opts.transport ?? new FakeTransport(opts.startDelay);
  const lines: string[] = [];
  const host: VoiceHost = new VoiceHost({
    transport,
    stt: opts.stt ?? fakeStt('whisper:large-v3-turbo-q5_0', opts.sttDelay ?? 400, opts.texts),
    fastStt: opts.fastStt,
    tts: opts.tts ?? serialTts(opts.ttsDelay ?? 300),
    cfg,
    prompt: () => 'Geschichte, Anna, Ben',
    onSpeech: (_s, text, used) => {
      if (opts.use?.(text) ?? true) used();
      return opts.onSpeech?.(host, text, used);
    },
    attention: () => opts.attention ?? 'answer',
    latencyLog: (l) => lines.push(l),
  });
  return { host, transport, lines };
}

const reactionOf = (lines: string[]) => lines.map((l) => l.match(REAKTION)).filter((m) => m !== null);

describe('voice latency: ⏱ lines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('logs recognition, announcement, reaction and summary in the documented format', async () => {
    const r = rig({
      texts: ['Meine Antwort ist Paris'],
      startDelay: 80,
      onSpeech: async (host) => {
        await new Promise((res) => setTimeout(res, 30)); // judging
        void host.say('Richtig, Anna! Paris ist die Lösung.');
      },
    });
    r.transport.speak(1500, 900);
    await vi.advanceTimersByTimeAsync(3000);
    const [erk, ans, rea] = r.lines;
    expect(erk).toMatch(ERKENNUNG);
    expect(erk).toBe('⏱ erkennung engine=whisper:large-v3-turbo-q5_0 attention=answer audio=1500ms stt=400ms rueckfall=nein');
    expect(ans).toMatch(ANSAGE);
    expect(ans).toBe(`⏱ ansage engine=piper:de_DE-thorsten-high zeichen=${'Richtig, Anna! Paris ist die Lösung.'.length} tts=300ms cache=nein warte=0ms`);
    expect(rea).toMatch(REAKTION);
    // pause 900 + stt 400 + logik 30 + tts 300 + start 80 = 1710
    expect(rea).toBe('⏱ reaktion gesamt=1710ms pause=900ms stt=400ms logik=30ms tts=300ms start=80ms');
    r.host.latencySummary(); // game over (the bot's finish)
    expect(r.lines.at(-1)).toMatch(BILANZ);
    expect(r.lines.at(-1)).toBe('⏱ bilanz n=1 stt_p50=400ms stt_p90=400ms tts_p50=300ms tts_p90=300ms reaktion_p50=1710ms reaktion_p90=1710ms verworfen=0 rueckfaelle=0');
    // A second game in the same voice session starts from zero: nothing new → no summary line.
    const n = r.lines.length;
    r.host.latencySummary();
    expect(r.lines.length).toBe(n);
  });

  it('never puts recognised or spoken text, names or solutions into ⏱ lines', async () => {
    const r = rig({ texts: ['Meine Antwort ist Konstantinopel'], onSpeech: (host) => void host.say('Konstantinopel? Anna, sag Ja oder Nein.') });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(3000);
    void r.host.say('Die Lösung war Byzanz, Ben ist dran.');
    await vi.advanceTimersByTimeAsync(3000);
    r.host.latencySummary();
    expect(r.lines.length).toBeGreaterThanOrEqual(5);
    for (const l of r.lines) {
      expect(l).toMatch(/^⏱ /);
      expect(l).not.toMatch(/Konstantinopel|Byzanz|Anna|Ben|Antwort|Lösung|Geschichte/i);
      // only key=value pairs after the kind
      expect(l.split(' ').slice(2).every((kv) => /^[a-z_0-9]+=[\w.:+-]+$/.test(kv))).toBe(true);
    }
  });

  it('times the first sentence after a processed utterance – and nothing more than 15 s after onSpeech', async () => {
    const r = rig({ texts: ['Sport für 200'], onSpeech: () => {} });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(400 + 14_000);
    void r.host.say('Sport für zweihundert.'); // within the window
    await vi.advanceTimersByTimeAsync(2000);
    void r.host.say('Ben, du bist dran.'); // a second sentence is no reaction
    await vi.advanceTimersByTimeAsync(2000);
    expect(reactionOf(r.lines)).toHaveLength(1);
    expect(reactionOf(r.lines)[0]![4]).toBe('14000'); // logik

    const late = rig({ texts: ['Sport für 200'], onSpeech: () => {} });
    late.transport.speak();
    await vi.advanceTimersByTimeAsync(400 + 15_001);
    void late.host.say('Sport für zweihundert.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(late.lines.some((l) => ANSAGE.test(l))).toBe(true);
    expect(reactionOf(late.lines)).toHaveLength(0);
  });

  it('keeps the window open while onSpeech still runs (slow judging) and attributes the reply to the latest utterance', async () => {
    const slow = rig({
      texts: ['Meine Antwort ist Rom'],
      onSpeech: async (host) => {
        await new Promise((res) => setTimeout(res, 20_000));
        void host.say('Leider falsch.');
      },
    });
    slow.transport.speak();
    await vi.advanceTimersByTimeAsync(22_000);
    expect(reactionOf(slow.lines)).toHaveLength(1);

    let sttDelay = 400;
    const texts = ['Hier', 'Meine Antwort ist Rom'];
    const lines: string[] = [];
    const cfg = { ...ConfigSchema.parse({}).voice, minRms: 0, minSpeechMs: 0 };
    const transport = new FakeTransport();
    const host: VoiceHost = new VoiceHost({
      transport,
      stt: { engine: 'whisper:x', transcribe: () => new Promise((res) => setTimeout(() => res(texts.shift()!), sttDelay)), close: async () => {} },
      tts: serialTts(300),
      cfg,
      prompt: () => '',
      onSpeech: (_s, text, used) => {
        used(); // both are used ("Hier" is a buzz) – the latest wins
        if (text.includes('Rom')) void host.say('Rom?');
      },
      latencyLog: (l) => lines.push(l),
    });
    transport.speak(); // "Hier" – processed, nothing said
    await vi.advanceTimersByTimeAsync(1000);
    sttDelay = 250;
    transport.speak(); // the answer: its reply is the reaction
    await vi.advanceTimersByTimeAsync(2000);
    const rs = reactionOf(lines);
    expect(rs).toHaveLength(1);
    expect(rs[0]![3]).toBe('250'); // stt of the second utterance
  });

  it('counts the real synthesis time as tts and the wait behind another synthesis as warte', async () => {
    const r = rig({ texts: [], ttsDelay: 300 });
    void r.host.say('Erster Satz.');
    void r.host.say('Zweiter Satz.');
    await vi.advanceTimersByTimeAsync(3000);
    const ans = r.lines.filter((l) => ANSAGE.test(l));
    expect(ans).toHaveLength(2);
    expect(ans[0]).toContain('tts=300ms cache=nein warte=0ms');
    // second: waits 300 ms for the first synthesis, then 300 ms synthesis; then waits until the first
    // sentence (500 ms of audio, started at 300) has played at 800 – synthesis was done at 600 → warte 300+200.
    expect(ans[1]).toContain('tts=300ms cache=nein warte=500ms');
  });

  it('gives a dropped wake check no line, only the counter in the summary', async () => {
    const r = rig({ texts: ['und dann hat er gesagt'], attention: 'wake', onSpeech: () => {} });
    r.transport.speak(3000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.lines).toEqual([]);
    await r.host.close(); // leaving the channel
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(BILANZ);
    expect(r.lines[0]).toContain('n=0');
    expect(r.lines[0]).toContain('verworfen=1');
  });

  it('logs the wake word utterance with both passes once the wake word is heard', async () => {
    const r = rig({ texts: ['Quizmaster', 'Quizmaster, wie ist der Stand'], attention: 'wake', onSpeech: () => {} });
    r.transport.speak(3000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.lines).toEqual(['⏱ erkennung engine=whisper:large-v3-turbo-q5_0 attention=wake audio=3000ms stt=800ms rueckfall=nein']);
  });

  it('writes no ⏱ line at all with voice.latencyLog: false', async () => {
    const r = rig({ texts: ['Meine Antwort ist Paris', 'blabla'], cfg: { latencyLog: false }, onSpeech: (host) => void host.say('Paris?') });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(3000);
    void r.host.say('Weiter geht es.');
    await vi.advanceTimersByTimeAsync(3000);
    r.host.latencySummary();
    await r.host.close();
    expect(r.lines).toEqual([]);
  });
});

describe('voice latency: review fixes (F1–F3, F5, F6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('F1: no reaction for an utterance the bot does not act on (thinking aloud), even if a sentence follows', async () => {
    const r = rig({ texts: ['hm, das war doch irgendwas mit Rom'], use: () => false });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(2400);
    void r.host.say('Noch zehn Sekunden.'); // the game's own timing, no reply to Anna
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.lines.some((l) => ERKENNUNG.test(l))).toBe(false);
    expect(reactionOf(r.lines)).toHaveLength(0);
    expect(r.lines.filter((l) => ANSAGE.test(l))).toHaveLength(1);
  });

  it('F1: side talk does not steal the reply of an earlier used utterance', async () => {
    const texts = ['Meine Antwort ist Rom', 'boah ist das schwer'];
    let reply: (() => void) | null = null;
    const r = rig({
      texts,
      use: (t) => t.includes('Antwort'),
      onSpeech: (host, t) => {
        if (t.includes('Antwort')) reply = () => void host.say('Rom?');
      },
    });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(500);
    r.transport.speak(); // Ben chats in a 'full' phase
    await vi.advanceTimersByTimeAsync(500);
    reply!();
    await vi.advanceTimersByTimeAsync(2000);
    const rs = reactionOf(r.lines);
    expect(rs).toHaveLength(1);
    expect(Number(rs[0]![4])).toBe(600); // logik: from the answer's STT end (400) to the reply (1000)
  });

  it('F5: an unused utterance in a full phase gets no line – only the counter, its STT time counts in the summary', async () => {
    const r = rig({ texts: ['und dann sind wir nach Hause', 'Sport für 200'], attention: 'full', use: (t) => t.startsWith('Sport') });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.lines).toEqual([]);
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.lines).toEqual(['⏱ erkennung engine=whisper:large-v3-turbo-q5_0 attention=full audio=1000ms stt=400ms rueckfall=nein']);
    r.host.latencySummary();
    expect(r.lines.at(-1)).toBe('⏱ bilanz n=1 stt_p50=400ms stt_p90=400ms tts_p50=- tts_p90=- reaktion_p50=- reaktion_p90=- verworfen=1 rueckfaelle=0');
  });

  it('logs the line when used() is called, keeps the times if onSpeech runs long or throws, ignores a late used()', async () => {
    let late: (() => void) | null = null;
    const r = rig({
      texts: ['Ja', 'Meine Antwort ist Rom'],
      use: () => false,
      onSpeech: async (host, t, used) => {
        if (t === 'Ja') {
          used();
          void host.say('Richtig, plus 100.'); // queued right away, judging continues
          await new Promise((res) => setTimeout(res, 20_000));
          throw new Error('quiz-base weg');
        }
        late = used;
      },
    });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(400);
    expect(r.lines[0]).toMatch(ERKENNUNG); // at used(), not after the 20 s
    await vi.advanceTimersByTimeAsync(1000);
    expect(reactionOf(r.lines)[0]![0]).toBe('⏱ reaktion gesamt=1600ms pause=900ms stt=400ms logik=0ms tts=300ms start=0ms');
    await vi.advanceTimersByTimeAsync(20_000);
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(1000);
    late!(); // after onSpeech returned: no longer counts
    expect(r.lines.filter((l) => ERKENNUNG.test(l))).toHaveLength(1);
  });

  it('F2: a cache hit says cache=ja, stays out of tts_p50/p90 and does not hide the running synthesis from the next sentence', async () => {
    const r = rig({ texts: [], tts: new CachedTts(serialTts(300)) });
    void r.host.say('Buzzer frei!');
    await vi.advanceTimersByTimeAsync(2000);
    void r.host.say('Satz A, neu.');
    await vi.advanceTimersByTimeAsync(10);
    void r.host.say('Buzzer frei!'); // hit
    await vi.advanceTimersByTimeAsync(10);
    void r.host.say('Satz C, neu.'); // waits for A's synthesis (started 20 ms earlier), then 300 ms
    await vi.advanceTimersByTimeAsync(5000);
    const ans = r.lines.filter((l) => ANSAGE.test(l));
    expect(ans).toHaveLength(4);
    expect(ans[2]).toMatch(/zeichen=12 tts=0ms cache=ja /);
    expect(ans[1]).toMatch(/tts=300ms cache=nein/);
    expect(ans[3]).toMatch(/tts=300ms cache=nein/);
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(1000);
    r.host.latencySummary();
    expect(r.lines.at(-1)).toContain('tts_p50=300ms tts_p90=300ms');
  });

  it('F3: a sentence that never plays gets neither ansage nor reaktion; transports without onStart count the play call', async () => {
    class Room {
      label = 'room';
      private h: ((u: Utterance) => void)[] = [];
      constructor(
        readonly reportsStart: boolean,
        private behave: 'stuck' | 'reject' | 'silent',
      ) {}
      play(): Promise<void> {
        if (this.behave === 'reject') return Promise.reject(new Error('kaputt'));
        return new Promise((res) => setTimeout(res, 500)); // never calls onStart
      }
      stop() {}
      onUtterance(h: (u: Utterance) => void) {
        this.h.push(h);
      }
      onClose() {}
      async close() {}
      speak(ms = 1000, pauseMs = 900) {
        const endedAt = Date.now() - pauseMs;
        this.h.forEach((h) => h({ speaker: ANNA, pcm: tone(ms), startedAt: endedAt - ms, endedAt }));
      }
    }
    for (const [room, lines] of [
      [new Room(true, 'stuck'), 0], // Discord never reached "Playing"
      [new Room(true, 'reject'), 0],
      [new Room(false, 'reject'), 0],
      [new Room(false, 'silent'), 2], // fake/old transport: play call = start
    ] as const) {
      const r = rig({ texts: ['Meine Antwort ist Rom'], transport: room, onSpeech: (host) => void host.say('Rom?') });
      room.speak();
      await vi.advanceTimersByTimeAsync(3000);
      expect(r.lines.filter((l) => ANSAGE.test(l) || REAKTION.test(l))).toHaveLength(lines);
    }
  });

  it('F3/F9: no reaction when the reply is replaced by key before it plays or its synthesis fails', async () => {
    const r = rig({
      texts: ['Meine Antwort ist Rom'],
      onSpeech: (host) => {
        void host.say('Rom?', { key: 'confirm' });
        void host.say('Okay.', { key: 'confirm' }); // replaces it – a sentence queued later is no reaction
      },
    });
    void r.host.say('Ein langer Satz davor.'); // keeps the queue busy
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(4000);
    expect(reactionOf(r.lines)).toHaveLength(0);

    const failing: TextToSpeech = { engine: 'piper:x', synth: () => Promise.reject(new Error('Piper weg')), close: async () => {} };
    const f = rig({ texts: ['Meine Antwort ist Rom'], tts: failing, onSpeech: (host) => void host.say('Rom?') });
    f.transport.speak();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.lines.filter((l) => ANSAGE.test(l) || REAKTION.test(l))).toEqual([]);
  });

  it('two models: the second pass of a confirm with a new answer shows both engines', async () => {
    const r = rig({
      texts: ['Meine Antwort ist zehn'],
      attention: 'confirm',
      fastStt: fakeStt('whisper:base-q5_1', 100, ['Meine Antwort ist zehn']),
    });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.lines).toEqual(['⏱ erkennung engine=whisper:base-q5_1+whisper:large-v3-turbo-q5_0 attention=confirm audio=1000ms stt=500ms rueckfall=nein']);
  });

  it('F6: the summary belongs to latencySummary(), not to clear(); right after one another only one is logged', async () => {
    const r = rig({ texts: ['Sport für 200'], onSpeech: (host) => void host.say('Sport für zweihundert.') });
    r.transport.speak();
    await vi.advanceTimersByTimeAsync(3000);
    r.host.clear(); // e.g. "Quizmaster, sei still" in the middle of a game
    expect(r.lines.some((l) => BILANZ.test(l))).toBe(false);
    r.host.latencySummary(); // finish()
    void r.host.say('Tschüss!'); // a goodbye alone is no new game
    await vi.advanceTimersByTimeAsync(2000);
    await r.host.close();
    expect(r.lines.filter((l) => BILANZ.test(l))).toHaveLength(1);
  });
});

describe('voice latency: tools/voice-latency.ts', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('reads a log file and reports p50/p90 per step and engine', () => {
    const samples = parseLatency(readFileSync(new URL('./fixtures/voice-latency-sample.txt', import.meta.url), 'utf8'));
    expect(samples).toHaveLength(13); // bilanz and other lines are skipped
    const rows = summarize(samples);
    const row = (step: string, engine: string) => rows.find((r) => r.step === step && r.engine === engine);
    expect(row('erkennung.stt', 'whisper:large-v3-turbo-q5_0')).toEqual({ step: 'erkennung.stt', engine: 'whisper:large-v3-turbo-q5_0', n: 3, p50: 412, p90: 900 });
    expect(row('erkennung.stt', 'whisper:base-q5_1')).toMatchObject({ n: 2, p50: 150, p90: 180 });
    expect(row('ansage.tts', 'piper:de_DE-thorsten-high')).toMatchObject({ n: 5, p50: 310, p90: 520 });
    expect(row('reaktion.gesamt', 'alle')).toMatchObject({ n: 3, p50: 1840, p90: 2600 });
    expect(rows[0]!.step).toBe('erkennung.audio');
    const report = formatReport(samples);
    expect(report).toMatch(/reaktion\.gesamt\s+alle\s+3\s+1840 ms\s+2600 ms/);
    expect(report).toContain('Rückfälle: 1, TTS aus dem Cache: 1');
    expect(formatReport([])).toContain('Keine ⏱-Zeilen');
  });

  it('F7: reads CRLF logs and only the logger’s own ⏱ lines', () => {
    const log = [
      '\x1b[36m20:01:09 [voice]\x1b[0m ⏱ erkennung engine=whisper:base-q5_1 attention=full audio=1200ms stt=150ms rueckfall=nein',
      'bot-1  | 20:01:10 [voice] ⏱ ansage engine=piper:x zeichen=5 tts=290ms cache=nein warte=0ms',
      '20:01:11 [discord] 🎙 ⏱ reaktion gesamt=99999ms: „⏱ reaktion gesamt=99999ms“', // a display name is no measurement
      '',
    ].join('\r\n');
    const samples = parseLatency(log);
    expect(samples.map((x) => x.kind)).toEqual(['erkennung', 'ansage']);
    expect(samples[1]!.fields.warte).toBe('0ms');
  });
});
