import { QuizBaseBoardStudio } from '../board-studio.ts';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { onStopSignal } from '../core/signals.ts';
import { GameSession, fetchPublicBoards } from '../session.ts';
import { QuizBot } from './bot.ts';
import { DiscordGateway } from './discord-gateway.ts';
import { GuildStore } from './store.ts';
import { createVoiceKit, voiceProblems } from '../voice/index.ts';

const log = createLogger('discord');

/** `qbhost discord` – runs the bot until Ctrl+C. */
export async function runDiscordBot(config: Config): Promise<void> {
  const token = process.env[config.discord.tokenEnv];
  if (!token) {
    throw new Error(`Kein Discord-Token: setze ${config.discord.tokenEnv} (z.B. in .env). Anleitung: docs/DISCORD.md`);
  }
  // The bot serves every server at once – a stray promise rejection is logged, it must not end the process.
  process.on('unhandledRejection', (e) => log.error(`Unbehandelter Fehler: ${(e as Error)?.stack ?? e}`));
  const gateway = new DiscordGateway();
  let voice = null;
  if (config.voice.enabled) {
    const problems = await voiceProblems(config);
    if (problems.length) log.warn(`Sprachsteuerung aus: ${problems.join('; ')} – \`npx qbhost voice-setup\``);
    else voice = createVoiceKit(config);
  }
  const bot = new QuizBot({
    gateway,
    config,
    store: new GuildStore(config.discord.dataDir),
    // Discord games have no terminal/web channel – the chat is the interface.
    createSession: (cfg) => new GameSession(cfg, []),
    listBoards: (query) => fetchPublicBoards(config, query),
    voice,
    boards: new QuizBaseBoardStudio(config),
  });
  await gateway.login(token);
  log.info(`Bereit. Befehle mit "${config.discord.prefix} hilfe" oder @Mention.${voice ? ' Sprachsteuerung: an.' : ''}`);

  await new Promise<void>((resolve) => {
    onStopSignal(async () => {
      log.info('Fahre herunter … (noch einmal Strg+C erzwingt das Beenden)');
      await bot.shutdown().catch(() => {});
      await voice?.close().catch(() => {});
      await gateway.destroy();
      resolve();
    });
  });
}
