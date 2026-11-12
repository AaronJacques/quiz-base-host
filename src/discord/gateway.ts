import type { Speaker, VoiceTransport } from '../voice/transport.ts';

/**
 * The bot's view of a chat platform. `DiscordGateway` implements it with
 * discord.js; tests use an in-memory fake. Keeping this tiny is what makes the
 * whole bot logic unit-testable without a Discord token.
 */
export interface ChatMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author: { id: string; username: string; displayName: string; isBot: boolean };
  /** Text with the bot mention already removed. */
  content: string;
  mentionsBot: boolean;
  /** User IDs mentioned in the message (excluding the bot). */
  mentions: string[];
  /** Author may manage the server (admins can always lead games). */
  canManage: boolean;
  /** Voice channel the author is in right now, if any. */
  voiceChannelId?: string | null;
  /** Synthesised from speech in a voice channel (not typed). */
  viaVoice?: boolean;
}

export interface ChatGateway {
  readonly botUserId: string;
  onMessage(handler: (msg: ChatMessage) => void | Promise<void>): void;
  send(channelId: string, text: string): Promise<void>;
  /** Direct message – used for secrets like the solution when the leader must decide. */
  sendDirect(userId: string, text: string): Promise<void>;
  react(msg: ChatMessage, emoji: string): Promise<void>;
  /** Joins a voice channel (optional – platforms/tests without voice leave it out). */
  joinVoice?(guildId: string, channelId: string, opts: { silenceMs: number; maxSpeechSec: number }): Promise<VoiceTransport>;
  /** People currently in a voice channel (for automatic name linking). */
  voiceMembers?(guildId: string, channelId: string): Speaker[];
}

export const mention = (userId: string) => `<@${userId}>`;
