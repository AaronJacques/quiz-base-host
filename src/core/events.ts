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
  'host:turn': { player: string; open: BoardCell[]; categories: string[] };
  'host:question': { player: string; category: string; points: number; text: string; hasImage: boolean; hasAudio: boolean };
  'host:await-answer': { player: string; timeoutSec: number; viaBuzzer: boolean };
  'host:verdict': { player: string; answer: string; correct: boolean; delta: number; reason?: string };
  'host:reveal': { answer: string | null };
  'host:scores': { players: PlayerState[] };
  'host:game-over': { players: PlayerState[] };
  'host:say': { text: string };

  // ── world → host ─────────────────────────────────────────────
  'player:pick': { player: string; col: number; row: number };
  'player:answer': { player: string; answer: string };
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
