import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { durationMs, head, rms, type Pcm } from './audio.ts';
import { stripWakeWord } from './commands.ts';
import type { SpeechToText } from './stt.ts';
import type { Speaker, Utterance, VoiceTransport } from './transport.ts';
import type { TextToSpeech } from './tts.ts';

const log = createLogger('voice');

export interface VoiceHostDeps {
  transport: VoiceTransport;
  stt: SpeechToText;
  tts: TextToSpeech;
  cfg: Config['voice'];
  /** Vocabulary hints for the recogniser (categories, player names). Must never contain solutions. */
  prompt: () => string;
  onSpeech: (speaker: Speaker, text: string) => void | Promise<void>;
  /**
   * How closely to listen to someone right now. 'full': everything is transcribed (the
   * person whose turn it is). 'wake': only the start of an utterance is checked for the
   * wake word – side talk of everyone else is never transcribed as a whole. Default 'full'.
   */
  attention?: (speaker: Speaker) => Attention;
  onClose?: () => void;
}

export type Attention = 'full' | 'wake';

/** How much of an utterance is checked for "Quizmaster" when someone is not on turn. */
const WAKE_HEAD_MS = 2000;

interface QueueItem {
  text: string;
  key?: string;
  audio: Promise<Pcm | null>;
  done: () => void;
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
  private spoken: { from: number; to: number }[] = [];
  private closed = false;
  private currentFrom = 0;

  constructor(private d: VoiceHostDeps) {
    d.transport.onUtterance((u) => void this.hear(u).catch((e) => log.warn(`Erkennung: ${(e as Error).message}`)));
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
   * replaced (e.g. a stale "who's turn" announcement). Resolves once spoken.
   */
  say(text: string, opts: { key?: string } = {}): Promise<void> {
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
      this.queue.push({ text: clean, key: opts.key, audio, done: resolve });
      void this.pump();
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
        await this.d.transport.play(pcm);
        this.currentFrom = 0;
        this.spoken.push({ from, to: Math.max(Date.now(), from + durationMs(pcm)) });
        if (this.spoken.length > 30) this.spoken.shift();
      }
      item.done();
      this.playing = null;
    }
  }

  private overlapsBotSpeech(u: Utterance): boolean {
    if (!this.d.cfg.ignoreWhileSpeaking) return false;
    const tail = 300;
    // Still talking: anything that started after the current sentence began overlaps.
    if (this.currentFrom && u.startedAt >= this.currentFrom) return true;
    return this.spoken.some((s) => u.startedAt >= s.from && u.startedAt <= s.to + tail);
  }

  private async hear(u: Utterance): Promise<void> {
    if (this.closed) return;
    const ms = durationMs(u.pcm);
    const loud = rms(u.pcm);
    const who = u.speaker.displayName;
    if (ms < this.d.cfg.minSpeechMs || loud < this.d.cfg.minRms) return log.debug(`verworfen (${who}, ${Math.round(ms)} ms, rms ${Math.round(loud)})`);
    if (this.overlapsBotSpeech(u)) return log.info(`🙉 ${who} sprach, während ich sprach – ignoriert`);
    let text: string;
    if ((this.d.attention?.(u.speaker) ?? 'full') === 'wake') {
      const start = head(u.pcm, WAKE_HEAD_MS);
      const heard = await this.d.stt.transcribe(start, this.d.cfg.wakeWords.join(', '));
      if (stripWakeWord(heard, this.d.cfg.wakeWords) === null) return log.debug(`🔇 ${who} ist nicht dran – kein Rufname, verworfen`);
      text = start === u.pcm ? heard : await this.d.stt.transcribe(u.pcm, this.d.prompt());
    } else {
      text = await this.d.stt.transcribe(u.pcm, this.d.prompt());
    }
    if (!text) return log.debug(`nichts erkannt (${who})`);
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
