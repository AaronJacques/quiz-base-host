import { AccountKeeper, LoginStatusStore } from '../account.ts';
import { QuizBaseBoardStudio } from '../board-studio.ts';
import { closeOpenBrowsers } from '../browser/playwright-driver.ts';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { onStopSignal } from '../core/signals.ts';
import { GameSession, fetchPublicBoards } from '../session.ts';
import { QuizBot } from './bot.ts';
import { DiscordGateway } from './discord-gateway.ts';
import type { ChatGateway } from './gateway.ts';
import { GuildStore } from './store.ts';
import { createVoiceKit, voiceProblems } from '../voice/index.ts';

const log = createLogger('discord');

/** A chat gateway the bot can log in with and shut down (`DiscordGateway`; the smoke test passes its own). */
export type BotGateway = ChatGateway & { login(token: string): Promise<void>; destroy(): Promise<void> };

/** `qbhost discord` – runs the bot until Ctrl+C / SIGTERM. `opts.gateway`: a gateway without Discord (smoke tests). */
export async function runDiscordBot(config: Config, opts: { gateway?: BotGateway; token?: string } = {}): Promise<void> {
  const token = opts.token ?? process.env[config.discord.tokenEnv];
  if (!token) {
    throw new Error(`Kein Discord-Token: setze ${config.discord.tokenEnv} (z.B. in .env). Anleitung: docs/DISCORD.md`);
  }
  // The bot serves every server at once – a stray promise rejection is logged, it must not end the process.
  process.on('unhandledRejection', (e) => log.error(`Unbehandelter Fehler: ${(e as Error)?.stack ?? e}`));
  const gateway = opts.gateway ?? new DiscordGateway();
  let voice = null;
  if (config.voice.enabled) {
    const problems = await voiceProblems(config);
    if (problems.length) log.warn(`Sprachsteuerung aus: ${problems.join('; ')} – \`npx qbhost voice-setup\``);
    else voice = createVoiceKit(config);
  }
  // The keeper asks the bot whether it is idle; the bot exists before the keeper's first timer can fire (start()).
  let bot: QuizBot | null = null;
  const keeper = new AccountKeeper({
    config,
    store: new LoginStatusStore(config.account.statusFile),
    isIdle: () => bot?.isIdleForMaintenance() ?? false,
  });
  bot = new QuizBot({
    gateway,
    config,
    store: new GuildStore(config.discord.dataDir),
    // Discord games have no terminal/web channel – the chat is the interface.
    createSession: (cfg) => new GameSession(cfg, [], { auth: keeper.authWatch('game'), onLogin: (ok) => keeper.report(ok, 'lobby') }),
    listBoards: (query) => fetchPublicBoards(config, query),
    voice,
    boards: new QuizBaseBoardStudio(config, { auth: keeper.authWatch('board'), onLogin: (ok) => keeper.report(ok, 'board-create') }),
    account: keeper,
  });
  try {
    await gateway.login(token);
  } catch (e) {
    // cli.ts exits with 1 right after: nothing of ours may still hold a browser (none should be open yet).
    await keeper.stop().catch(() => {});
    await closeOpenBrowsers(3000).catch(() => 0);
    throw e;
  }
  log.info(`Bereit. Befehle mit "${config.discord.prefix} hilfe" oder @Mention.${voice ? ' Sprachsteuerung: an.' : ''}`);
  // Only now can DMs go out: an unreported loss from before the restart, then the login watch.
  bot.reportPendingLoss();
  keeper.start();
  if (keeper.enabled) log.info(`🔐 Anmeldewächter an: erste Prüfung in ${config.account.startCheckDelaySec} s, dann alle ${config.account.keepAliveHours} h im Leerlauf`);

  const running = bot;
  await new Promise<void>((resolve) => {
    onStopSignal(
      async () => {
        await shutdownBot({ keeper, bot: running, voice, gateway, closeBrowsers: closeOpenBrowsers });
        resolve();
      },
      { beforeForceExit: () => closeOpenBrowsers(3000) },
    );
  });
}

/**
 * Time budgets of the shutdown (ms). Docker gives 60 s (`stop_grace_period`); the steps add up to 45 s, the
 * watchdog then closes the browsers (≤ 5 s) and ends the process – at the latest after 50 s.
 */
export const SHUTDOWN_BUDGET = { keeper: 8000, bot: 24_000, browsers: 7000, voice: 3000, gateway: 3000, watchdog: 45_000, watchdogBrowsers: 5000 };

export interface ShutdownParts {
  keeper: { stop(): Promise<void> };
  bot: { shutdown(): Promise<void> };
  voice?: { close(): Promise<void> } | null;
  gateway: { destroy(): Promise<void> };
  /** Closes every browser still open (`closeOpenBrowsers`); returns how many were open. */
  closeBrowsers: (timeoutMs: number) => Promise<number>;
  /** Hard end after the watchdog (default `process.exit`). */
  exit?: (code: number) => void;
  now?: () => number;
}

/**
 * Login watch → game + its browser → any browser still open → voice → Discord, each step time-limited, so
 * every browser is closed before the process ends (a killed Chromium loses a token it has not written yet).
 * Logs how long it took. If all of it hangs, the watchdog closes the browsers and exits with 1.
 * Returns the duration in ms (never rejects).
 */
export async function shutdownBot(p: ShutdownParts): Promise<number> {
  const now = p.now ?? Date.now;
  const exit = p.exit ?? ((code: number) => process.exit(code));
  const b = SHUTDOWN_BUDGET;
  const t0 = now();
  log.info('Fahre herunter … (noch einmal Strg+C schließt die Browser und beendet sofort)');
  let forced: Promise<void> | null = null;
  const watchdog = setTimeout(() => {
    log.warn(`Herunterfahren dauerte über ${b.watchdog / 1000} s – schließe die Browser und beende hart`);
    forced = p
      .closeBrowsers(b.watchdogBrowsers)
      .catch(() => 0)
      .then(() => exit(1));
  }, b.watchdog);
  await step('Anmeldewächter', p.keeper.stop(), b.keeper);
  await step('Spiel', p.bot.shutdown(), b.bot);
  const late = await step('Browser', p.closeBrowsers(b.browsers), b.browsers); // safety net – normally 0
  await step('Sprache', p.voice?.close() ?? Promise.resolve(), b.voice);
  await step('Discord', p.gateway.destroy(), b.gateway);
  clearTimeout(watchdog);
  if (forced) await forced;
  const ms = now() - t0;
  const n = typeof late === 'number' ? late : 0;
  log.info(`Heruntergefahren in ${(ms / 1000).toFixed(1).replace('.', ',')} s${n ? ` (${n} Browser erst am Ende geschlossen)` : ''}`);
  return ms;
}

/** Awaits `p` at most `ms`; a timeout or an error is logged as a warning. Returns the value, or undefined. */
async function step<T>(what: string, p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol('timeout');
  try {
    const r = await Promise.race([p, new Promise<typeof timeout>((res) => (t = setTimeout(() => res(timeout), ms)))]);
    if (r === timeout) {
      log.warn(`Herunterfahren: ${what} nicht in ${ms / 1000} s fertig – weiter`);
      return undefined;
    }
    return r as T;
  } catch (e) {
    log.warn(`Herunterfahren: ${what}: ${(e as Error).message}`);
    return undefined;
  } finally {
    clearTimeout(t);
  }
}
