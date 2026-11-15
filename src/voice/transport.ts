import type { Pcm } from './audio.ts';

export interface Speaker {
  id: string;
  username: string;
  displayName: string;
}

/** One finished utterance of one person (the platform already separates speakers). */
export interface Utterance {
  speaker: Speaker;
  pcm: Pcm;
  /** Epoch ms when the person started / stopped speaking. */
  startedAt: number;
  endedAt: number;
}

export interface PlayOptions {
  /** Playback really started. Must not throw (it runs inside the transport's event handling). */
  onStart?: () => void;
}

/**
 * Audio in and out of a voice room. `DiscordVoiceTransport` is the real one;
 * `LoopbackTransport` lets local test clients (or agents) talk to the bot over HTTP.
 */
export interface VoiceTransport {
  readonly label: string;
  /** Calls `play`'s `onStart` when sound really starts. Without it the `play` call counts as start (`⏱` lines). */
  readonly reportsStart?: boolean;
  /**
   * Plays audio and resolves when playback has finished (or was stopped). `onStart` is called once when
   * the sound actually starts (latency measurement); transports may leave it out.
   */
  play(pcm: Pcm, opts?: PlayOptions): Promise<void>;
  stop(): void;
  onUtterance(handler: (u: Utterance) => void): void;
  /** Someone started to speak (before the utterance is complete) – for barge-in. Optional: transports without it deliver whole utterances only. */
  onSpeechStart?(handler: (s: Speaker) => void): void;
  /** Called when the connection is gone for good (kicked, channel deleted, network). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}
