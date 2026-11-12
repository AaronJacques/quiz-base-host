import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, type Message } from 'discord.js';
import { DiscordVoiceTransport } from '../voice/discord-voice.ts';
import type { Speaker, VoiceTransport } from '../voice/transport.ts';
import { createLogger } from '../core/logger.ts';
import type { ChatGateway, ChatMessage } from './gateway.ts';

const log = createLogger('discord');

/** discord.js implementation of the ChatGateway. */
export class DiscordGateway implements ChatGateway {
  private client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel],
  });
  private handlers: ((m: ChatMessage) => void | Promise<void>)[] = [];
  private raw = new Map<string, Message>();

  get botUserId(): string {
    return this.client.user?.id ?? '';
  }

  async login(token: string): Promise<void> {
    this.client.on(Events.MessageCreate, (m) => this.dispatch(m));
    this.client.on(Events.Error, (e) => log.error(e.message));
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (c) => {
        log.info(`Eingeloggt als ${c.user.tag} – auf ${c.guilds.cache.size} Server(n)`);
        resolve();
      });
      this.client.login(token).catch((e: Error) => {
        if (/disallowed intents/i.test(e.message)) {
          reject(new Error('Discord lehnt die Intents ab: Im Developer Portal unter Bot → Privileged Gateway Intents den „Message Content Intent“ einschalten und speichern (docs/DISCORD.md).'));
        } else if (/invalid token|TokenInvalid/i.test(e.message)) {
          reject(new Error('Discord-Token ungültig: im Developer Portal unter Bot → Reset Token neu erzeugen und in .env eintragen.'));
        } else reject(e);
      });
    });
  }

  onMessage(handler: (msg: ChatMessage) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  private dispatch(m: Message): void {
    const botId = this.botUserId;
    const mentionsBot = !!botId && m.mentions.users.has(botId);
    const content = m.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    const msg: ChatMessage = {
      id: m.id,
      channelId: m.channelId,
      guildId: m.guildId,
      author: {
        id: m.author.id,
        username: m.author.username,
        displayName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
        isBot: m.author.bot,
      },
      content,
      mentionsBot,
      mentions: [...m.mentions.users.keys()].filter((id) => id !== botId),
      canManage: !!m.member?.permissions.has(PermissionFlagsBits.ManageGuild),
      voiceChannelId: m.member?.voice.channelId ?? null,
    };
    this.raw.set(m.id, m);
    if (this.raw.size > 200) this.raw.delete(this.raw.keys().next().value!);
    for (const h of this.handlers) void h(msg);
  }

  async send(channelId: string, text: string): Promise<void> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch?.isSendable()) throw new Error(`Channel ${channelId} nicht beschreibbar`);
    await ch.send({ content: text, allowedMentions: { parse: ['users'] } });
  }

  async sendDirect(userId: string, text: string): Promise<void> {
    const user = await this.client.users.fetch(userId);
    await user.send(text);
  }

  async react(msg: ChatMessage, emoji: string): Promise<void> {
    await this.raw.get(msg.id)?.react(emoji).catch(() => {});
  }

  async joinVoice(guildId: string, channelId: string, opts: { silenceMs: number; maxSpeechSec: number }): Promise<VoiceTransport> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) throw new Error('Das ist kein Voice-Channel.');
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
      throw new Error(`Mir fehlen im Voice-Channel „${channel.name}“ die Rechte „Verbinden“ und/oder „Sprechen“.`);
    }
    return DiscordVoiceTransport.join({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      ...opts,
      speaker: (userId) => {
        const member = guild.members.cache.get(userId);
        if (!member || member.user.bot) return null;
        return { id: userId, username: member.user.username, displayName: member.displayName };
      },
    });
  }

  voiceMembers(guildId: string, channelId: string): Speaker[] {
    const channel = this.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()].filter((m) => !m.user.bot).map((m) => ({ id: m.id, username: m.user.username, displayName: m.displayName }));
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
