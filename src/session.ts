import { createDriver, type BrowserDriver } from './browser/index.ts';
import type { Channel } from './channels/channel.ts';
import type { Config } from './config.ts';
import { EventBus } from './core/events.ts';
import { createLogger, sleep } from './core/logger.ts';
import { createJudge } from './judge/index.ts';
import { createLlm, UsageMeter } from './llm/index.ts';
import { TafelquizController } from './modes/tafelquiz/controller.ts';
import type { GameRules } from './modes/tafelquiz/rules.ts';
import { createLobbyWithOwnBoard, createLobbyWithPublicBoard, listPublicBoards } from './site/lobby.ts';
import { TafelquizPage } from './site/tafelquiz/page.ts';

const log = createLogger('session');

export interface LobbyInfo {
  code: string;
  joinUrl: string;
}

/**
 * One game from lobby to results: its own browser tab, event bus, judge and
 * controller. The CLI host runs exactly one; the Discord bot creates one per
 * `!quiz neu`. `rules` is a live object – changing it affects the next
 * question of a running game.
 */
export class GameSession {
  readonly bus = new EventBus();
  readonly meter = new UsageMeter();
  readonly rules: GameRules;
  readonly page: TafelquizPage;
  private driver: BrowserDriver;
  private ac = new AbortController();
  private opened = false;
  private ending: Promise<void> | null = null;

  constructor(
    private config: Config,
    private channels: Channel[] = [],
  ) {
    this.rules = { ...config.game };
    this.driver = createDriver(config);
    this.page = new TafelquizPage(this.driver);

    // Operator point corrections go straight to the page. A failing browser must not take the process down.
    this.bus.on('operator:command', ({ command, args }) => {
      if (command !== 'punkte' || args.length < 2) return;
      const delta = Number(args[args.length - 1]);
      const name = args.slice(0, -1).join(' ');
      if (!Number.isFinite(delta)) return;
      this.page.award(name, delta).then(
        (r) => void (r.ok || log.warn(`Punktekorrektur ${name} ${delta}: ${r.error ?? 'fehlgeschlagen'}`)),
        (e) => log.warn(`Punktekorrektur ${name} ${delta}: ${(e as Error).message}`),
      );
    });
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    for (const c of this.channels) await c.start(this.bus);
    await this.driver.open(this.config.baseUrl);
  }

  /** Creates a Tafelquiz lobby for a public board (or, with `own`, one of the account's boards) and returns code + invite link. */
  async createLobby(boardTitle: string, opts: { own?: boolean } = {}): Promise<LobbyInfo> {
    await this.open();
    if (opts.own) await createLobbyWithOwnBoard(this.driver, this.config.baseUrl, boardTitle);
    else await createLobbyWithPublicBoard(this.driver, this.config.baseUrl, 'Tafelquiz', boardTitle);
    await this.page.revealCode();
    const s = await this.page.waitFor((x) => !!x.lobbyCode, 8000, 300);
    if (!s?.lobbyCode) throw new Error('Lobby-Code nicht lesbar');
    return { code: s.lobbyCode, joinUrl: `${this.config.baseUrl}/join?code=${s.lobbyCode}` };
  }

  /** Drives the game until results (or `stop()`). */
  async run(): Promise<void> {
    await this.open();
    const llm = createLlm(this.config);
    const judge = createJudge(this.config, this.bus, llm, this.meter);
    log.info(`LLM: ${llm ? `${llm.name}/${this.config.llm.model}` : 'aus'} · Bewertung: ${this.config.judge.strategy}`);

    while (!this.ac.signal.aborted) {
      const s = await this.page.state().catch(() => null);
      if (s && s.phase !== 'unknown') break;
      await sleep(1500);
    }
    const controller = new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: this.config.browser.pollMs });
    await controller.run(this.ac.signal);
  }

  /**
   * Ends the game on quiz-base (results for everyone) and stops the controller. The controller is
   * stopped first, so a question that is cut off gets no verdict, no points and no further clicks.
   */
  endGame(): Promise<void> {
    this.ending ??= (async () => {
      this.ac.abort();
      const s = await this.page.state().catch(() => null);
      if (s && (s.phase === 'board' || s.phase === 'question')) await this.page.endGame();
      else if (s?.phase === 'lobby') await this.page.closeLobby();
    })();
    return this.ending;
  }

  async close(): Promise<void> {
    this.ac.abort();
    await this.ending?.catch(() => {}); // let "Spiel beenden" finish before the browser goes away
    log.info(`Verbrauch: ${this.meter.summary()}`);
    for (const c of this.channels) await c.stop().catch(() => {});
    await this.driver.close().catch(() => {});
  }
}

let searchQueue: Promise<unknown> = Promise.resolve();

/**
 * Lists public Tafelquiz boards (optionally via quiz-base's search) with a
 * short-lived browser. Uses its own profile so it never collides with a game's
 * browser, and runs one search at a time.
 */
export function fetchPublicBoards(config: Config, query?: string): Promise<string[]> {
  const run = async () => {
    const driver = createDriver({ ...config, browser: { ...config.browser, headless: true, profileDir: `${config.browser.profileDir}-search` } });
    try {
      await driver.open(config.baseUrl);
      return await listPublicBoards(driver, config.baseUrl, 'Tafelquiz', query);
    } finally {
      await driver.close().catch(() => {});
    }
  };
  const result = searchQueue.then(run, run);
  searchQueue = result.catch(() => {});
  return result;
}
