import type { Attention } from './voice-host.ts';

/**
 * Latency measurement for the voice path (`⏱` lines on `info`, see docs/VOICE.md "Latenz messen").
 * Only timestamps are taken – nothing here awaits or touches audio, so the voice path keeps its timing.
 * The lines never contain recognised or spoken text, names or solutions: only engines, counts and ms.
 * Every method is synchronous and never throws (it runs inside transport/event handlers).
 */

/** A reply counts as the reaction to an utterance only if it is queued at most this long after `onSpeech` ended. */
export const REACTION_WINDOW_MS = 15_000;

export interface LatencyOptions {
  enabled: boolean;
  log: (line: string) => void;
  now?: () => number;
}

/** One STT pass of an utterance (its time is part of the utterance's `stt`, measured from `hear`). */
export interface SttPass {
  engine: string;
  /**
   * Another engine took over after this one failed (fast → main model, cloud → local), or – on a local
   * pass – it stood in for a paused cloud. Any of them → `rueckfall=ja`.
   */
  fallback?: boolean;
}

/** Timestamps of one queued sentence, filled in as it moves through the queue. */
export interface SpeechTimes {
  engine: string;
  chars: number;
  cache: boolean;
  queuedAt: number;
  /** When the engine actually started on it (later than `queuedAt` when it waits behind another synthesis). */
  synthStartAt?: number;
  synthDoneAt?: number;
  pickedAt?: number;
  /** The utterance this sentence answers, if it is the first reply to it. */
  reaction?: Reaction;
}

interface Reaction {
  endedAt: number;
  heardAt: number;
  sttDoneAt: number;
}

/** A transcribed utterance on its way through `onSpeech`. */
export interface Heard extends Reaction {
  /** The finished `⏱ erkennung` line – logged only once the bot uses the utterance. */
  line: string;
  fallback: boolean;
  used: boolean;
  /** `onSpeech` is over: a late `used` no longer counts. */
  done: boolean;
  /** Reaction window: Infinity while `onSpeech` still runs. */
  deadline: number;
}

/** Nearest-rank percentile (p in 0..100) of unsorted values; NaN for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

const ms = (n: number) => `${Math.max(0, Math.round(n))}ms`;
const yesNo = (b: boolean) => (b ? 'ja' : 'nein');
/** Engine names come from config (model file, voice) – keep them to one safe token. */
const token = (s: string) => s.replace(/[^\w.:+-]+/g, '_') || 'unbekannt';

export class LatencyMeter {
  private readonly now: () => number;
  /** The latest used utterance still waiting for its reply. */
  private pending: Heard | null = null;
  private recognitions = 0;
  private stt: number[] = [];
  private tts: number[] = [];
  private reactions: number[] = [];
  private dropped = 0;
  private fallbacks = 0;

  constructor(private o: LatencyOptions) {
    this.now = o.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.o.enabled;
  }

  /** Current time – callers stamp with this so tests can use fake clocks. */
  stamp(): number {
    return this.now();
  }

  /** A wake check found no wake word: no line (side talk stays out of `info`), only counters. */
  wakeDropped(passes: SttPass[] = []): void {
    this.dropped++;
    if (passes.some((p) => p.fallback)) this.fallbacks++;
  }

  /**
   * An utterance was transcribed in full (all passes, ending at `sttDoneAt`); its STT time counts in the
   * summary either way. `toBot`: its text goes to `onSpeech` – then the returned handle goes to `used`
   * (the bot acted on it) and `handled` (`onSpeech` is over). Otherwise (nothing heard, echo) it is dropped.
   */
  recognised(u: { endedAt: number; heardAt: number; sttDoneAt: number; attention: Attention; audioMs: number; passes: SttPass[]; toBot: boolean }): Heard | null {
    const { sttDoneAt } = u;
    if (!u.passes.length) return null;
    const engines = [...new Set(u.passes.map((p) => p.engine))].map(token).join('+');
    const sttMs = sttDoneAt - u.heardAt;
    const fallback = u.passes.some((p) => p.fallback);
    this.stt.push(sttMs);
    if (fallback) this.fallbacks++; // every fallback counts in the summary, also for side talk (no line)
    if (!u.toBot) {
      this.dropped++;
      return null;
    }
    const line = `⏱ erkennung engine=${engines} attention=${u.attention} audio=${ms(u.audioMs)} stt=${ms(sttMs)} rueckfall=${yesNo(fallback)}`;
    return { endedAt: u.endedAt, heardAt: u.heardAt, sttDoneAt, line, fallback, used: false, done: false, deadline: Infinity };
  }

  /**
   * The bot acted on the utterance (posted its transcript): now it gets its `erkennung` line, and the next
   * sentence queued answers it (the latest used utterance wins). Only marks – all times were taken already.
   */
  used(h: Heard | null): void {
    if (!h || h.used || h.done) return;
    h.used = true;
    this.recognitions++;
    this.emit(h.line);
    this.pending = h;
  }

  /** `onSpeech` returned (or threw). Unused → side talk: no line, only the counter. Used → its reaction window starts closing. */
  handled(h: Heard | null): void {
    if (!h || h.done) return;
    h.done = true;
    if (!h.used) this.dropped++;
    else if (this.pending === h) h.deadline = this.now() + REACTION_WINDOW_MS;
  }

  /** A sentence enters the queue. The first one after a recognised utterance (within the window) is its reaction. */
  queued(s: { engine: string; chars: number; cache?: boolean }): SpeechTimes {
    const t: SpeechTimes = { engine: token(s.engine), chars: s.chars, cache: !!s.cache, queuedAt: this.now() };
    const p = this.pending;
    if (p) {
      this.pending = null;
      if (t.queuedAt <= p.deadline) t.reaction = p;
    }
    return t;
  }

  /** Playback of `t` started (transport `onStart`; `at` = the `play` call for transports without it). */
  started(t: SpeechTimes, at?: number): void {
    const startAt = at ?? this.now();
    const done = t.synthDoneAt ?? t.queuedAt;
    const synthStart = Math.min(done, Math.max(t.queuedAt, t.synthStartAt ?? t.queuedAt));
    const ttsMs = done - synthStart;
    const queueWait = synthStart - t.queuedAt + Math.max(0, (t.pickedAt ?? done) - done);
    if (!t.cache) this.tts.push(ttsMs); // a cache hit is no synthesis – it would pull tts_p50 down
    this.emit(`⏱ ansage engine=${t.engine} zeichen=${t.chars} tts=${ms(ttsMs)} cache=${yesNo(t.cache)} warte=${ms(queueWait)}`);
    const r = t.reaction;
    if (!r) return;
    // pause + stt + logik + tts + start = gesamt (every gap belongs to exactly one field).
    const total = startAt - r.endedAt;
    this.reactions.push(total);
    this.emit(
      `⏱ reaktion gesamt=${ms(total)} pause=${ms(r.heardAt - r.endedAt)} stt=${ms(r.sttDoneAt - r.heardAt)} logik=${ms(t.queuedAt - r.sttDoneAt)} tts=${ms(ttsMs)} start=${ms(startAt - done + (synthStart - t.queuedAt))}`,
    );
  }

  /**
   * Logs the summary since the last one (game over, leaving the channel) and starts afresh. Nothing was
   * transcribed in full (no recognition; only wake checks without the wake word, side talk after the game)
   * → no line: a second call right after the first, or a goodbye, adds none. Such drops are not lost:
   * `verworfen` keeps them for the next real summary.
   */
  summary(): void {
    if (!this.recognitions && !this.stt.length) {
      this.pending = null;
      return;
    }
    const p = (v: number[], q: number) => (v.length ? ms(percentile(v, q)) : '-');
    this.emit(
      `⏱ bilanz n=${this.recognitions} stt_p50=${p(this.stt, 50)} stt_p90=${p(this.stt, 90)} tts_p50=${p(this.tts, 50)} tts_p90=${p(this.tts, 90)} reaktion_p50=${p(this.reactions, 50)} reaktion_p90=${p(this.reactions, 90)} verworfen=${this.dropped} rueckfaelle=${this.fallbacks}`,
    );
    this.recognitions = 0;
    this.stt = [];
    this.tts = [];
    this.reactions = [];
    this.dropped = 0;
    this.fallbacks = 0;
    this.pending = null;
  }

  private emit(line: string): void {
    if (!this.o.enabled) return;
    try {
      this.o.log(line);
    } catch {
      /* logging must never break the voice path */
    }
  }
}
