import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { GameSession, fetchPublicBoards } from '../session.ts';
import { QuizBot } from './bot.ts';
import { DiscordGateway } from './discord-gateway.ts';
import { GuildStore } from './store.ts';

const log = createLogger('discord');

/** `qbhost discord` – runs the bot until Ctrl+C. */
export async function runDiscordBot(config: Config): Promise<void> {
  const token = process.env[config.discord.tokenEnv];
  if (!token) {
    throw new Error(`Kein Discord-Token: setze ${config.discord.tokenEnv} (z.B. in .env). Anleitung: docs/DISCORD.md`);
  }
  const gateway = new DiscordGateway();
  const bot = new QuizBot({
    gateway,
    config,
    store: new GuildStore(config.discord.dataDir),
    // Discord games have no terminal/web channel – the chat is the interface.
    createSession: (cfg) => new GameSession(cfg, []),
    listBoards: (query) => fetchPublicBoards(config, query),
  });
  await gateway.login(token);
  log.info(`Bereit. Befehle mit "${config.discord.prefix} hilfe" oder @Mention.`);

  await new Promise<void>((resolve) => {
    const stop = async () => {
      log.info('Fahre herunter …');
      await bot.shutdown().catch(() => {});
      await gateway.destroy();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
