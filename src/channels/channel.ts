import type { EventBus } from '../core/events.ts';

/**
 * A channel connects people to the host: it renders `host:*` events and turns
 * input into `player:*` / `operator:*` events. Channels never touch the
 * browser or the game logic directly – that's what keeps adding Discord, TTS or
 * speech input a matter of writing one more class.
 */
export interface Channel {
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
}
