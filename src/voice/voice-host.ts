import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { durationMs, head, rms, type Pcm } from './audio.ts';
import { extractAnswer, isEcho, stripWakeWord } from './commands.ts';
import { LatencyMeter, type SpeechTimes, type SttPass } from './latency.ts';
import type { SpeechToText } from './stt.ts';
import type { Speaker, Utterance, VoiceTransport } from './transport.ts';
import type { TextToSpeech } from './tts.ts';

const log = createLogger('voice');

export interface VoiceHostDeps {
  transport: VoiceTransport;
  /** The precise main model: spoken answers ('answer'), and everything when there is no `fastStt`. */
  stt: SpeechToText;
  /** Optional fast second model for everything without a spoken answer ('full', 'wake', first pass of 'confirm'). */
  fastStt?: SpeechToText;
  tts: TextToSpeech;
  cfg: Config['voice'];
  /** Vocabulary hints for the recogniser (categories, player names). Must never contain solutions. */
  prompt: () => string;
  /**
   * The recognised text. Call `used()` when the bot acts on it (the transcript goes to the chat): only
   * then it gets a `⏱ erkennung` line and its reply is timed – side talk stays out of `info` (rule 8).
   * `used` only marks, never throws and never waits.
   */
  onSpeech: (speaker: Speaker, text: string, used: () => void) => void | Promise<void>;
  /**
   * How closely to listen to someone right now – decided by the bot, which knows the game:
   * - 'answer': a spoken answer may come (the answerer) → the precise main model.
   * - 'confirm': the answerer was asked back ("Paris?") → the fast model for "Ja"/"Nein"; if it hears an
   *   answer keyword (a new answer replaces the old one), the same audio again with the main model.
   * - 'full': everything else that is transcribed in full (picks, "Hier!", menus) → the fast model.
   * - 'wake': only the start of an utterance is checked for the wake word (fast model) – side talk of
   *   everyone else is never transcribed as a whole. Default 'full'.
   */
  attention?: (speaker: Speaker) => Attention;
  /**
   * May this person interrupt the bot right now (barge-in, `voice.bargeIn`)? Only lines queued with
   * `interruptible` – hints, reminders, "deine Antwort?" – never a question or a solution. The bot
   * answers true for whoever is on turn; everyone else stays under the echo protection.
   */
  mayInterrupt?: (speaker: Speaker) => boolean;
  onClose?: () => void;
  /** Where `⏱` lines go (default: `info` on the voice logger). Only used with `cfg.latencyLog`. */
  latencyLog?: (line: string) => void;
}

export type Attention = 'answer' | 'confirm' | 'full' | 'wake';

/** How much of an utterance is checked for "Quizmaster" when someone is not on turn. */
const WAKE_HEAD_MS = 2000;

interface QueueItem {
  text: string;
  key?: string;
  interruptible: boolean;
  audio: Promise<Pcm | null>;
  done: () => void;
  times: SpeechTimes;
}

interface Spoken {
  from: number;
  to: number;
  interruptible: boolean;
  text: string;
}

/** Words the German TTS voice gets wrong, spelled the way it pronounces them right. */
const PRONOUNCE: [RegExp, string][] = [
  [/quiz-base(\.de)?/gi, 'Quiz Base'],
  [/\bkm\b/g, 'Kilometer'],
  [/\bca\.\s/g, 'circa '],
  [/\bz\.\s?B\./g, 'zum Beispiel'],
  [/(\p{L})\/(\p{L})/gu, '$1 und $2'], // "Serien/Filme"
  [/(^|\s)-(\d)/g, '$1minus $2'],
];

/** Makes chat text speakable: no emoji, markdown, mentions, links. */
export function forSpeech(text: string): string {
  let out = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<@!?[\w-]+>|<#[\w-]+>/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[*_`>|~]+/g, '')
    .replace(/-#\s*/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of PRONOUNCE) out = out.replace(re, to);
  return out;
}

/**
 * One voice session: speaks queued sentences one after another (synthesising the
 * next while the current one plays) and turns utterances into text.
 */
export class VoiceHost {
  private queue: QueueItem[] = [];
  private playing: QueueItem | null = null;
  /** Recent playback intervals, to drop what people said over the bot (echo protection). */
  private spoken: Spoken[] = [];
  private closed = false;
  private currentFrom = 0;
  /** The sentence playing now was cut short by barge-in. */
  private cut = false;
  /** `⏱` measurement – timestamps only, never awaited. */
  private latency: LatencyMeter;
  /** The sentence whose synthesis was started last (serial engines like Piper start the next one after it). */
  private lastSynth: SpeechTimes | null = null;

  constructor(private d: VoiceHostDeps) {
    this.latency = new LatencyMeter({ enabled: d.cfg.latencyLog !== false, log: d.latencyLog ?? ((l) => log.info(l)) });
    d.transport.onUtterance((u) => void this.hear(u).catch((e) => log.warn(`Erkennung: ${(e as Error).message}`)));
    // Discord tells us when someone starts to speak: the person on turn stops a hint right away.
    d.transport.onSpeechStart?.((s) => {
      if (this.playing?.interruptible && this.currentFrom && this.mayInterrupt(s)) this.interrupt(s.displayName);
    });
    d.transport.onClose(() => {
      this.closed = true;
      this.queue.splice(0).forEach((q) => q.done());
      this.latencySummary();
      d.onClose?.();
    });
  }

  get label(): string {
    return this.d.transport.label;
  }

  get busy(): boolean {
    return !!this.playing || this.queue.length > 0;
  }

  /**
   * Queues a sentence. With `key`, an older queued sentence with the same key is
   * replaced (e.g. a stale "who's turn" announcement, an older hint). With `interruptible`,
   * the person on turn may talk over it (see `mayInterrupt`). Resolves once spoken (or cut/dropped).
   */
  say(text: string, opts: { key?: string; interruptible?: boolean } = {}): Promise<void> {
    const clean = forSpeech(text);
    if (!clean || this.closed) return Promise.resolve();
    if (opts.key) {
      for (const q of this.queue.filter((q) => q.key === opts.key)) q.done();
      this.queue = this.queue.filter((q) => q.key !== opts.key);
    }
    return new Promise<void>((resolve) => {
      const cache = this.d.tts.cached?.(clean) ?? false;
      const times = this.latency.queued({ engine: this.d.tts.engine ?? 'unbekannt', chars: clean.length, cache });
      // A synthesis still running when this one is queued delays its real start (one sentence at a time).
      // A cache hit needs no synthesis: it neither waits for one nor holds up the next sentence.
      const before = !cache && this.lastSynth?.synthDoneAt === undefined ? this.lastSynth : null;
      if (!cache) this.lastSynth = times;
      const raw = this.d.tts.synth(clean);
      const synthDone = () => {
        times.synthDoneAt = this.latency.stamp();
        times.synthStartAt = before?.synthDoneAt ?? times.queuedAt;
      };
      raw.then(synthDone, synthDone); // side branch: the queue below does not wait for it
      const audio = raw.catch((e) => {
        log.warn(`TTS „${clean.slice(0, 40)}“: ${(e as Error).message}`);
        return null;
      });
      this.queue.push({ text: clean, key: opts.key, interruptible: !!opts.interruptible, audio, done: resolve, times });
      void this.pump().catch((e) => log.warn(`Sprechen: ${(e as Error).message}`));
    });
  }

  /** Drops everything not yet spoken (e.g. the game ended). */
  clear(): void {
    this.queue.splice(0).forEach((q) => q.done());
  }

  /**
   * Logs the `⏱ bilanz` since the last one and starts a new one: at the end of every game (the bot's
   * `finish`) and when leaving the channel. A second call without anyone speaking in between logs nothing.
   */
  latencySummary(): void {
    try {
      this.latency.summary();
    } catch {
      /* measurement never breaks the voice path */
    }
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    while (!this.closed && this.queue.length) {
      const item = (this.playing = this.queue.shift()!);
      item.times.pickedAt = this.latency.stamp();
      const pcm = await item.audio;
      if (pcm) {
        log.info(`🔊 ${item.text}`);
        const from = (this.currentFrom = Date.now());
        this.cut = false;
        let started = false;
        const onStart = () => {
          if (started) return;
          started = true;
          this.latency.started(item.times);
        };
        let failed = false;
        await this.d.transport.play(pcm, { onStart }).catch((e) => {
          failed = true;
          log.warn(`Wiedergabe: ${(e as Error).message}`);
        });
        // Transports without `onStart`: the play call is the best start time there is. Never played → no line.
        if (!started && !failed && !this.d.transport.reportsStart) {
          started = true;
          this.latency.started(item.times, from);
        }
        this.currentFrom = 0;
        const to = this.cut ? Date.now() : Math.max(Date.now(), from + durationMs(pcm));
        this.spoken.push({ from, to, interruptible: item.interruptible, text: item.text });
        if (this.spoken.length > 30) this.spoken.shift();
      }
      item.done();
      this.playing = null;
    }
  }

  /** The fast model if there is one; if it fails (not started, crashed twice), the main model takes over. */
  private async fast(pcm: Pcm, prompt: string, passes: SttPass[]): Promise<string> {
    if (!this.d.fastStt) return this.main(pcm, prompt, passes);
    try {
      passes.push({ engine: engineOf(this.d.fastStt) });
      return await this.d.fastStt.transcribe(pcm, prompt);
    } catch (e) {
      log.warn(`Schnelles Whisper-Modell: ${(e as Error).message} – nehme das Hauptmodell`);
      return this.main(pcm, prompt, passes);
    }
  }

  private main(pcm: Pcm, prompt: string, passes: SttPass[]): Promise<string> {
    passes.push({ engine: engineOf(this.d.stt) });
    return this.d.stt.transcribe(pcm, prompt);
  }

  private mayInterrupt(s: Speaker): boolean {
    return this.d.cfg.bargeIn && !!this.d.mayInterrupt?.(s);
  }

  private interrupt(who: string): void {
    if (this.cut) return;
    this.cut = true;
    log.info(`✋ ${who} unterbricht mich`);
    this.d.transport.stop();
  }

  /** The bot's sentences an utterance started over (echo protection); empty when there are none or the guard is off. */
  private overlapped(u: Utterance): Pick<Spoken, 'interruptible' | 'text'>[] {
    if (!this.d.cfg.ignoreWhileSpeaking) return [];
    const tail = 300;
    const out: Pick<Spoken, 'interruptible' | 'text'>[] = this.spoken.filter((s) => u.startedAt >= s.from && u.startedAt <= s.to + tail);
    // Still talking: anything that started after the current sentence began overlaps.
    if (this.currentFrom && this.playing && u.startedAt >= this.currentFrom) out.push(this.playing);
    return out;
  }

  private async hear(u: Utterance): Promise<void> {
    if (this.closed) return;
    const heardAt = this.latency.stamp();
    const ms = durationMs(u.pcm);
    const loud = rms(u.pcm);
    const who = u.speaker.displayName;
    if (ms < this.d.cfg.minSpeechMs || loud < this.d.cfg.minRms) return log.debug(`verworfen (${who}, ${Math.round(ms)} ms, rms ${Math.round(loud)})`);
    const over = this.overlapped(u);
    // Barge-in: the person on turn may talk over hints and prompts – whatever else they talked over stays ignored.
    const bargeIn = over.length > 0 && over.every((o) => o.interruptible) && this.mayInterrupt(u.speaker);
    if (over.length && !bargeIn) return log.info(`🙉 ${who} sprach, während ich sprach – ignoriert`);
    if (bargeIn && this.playing?.interruptible && this.currentFrom) this.interrupt(who);
    let text: string;
    const attention = this.d.attention?.(u.speaker) ?? 'full';
    const passes: SttPass[] = [];
    if (attention === 'wake') {
      const start = head(u.pcm, WAKE_HEAD_MS);
      const heard = await this.fast(start, this.d.cfg.wakeWords.join(', '), passes);
      if (stripWakeWord(heard, this.d.cfg.wakeWords) === null) {
        this.latency.wakeDropped(); // side talk: counted, no line
        return log.debug(`🔇 ${who} ist nicht dran – kein Rufname, verworfen`);
      }
      text = start === u.pcm ? heard : await this.fast(u.pcm, this.d.prompt(), passes);
    } else if (attention === 'answer') {
      text = await this.main(u.pcm, this.d.prompt(), passes);
    } else {
      text = await this.fast(u.pcm, this.d.prompt(), passes);
      // "Genau, meine Antwort ist zehn" while "Paris?" waits for "Ja": a new answer – hear it precisely.
      if (attention === 'confirm' && this.d.fastStt && extractAnswer(text) !== null) {
        log.debug(`🎙 ${who}: neue Antwort in der Rückfrage – noch einmal mit dem Hauptmodell`);
        text = await this.main(u.pcm, this.d.prompt(), passes);
      }
    }
    const sttDoneAt = this.latency.stamp();
    // Without headphones the bot's own voice comes back – that is no barge-in.
    const echo = !!text && bargeIn && over.some((o) => isEcho(text, o.text));
    const heard = this.latency.recognised({ endedAt: u.endedAt, heardAt, sttDoneAt, attention, audioMs: ms, passes, toBot: !!text && !echo });
    if (!text) return log.debug(`nichts erkannt (${who})`);
    if (echo) return log.info(`🙉 ${who}: klang wie meine eigene Ansage – ignoriert`);
    log.debug(`🎙 ${who}: „${text}“`); // side talk stays out of the normal log
    const used = () => {
      try {
        this.latency.used(heard);
      } catch {
        /* measurement never breaks the voice path */
      }
    };
    try {
      await this.d.onSpeech(u.speaker, text, used);
    } finally {
      this.latency.handled(heard);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.latencySummary();
    this.d.transport.stop();
    await this.d.transport.close();
  }
}

function engineOf(stt: SpeechToText): string {
  return stt.engine ?? 'unbekannt';
}
