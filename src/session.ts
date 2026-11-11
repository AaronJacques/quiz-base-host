import { createDriver, type BrowserDriver } from './browser/index.ts';
import type { Channel } from './channels/channel.ts';
import type { Config } from './config.ts';
import { EventBus } from './core/events.ts';
import { createLogger, sleep } from './core/logger.ts';
import { createJudge } from './judge/index.ts';
import { createLlm, UsageMeter } from './llm/index.ts';
import { TafelquizController } from './modes/tafelquiz/controller.ts';
import type { GameRules } from './modes/tafelquiz/rules.ts';
import { createLobbyWithPublicBoard, listPublicBoards } from './site/lobby.ts';
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

  constructor(
    private config: Config,
    private channels: Channel[] = [],
  ) {
    this.rules = { ...config.game };
    this.driver = createDriver(config);
    this.page = new TafelquizPage(this.driver);

    // Operator point corrections go straight to the page.
    this.bus.on('operator:command', async ({ command, args }) => {
      if (command !== 'punkte' || args.length < 2) return;
      const delta = Number(args[args.length - 1]);
      const name = args.slice(0, -1).join(' ');
      if (Number.isFinite(delta)) await this.page.award(name, delta);
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

  /** Creates a Tafelquiz lobby for a public board and returns code + invite link. */
  async createLobby(boardTitle: string): Promise<LobbyInfo> {
    await this.open();
    await createLobbyWithPublicBoard(this.driver, this.config.baseUrl, 'Tafelquiz', boardTitle);
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

  /** Ends the game on quiz-base (results for everyone) and stops the controller. */
  async endGame(): Promise<void> {
    const s = await this.page.state().catch(() => null);
    if (s && (s.phase === 'board' || s.phase === 'question')) await this.page.endGame();
    else if (s?.phase === 'lobby') await this.page.closeLobby();
    this.ac.abort();
  }

  async close(): Promise<void> {
    this.ac.abort();
    log.info(`Verbrauch: ${this.meter.summary()}`);
    for (const c of this.channels) await c.stop().catch(() => {});
    await this.driver.close().catch(() => {});
  }
}

/** Lists public Tafelquiz boards with a short-lived browser. */
export async function fetchPublicBoards(config: Config): Promise<string[]> {
  const driver = createDriver(config);
  try {
    await driver.open(config.baseUrl);
    return await listPublicBoards(driver, config.baseUrl, 'Tafelquiz');
  } finally {
    await driver.close().catch(() => {});
  }
}
