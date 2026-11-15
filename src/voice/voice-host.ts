import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { durationMs, head, rms, type Pcm } from './audio.ts';
import { extractAnswer, isEcho, stripWakeWord } from './commands.ts';
import { LatencyMeter, type SpeechTimes, type SttPass } from './latency.ts';
import { FallbackStt, SttTrouble } from './providers.ts';
import { isCloud, type LocalStt, type SpeechToText, type SttOptions } from './stt.ts';
import type { Speaker, Utterance, VoiceTransport } from './transport.ts';
import { SynthTimeout, type TextToSpeech } from './tts.ts';

const log = createLogger('voice');

export interface VoiceHostDeps {
  transport: VoiceTransport;
  /** The precise main model: spoken answers ('answer'), and everything when there is no `fastStt`. */
  stt: SpeechToText;
  /** Optional fast second model for everything without a spoken answer ('full', 'wake', first pass of 'confirm'). */
  fastStt?: SpeechToText;
  /** 'confirm' (first pass), if it differs from `fastStt` (`voice.sttCloudFor`); default `fastStt`. */
  confirmStt?: SpeechToText;
  /**
   * Cloud routing only: the local main / fast engines (undefined = `stt` / `fastStt` are local anyway,
   * null = there is none). Whatever must not go to the cloud is heard with these.
   */
  localStt?: LocalStt | null;
  localFastStt?: LocalStt | null;
  /**
   * May this utterance, begun at `startedAt` (epoch ms), go to a cloud route (`voice.stt`)? Only for
   * someone the bot clearly knows and has let speak since before `startedAt` without a break (on turn, may
   * buzz, asked the menu). Fail-safe: only `true` counts – missing, throwing, `undefined` or anything else
   * means local. A wake check never goes out (unless `wake` is in `sttCloudFor`); the command after a
   * locally heard wake word may.
   */
  cloudAllowed?: (speaker: Speaker, startedAt: number) => boolean;
  /**
   * The wake-word check of everyone not on turn; default `fastStt`. Local unless `wake` is in
   * `voice.sttCloudFor`: side talk without the wake word never leaves the server.
   */
  wakeStt?: SpeechToText;
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
  /**
   * Recognition is broken and nothing local takes over (`SttTrouble`: cloud down, no fallback): the bot
   * asks people to type. Called on every such failure – the bot shows it once per game. Must not throw.
   */
  onTrouble?: (msg: string) => void;
  /** Where `⏱` lines go (default: `info` on the voice logger). Only used with `cfg.latencyLog`. */
  latencyLog?: (line: string) => void;
}

export type Attention = 'answer' | 'confirm' | 'full' | 'wake';

/** How much of an utterance is checked for "Quizmaster" when someone is not on turn. */
const WAKE_HEAD_MS = 2000;

/** A failing wake check (or no local engine) warns at most this often; each one drops an utterance. */
const DROP_WARN_EVERY_MS = 60_000;

/** The engine itself if it is local; null for a cloud engine or none. */
function localOnly(stt: SpeechToText | null | undefined): SpeechToText | null {
  return stt && !isCloud(stt) ? stt : null;
}

/** All parts of one `say`: `key` and `interruptible` hold for the whole group. */
interface Group {
  key?: string;
  interruptible: boolean;
  /** Replaced or interrupted: parts not synthesised yet are skipped, queued ones dropped. */
  cancelled: boolean;
  /** Resolves (with null) when the group is cancelled – the queue stops waiting for a dropped part's audio. */
  dropped: Promise<null>;
  drop: () => void;
  /** Parts not yet spoken or dropped – `done` resolves the `say` at 0. */
  left: number;
  done: () => void;
}

interface QueueItem {
  text: string;
  group: Group;
  /** Same as `group.interruptible` (echo protection reads it from here). */
  interruptible: boolean;
  audio: Promise<Pcm | null>;
  times: SpeechTimes;
  /** Splitting: lets the synthesis chain move on without this part (its engine call hangs). */
  abandon?: () => void;
}

interface Spoken {
  from: number;
  to: number;
  interruptible: boolean;
  text: string;
  /** Splitting: the group of the part – its interval is stretched over the gap to the group's next part. */
  group?: Group;
}

/**
 * Splitting: how long the bot waits in the gap for the next part of a group it is already speaking, as
 * "still talking" (deaf to everyone not on turn). After that the group is given up like an interrupt, so a
 * hung engine (Piper has no timeout) leaves the bot mute but never deaf for long. Why 15 s: on a 1-vCPU
 * server Piper (thorsten-high) needs ~8 s for a whole 246-character question and rarely over 4 s for one
 * sentence; a part may also wait behind one pre-warm line (≤ 80 characters, ~2.5 s). And the part's
 * synthesis already ran while the previous part played. 15 s is three times the worst real part.
 */
export const PART_GAP_LIMIT_MS = 15_000;

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

/** Parts shorter than this are joined to a neighbour: one more synthesis call is not worth a few words. */
export const MIN_PART_CHARS = 25;

/** Words that end in a full stop without ending a sentence (compared in lower case). */
const ABBREVIATIONS = new Set(
  'ca bzw usw etc evtl ggf inkl exkl bspw vgl dr prof nr st str mio mrd jh jhd chr vs sog hl allg abs abb ff mind max min'.split(' '),
);

/**
 * Splits speakable text into sentence parts for `voice.ttsSplitSentences`: a cut only after `.`, `!` or
 * `?` (also behind a closing quote) followed by a space and a capital letter, digit or opening quote. A
 * full stop after a digit ("1. September", "Geschichte für 200."), a single letter ("z. B.", "A.") or a
 * known abbreviation ("ca.", "Nr.") never cuts; neither does "…". From the first answer option on
 * ("A: …", "A) …") nothing is cut, so the options stay one part. Parts under `MIN_PART_CHARS` are joined
 * to the next one (the last one to the previous). Why: the first part is the first sentence, so its
 * synthesis is short (≈ 1 s for ~30 characters on a 1-vCPU server) and the rest is made while it plays –
 * Piper is faster than real time, so the next sentence is usually ready before the current one ends.
 * Commas never cut: that would break the intonation.
 */
export function splitSentences(text: string): string[] {
  const options = text.search(/(?:^|\s)[A-H][:)]\s/);
  const stopAt = options < 0 ? text.length : options;
  const sentences: string[] = [];
  let from = 0;
  for (const m of text.matchAll(/([.!?])["“”»’']?(?=\s+["„“»']?[\p{Lu}\d])/gu)) {
    const end = m.index + m[0].length;
    if (end > stopAt) break;
    if (m[1] === '.') {
      const word = /(\S+)\.$/u.exec(text.slice(from, m.index + 1))?.[1] ?? '';
      const bare = word.replace(/^[(„"»']+/u, '');
      if (/\d$/.test(bare) || /^\p{L}$/u.test(bare) || /\.\p{L}$/u.test(bare) || ABBREVIATIONS.has(bare.toLowerCase())) continue;
    }
    sentences.push(text.slice(from, end).trim());
    from = end;
  }
  sentences.push(text.slice(from).trim());
  const parts: string[] = [];
  let buf = '';
  for (const s of sentences.filter(Boolean)) {
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= MIN_PART_CHARS) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) {
    if (parts.length) parts[parts.length - 1] = `${parts.at(-1)} ${buf}`;
    else parts.push(buf);
  }
  return parts;
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
  /**
   * Splitting: when the first part of the group being spoken started. Stays set in the gap while the next
   * part of the same group is still being synthesised – the bot is still talking (barge-in, echo, rule 8).
   */
  private groupFrom = 0;
  /** Someone started to speak (`onSpeechStart`): pre-warming waits until their utterance is in. */
  private speechHolds = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>();
  /** The sentence playing now was cut short by barge-in. */
  private cut = false;
  /** `⏱` measurement – timestamps only, never awaited. */
  private latency: LatencyMeter;
  /** The sentence whose synthesis was started last (serial engines like Piper start the next one after it). */
  private lastSynth: SpeechTimes | null = null;
  /** `ttsSplitSentences`: the last part handed to the engine – the next one starts only after it. */
  private synthTail: Promise<unknown> = Promise.resolve();
  /** Held on the TTS while the queue is not empty (pre-warming waits, see `TextToSpeech.hold`). */
  private speakHold: (() => void) | null = null;
  /** When each kind of drop warning was last logged (`DROP_WARN_EVERY_MS`). */
  private warnedAt = new Map<string, number>();

  constructor(private d: VoiceHostDeps) {
    this.latency = new LatencyMeter({ enabled: d.cfg.latencyLog !== false, log: d.latencyLog ?? ((l) => log.info(l)) });
    d.transport.onUtterance((u) => {
      const release = this.hold();
      this.endSpeechHold(u.speaker.id);
      void this.hear(u)
        .catch((e) => {
          log.warn(`Erkennung: ${(e as Error).message}`);
          if (e instanceof SttTrouble) this.trouble(e.message);
        })
        .finally(release);
    });
    // Discord tells us when someone starts to speak: the person on turn stops a hint right away.
    d.transport.onSpeechStart?.((s) => {
      this.speechStarted(s);
      if (this.playing?.interruptible && this.speaking() && this.mayInterrupt(s)) this.interrupt(s.displayName);
    });
    d.transport.onClose(() => {
      this.closed = true;
      this.cancel(() => true);
      this.releaseSpeakHold();
      for (const id of [...this.speechHolds.keys()]) this.endSpeechHold(id);
      this.latencySummary();
      d.onClose?.();
    });
  }

  private trouble(msg: string): void {
    try {
      this.d.onTrouble?.(msg);
    } catch {
      /* a broken notice must not break the voice path */
    }
  }

  /** Tells the TTS the voice path is busy; never throws. */
  private hold(): () => void {
    try {
      const release = this.d.tts.hold?.();
      return () => {
        try {
          release?.();
        } catch {
          /* never breaks the voice path */
        }
      };
    } catch {
      return () => {};
    }
  }

  /** The bot is talking: a part plays, or the next part of the same group is on its way (since when, 0 = not). */
  private speaking(): number {
    return this.currentFrom || this.groupFrom;
  }

  /**
   * Hold the TTS from someone's first sound on, not only once their utterance is complete: pre-warming
   * must not start while they talk. Released when their utterance arrives (then `hear` holds) or – the
   * transport drops utterances without audio – after the longest possible utterance.
   */
  private speechStarted(s: Speaker): void {
    const old = this.speechHolds.get(s.id);
    if (old) clearTimeout(old.timer);
    const release = old?.release ?? this.hold();
    const timer = setTimeout(() => this.endSpeechHold(s.id), (this.d.cfg.maxSpeechSec + 2) * 1000 + this.d.cfg.silenceMs);
    timer.unref?.();
    this.speechHolds.set(s.id, { release, timer });
  }

  private endSpeechHold(id: string): void {
    const h = this.speechHolds.get(id);
    if (!h) return;
    this.speechHolds.delete(id);
    clearTimeout(h.timer);
    h.release();
  }

  private releaseSpeakHold(): void {
    const release = this.speakHold;
    this.speakHold = null;
    release?.();
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
    if (opts.key) this.cancel((g) => g.key === opts.key);
    // `ttsSplitSentences`: one part per sentence – all parts form a group, see `Group`.
    const parts = this.d.cfg.ttsSplitSentences ? splitSentences(clean) : [clean];
    return new Promise<void>((resolve) => {
      let drop = () => {};
      const dropped = new Promise<null>((r) => (drop = () => r(null)));
      const group: Group = { key: opts.key, interruptible: !!opts.interruptible, cancelled: false, dropped, drop, left: parts.length, done: resolve };
      for (const part of parts) this.queue.push(this.item(part, group));
      if (!this.speakHold) this.speakHold = this.hold();
      void this.pump().catch((e) => log.warn(`Sprechen: ${(e as Error).message}`));
    });
  }

  /** One queued part: its synthesis is started (or, when splitting, chained) right away. */
  private item(text: string, group: Group): QueueItem {
    const cache = this.d.tts.cached?.(text) ?? false;
    const times = this.latency.queued({ engine: this.d.tts.engine ?? 'unbekannt', chars: text.length, cache });
    let raw: Promise<Pcm | null>;
    let abandon: (() => void) | undefined;
    let before: SpeechTimes | null = null;
    /** When the engine reported starting on it (`SynthOptions.onStart`, e.g. after a pre-warm line). */
    let engineStart: number | undefined;
    if (this.d.cfg.ttsSplitSentences && !cache) {
      // One part at a time, in queue order: a part reaches the engine only after the previous one is done,
      // so a part of a dropped group is skipped instead of holding up the next sentence behind it.
      raw = this.synthTail.then(() => {
        if (group.cancelled || this.closed) return null;
        times.synthStartAt = this.latency.stamp();
        // The engine may still finish a pre-warm line first: then it tells when it really starts on this one.
        return this.d.tts.synth(text, { onStart: () => (times.synthStartAt = this.latency.stamp()) });
      });
      // Normally the next part waits for this one; a part given up in the gap (`PART_GAP_LIMIT_MS`) lets it go.
      const given = new Promise<void>((r) => (abandon = r));
      this.synthTail = Promise.race([raw.catch(() => {}), given]);
    } else {
      // A synthesis still running when this one is queued delays its real start (one sentence at a time).
      // A cache hit needs no synthesis: it neither waits for one nor holds up the next sentence.
      before = !cache && this.lastSynth?.synthDoneAt === undefined ? this.lastSynth : null;
      if (!cache) this.lastSynth = times;
      raw = this.d.tts.synth(text, { onStart: () => (engineStart = this.latency.stamp()) });
    }
    const synthDone = () => {
      times.synthDoneAt = this.latency.stamp();
      times.synthStartAt ??= Math.max(before?.synthDoneAt ?? times.queuedAt, engineStart ?? 0);
    };
    raw.then(synthDone, synthDone); // side branch: the queue below does not wait for it
    const audio = raw.catch((e) => {
      // A synthesis past its deadline was reported by the engine already – without the text.
      if (e instanceof SynthTimeout) log.debug(`TTS: ${e.message}`);
      else log.warn(`TTS „${text.slice(0, 40)}“: ${(e as Error).message}`);
      return null;
    });
    return { text, group, interruptible: group.interruptible, audio, times, abandon };
  }

  /** A part is over (spoken, failed or dropped); the `say` resolves with its group's last part. */
  private finish(item: QueueItem): void {
    if (--item.group.left <= 0) item.group.done();
  }

  /** Removes queued parts. */
  private drop(which: (q: QueueItem) => boolean): void {
    const gone = this.queue.filter(which);
    this.queue = this.queue.filter((q) => !which(q));
    gone.forEach((q) => this.finish(q));
  }

  /** Drops every group that matches, with all its remaining parts (also syntheses still running). */
  private cancel(which: (g: Group) => boolean): void {
    const groups = new Set([...this.queue.map((q) => q.group), ...(this.playing ? [this.playing.group] : [])].filter(which));
    for (const g of groups) {
      g.cancelled = true;
      g.drop();
    }
    this.drop((q) => groups.has(q.group));
  }

  /** Drops everything not yet spoken (e.g. the game ended). */
  clear(): void {
    this.cancel(() => true);
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
      // Splitting: a dropped group's part is not waited for – its synthesis may finish later, unheard.
      let pcm = await (this.d.cfg.ttsSplitSentences ? this.partAudio(item) : item.audio);
      // Splitting: nothing of a replaced or interrupted group is heard any more, not even a part that was
      // still being synthesised. (Without splitting, the picked sentence plays as it always did.)
      if (item.group.cancelled && this.d.cfg.ttsSplitSentences) pcm = null;
      else if (!pcm) this.handOnReaction(item);
      if (pcm) {
        log.info(`🔊 ${item.text}`);
        const from = (this.currentFrom = Date.now());
        // The next part of the same group: the gap before it still counts as talking for later utterances.
        const prev = this.spoken.at(-1);
        if (this.groupFrom && prev?.group === item.group) prev.to = Math.max(prev.to, from);
        if (!this.groupFrom) this.groupFrom = from;
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
        if (!started) this.handOnReaction(item); // never audible: the next part answers
        this.currentFrom = 0;
        const to = this.cut ? Date.now() : Math.max(Date.now(), from + durationMs(pcm));
        this.spoken.push({ from, to, interruptible: item.interruptible, text: item.text, group: item.group });
        if (this.spoken.length > 30) this.spoken.shift();
      }
      this.playing = null;
      this.finish(item);
      // The group is over (or dropped): until its next part plays, the bot keeps talking only within a group.
      const next = this.queue[0];
      if (!next || next.group !== item.group || item.group.cancelled) this.groupFrom = 0;
    }
    if (!this.queue.length || this.closed) this.releaseSpeakHold();
  }

  /**
   * Splitting: a part's audio, or null once its group is dropped. In the gap of a group already being
   * spoken, at most `PART_GAP_LIMIT_MS` – then the group is given up, so the bot does not stay deaf.
   */
  private async partAudio(item: QueueItem): Promise<Pcm | null> {
    if (!this.groupFrom) return Promise.race([item.audio, item.group.dropped]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`Sprachausgabe: der nächste Teil einer Ansage kam nicht innerhalb von ${PART_GAP_LIMIT_MS / 1000} s – Rest verworfen`);
        item.abandon?.();
        this.cancel((g) => g === item.group);
        resolve(null);
      }, PART_GAP_LIMIT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([item.audio, item.group.dropped, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A part that never sounds (no audio, playback failed or never started) hands its reaction to the group's next part. */
  private handOnReaction(item: QueueItem): void {
    const r = item.times.reaction;
    const next = this.queue[0];
    if (!r || next?.group !== item.group || next.times.reaction) return;
    next.times.reaction = r;
    item.times.reaction = undefined;
  }

  /**
   * The engine that hears this attention (see `VoiceHostDeps`). `cloud` false → only a local engine
   * (null = there is none): for everyone not clearly allowed to speak (`cloudAllowed`).
   */
  private route(a: Attention, cloud = true): SpeechToText | null {
    const d = this.d;
    if (!cloud) {
      // Never a cloud engine here, however the deps are wired: without a local one there is none (null).
      const main = this.localMain();
      const fast = localOnly(d.localFastStt === undefined ? d.fastStt : d.localFastStt);
      return a === 'answer' ? (main ?? fast ?? null) : (fast ?? main ?? null);
    }
    if (a === 'answer') return d.stt;
    if (a === 'confirm') return d.confirmStt ?? d.fastStt ?? d.stt;
    // The wake check of people not on turn: a cloud engine only if passed as `wakeStt` on purpose (`wake`
    // in `sttCloudFor`); the defaults are local only – none → the utterance is dropped.
    if (a === 'wake') return d.wakeStt ?? localOnly(d.fastStt) ?? this.localMain();
    return d.fastStt ?? d.stt;
  }

  /** The local main model: `stt` itself unless the routing names another one; never a cloud engine (null). */
  private localMain(): SpeechToText | null {
    return localOnly(this.d.localStt === undefined ? this.d.stt : this.d.localStt);
  }

  /**
   * May this utterance go to a cloud route? Asked once per utterance, with its beginning: the earlier of the
   * transport's start and end minus the audio length (works without a start signal, e.g. loopback). No
   * beginning, no callback, an error or anything but `true` → no.
   */
  private cloudOk(u: Utterance): boolean {
    const start = Math.min(u.startedAt, u.endedAt - durationMs(u.pcm));
    if (!Number.isFinite(start) || !this.d.cloudAllowed) return false;
    try {
      return this.d.cloudAllowed(u.speaker, start) === true;
    } catch {
      return false;
    }
  }

  /** A warning without content, at most once a minute per kind (each one stands for dropped utterances). */
  private warnRarely(key: string, msg: string): void {
    const now = Date.now();
    if (now - (this.warnedAt.get(key) ?? -Infinity) < DROP_WARN_EVERY_MS) return;
    this.warnedAt.set(key, now);
    log.warn(msg);
  }

  /**
   * Hears with `stt`. If a local engine fails (not started, crashed twice), the local main model takes
   * over – never a cloud route, so a failed local check cannot send audio out. A cloud route keeps its
   * own fallback rule (`cloudFallback`; with `none` its failure stays a failure).
   */
  private async listen(stt: SpeechToText, pcm: Pcm, prompt: string, passes: SttPass[]): Promise<string> {
    try {
      passes.push({ engine: engineOf(stt) });
      return await stt.transcribe(pcm, prompt, this.sttOpts(passes));
    } catch (e) {
      const local = this.localMain();
      if (!local || local === stt || sameEngine(stt, local) || stt instanceof FallbackStt) throw e;
      log.warn(`Erkennung mit ${engineOf(stt)}: ${(e as Error).message} – nehme das lokale Hauptmodell`);
      const failed = passes.at(-1);
      if (failed) failed.fallback = true; // ⏱ rueckfall=ja
      passes.push({ engine: engineOf(local) });
      return local.transcribe(pcm, prompt, this.sttOpts(passes));
    }
  }

  /**
   * The wake check could not be done locally (engine failed, not ready): the utterance is dropped – it
   * never goes to the cloud instead. A warning without content, at most once a minute.
   */
  private wakeFailed(e: unknown, passes: SttPass[]): void {
    this.latency.wakeDropped(passes);
    log.debug(`Rufnamen-Prüfung: ${(e as Error)?.message ?? e}`);
    if (e instanceof SttTrouble) this.trouble(e.message);
    this.warnRarely('wake', 'Rufnamen-Prüfung gescheitert (lokale Erkennung nicht bereit) – Äußerung verworfen');
  }

  /** Lets a cloud route tell the measurement that its local fallback heard the utterance. Synchronous. */
  private sttOpts(passes: SttPass[]): SttOptions {
    return {
      onFallback: (engine, tried) => {
        const last = passes.at(-1);
        if (tried || !last) {
          if (last) last.fallback = true;
          passes.push({ engine });
        } else {
          // The cloud was skipped (paused): the local engine heard it in its place.
          last.engine = engine;
          last.fallback = true;
        }
      },
    };
  }

  private mayInterrupt(s: Speaker): boolean {
    return this.d.cfg.bargeIn && !!this.d.mayInterrupt?.(s);
  }

  private interrupt(who: string): void {
    if (this.cut) return;
    this.cut = true;
    log.info(`✋ ${who} unterbricht mich`);
    // The rest of the interrupted announcement goes too, not just the part playing now.
    const current = this.playing?.group;
    if (current) this.cancel((g) => g === current);
    this.d.transport.stop();
  }

  /** The bot's sentences an utterance started over (echo protection); empty when there are none or the guard is off. */
  private overlapped(u: Utterance): Pick<Spoken, 'interruptible' | 'text'>[] {
    if (!this.d.cfg.ignoreWhileSpeaking) return [];
    const tail = 300;
    const out: Pick<Spoken, 'interruptible' | 'text'>[] = this.spoken.filter((s) => u.startedAt >= s.from && u.startedAt <= s.to + tail);
    // Still talking: anything that started after the current sentence began overlaps.
    const since = this.speaking();
    if (since && this.playing && u.startedAt >= since) {
      out.push(this.playing);
      // Between two parts: the part just spoken is what may come back as echo.
      const last = this.spoken.at(-1);
      if (!this.currentFrom && last) out.push(last);
    }
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
    if (bargeIn && this.playing?.interruptible && this.speaking()) this.interrupt(who);
    let text: string;
    const attention = this.d.attention?.(u.speaker) ?? 'full';
    const passes: SttPass[] = [];
    if (attention === 'wake') {
      const start = head(u.pcm, WAKE_HEAD_MS);
      const wake = this.route('wake');
      if (!wake) {
        this.latency.wakeDropped(passes);
        log.debug(`🔇 ${who}: keine lokale Rufnamen-Prüfung – verworfen`);
        return this.warnRarely('no-local', 'Keine lokale Spracherkennung für eine Äußerung, die nicht in die Cloud darf – verworfen');
      }
      let heard: string;
      try {
        heard = await this.listen(wake, start, this.d.cfg.wakeWords.join(', '), passes);
      } catch (e) {
        return this.wakeFailed(e, passes);
      }
      if (stripWakeWord(heard, this.d.cfg.wakeWords) === null) {
        this.latency.wakeDropped(passes); // side talk: counted, no line
        return log.debug(`🔇 ${who} ist nicht dran – kein Rufname, verworfen`);
      }
      // Addressed to the bot (the wake word was heard): the whole utterance is heard like any command ('full').
      text = start === u.pcm ? heard : await this.listen(this.route('full')!, u.pcm, this.d.prompt(), passes);
    } else {
      // Cloud only for whom the bot clearly let speak the whole utterance; everyone else locally (or not at all).
      const cloud = this.cloudOk(u);
      const first = this.route(attention, cloud);
      if (!first) {
        this.latency.wakeDropped(passes);
        log.debug(`🔇 ${who}: keine lokale Erkennung für diese Person – verworfen`);
        return this.warnRarely('no-local', 'Keine lokale Spracherkennung für eine Äußerung, die nicht in die Cloud darf – verworfen');
      }
      text = await this.listen(first, u.pcm, this.d.prompt(), passes);
      // "Genau, meine Antwort ist zehn" while "Paris?" waits for "Ja": a new answer – hear it precisely
      // (only if the main model is another engine than the one that just heard it).
      const main = this.route('answer', cloud);
      if (attention === 'confirm' && main && first !== main && !sameEngine(first, main) && extractAnswer(text) !== null) {
        log.debug(`🎙 ${who}: neue Antwort in der Rückfrage – noch einmal mit dem Hauptmodell`);
        text = await this.listen(main, u.pcm, this.d.prompt(), passes);
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

/** Two routes that end at the same engine (two cloud routes with different local fallbacks). Unnamed engines never match. */
function sameEngine(a: SpeechToText, b: SpeechToText): boolean {
  return a === b || (!!a.engine && a.engine === b.engine);
}
