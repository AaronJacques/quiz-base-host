import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { durationMs, head, rms, type Pcm } from './audio.ts';
import { extractAnswer, isEcho, stripWakeWord } from './commands.ts';
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
  onSpeech: (speaker: Speaker, text: string) => void | Promise<void>;
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

  constructor(private d: VoiceHostDeps) {
    d.transport.onUtterance((u) => void this.hear(u).catch((e) => log.warn(`Erkennung: ${(e as Error).message}`)));
    // Discord tells us when someone starts to speak: the person on turn stops a hint right away.
    d.transport.onSpeechStart?.((s) => {
      if (this.playing?.interruptible && this.currentFrom && this.mayInterrupt(s)) this.interrupt(s.displayName);
    });
    d.transport.onClose(() => {
      this.closed = true;
      this.queue.splice(0).forEach((q) => q.done());
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
      const audio = this.d.tts.synth(clean).catch((e) => {
        log.warn(`TTS „${clean.slice(0, 40)}“: ${(e as Error).message}`);
        return null;
      });
      this.queue.push({ text: clean, key: opts.key, interruptible: !!opts.interruptible, audio, done: resolve });
      void this.pump().catch((e) => log.warn(`Sprechen: ${(e as Error).message}`));
    });
  }

  /** Drops everything not yet spoken (e.g. the game ended). */
  clear(): void {
    this.queue.splice(0).forEach((q) => q.done());
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    while (!this.closed && this.queue.length) {
      const item = (this.playing = this.queue.shift()!);
      const pcm = await item.audio;
      if (pcm) {
        log.info(`🔊 ${item.text}`);
        const from = (this.currentFrom = Date.now());
        this.cut = false;
        await this.d.transport.play(pcm).catch((e) => log.warn(`Wiedergabe: ${(e as Error).message}`));
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
  private async fast(pcm: Pcm, prompt: string): Promise<string> {
    if (!this.d.fastStt) return this.d.stt.transcribe(pcm, prompt);
    try {
      return await this.d.fastStt.transcribe(pcm, prompt);
    } catch (e) {
      log.warn(`Schnelles Whisper-Modell: ${(e as Error).message} – nehme das Hauptmodell`);
      return this.d.stt.transcribe(pcm, prompt);
    }
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
    if (attention === 'wake') {
      const start = head(u.pcm, WAKE_HEAD_MS);
      const heard = await this.fast(start, this.d.cfg.wakeWords.join(', '));
      if (stripWakeWord(heard, this.d.cfg.wakeWords) === null) return log.debug(`🔇 ${who} ist nicht dran – kein Rufname, verworfen`);
      text = start === u.pcm ? heard : await this.fast(u.pcm, this.d.prompt());
    } else if (attention === 'answer') {
      text = await this.d.stt.transcribe(u.pcm, this.d.prompt());
    } else {
      text = await this.fast(u.pcm, this.d.prompt());
      // "Genau, meine Antwort ist zehn" while "Paris?" waits for "Ja": a new answer – hear it precisely.
      if (attention === 'confirm' && this.d.fastStt && extractAnswer(text) !== null) {
        log.debug(`🎙 ${who}: neue Antwort in der Rückfrage – noch einmal mit dem Hauptmodell`);
        text = await this.d.stt.transcribe(u.pcm, this.d.prompt());
      }
    }
    if (!text) return log.debug(`nichts erkannt (${who})`);
    // Without headphones the bot's own voice comes back – that is no barge-in.
    if (bargeIn && over.some((o) => isEcho(text, o.text))) return log.info(`🙉 ${who}: klang wie meine eigene Ansage – ignoriert`);
    log.debug(`🎙 ${who}: „${text}“`); // side talk stays out of the normal log
    await this.d.onSpeech(u.speaker, text);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.d.transport.stop();
    await this.d.transport.close();
  }
}
