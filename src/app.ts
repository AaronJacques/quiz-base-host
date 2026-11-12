import { BoardStore } from './boardgen/store.ts';
import type { Config } from './config.ts';
import type { Channel } from './channels/channel.ts';
import { TerminalChannel } from './channels/terminal.ts';
import { WebCompanion } from './channels/web/server.ts';
import { createLogger } from './core/logger.ts';
import { GameSession } from './session.ts';

const log = createLogger('app');

/** CLI mode: one game, operated from the terminal, players use the web companion. */
export async function runHost(config: Config): Promise<void> {
  const channels: Channel[] = [new TerminalChannel()];
  if (config.companion.enabled) channels.push(new WebCompanion({ port: config.companion.port, host: config.companion.host }));
  const session = new GameSession(config, channels);

  const shutdown = () => (session.signal.aborted ? process.exit(1) : void session.close());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`Browser: ${config.browser.driver}`);
  await session.open();
  if (config.game.publicBoard) {
    // Boards created with `qbhost board-create` live in the own account, not in the public list.
    const own = new BoardStore(config.boardgen.dir).findCreated(config.game.publicBoard);
    const board = own.length === 1 ? own[0]!.title : config.game.publicBoard;
    const lobby = await session.createLobby(board, { own: own.length === 1 });
    log.info(`Lobby ${lobby.code} – Beitreten: ${lobby.joinUrl}`);
  } else {
    log.info('Kein Board angegeben – erstelle die Lobby im Browser (Tafelquiz → Board → "Lobby erstellen"). Ich übernehme ab dem Warteraum.');
  }
  try {
    await session.run();
  } finally {
    await session.close();
  }
}
