import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { durationMs, type Pcm } from '../src/voice/audio.ts';
import { createVoiceKit, isFixedSpeech, warmLines, WARM_MAX_CHARS } from '../src/voice/index.ts';
import * as narration from '../src/voice/narration.ts';
import { ANSWER_HOW_LINE, FIXED_LINES } from '../src/voice/narration.ts';
import type { SpeechToText } from '../src/voice/stt.ts';
import type { PlayOptions, Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import { CachedTts, decodeCacheFile, DiskCachedTts, encodeCacheFile, type TextToSpeech } from '../src/voice/tts.ts';
import { forSpeech, MIN_PART_CHARS, PART_GAP_LIMIT_MS, splitSentences, VoiceHost } from '../src/voice/voice-host.ts';

setLogLevel((process.env.QB_LOG as any) ?? 'error');

const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(5);
  }
}

/** Which text a PCM was made from (the fake engine tags them). */
const said = new WeakMap<Pcm, string>();

/**
 * One sentence at a time, like the Piper worker: `delay` ms per synthesis, `audioMs` of sound.
 * Records every call (and the most that ran at once).
 */
class FakeEngine implements TextToSpeech {
  readonly engine = 'piper:de_DE-thorsten-high';
  calls: string[] = [];
  finished: string[] = [];
  running = 0;
  maxRunning = 0;
  private busy: Promise<unknown> = Promise.resolve();
  constructor(
    private delay = 20,
    private audioMs = 60,
  ) {}
  synth(text: string): Promise<Pcm> {
    const p = this.busy.then(async () => {
      this.calls.push(text);
      this.running++;
      this.maxRunning = Math.max(this.maxRunning, this.running);
      await sleep(this.delay);
      this.running--;
      this.finished.push(text);
      const pcm: Pcm = { rate: 16000, channels: 1, samples: new Int16Array((16000 * this.audioMs) / 1000).fill(1000) };
      said.set(pcm, text);
      return pcm;
    });
    this.busy = p.catch(() => {});
    return p;
  }
  async close(): Promise<void> {}
}

class FakeTransport implements VoiceTransport {
  readonly label = 'fake';
  played: string[] = [];
  private utterance: ((u: Utterance) => void)[] = [];
  private speechStart: ((s: Speaker) => void)[] = [];
  private stopCurrent: (() => void) | null = null;
  /** The next n `play` calls fail without a sound. */
  failPlays = 0;
  /** End of the last playback. */
  lastEnd = 0;
  play(pcm: Pcm, opts?: PlayOptions): Promise<void> {
    if (this.failPlays > 0) {
      this.failPlays--;
      return Promise.reject(new Error('Wiedergabe kaputt'));
    }
    this.played.push(said.get(pcm) ?? '?');
    return new Promise((resolve) => {
      opts?.onStart?.();
      const end = () => {
        this.lastEnd = Date.now();
        resolve();
      };
      const t = setTimeout(end, durationMs(pcm));
      this.stopCurrent = () => {
        clearTimeout(t);
        end();
      };
    });
  }
  stop(): void {
    this.stopCurrent?.();
  }
  onUtterance(h: (u: Utterance) => void): void {
    this.utterance.push(h);
  }
  onSpeechStart(h: (s: Speaker) => void): void {
    this.speechStart.push(h);
  }
  private closeHandlers: (() => void)[] = [];
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  async close(): Promise<void> {
    this.closeHandlers.splice(0).forEach((h) => h());
  }
  startSpeaking(who: Speaker = ANNA): void {
    this.speechStart.forEach((h) => h(who));
  }
  /** Someone (Anna) started speaking `agoMs` ago and just stopped. */
  speak(agoMs: number, who: Speaker = ANNA): void {
    const now = Date.now();
    const u: Utterance = { speaker: who, pcm: { rate: 16000, channels: 1, samples: new Int16Array(16000).fill(3000) }, startedAt: now - agoMs, endedAt: now };
    this.utterance.forEach((h) => h(u));
  }
}

function voiceCfg(over: Partial<Config['voice']> = {}): Config['voice'] {
  return { ...ConfigSchema.parse({}).voice, ...over };
}

function rig(
  opts: { tts?: TextToSpeech; engine?: FakeEngine; split?: boolean; heard?: string[]; bargeIn?: boolean; mayInterrupt?: (s: Speaker) => boolean; transport?: FakeTransport } = {},
) {
  const engine = opts.engine ?? new FakeEngine();
  const transport = opts.transport ?? new FakeTransport();
  const lines: string[] = [];
  const speech: string[] = [];
  const heard = [...(opts.heard ?? [])];
  const stt: SpeechToText = { engine: 'whisper:fake', transcribe: async () => heard.shift() ?? '', close: async () => {} } as SpeechToText;
  const host = new VoiceHost({
    transport,
    stt,
    tts: opts.tts ?? engine,
    cfg: voiceCfg({ ttsSplitSentences: opts.split ?? true, bargeIn: opts.bargeIn ?? true }),
    prompt: () => '',
    onSpeech: (_s, text, used) => {
      used();
      speech.push(text);
    },
    attention: () => 'answer',
    mayInterrupt: opts.mayInterrupt ?? (() => true),
    latencyLog: (l) => lines.push(l),
  });
  return { host, engine, transport, lines, speech };
}

const LONG_QUESTION =
  'Geschichte für 400. Wer war der erste Präsident der Vereinigten Staaten von Amerika? Er wurde am 22. Februar 1732 geboren und führte die Kontinentalarmee im Unabhängigkeitskrieg. Sein Gesicht ist heute auf der Ein-Dollar-Note zu sehen.';

describe('splitSentences', () => {
  it('cuts a long question into sentences, the first one short', () => {
    const parts = splitSentences(LONG_QUESTION);
    expect(parts).toEqual([
      'Geschichte für 400. Wer war der erste Präsident der Vereinigten Staaten von Amerika?',
      'Er wurde am 22. Februar 1732 geboren und führte die Kontinentalarmee im Unabhängigkeitskrieg.',
      'Sein Gesicht ist heute auf der Ein-Dollar-Note zu sehen.',
    ]);
    expect(parts.join(' ')).toBe(LONG_QUESTION);
  });

  it('never cuts in numbers, decimals, times, ordinals or formulas', () => {
    expect(splitSentences('Wie viel ist eigentlich 3.5 mal 2? Es sind genau sieben, ganz sicher.')).toEqual(['Wie viel ist eigentlich 3.5 mal 2?', 'Es sind genau sieben, ganz sicher.']);
    expect(splitSentences('Der Krieg begann am 1. September 1939 in Europa mit dem Überfall.')).toHaveLength(1);
    expect(splitSentences('Der Zug fährt um 12.30 Uhr. Das ist etwas später als gedacht.')).toEqual(['Der Zug fährt um 12.30 Uhr.', 'Das ist etwas später als gedacht.']);
    expect(splitSentences('Rechne: 2 + 2 = 4. Und was ergibt dann 4 mal 4 genau?')).toHaveLength(1);
    expect(splitSentences('Ludwig XIV. regierte sehr lange über das Königreich Frankreich.')).toHaveLength(1);
  });

  it('never cuts after abbreviations or single letters', () => {
    expect(splitSentences('Nenne z. B. eine Hauptstadt in Europa, die am Meer liegt.')).toHaveLength(1);
    expect(splitSentences('Das sind ca. 300 Kilometer bis zur nächsten großen Stadt.')).toHaveLength(1);
    expect(splitSentences('Er lebte im 5. Jh. v. Chr. Und er war ein berühmter Philosoph.')).toHaveLength(1);
    expect(splitSentences('Das Haus Nr. 5 steht leer, das Haus Nr. 7 dagegen nicht.')).toHaveLength(1);
    expect(splitSentences('Gesucht ist d. h. der Name des Erfinders vom Telefon.')).toHaveLength(1);
  });

  it('keeps the answer options in one part', () => {
    const q = 'Erdkunde für 200. Welcher Fluss ist der längste der Welt? Die Möglichkeiten: A: Nil. B: Amazonas. C: Jangtse. Schaut dazu aufs Bild.';
    expect(splitSentences(q)).toEqual(['Erdkunde für 200. Welcher Fluss ist der längste der Welt?', 'Die Möglichkeiten: A: Nil. B: Amazonas. C: Jangtse. Schaut dazu aufs Bild.']);
    // The options start a part of their own and are never cut.
    expect(splitSentences('Welches Tier ist am schnellsten? A) Gepard. B) Löwe. C) Strauß.')).toEqual(['Welches Tier ist am schnellsten?', 'A) Gepard. B) Löwe. C) Strauß.']);
  });

  it('joins short parts to their neighbours and keeps "…" and quotes', () => {
    expect(splitSentences('Richtig! Plus 200.')).toEqual(['Richtig! Plus 200.']);
    expect(splitSentences('Niemand? Schade. Die richtige Antwort war: Paris.')).toEqual(['Niemand? Schade. Die richtige Antwort war: Paris.']);
    // The last part is short: it goes to the previous one.
    expect(splitSentences('Das war eine wirklich schwierige Frage heute. Weiter so!')).toEqual(['Das war eine wirklich schwierige Frage heute. Weiter so!']);
    expect(splitSentences('Er sagte ganz leise „Hallo Welt.“ Danach war es sehr lange still im Raum.')).toEqual(['Er sagte ganz leise „Hallo Welt.“', 'Danach war es sehr lange still im Raum.']);
    expect(splitSentences('Meine Antwort ist … Paris, ganz bestimmt und sicher.')).toHaveLength(1);
    for (const p of splitSentences(LONG_QUESTION)) expect(p.length).toBeGreaterThanOrEqual(MIN_PART_CHARS);
    expect(splitSentences('Kurz.')).toEqual(['Kurz.']);
  });
});

describe('VoiceHost: sentence groups (voice.ttsSplitSentences)', () => {
  it('plays all parts in order, without a later announcement in between', async () => {
    const r = rig();
    const a = r.host.say(LONG_QUESTION);
    const b = r.host.say('Anna, deine Antwort?');
    await Promise.all([a, b]);
    expect(r.transport.played).toEqual([...splitSentences(LONG_QUESTION), 'Anna, deine Antwort?']);
    // The engine got each part once, one after another.
    expect(r.engine.calls).toEqual(r.transport.played);
    expect(r.engine.maxRunning).toBe(1);
  });

  it('first part sounds while the rest is still being made', async () => {
    const r = rig({ engine: new FakeEngine(40, 200) });
    void r.host.say(LONG_QUESTION);
    await until(() => r.transport.played.length === 1);
    expect(r.engine.finished).toHaveLength(1);
  });

  it('barge-in drops the rest of the group; only the running synthesis finishes, the next line is next', async () => {
    const r = rig({ engine: new FakeEngine(30, 300) });
    const five = 'Das ist der erste Satz der Gruppe hier. Das ist der zweite Satz der Gruppe hier. Das ist der dritte Satz der Gruppe hier. Das ist der vierte Satz der Gruppe hier. Das ist der fünfte Satz der Gruppe hier.';
    expect(splitSentences(five)).toHaveLength(5);
    const done = r.host.say(five, { interruptible: true });
    await until(() => r.transport.played.length === 1);
    await sleep(10); // part 2 is now being synthesised
    r.transport.startSpeaking();
    await done; // the say resolves once its group is gone
    const next = r.host.say('Okay. Deine Antwort?');
    await next;
    expect(r.transport.played).toEqual(['Das ist der erste Satz der Gruppe hier.', 'Okay. Deine Antwort?']);
    // Part 1 and the part already running – nothing else of the group reached the engine.
    expect(r.engine.calls).toEqual(['Das ist der erste Satz der Gruppe hier.', 'Das ist der zweite Satz der Gruppe hier.', 'Okay. Deine Antwort?']);
  });

  it('a line with the same key replaces the whole group, also a part still being synthesised', async () => {
    const r = rig({ engine: new FakeEngine(60, 150) });
    const old = r.host.say(LONG_QUESTION, { key: 'turn' });
    await until(() => r.transport.played.length === 1);
    expect(r.engine.running).toBe(1); // part 2 in the engine
    const fresh = r.host.say('Ben, du bist dran. Welche Karte?', { key: 'turn' });
    await Promise.all([old, fresh]);
    expect(r.transport.played).toEqual([splitSentences(LONG_QUESTION)[0], 'Ben, du bist dran. Welche Karte?']);
    expect(r.engine.calls).not.toContain(splitSentences(LONG_QUESTION)[2]);
  });

  it('clear() drops all remaining parts', async () => {
    const r = rig({ engine: new FakeEngine(20, 150) });
    const p = r.host.say(LONG_QUESTION);
    await until(() => r.transport.played.length === 1);
    r.host.clear();
    await p;
    expect(r.transport.played).toHaveLength(1);
  });

  it('echo protection works per part: the bot hearing its own second part is ignored', async () => {
    const parts = splitSentences(LONG_QUESTION);
    const r = rig({ engine: new FakeEngine(10, 400), heard: [parts[1]!, 'Meine Antwort ist Washington'] });
    void r.host.say(LONG_QUESTION, { interruptible: true });
    await until(() => r.transport.played.length === 2);
    await sleep(50);
    r.transport.speak(20); // started during part 2 → the echo of part 2
    await sleep(50);
    expect(r.speech).toEqual([]);
    expect(r.transport.played).toHaveLength(2);
  });

  it('a real answer during a part is barge-in and stops the rest', async () => {
    const r = rig({ engine: new FakeEngine(10, 400), heard: ['Meine Antwort ist Washington'] });
    void r.host.say(LONG_QUESTION, { interruptible: true });
    await until(() => r.transport.played.length === 2);
    await sleep(50);
    r.transport.speak(20);
    await until(() => r.speech.length === 1);
    await sleep(500);
    expect(r.transport.played).toHaveLength(2);
  });

  it('logs one ⏱ ansage per part and the reaction on the first audible part', async () => {
    const r = rig({ heard: ['Meine Antwort ist Paris'] });
    r.transport.speak(500);
    await until(() => r.speech.length === 1);
    await r.host.say(LONG_QUESTION);
    const ansage = r.lines.filter((l) => l.startsWith('⏱ ansage'));
    expect(ansage.map((l) => Number(/zeichen=(\d+)/.exec(l)![1]))).toEqual(splitSentences(LONG_QUESTION).map((p) => p.length));
    const reaktion = r.lines.filter((l) => l.startsWith('⏱ reaktion'));
    expect(reaktion).toHaveLength(1);
    expect(r.lines.indexOf(reaktion[0]!)).toBe(r.lines.indexOf(ansage[0]!) + 1);
  });

  it('a first part without audio hands the reaction to the next part', async () => {
    const engine = new FakeEngine();
    let first = true;
    const failing: TextToSpeech = {
      engine: engine.engine,
      synth: (t) => (first ? ((first = false), Promise.reject(new Error('kaputt'))) : engine.synth(t)),
      close: async () => {},
    };
    const r = rig({ tts: failing, heard: ['Meine Antwort ist Paris'] });
    r.transport.speak(500);
    await until(() => r.speech.length === 1);
    await r.host.say(LONG_QUESTION);
    expect(r.transport.played).toEqual(splitSentences(LONG_QUESTION).slice(1));
    expect(r.lines.filter((l) => l.startsWith('⏱ reaktion'))).toHaveLength(1);
  });
});

describe('DiskCachedTts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-ttscache-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const disk = (engine: TextToSpeech, identity = 'piper|models/x.onnx|0.95') => new DiskCachedTts(engine, { dir, identity, allow: isFixedSpeech });
  const files = () => readdirSync(dir).filter((f) => f.endsWith('.pcm'));

  it('serves a stored fixed line after a restart without calling the engine', async () => {
    const a = new FakeEngine();
    const first = disk(a);
    expect(first.cached('Niemand? Schade.')).toBe(false);
    await first.synth('Niemand? Schade.');
    await until(() => files().length === 1);
    const b = new FakeEngine();
    const second = disk(b);
    expect(second.cached('Niemand? Schade.')).toBe(true);
    const pcm = await second.synth('Niemand? Schade.');
    expect(b.calls).toEqual([]);
    expect(pcm.samples.length).toBe(960);
    // Another voice or speed never hits.
    expect(disk(new FakeEngine(), 'piper|models/y.onnx|0.95').cached('Niemand? Schade.')).toBe(false);
  });

  it('only exact FIXED_LINES texts (and their parts) go to disk – never game content', async () => {
    const engine = new FakeEngine();
    const tts = new CachedTts(disk(engine));
    const r = rig({ tts, engine });
    await r.host.say(`Okay, wir starten! Anna, du bist dran. Welche Karte?`);
    await r.host.say(`${ANSWER_HOW_LINE} Anna, du bist dran.`);
    await r.host.say('Geschichte für 200. Wer war der erste Präsident der USA? Die richtige Antwort war: George Washington.');
    await r.host.say('Niemand? Schade. Die richtige Antwort war: Paris.');
    await r.host.say('Niemand? Schade.');
    await sleep(100);
    const keys = new Set(files().map((f) => f.slice(0, 64)));
    const d = disk(new FakeEngine());
    const stored = r.engine.calls.filter((t) => keys.has(d.key(t)));
    expect(stored).toEqual(['Antwortet immer mit: Meine Antwort ist, und dann eure Antwort.', 'Niemand? Schade.']);
    expect(keys.size).toBe(2);
    for (const t of r.engine.calls) if (/Anna|Paris|Washington|200/.test(t)) expect(keys.has(d.key(t))).toBe(false);
  });

  it('ignores broken, truncated and foreign files and writes them anew', async () => {
    const d = disk(new FakeEngine());
    const key = d.key('Niemand? Schade.');
    writeFileSync(path.join(dir, `${key}.pcm`), 'kaputt');
    const engine = new FakeEngine();
    const tts = disk(engine);
    expect(tts.cached('Niemand? Schade.')).toBe(false); // F4: the header is checked at the start
    const pcm = await tts.synth('Niemand? Schade.');
    expect(engine.calls).toEqual(['Niemand? Schade.']);
    expect(pcm.samples.length).toBe(960);
    await until(() => decodeCacheFile(readFileSync(path.join(dir, `${key}.pcm`)), key) !== null);

    const good = encodeCacheFile(pcm, key);
    expect(decodeCacheFile(good, key)?.samples.length).toBe(960);
    expect(decodeCacheFile(good, d.key('Noch keine Punkte.'))).toBeNull(); // foreign key
    expect(decodeCacheFile(good.subarray(0, good.length - 2), key)).toBeNull(); // truncated
    // A foreign file under a fixed line's name is not played.
    writeFileSync(path.join(dir, `${d.key('Noch keine Punkte.')}.pcm`), good);
    const e2 = new FakeEngine();
    await disk(e2).synth('Noch keine Punkte.');
    expect(e2.calls).toEqual(['Noch keine Punkte.']);
    // No leftover .part files.
    await sleep(50);
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('FIXED_LINES have no placeholders and still exist where they are spoken', () => {
    const constants = new Set(Object.values(narration).filter((v): v is string => typeof v === 'string'));
    const discord = ['src/discord/bot.ts', 'src/discord/voice-bridge.ts', 'src/voice/narration.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const line of FIXED_LINES) {
      expect(line).not.toMatch(/\$\{|\{|\}|„|“/); // no placeholders, no quoted answers
      if (constants.has(line)) continue;
      // A literal: spoken somewhere as exactly this text (not only listed in FIXED_LINES).
      const at = discord.split(`'${line}'`).length - 1;
      expect(at, line).toBeGreaterThanOrEqual(2);
    }
    for (const [name, value] of Object.entries(narration)) if (FIXED_LINES.includes(value as string)) expect(discord.includes(name), name).toBe(true);
    // Lines built from game data are never fixed.
    expect(isFixedSpeech(forSpeech(narration.turnLine({ player: 'Anna', categories: [], open: [], grid: [] } as never, false)))).toBe(false);
    expect(isFixedSpeech(forSpeech(narration.revealLine('Paris')))).toBe(false);
  });
});

describe('pre-warming fixed lines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-ttswarm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never starts while held, runs one synthesis at a time, only short lines', async () => {
    const engine = new FakeEngine(10);
    const tts = new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech });
    const release = tts.hold();
    const lines = warmLines(voiceCfg({ ttsSplitSentences: true }));
    expect(lines.every((l) => l.length <= WARM_MAX_CHARS && isFixedSpeech(l))).toBe(true);
    const warm = tts.warm(lines.slice(0, 4), { quietMs: 30 });
    await sleep(120);
    expect(engine.calls).toEqual([]);
    release();
    await warm;
    expect(engine.calls).toEqual(lines.slice(0, 4));
    expect(engine.maxRunning).toBe(1);
    await tts.close();
  });

  it('a line spoken during a pre-warm synthesis is next; warming waits for quiet again', async () => {
    const engine = new FakeEngine(60, 100);
    const disk = new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech });
    const r = rig({ tts: new CachedTts(disk), engine });
    const lines = warmLines(voiceCfg({ ttsSplitSentences: true })).slice(0, 3);
    void disk.warm(lines, { quietMs: 40 });
    await until(() => engine.calls.length === 1); // warm line 1 is in the engine
    const t0 = Date.now();
    const said = r.host.say(LONG_QUESTION);
    await until(() => r.transport.played.length === 1);
    expect(Date.now() - t0).toBeLessThan(200); // at most the one running warm synthesis plus part 1
    await said;
    expect(engine.calls.slice(0, 4)).toEqual([lines[0], ...splitSentences(LONG_QUESTION)]);
    await sleep(300);
    expect(engine.calls.slice(4)).toEqual(lines.slice(1));
    await disk.close();
  });
});

describe('defaults = behaviour before T5', () => {
  it('both switches are off', () => {
    const v = ConfigSchema.parse({}).voice;
    expect(v.ttsSplitSentences).toBe(false);
    expect(v.ttsDiskCache).toBe(false);
  });

  it('without splitting a long text is one sentence and one synthesis', async () => {
    const r = rig({ split: false });
    await r.host.say(LONG_QUESTION);
    expect(r.engine.calls).toEqual([LONG_QUESTION]);
    expect(r.lines.filter((l) => l.startsWith('⏱ ansage'))).toHaveLength(1);
  });

  it('without the disk cache nothing is written and nothing counts as stored', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-kit-'));
    try {
      const kit = createVoiceKit(ConfigSchema.parse({ voice: { dir } }));
      expect(kit.tts.cached('Niemand? Schade.')).toBe(false);
      expect(existsSync(path.join(dir, 'tts-cache'))).toBe(false);
      await kit.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const BEN: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };
const FIVE = 'Das ist der erste Satz der Gruppe hier. Das ist der zweite Satz der Gruppe hier. Das ist der dritte Satz der Gruppe hier.';
const [P1, P2, P3] = splitSentences(FIVE) as [string, string, string];

/** Every synthesis waits until the test resolves (or rejects) it – races are set up step by step. */
class ManualEngine implements TextToSpeech {
  readonly engine = 'piper:manual';
  calls: { text: string; resolve: () => void; reject: () => void }[] = [];
  constructor(private audioMs = 80) {}
  synth(text: string): Promise<Pcm> {
    return new Promise((resolve, reject) => {
      const pcm: Pcm = { rate: 16000, channels: 1, samples: new Int16Array((16000 * this.audioMs) / 1000).fill(1000) };
      said.set(pcm, text);
      this.calls.push({ text, resolve: () => resolve(pcm), reject: () => reject(new Error('Synthese kaputt')) });
    });
  }
  texts(): string[] {
    return this.calls.map((c) => c.text);
  }
  async finish(text: string): Promise<void> {
    await until(() => this.calls.some((c) => c.text === text));
    this.calls.find((c) => c.text === text)!.resolve();
  }
  async close(): Promise<void> {}
}

function manualRig(o: { interruptible?: boolean; mayInterrupt?: (s: Speaker) => boolean; heard?: string[]; audioMs?: number } = {}) {
  const engine = new ManualEngine(o.audioMs);
  const r = rig({ tts: engine, heard: o.heard, mayInterrupt: o.mayInterrupt });
  return { ...r, manual: engine };
}

/** Part 1 has played, part 2 is still in the engine: the gap within the group. */
async function inGap(r: ReturnType<typeof manualRig>): Promise<void> {
  await r.manual.finish(P1);
  await until(() => r.transport.lastEnd > 0);
  await until(() => r.manual.texts().includes(P2));
}

describe('T5 review: races with step-by-step syntheses (ZUSATZ)', () => {
  it('barge-in while part 1 plays and part 2 is ready: nothing more of the group, the queue goes on', async () => {
    const r = manualRig({ audioMs: 300 });
    const said1 = r.host.say(FIVE, { interruptible: true });
    await r.manual.finish(P1);
    await until(() => r.transport.played.length === 1);
    await r.manual.finish(P2);
    await sleep(10);
    r.transport.startSpeaking();
    await said1;
    r.manual.calls.forEach((c) => c.resolve());
    const next = r.host.say('Okay. Deine Antwort?');
    await r.manual.finish('Okay. Deine Antwort?');
    await next;
    expect(r.transport.played).toEqual([P1, 'Okay. Deine Antwort?']);
  });

  it('barge-in while part 2 is being synthesised: part 2 is not played, part 3 never synthesised', async () => {
    const r = manualRig({ audioMs: 300 });
    const said1 = r.host.say(FIVE, { interruptible: true });
    await r.manual.finish(P1);
    await until(() => r.transport.played.length === 1 && r.manual.texts().includes(P2));
    r.transport.startSpeaking();
    await said1;
    await r.manual.finish(P2);
    const next = r.host.say('Okay. Deine Antwort?');
    await r.manual.finish('Okay. Deine Antwort?');
    await next;
    expect(r.transport.played).toEqual([P1, 'Okay. Deine Antwort?']);
    expect(r.manual.texts()).toEqual([P1, P2, 'Okay. Deine Antwort?']);
  });

  it('barge-in in the gap between two parts drops the group (F2)', async () => {
    const r = manualRig();
    const said1 = r.host.say(FIVE, { interruptible: true });
    await inGap(r);
    r.transport.startSpeaking();
    await said1;
    await r.manual.finish(P2);
    const next = r.host.say('Okay. Deine Antwort?');
    await r.manual.finish('Okay. Deine Antwort?');
    await next;
    expect(r.transport.played).toEqual([P1, 'Okay. Deine Antwort?']);
    expect(r.manual.texts()).not.toContain(P3);
  });

  it('a new group with the same key replaces the old one in the gap', async () => {
    const r = manualRig();
    const old = r.host.say(FIVE, { key: 'turn' });
    await inGap(r);
    const fresh = r.host.say('Ben, du bist dran. Welche Karte?', { key: 'turn' });
    await old;
    await r.manual.finish(P2);
    await r.manual.finish('Ben, du bist dran. Welche Karte?');
    await fresh;
    expect(r.transport.played).toEqual([P1, 'Ben, du bist dran. Welche Karte?']);
    expect(r.manual.texts()).not.toContain(P3);
  });

  it('clear() in the middle of a group: the say resolves, the next line plays', async () => {
    const r = manualRig();
    const said1 = r.host.say(FIVE);
    await inGap(r);
    r.host.clear();
    await said1;
    await r.manual.finish(P2);
    const next = r.host.say('Noch keine Punkte.');
    await r.manual.finish('Noch keine Punkte.');
    await next;
    expect(r.transport.played).toEqual([P1, 'Noch keine Punkte.']);
  });

  it('close() in the middle of a group: the say resolves, nothing more is played', async () => {
    const r = manualRig();
    const said1 = r.host.say(FIVE);
    await inGap(r);
    await r.transport.close();
    await said1;
    await r.manual.finish(P2);
    await r.host.say('Noch keine Punkte.'); // closed: resolves at once
    await sleep(50);
    expect(r.transport.played).toEqual([P1]);
    expect(r.manual.texts()).toEqual([P1, P2]);
  });

  it('synthesis of part 2 fails: part 3 is still spoken, the say resolves', async () => {
    const r = manualRig();
    const said1 = r.host.say(FIVE);
    await inGap(r);
    r.manual.calls.find((c) => c.text === P2)!.reject();
    await r.manual.finish(P3);
    await said1;
    expect(r.transport.played).toEqual([P1, P3]);
  });
});

describe('T5 review: the gap between two parts counts as speaking (F2)', () => {
  it('echo protection covers the gap: an utterance there is ignored as echo of the part just spoken', async () => {
    const r = manualRig({ heard: [P1], mayInterrupt: () => false });
    void r.host.say(FIVE);
    await inGap(r);
    await sleep(400); // more than the 300 ms tail after part 1
    r.transport.speak(10);
    await sleep(50);
    expect(r.speech).toEqual([]);
    await r.manual.finish(P2);
    await until(() => r.transport.played.length === 2);
  });

  it('someone not on turn cannot interrupt in the gap (rule 8)', async () => {
    const r = manualRig({ heard: ['Meine Antwort ist Washington'], mayInterrupt: (s) => s.id === ANNA.id });
    void r.host.say(FIVE, { interruptible: true });
    await inGap(r);
    r.transport.startSpeaking(BEN);
    r.transport.speak(10, BEN);
    await sleep(50);
    expect(r.speech).toEqual([]);
    await r.manual.finish(P2);
    await until(() => r.transport.played.length === 2);
    expect(r.transport.played).toEqual([P1, P2]);
  });

  it('an answer in the gap of a question (not interruptible) is ignored and the question goes on', async () => {
    const r = manualRig({ heard: ['Meine Antwort ist Washington'] });
    void r.host.say(FIVE);
    await inGap(r);
    r.transport.startSpeaking();
    r.transport.speak(10);
    await sleep(50);
    expect(r.speech).toEqual([]);
    await r.manual.finish(P2);
    await until(() => r.transport.played.length === 2);
  });

  it('the person on turn answering in the gap of a hint is barge-in: heard, rest of the group dropped', async () => {
    const r = manualRig({ heard: ['Meine Antwort ist Washington'] });
    const said1 = r.host.say(FIVE, { interruptible: true });
    await inGap(r);
    r.transport.speak(10);
    await until(() => r.speech.length === 1);
    await said1;
    await r.manual.finish(P2);
    await sleep(50);
    expect(r.transport.played).toEqual([P1]);
    expect(r.manual.texts()).not.toContain(P3);
  });

  it('without splitting nothing changes: key replacement leaves the playing line, barge-in only cuts the current one', async () => {
    const r = rig({ split: false, engine: new FakeEngine(10, 200) });
    const a = r.host.say(LONG_QUESTION, { key: 'turn', interruptible: true });
    const b = r.host.say('Gerade gibt es nichts zu wiederholen.');
    await until(() => r.transport.played.length === 1);
    const c = r.host.say('Ben, du bist dran. Welche Karte?', { key: 'turn' });
    await sleep(20);
    r.transport.startSpeaking(); // cuts the long line only
    await Promise.all([a, b, c]);
    expect(r.transport.played).toEqual([LONG_QUESTION, 'Gerade gibt es nichts zu wiederholen.', 'Ben, du bist dran. Welche Karte?']);
    expect(r.engine.calls).toEqual(r.transport.played);
  });
});

describe('T5 review: pre-warming pauses (F1) and is measured right (F3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-ttsrev-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('waits for a full quiet period again after every pre-warmed line', async () => {
    const engine = new FakeEngine(5);
    const at: number[] = [];
    const timed: TextToSpeech = { engine: engine.engine, synth: (t) => (at.push(Date.now()), engine.synth(t)), close: async () => {} };
    const tts = new DiskCachedTts(timed, { dir, identity: 'x', allow: isFixedSpeech });
    await tts.warm(warmLines(voiceCfg({ ttsSplitSentences: true })).slice(0, 3), { quietMs: 80 });
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(75);
  });

  it('someone starting to speak holds pre-warming until their utterance is handled', async () => {
    const engine = new FakeEngine(5);
    const disk = new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech });
    const r = rig({ tts: new CachedTts(disk), engine, heard: [''] });
    r.transport.startSpeaking();
    void disk.warm(warmLines(voiceCfg({ ttsSplitSentences: true })).slice(0, 2), { quietMs: 40 });
    await sleep(200);
    expect(engine.calls).toEqual([]);
    r.transport.speak(100); // the utterance arrives, is heard (nothing recognised) and released
    await until(() => engine.calls.length === 2);
    await disk.close();
  });

  for (const split of [true, false]) {
    it(`a real line behind a pre-warm line shows the wait as warte, not tts (split=${split})`, async () => {
      const engine = new FakeEngine(100, 50);
      const disk = new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech });
      const r = rig({ tts: new CachedTts(disk), engine, split });
      void disk.warm(warmLines(voiceCfg({ ttsSplitSentences: split })).slice(0, 1), { quietMs: 10 });
      await until(() => engine.calls.length === 1);
      await r.host.say('Ben, du bist dran. Welche Karte?');
      const line = r.lines.find((l) => l.startsWith('⏱ ansage'))!;
      const tts = Number(/tts=(\d+)ms/.exec(line)![1]);
      const warte = Number(/warte=(\d+)ms/.exec(line)![1]);
      expect(tts).toBeLessThan(150);
      expect(warte).toBeGreaterThanOrEqual(40);
      await disk.close();
    });
  }
});

describe('T5 review: cache hits and reactions (F4, F5, F6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qbhost-ttsrev-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a broken cache file is no cache=ja: the line goes through the engine in order (F4)', async () => {
    const key = new DiskCachedTts(new FakeEngine(), { dir, identity: 'x', allow: isFixedSpeech }).key('Niemand? Schade.');
    writeFileSync(path.join(dir, `${key}.pcm`), `QBTTS1\n${JSON.stringify({ key, rate: 16000, channels: 1, samples: 999 })}\nzu kurz`);
    const engine = new FakeEngine();
    const r = rig({ tts: new CachedTts(new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech })), engine });
    await r.host.say('Niemand? Schade.');
    expect(r.lines.find((l) => l.startsWith('⏱ ansage'))).toContain('cache=nein');
    expect(engine.calls).toEqual(['Niemand? Schade.']);
  });

  it('a file broken after the start is read once, then no hit any more until written anew (F4)', async () => {
    const first = new DiskCachedTts(new FakeEngine(), { dir, identity: 'x', allow: isFixedSpeech });
    await first.synth('Noch keine Punkte.');
    await until(() => readdirSync(dir).some((f) => f.endsWith('.pcm')));
    const engine = new FakeEngine();
    const tts = new DiskCachedTts(engine, { dir, identity: 'x', allow: isFixedSpeech });
    expect(tts.cached('Noch keine Punkte.')).toBe(true);
    writeFileSync(path.join(dir, `${tts.key('Noch keine Punkte.')}.pcm`), 'kaputt');
    const pcm = await tts.synth('Noch keine Punkte.');
    expect(engine.calls).toEqual(['Noch keine Punkte.']);
    expect(pcm.samples.length).toBe(960);
  });

  it('playback of part 1 fails: the reaction is measured on the next audible part (F5)', async () => {
    const transport = new FakeTransport();
    const r = rig({ transport, heard: ['Meine Antwort ist Paris'] });
    r.transport.speak(500);
    await until(() => r.speech.length === 1);
    transport.failPlays = 1;
    await r.host.say(LONG_QUESTION);
    expect(r.transport.played).toEqual(splitSentences(LONG_QUESTION).slice(1));
    expect(r.lines.filter((l) => l.startsWith('⏱ reaktion'))).toHaveLength(1);
  });

  it('a cache folder that is a file or not writable never breaks speaking (F6)', async () => {
    const file = path.join(dir, 'datei');
    writeFileSync(file, 'x');
    const onFile = new DiskCachedTts(new FakeEngine(), { dir: file, identity: 'x', allow: isFixedSpeech });
    expect((await onFile.synth('Niemand? Schade.')).samples.length).toBe(960);
    const ro = path.join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      const tts = new DiskCachedTts(new FakeEngine(), { dir: ro, identity: 'x', allow: isFixedSpeech });
      expect((await tts.synth('Niemand? Schade.')).samples.length).toBe(960);
      await sleep(50);
      expect(readdirSync(ro)).toEqual([]);
      expect(tts.cached('Niemand? Schade.')).toBe(false);
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});

describe('T5 delta review: a hung next part (F7) and the gap after the group (F8)', () => {
  afterEach(() => vi.useRealTimers());

  /** Fake timers: part 1 has played (80 ms), part 2 hangs in the engine. */
  async function hungGap(o: { heard?: string[] } = {}) {
    vi.useFakeTimers();
    const r = manualRig({ heard: o.heard, mayInterrupt: () => false });
    let resolved = false;
    void r.host.say(FIVE).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    r.manual.calls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.transport.played).toEqual([P1]);
    expect(r.manual.texts()).toEqual([P1, P2]);
    return { r, resolved: () => resolved };
  }

  it('a hung next part: after PART_GAP_LIMIT_MS the bot hears again, the say resolves, the next line plays', async () => {
    const { r, resolved } = await hungGap({ heard: ['Quizmaster, Spiel beenden'] });
    r.transport.speak(10, BEN); // in the gap: the bot is still talking
    await vi.advanceTimersByTimeAsync(10);
    expect(r.speech).toEqual([]);
    await vi.advanceTimersByTimeAsync(PART_GAP_LIMIT_MS);
    expect(resolved()).toBe(true);
    r.transport.speak(10, BEN);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.speech).toEqual(['Quizmaster, Spiel beenden']);
    const next = r.host.say('Noch keine Punkte.');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.manual.texts()).toEqual([P1, P2, 'Noch keine Punkte.']); // part 3 never reached the engine
    r.manual.calls[2]!.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(r.transport.played).toEqual([P1, 'Noch keine Punkte.']);
    r.manual.calls[1]!.resolve(); // the hung part finally comes back: not played
    await vi.advanceTimersByTimeAsync(200);
    expect(r.transport.played).toEqual([P1, 'Noch keine Punkte.']);
  });

  it('a slow but timely next part is played normally', async () => {
    const { r, resolved } = await hungGap();
    await vi.advanceTimersByTimeAsync(PART_GAP_LIMIT_MS - 1000);
    r.manual.calls[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    r.manual.calls[2]!.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(r.transport.played).toEqual([P1, P2, P3]);
    expect(resolved()).toBe(true);
  });

  it('an utterance that began in the gap of a question and arrives after it is ignored; an answer right after is heard', async () => {
    const r = manualRig({ heard: ['Meine Antwort ist Paris'] });
    const question = r.host.say(FIVE);
    await inGap(r);
    await sleep(400); // more than the 300 ms tail after part 1
    const began = Date.now();
    await sleep(50); // Anna is talking in the gap; part 2 comes later
    await r.manual.finish(P2);
    await r.manual.finish(P3);
    await question;
    r.transport.speak(Date.now() - began); // began in the gap, arrives after the group
    await sleep(50);
    expect(r.speech).toEqual([]);
    await sleep(400);
    r.transport.speak(10); // after the question: a normal answer
    await until(() => r.speech.length === 1);
    expect(r.speech).toEqual(['Meine Antwort ist Paris']);
  });
});
