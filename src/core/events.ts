import { EventEmitter } from 'node:events';
import type { BoardCell, PlayerState } from './types.ts';

/**
 * Everything that crosses module boundaries goes through this typed bus.
 * Channels (web companion, terminal, later Discord/TTS) subscribe to the
 * `host:*` events and emit `player:*` / `operator:*` events.
 */
export interface HostEvents {
  // ── host → world ─────────────────────────────────────────────
  'host:status': { phase: string; message: string };
  /** Waiting room changed (players joined / got ready). */
  'host:lobby': { code: string | null; players: { name: string; ready: boolean }[]; canStart: boolean };
  /** `grid` = all cells of the active board incl. answered ones (needed to say "schon weg"). */
  'host:turn': { player: string; open: BoardCell[]; grid: BoardCell[]; categories: string[]; board: { active: number; count: number } };
  /** Short structured game notices that chat channels may render (the terminal uses host:say). */
  'host:notice': { kind: 'buzzer-open' | 'buzzed' | 'no-buzz' | 'reminder' | 'board-switch' | 'operator-needed' | 'started'; player?: string; text: string; /** Private detail (may contain the solution) – only for the game leader. */ detail?: string };
  'host:question': { player: string; category: string; points: number; text: string; hasImage: boolean; hasAudio: boolean; /** Multiple-choice labels (without the correct flag). */ options: string[] };
  'host:await-answer': { player: string; timeoutSec: number; viaBuzzer: boolean };
  'host:verdict': { player: string; answer: string; correct: boolean; delta: number; reason?: string };
  'host:reveal': { answer: string | null };
  'host:scores': { players: PlayerState[] };
  'host:game-over': { players: PlayerState[] };
  'host:say': { text: string };

  // ── world → host ─────────────────────────────────────────────
  'player:pick': { player: string; col: number; row: number };
  /** `spoken` = transcribed from speech, so it may contain recognition errors. */
  'player:answer': { player: string; answer: string; spoken?: boolean };
  /** A buzz claimed outside quiz-base (e.g. someone shouts "Buzzer!" in voice chat). */
  'player:buzz': { player: string };
  'operator:command': { command: string; args: string[] };
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof HostEvents>(event: K, payload: HostEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof HostEvents>(event: K, handler: (payload: HostEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  /** Resolve with the first payload that matches `filter`, or null after `timeoutMs`. */
  waitFor<K extends keyof HostEvents>(
    event: K,
    filter: (payload: HostEvents[K]) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HostEvents[K] | null> {
    return new Promise((resolve) => {
      const done = (value: HostEvents[K] | null) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const off = this.on(event, (p) => {
        if (filter(p)) done(p);
      });
      const onAbort = () => done(null);
      signal?.addEventListener('abort', onAbort);
      const timer = setTimeout(() => done(null), timeoutMs);
    });
  }
}
