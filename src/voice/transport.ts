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

/**
 * Audio in and out of a voice room. `DiscordVoiceTransport` is the real one;
 * `LoopbackTransport` lets local test clients (or agents) talk to the bot over HTTP.
 */
export interface VoiceTransport {
  readonly label: string;
  /** Plays audio and resolves when playback has finished (or was stopped). */
  play(pcm: Pcm): Promise<void>;
  stop(): void;
  onUtterance(handler: (u: Utterance) => void): void;
  /** Called when the connection is gone for good (kicked, channel deleted, network). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}
