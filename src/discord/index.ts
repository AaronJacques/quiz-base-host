import { AccountKeeper, LoginStatusStore, type AccountKeeperDeps } from '../account.ts';
import { QuizBaseBoardStudio, type BoardStudio, type BoardStudioOptions } from '../board-studio.ts';
import { closeOpenBrowsers } from '../browser/playwright-driver.ts';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { onStopSignal } from '../core/signals.ts';
import { GameSession, fetchPublicBoards, type GameSessionOptions } from '../session.ts';
import { QuizBot, type SessionLike } from './bot.ts';
import { DiscordGateway } from './discord-gateway.ts';
import type { ChatGateway } from './gateway.ts';
import { GuildStore } from './store.ts';
import { createVoiceKit, voiceProblems } from '../voice/index.ts';

const log = createLogger('discord');

/** A chat gateway the bot can log in with and shut down (`DiscordGateway`; tests pass their own). */
export type BotGateway = ChatGateway & { login(token: string): Promise<void>; destroy(): Promise<void> };

/**
 * Seams for tests (all optional; production uses the defaults). They replace only what would need Discord, a browser
 * or process signals – the wiring between keeper, bot, sessions and shutdown stays the production code.
 */
export interface DiscordBotOptions {
  gateway?: BotGateway;
  token?: string;
  /** Game session from the config and the keeper's session options (default `new GameSession(cfg, [], opts)`). */
  createSession?: (config: Config, opts: GameSessionOptions) => SessionLike;
  /** Board studio from the config and the keeper's options (default `new QuizBaseBoardStudio`). */
  createBoards?: (config: Config, opts: BoardStudioOptions) => BoardStudio;
  /** Public boards (default: quiz-base's own search in a browser). */
  listBoards?: (query?: string) => Promise<string[]>;
  /** Extra deps for the AccountKeeper (tests: `openProbe`, `now`). */
  keeperDeps?: Pick<AccountKeeperDeps, 'openProbe' | 'now' | 'random'>;
  /** Default `closeOpenBrowsers`. */
  closeBrowsers?: (timeoutMs: number) => Promise<number>;
  /** Default `onStopSignal` (SIGINT/SIGTERM). */
  onStop?: typeof onStopSignal;
  /** Install the `unhandledRejection` logger. Default true; tests: false. */
  processHandlers?: boolean;
  exit?: (code: number) => void;
}

export interface RunningBot {
  bot: QuizBot;
  keeper: AccountKeeper;
  /** Resolves once a stop signal shut everything down. */
  stopped: Promise<void>;
}

/** `qbhost discord` – runs the bot until Ctrl+C / SIGTERM. */
export async function runDiscordBot(config: Config, opts: DiscordBotOptions = {}): Promise<void> {
  await (await startDiscordBot(config, opts)).stopped;
}

/** Starts the bot (login, pending loss DM, login watch) and arms the clean shutdown on a stop signal. */
export async function startDiscordBot(config: Config, opts: DiscordBotOptions = {}): Promise<RunningBot> {
  const token = opts.token ?? process.env[config.discord.tokenEnv];
  if (!token) {
    throw new Error(`Kein Discord-Token: setze ${config.discord.tokenEnv} (z.B. in .env). Anleitung: docs/DISCORD.md`);
  }
  const closeBrowsers = opts.closeBrowsers ?? closeOpenBrowsers;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  if (opts.processHandlers !== false) {
    // The bot serves every server at once – a stray promise rejection is logged, it must not end the process.
    // (An exception nobody caught: `onFatalError` in cli.ts closes the browsers and exits with 1.)
    process.on('unhandledRejection', (e) => log.error(`Unbehandelter Fehler: ${redact((e as Error)?.stack ?? String(e), token)}`));
  }
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
    ...opts.keeperDeps,
    config,
    store: new LoginStatusStore(config.account.statusFile),
    isIdle: () => bot?.isIdleForMaintenance() ?? false,
  });
  const createSession = opts.createSession ?? ((cfg, o) => new GameSession(cfg, [], o));
  const createBoards = opts.createBoards ?? ((cfg, o) => new QuizBaseBoardStudio(cfg, o));
  bot = new QuizBot({
    gateway,
    config,
    store: new GuildStore(config.discord.dataDir),
    // Discord games have no terminal/web channel – the chat is the interface.
    createSession: (cfg) => createSession(cfg, { auth: keeper.authWatch('game'), onLogin: (ok) => keeper.report(ok, 'lobby') }),
    listBoards: opts.listBoards ?? ((query) => fetchPublicBoards(config, query)),
    voice,
    boards: createBoards(config, { auth: keeper.authWatch('board'), onLogin: (ok) => keeper.report(ok, 'board-create') }),
    account: keeper,
  });
  try {
    await gateway.login(token);
  } catch (e) {
    // cli.ts exits with 1 right after: nothing of ours may still hold a browser (none should be open yet).
    await keeper.stop().catch(() => {});
    await closeBrowsers(3000).catch(() => 0);
    throw e;
  }
  log.info(`Bereit. Befehle mit "${config.discord.prefix} hilfe" oder @Mention.${voice ? ' Sprachsteuerung: an.' : ''}`);
  // Only now can DMs go out: an unreported loss from before the restart, then the login watch.
  bot.reportPendingLoss();
  keeper.start();
  if (keeper.enabled) log.info(`🔐 Anmeldewächter an: erste Prüfung in ${config.account.startCheckDelaySec} s, dann alle ${config.account.keepAliveHours} h im Leerlauf`);

  const running = bot;
  const stopped = new Promise<void>((resolve) => {
    (opts.onStop ?? onStopSignal)(
      async () => {
        await shutdownBot({ keeper, bot: running, voice, gateway, closeBrowsers, exit });
        resolve();
      },
      { beforeForceExit: () => closeBrowsers(3000) },
    );
  });
  return { bot: running, keeper, stopped };
}

/** Replaces the Discord token (if it ever appears in an error text) before logging. */
function redact(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join('***') : text;
}

/**
 * Time budgets of the shutdown (ms). Docker gives 60 s (`stop_grace_period`); the steps add up to 45 s, the
 * watchdog then closes the browsers (≤ 5 s) and ends the process – at the latest after 50 s.
 */
export const SHUTDOWN_BUDGET = { keeper: 8000, bot: 24_000, browsers: 7000, voice: 3000, gateway: 3000, watchdog: 45_000, watchdogBrowsers: 5000 };

export interface ShutdownParts {
  keeper: { stop(): Promise<void> };
  /** `beginShutdown`: refuse new lobbies and boards from now on (called first). */
  bot: { shutdown(): Promise<void>; beginShutdown?(): void };
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
  try {
    p.bot.beginShutdown?.(); // no new lobby may start while the running one is ended (it would stay open on quiz-base)
  } catch (e) {
    log.warn(`Herunterfahren: ${(e as Error).message}`);
  }
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
