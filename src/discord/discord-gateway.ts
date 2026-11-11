import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, type Message } from 'discord.js';
import { createLogger } from '../core/logger.ts';
import type { ChatGateway, ChatMessage } from './gateway.ts';

const log = createLogger('discord');

/** discord.js implementation of the ChatGateway. */
export class DiscordGateway implements ChatGateway {
  private client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
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
      this.client.login(token).catch(reject);
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

  async destroy(): Promise<void> {
    await this.client.destroy();
  }
}
