import type { Config } from './config.ts';
import { createDriver, type BrowserDriver } from './browser/index.ts';
import type { Channel } from './channels/channel.ts';
import { TerminalChannel } from './channels/terminal.ts';
import { WebCompanion } from './channels/web/server.ts';
import { EventBus } from './core/events.ts';
import { createLogger } from './core/logger.ts';
import { createJudge } from './judge/index.ts';
import { createLlm, UsageMeter } from './llm/index.ts';
import { TafelquizController } from './modes/tafelquiz/controller.ts';
import { createLobbyWithPublicBoard } from './site/lobby.ts';
import { TafelquizPage } from './site/tafelquiz/page.ts';

const log = createLogger('app');

/**
 * Composition root: builds every component from config and wires them
 * together. This is the only place that knows concrete classes.
 */
export async function runHost(config: Config): Promise<void> {
  const bus = new EventBus();
  const meter = new UsageMeter();
  const llm = createLlm(config);
  const judge = createJudge(config, bus, llm, meter);
  const driver: BrowserDriver = createDriver(config);
  const page = new TafelquizPage(driver);

  const channels: Channel[] = [new TerminalChannel()];
  if (config.companion.enabled) channels.push(new WebCompanion({ port: config.companion.port, host: config.companion.host }));
  for (const c of channels) await c.start(bus);

  // Operator point corrections go straight to the page.
  bus.on('operator:command', async ({ command, args }) => {
    if (command !== 'punkte' || args.length < 2) return;
    const delta = Number(args[args.length - 1]);
    const name = args.slice(0, -1).join(' ');
    if (Number.isFinite(delta)) await page.award(name, delta);
  });

  log.info(`Browser: ${driver.name} · LLM: ${llm ? `${llm.name}/${config.llm.model}` : 'aus'} · Bewertung: ${config.judge.strategy}`);
  await driver.open(config.baseUrl);

  if (config.game.publicBoard) {
    await createLobbyWithPublicBoard(driver, config.baseUrl, 'Tafelquiz', config.game.publicBoard);
  } else {
    const url = await driver.currentUrl();
    if (!/\/(lobby|host)/.test(url)) {
      log.info('Kein Board angegeben – erstelle die Lobby im Browser (Tafelquiz → Board → "Lobby erstellen"). Ich übernehme ab dem Warteraum.');
    }
  }

  const ac = new AbortController();
  const shutdown = async () => {
    if (ac.signal.aborted) process.exit(1);
    ac.abort();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const controller = new TafelquizController({ page, bus, judge, game: config.game, pollMs: config.browser.pollMs });
  try {
    // Wait until we are in the waiting room or a running game.
    while (!ac.signal.aborted) {
      const s = await page.state().catch(() => null);
      if (s && s.phase !== 'unknown') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await controller.run(ac.signal);
  } finally {
    log.info(`Verbrauch: ${meter.summary()}`);
    for (const c of channels) await c.stop();
    await driver.close();
  }
}
