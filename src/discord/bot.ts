import type { Config } from '../config.ts';
import type { EventBus, HostEvents } from '../core/events.ts';
import { createLogger } from '../core/logger.ts';
import type { PlayerState } from '../core/types.ts';
import { normalize, similarity } from '../judge/normalize.ts';
import { applyRule, findRule, formatRuleValue, type GameRules } from '../modes/tafelquiz/rules.ts';
import type { LobbyInfo } from '../session.ts';
import { helpText, medal, rulesText } from './format.ts';
import { mention, type ChatGateway, type ChatMessage } from './gateway.ts';
import { formatBoard, parsePick } from './pick-parser.ts';
import type { GuildStore } from './store.ts';

const log = createLogger('discord');

/** What the bot needs from a game session (GameSession implements it; tests use a fake). */
export interface SessionLike {
  readonly bus: EventBus;
  readonly rules: GameRules;
  readonly meter: { summary(): string };
  createLobby(board: string): Promise<LobbyInfo>;
  run(): Promise<void>;
  endGame(): Promise<void>;
  close(): Promise<void>;
}

export interface BotDeps {
  gateway: ChatGateway;
  config: Config;
  store: GuildStore;
  createSession: (config: Config) => SessionLike;
  /** Public Tafelquiz boards; with a query via quiz-base's own search. */
  listBoards: (query?: string) => Promise<string[]>;
}

/** A numbered board list shown in a channel. With `askedBy`, that user's next message answers it. */
interface BoardMenu {
  channelId: string;
  options: string[];
  askedBy: string | null;
  expires: number;
}

const MENU_TTL_MS = 5 * 60_000;
const MENU_SIZE = 15;

interface ActiveGame {
  guildId: string;
  channelId: string;
  leaderId: string;
  board: string;
  session: SessionLike;
  lobby: LobbyInfo | null;
  phase: 'creating' | 'lobby' | 'running' | 'over';
  lobbyPlayers: { name: string; ready: boolean }[];
  canStart: boolean;
  startRequested: boolean;
  players: PlayerState[];
  turn: HostEvents['host:turn'] | null;
  lastTurnSig: string;
  questionOpen: boolean;
  awaiting: HostEvents['host:await-answer'] | null;
  /** Authors who wrote in the game channel – used for automatic name linking. */
  seen: Map<string, { username: string; displayName: string }>;
  hinted: Set<string>;
  /** LLM reasons are held back until the reveal – they often contain the solution. */
  reasons: string[];
  lobbyStatusSig: string;
  lobbyStatusTimer?: NodeJS.Timeout;
  lobbyTimeout?: NodeJS.Timeout;
  offs: (() => void)[];
}

type Handler = (msg: ChatMessage, args: string[], game: ActiveGame | null) => Promise<void>;

/**
 * Discord front-end for the quiz host. Maps chat commands and messages to the
 * game's EventBus and renders host events as chat messages. All game logic
 * stays in the TafelquizController – this class only translates.
 */
export class QuizBot {
  private game: ActiveGame | null = null;
  private boardCache = new Map<string, { at: number; list: string[] }>();
  private menu: BoardMenu | null = null;
  private outbox = new Map<string, { lines: string[]; timer?: NodeJS.Timeout }>();
  private commands: Record<string, Handler>;

  constructor(private d: BotDeps) {
    const c = this.commands = {} as Record<string, Handler>;
    const alias = (names: string[], h: Handler) => names.forEach((n) => (c[n] = h));
    alias(['hilfe', 'help', '?'], (m) => this.say(m.channelId, helpText(this.prefix)));
    alias(['boards', 'karten', 'liste'], (m, a) => this.cmdBoards(m, a));
    alias(['neu', 'new', 'lobby-neu', 'erstellen'], (m, a, g) => this.cmdNew(m, a, g));
    alias(['ich', 'name', 'bin'], (m, a, g) => this.cmdMe(m, a, g));
    alias(['link', 'verknuepfe', 'verknüpfe'], (m, a, g) => this.cmdLink(m, a, g));
    alias(['lobby', 'wer', 'status'], (m, _a, g) => this.cmdStatus(m, g));
    alias(['los', 'start'], (m, _a, g) => this.cmdStart(m, g));
    alias(['regeln', 'rules'], (m, a, g) => this.cmdRules(m, a, g));
    alias(['regel', 'rule', 'set'], (m, a, g) => this.cmdRule(m, a, g));
    alias(['brett', 'board', 'karte'], (m, _a, g) => this.cmdBoard(m, g));
    alias(['stand', 'punkte', 'scores'], (m, _a, g) => this.cmdScores(m, g));
    alias(['nimm', 'pick'], (m, a, g) => this.cmdPickFor(m, a, g));
    alias(['richtig', 'r'], (m, _a, g) => this.cmdOverride(m, g, 'r'));
    alias(['falsch', 'f'], (m, _a, g) => this.cmdOverride(m, g, 'f'));
    alias(['skip', 'weiter'], (m, _a, g) => this.cmdOverride(m, g, 'skip'));
    alias(['korrektur', 'korrigiere'], (m, a, g) => this.cmdCorrect(m, a, g));
    alias(['ende', 'stop', 'beenden', 'abbrechen'], (m, _a, g) => this.cmdEnd(m, g));
    d.gateway.onMessage((m) => this.onMessage(m).catch((e) => log.error(`Nachricht: ${(e as Error).stack ?? e}`)));
  }

  private get prefix(): string {
    return this.d.config.discord.prefix;
  }

  // ───────────────────────────── routing ─────────────────────────────

  async onMessage(msg: ChatMessage): Promise<void> {
    if (msg.author.isBot || !msg.guildId) return;
    // With configured channels the bot lives only there – prefix and @mentions elsewhere are ignored.
    const allowed = this.d.config.discord.channelIds;
    if (allowed.length && !allowed.includes(msg.channelId)) return;
    const game = this.game;
    if (game && msg.channelId === game.channelId) game.seen.set(msg.author.id, { username: msg.author.username, displayName: msg.author.displayName });

    const cmd = this.parseCommand(msg);
    if (cmd) {
      const handler = this.commands[cmd.name];
      if (handler) return handler(msg, cmd.args, game);
      // "@Bot Waluigi" during a game = an answer / pick, not an unknown command.
      if (game && msg.channelId === game.channelId) return this.onGameInput(msg, game, [cmd.name, ...cmd.args].join(' '));
      return this.say(msg.channelId, `Kenne ich nicht: \`${cmd.name}\`. \`${this.prefix} hilfe\` zeigt alle Befehle.`);
    }
    if (game && msg.channelId === game.channelId) return this.onGameInput(msg, game, msg.content);
    const menu = this.menu;
    if (!game && menu?.askedBy === msg.author.id && menu.channelId === msg.channelId && Date.now() < menu.expires) {
      const text = msg.content.trim();
      if (!text || text.startsWith('//')) return;
      if (/^(abbrechen|abbruch|stop|cancel|nein)$/i.test(text)) {
        this.menu = null;
        return this.say(msg.channelId, 'Okay, keine neue Lobby.');
      }
      await this.chooseBoard(msg, text);
    }
  }

  private parseCommand(msg: ChatMessage): { name: string; args: string[] } | null {
    let text = msg.content.trim();
    const p = this.prefix.toLowerCase();
    if ((text.toLowerCase() === p || text.toLowerCase().startsWith(p + ' '))) text = text.slice(p.length).trim();
    else if (!msg.mentionsBot) return null;
    if (!text) return { name: 'hilfe', args: [] };
    const [name = '', ...args] = text.split(/\s+/);
    return { name: name.toLowerCase(), args };
  }

  // ───────────────────────────── commands ─────────────────────────────

  private async cmdBoards(msg: ChatMessage, args: string[]): Promise<void> {
    const query = args.join(' ').trim();
    const list = await this.getBoards(msg.channelId, query);
    if (!list) return;
    if (!list.length) return this.say(msg.channelId, this.notFound(query, await this.suggest(query)));
    this.menu = { channelId: msg.channelId, options: list.slice(0, MENU_SIZE), askedBy: null, expires: Date.now() + MENU_TTL_MS };
    await this.say(msg.channelId, [
      query ? `**📚 Boards zu „${query}“** (${list.length})` : `**📚 Tafelquiz-Boards** (Auswahl von quiz-base; \`${this.prefix} boards <suche>\` findet mehr)`,
      ...this.numbered(this.menu.options),
      list.length > MENU_SIZE ? `… und ${list.length - MENU_SIZE} weitere – genauer suchen.` : '',
      `Starten mit \`${this.prefix} neu <Nr>\` oder \`${this.prefix} neu <Name>\``,
    ].filter(Boolean).join('\n'));
  }

  private async cmdNew(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (game) return this.say(msg.channelId, `Es läuft schon ein Spiel in <#${game.channelId}>. Die Spielleitung kann es mit \`${this.prefix} ende\` beenden.`);
    const text = args.join(' ').trim();
    if (text) return this.chooseBoard(msg, text);
    // No board named → ask instead of picking one.
    const list = await this.getBoards(msg.channelId);
    if (!list) return;
    this.menu = { channelId: msg.channelId, options: list.slice(0, 10), askedBy: msg.author.id, expires: Date.now() + MENU_TTL_MS };
    await this.say(msg.channelId, [
      `🎲 ${mention(msg.author.id)}, **welches Quiz** wollt ihr spielen? Schreib den Namen (oder einen Teil davon), ich suche auf quiz-base.`,
      'Oder nimm eins der beliebten Boards per Nummer:',
      ...this.numbered(this.menu.options),
      '`abbrechen` bricht ab.',
    ].join('\n'));
  }

  /** Resolves a board from a number or a name and creates the lobby – or asks back when it is not unambiguous. */
  private async chooseBoard(msg: ChatMessage, text: string): Promise<void> {
    const menu = this.menu?.channelId === msg.channelId && Date.now() < this.menu.expires ? this.menu : null;
    if (/^\d+$/.test(text)) {
      const options = menu?.options ?? (await this.getBoards(msg.channelId));
      if (!options) return;
      const board = options[Number(text) - 1];
      if (!board) return this.say(msg.channelId, `Nummer ${text} gibt es nicht${options.length ? ` (1–${options.length})` : ''}. Schreib sonst den Namen des Quiz.`);
      return this.createGame(msg, board);
    }
    const query = text.replace(/^["„“']+|["„“']+$/g, '').trim();
    const results = await this.getBoards(msg.channelId, query);
    if (!results) return;
    const exact = results.filter((t) => normalize(t) === normalize(query));
    if (exact.length === 1) return this.createGame(msg, exact[0]!);
    if (results.length === 1) return this.createGame(msg, results[0]!);

    const options = results.length ? results.slice(0, MENU_SIZE) : await this.suggest(query);
    this.menu = { channelId: msg.channelId, options, askedBy: msg.author.id, expires: Date.now() + MENU_TTL_MS };
    if (!results.length) return this.say(msg.channelId, this.notFound(query, options) + ' Schreib einen anderen Namen oder `abbrechen`.');
    await this.say(msg.channelId, [
      `🤔 Zu „${query}“ passen ${results.length} Boards. Welches meinst du? Antworte mit der **Nummer** (oder genauerem Namen, \`abbrechen\`):`,
      ...this.numbered(options),
      results.length > MENU_SIZE ? `… und ${results.length - MENU_SIZE} weitere.` : '',
    ].filter(Boolean).join('\n'));
  }

  private async createGame(msg: ChatMessage, board: string): Promise<void> {
    if (this.game) return;
    this.menu = null;
    const guild = this.d.store.get(msg.guildId!);
    const config: Config = { ...this.d.config, game: { ...this.d.config.game, ...guild.rules, autoStart: false, publicBoard: undefined } };
    const session = this.d.createSession(config);
    const g: ActiveGame = {
      guildId: msg.guildId!, channelId: msg.channelId, leaderId: msg.author.id, board, session, lobby: null, phase: 'creating',
      lobbyPlayers: [], canStart: false, startRequested: false, players: [], turn: null, lastTurnSig: '', questionOpen: false,
      awaiting: null, seen: new Map([[msg.author.id, { username: msg.author.username, displayName: msg.author.displayName }]]),
      hinted: new Set(), reasons: [], lobbyStatusSig: '', offs: [],
    };
    this.game = g;
    this.attach(g);
    await this.say(msg.channelId, `⏳ Erstelle eine Tafelquiz-Lobby mit **${board}** …`);
    try {
      g.lobby = await session.createLobby(board);
    } catch (e) {
      log.error(`Lobby: ${(e as Error).message}`);
      await this.say(msg.channelId, `⚠️ Lobby konnte nicht erstellt werden: ${(e as Error).message}`);
      return this.finish(g);
    }
    g.phase = 'lobby';
    await this.say(msg.channelId, [
      `🎮 **Neue Lobby: ${board}** · Spielleitung: ${mention(g.leaderId)}`,
      `🔗 ${g.lobby.joinUrl}  (Code \`${g.lobby.code}\`)`,
      '',
      '1. Link öffnen, Namen eingeben, **„Ich bin bereit!“** klicken (bei Musik-Boards auch **„Sound aktivieren“**).',
      `2. Hier \`${this.prefix} ich <dein quiz-base-Name>\` schreiben, falls ich dich nicht automatisch erkenne.`,
      'Sobald alle bereit und verknüpft sind, geht es los.',
    ].join('\n'));
    g.lobbyTimeout = setTimeout(() => {
      if (this.game === g && g.phase === 'lobby') {
        void this.say(g.channelId, `⌛ Die Lobby wurde nicht innerhalb von ${this.d.config.discord.lobbyTimeoutMin} Minuten gestartet und wird geschlossen.`);
        void g.session.endGame().finally(() => this.finish(g));
      }
    }, this.d.config.discord.lobbyTimeoutMin * 60_000);
    session
      .run()
      .catch(async (e) => {
        log.error(`Spiel: ${(e as Error).stack ?? e}`);
        await this.say(g.channelId, `⚠️ Das Spiel ist abgebrochen: ${(e as Error).message}`);
      })
      .finally(() => this.finish(g));
  }

  private async cmdMe(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      const current = this.d.store.get(msg.guildId!).links[msg.author.id];
      return this.say(msg.channelId, current ? `Du bist mit **${current}** verknüpft.` : `Schreib \`${this.prefix} ich <dein Name in quiz-base>\`.`);
    }
    await this.link(msg, msg.author.id, name, game);
  }

  private async cmdLink(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    const target = msg.mentions[0];
    const name = args.filter((a) => !/^<@!?\d+>$/.test(a)).join(' ').trim();
    if (!target || !name) return this.say(msg.channelId, `So geht's: \`${this.prefix} link @user <quiz-base-Name>\``);
    await this.link(msg, target, name, game);
  }

  private async link(msg: ChatMessage, userId: string, rawName: string, game: ActiveGame | null): Promise<void> {
    const guild = this.d.store.get(msg.guildId!);
    const inLobby = game ? this.knownNames(game) : [];
    const canonical = inLobby.find((n) => normalize(n) === normalize(rawName));
    const name = canonical ?? rawName;
    // A quiz-base name belongs to exactly one Discord user.
    for (const [uid, n] of Object.entries(guild.links)) if (uid !== userId && normalize(n) === normalize(name)) delete guild.links[uid];
    guild.links[userId] = name;
    this.d.store.save(msg.guildId!);
    const note = game && !canonical ? ` (Noch nicht in der Lobby – gerade drin: ${inLobby.join(', ') || 'niemand'}.)` : '';
    await this.say(msg.channelId, `🔗 ${mention(userId)} = **${name}**${note}`);
    if (game?.phase === 'lobby') {
      this.scheduleLobbyStatus(game, true);
      this.maybeAutoStart(game);
    }
  }

  private async cmdStatus(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game) return this.say(msg.channelId, `Gerade läuft kein Spiel. \`${this.prefix} neu\` startet eins.`);
    if (game.phase === 'lobby') return this.say(msg.channelId, this.lobbyStatus(game));
    return this.cmdScores(msg, game);
  }

  private async cmdStart(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game || game.phase !== 'lobby') return this.say(msg.channelId, 'Es gibt keine offene Lobby.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    if (!game.canStart) {
      const ready = game.lobbyPlayers.filter((p) => p.ready).length;
      return this.say(msg.channelId, `Noch nicht alle sind in quiz-base bereit (${ready}/${game.lobbyPlayers.length}).`);
    }
    const unlinked = game.lobbyPlayers.filter((p) => !this.userFor(game, p.name)).map((p) => p.name);
    if (unlinked.length) await this.say(msg.channelId, `⚠️ Nicht verknüpft: ${unlinked.join(', ')}. Sie können nicht per Chat wählen oder antworten (die Spielleitung kann mit \`${this.prefix} nimm\` helfen).`);
    this.requestStart(game);
  }

  private async cmdRules(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    const guild = this.d.store.get(msg.guildId!);
    if (args[0]?.toLowerCase() === 'reset') {
      if (game && !this.isLeader(msg, game)) return this.notLeader(msg);
      guild.rules = {};
      this.d.store.save(msg.guildId!);
      if (game) Object.assign(game.session.rules, this.d.config.game);
      return this.say(msg.channelId, '📏 Regeln auf Standard zurückgesetzt.\n' + rulesText(this.currentRules(msg.guildId!), this.prefix));
    }
    if (args.length >= 2) return this.cmdRule(msg, args, game);
    await this.say(msg.channelId, rulesText(game ? game.session.rules : this.currentRules(msg.guildId!), this.prefix));
  }

  private async cmdRule(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (game && !this.isLeader(msg, game)) return this.notLeader(msg, 'Während eines Spiels darf nur die Spielleitung Regeln ändern.');
    const [name = '', ...rest] = args;
    const spec = findRule(name);
    if (!spec || !rest.length) return this.say(msg.channelId, `So geht's: \`${this.prefix} regel <name> <wert>\` – Namen siehst du mit \`${this.prefix} regeln\`.`);
    const guild = this.d.store.get(msg.guildId!);
    const rules = this.currentRules(msg.guildId!);
    const err = applyRule(rules, spec, rest.join(''));
    if (err) return this.say(msg.channelId, `⚠️ ${err}`);
    (guild.rules as any)[spec.key] = rules[spec.key];
    this.d.store.save(msg.guildId!);
    if (game) (game.session.rules as any)[spec.key] = rules[spec.key];
    await this.say(msg.channelId, `📏 ${spec.label}: **${formatRuleValue(rules, spec)}**${game ? ' (gilt ab der nächsten Frage)' : ''}`);
  }

  private async cmdBoard(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game?.turn) return this.say(msg.channelId, 'Gerade ist kein Brett offen.');
    await this.say(msg.channelId, this.turnText(game, game.turn));
  }

  private async cmdScores(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game?.players.length) return this.say(msg.channelId, 'Noch keine Punkte.');
    await this.say(msg.channelId, '📊 ' + this.scoreLine(game));
  }

  private async cmdPickFor(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!game?.turn || game.questionOpen) return this.say(msg.channelId, 'Gerade wird keine Karte gewählt.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    await this.handlePick(msg, game, args.join(' '), '@operator', true);
  }

  private async cmdOverride(msg: ChatMessage, game: ActiveGame | null, command: 'r' | 'f' | 'skip'): Promise<void> {
    if (!game || game.phase !== 'running') return this.say(msg.channelId, 'Gerade läuft keine Frage.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    game.session.bus.emit('operator:command', { command, args: [] });
    await this.d.gateway.react(msg, '👍');
  }

  private async cmdCorrect(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!game || game.phase !== 'running') return this.say(msg.channelId, 'Gerade läuft kein Spiel.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    const delta = Number(args[args.length - 1]?.replace('+', ''));
    const raw = args.slice(0, -1).join(' ');
    const name = game.players.find((p) => normalize(p.name) === normalize(raw))?.name;
    if (!name || !Number.isFinite(delta)) return this.say(msg.channelId, `So geht's: \`${this.prefix} korrektur <Name> <±Punkte>\``);
    game.session.bus.emit('operator:command', { command: 'punkte', args: [name, String(delta)] });
    await this.say(msg.channelId, `✏️ ${name}: ${delta > 0 ? '+' : ''}${delta}`);
  }

  private async cmdEnd(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game) return this.say(msg.channelId, 'Gerade läuft kein Spiel.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    await this.say(msg.channelId, '🛑 Spiel wird beendet …');
    await game.session.endGame().catch(() => {});
    if (game.phase !== 'running') await this.finish(game);
  }

  // ───────────────────────────── game input ─────────────────────────────

  private async onGameInput(msg: ChatMessage, game: ActiveGame, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('//') || game.phase !== 'running') return;
    const name = this.nameFor(game, msg.author.id);

    if (!name) {
      const relevant = (game.awaiting && !this.userFor(game, game.awaiting.player)) || (game.turn && parsePick(trimmed, game.turn.grid).kind !== 'none');
      if (relevant && !game.hinted.has(msg.author.id)) {
        game.hinted.add(msg.author.id);
        await this.say(msg.channelId, `${mention(msg.author.id)} du bist noch nicht verknüpft: \`${this.prefix} ich <dein quiz-base-Name>\``);
      }
      return;
    }

    if (game.awaiting && game.awaiting.player === name) {
      game.session.bus.emit('player:answer', { player: name, answer: trimmed.slice(0, 200) });
      game.awaiting = null;
      await this.d.gateway.react(msg, '📝');
      return;
    }

    if (game.turn && !game.questionOpen) {
      if (game.turn.player === name) return this.handlePick(msg, game, trimmed, name, false);
      if (parsePick(trimmed, game.turn.grid).kind !== 'none') await this.say(msg.channelId, `Gerade ist **${game.turn.player}** am Zug.`);
    }
  }

  private async handlePick(msg: ChatMessage, game: ActiveGame, text: string, player: string, verbose: boolean): Promise<void> {
    const res = parsePick(text, game.turn!.grid);
    switch (res.kind) {
      case 'ok':
        game.session.bus.emit('player:pick', { player, col: res.cell.col, row: res.cell.row });
        await this.d.gateway.react(msg, '👍');
        return;
      case 'taken': {
        const free = game.turn!.grid.filter((c) => c.col === res.cell.col && !c.answered).map((c) => c.points);
        return this.say(msg.channelId, `❌ **${res.cell.category} ${res.cell.points}** ist schon weg. ${free.length ? `In ${res.cell.category} noch frei: ${free.join(', ')}.` : `${res.cell.category} ist leer.`}`);
      }
      case 'ambiguous':
      case 'invalid':
        return this.say(msg.channelId, `🤔 ${res.hint}`);
      case 'none':
        if (verbose) await this.say(msg.channelId, '🤔 Welche Karte? Z.B. `Nintendo 200`.');
    }
  }

  // ───────────────────────────── host events → chat ─────────────────────────────

  private attach(g: ActiveGame): void {
    const on = <K extends keyof HostEvents>(e: K, h: (p: HostEvents[K]) => void) => g.offs.push(g.session.bus.on(e, h));
    const ch = g.channelId;

    on('host:lobby', (l) => {
      g.lobbyPlayers = l.players;
      g.canStart = l.canStart;
      this.autoLink(g);
      this.scheduleLobbyStatus(g);
      this.maybeAutoStart(g);
    });
    on('host:scores', ({ players }) => (g.players = players));
    on('host:notice', (n) => {
      const who = n.player ? this.who(g, n.player) : '';
      switch (n.kind) {
        case 'started':
          g.phase = 'running';
          clearTimeout(g.lobbyTimeout);
          clearTimeout(g.lobbyStatusTimer);
          this.queue(ch, `🚀 **Los geht's!** Regeln: \`${this.prefix} regeln\` · Hilfe: \`${this.prefix} hilfe\``);
          break;
        case 'buzzed':
          this.queue(ch, `🔔 ${who} hat gebuzzert!`);
          break;
        case 'reminder':
          this.queue(ch, `⏰ ${who}, du bist dran – schreib z.B. \`${g.turn?.open[0]?.category ?? 'Kategorie'} ${g.turn?.open[0]?.points ?? 100}\`.`);
          break;
        case 'operator-needed':
          this.queue(ch, `❓ ${n.text} (${mention(g.leaderId)}: \`${this.prefix} richtig\` / \`${this.prefix} falsch\`)`);
          if (n.detail) void this.d.gateway.sendDirect(g.leaderId, `❓ ${n.detail}\nIm Channel mit \`${this.prefix} richtig\` oder \`${this.prefix} falsch\` antworten.`).catch(() => {});
          break;
        default:
          this.queue(ch, `${n.kind === 'buzzer-open' ? '🔔' : n.kind === 'board-switch' ? '🔀' : '·'} ${n.text}`);
      }
    });
    on('host:turn', (t) => {
      if (g.phase === 'lobby') {
        g.phase = 'running';
        clearTimeout(g.lobbyTimeout);
      }
      g.turn = t;
      g.questionOpen = false;
      g.awaiting = null;
      const sig = `${t.player}|${t.board.active}|${t.open.length}`;
      if (sig === g.lastTurnSig) return; // re-emitted after a reminder – no need to repost the board
      g.lastTurnSig = sig;
      this.queue(ch, this.turnText(g, t));
    });
    on('host:question', (q) => {
      g.questionOpen = true;
      const extras = [q.hasImage ? '🖼 Bild auf quiz-base' : '', q.hasAudio ? '🎵 Audio läuft auf quiz-base' : ''].filter(Boolean).join(' · ');
      this.queue(ch, `❔ **${q.category || 'Frage'} · ${q.points} Punkte**\n> ${q.text}${extras ? `\n${extras}` : ''}`);
    });
    on('host:await-answer', (a) => {
      g.awaiting = a;
      this.queue(ch, `✍️ ${this.who(g, a.player)}, deine Antwort? Schreib sie einfach hier rein (${a.timeoutSec} s).`);
    });
    on('host:verdict', (v) => {
      g.awaiting = null;
      const delta = v.delta ? ` **${v.delta > 0 ? '+' : '−'}${Math.abs(v.delta)}**` : '';
      this.queue(ch, `${v.correct ? '✅' : '❌'} **${v.player}**: „${v.answer}“ ist ${v.correct ? 'richtig' : 'falsch'}${delta}`);
      if (v.reason && !v.correct && v.answer && !v.answer.startsWith('(')) g.reasons.push(`${v.player}: ${v.reason}`);
    });
    on('host:reveal', ({ answer }) => {
      const why = g.reasons.splice(0).map((r) => `-# ${r}`).join('\n');
      this.queue(ch, `${answer ? `💡 Lösung: **${answer}**\n` : ''}${why ? `${why}\n` : ''}📊 ${this.scoreLine(g)}`);
    });
    on('host:game-over', ({ players }) => {
      g.phase = 'over';
      const ranking = [...players].sort((a, b) => b.score - a.score).map((p, i) => `${medal(i)} ${this.who(g, p.name)} — **${p.score}**`);
      this.queue(ch, ['🏁 **Spiel vorbei!**', ...ranking, `-# Host-Kosten: ${g.session.meter.summary()}`].join('\n'));
    });
  }

  private turnText(g: ActiveGame, t: HostEvents['host:turn']): string {
    const boardInfo = t.board.count > 1 ? ` · Board ${t.board.active}/${t.board.count}` : '';
    const example = t.open[0] ? `${t.open[0].category} ${t.open[0].points}` : 'Kategorie Punkte';
    return `🎯 ${this.who(g, t.player)} ist am Zug${boardInfo} – schreib z.B. \`${example}\`\n${formatBoard(t.grid)}`;
  }

  private scoreLine(g: ActiveGame): string {
    return [...g.players].sort((a, b) => b.score - a.score).map((p) => `${p.name} ${p.score}`).join(' · ');
  }

  // ───────────────────────────── lobby & linking ─────────────────────────────

  private lobbyStatus(g: ActiveGame): string {
    if (!g.lobbyPlayers.length) return `👥 Noch niemand in der Lobby. 🔗 ${g.lobby?.joinUrl ?? ''}`;
    const ready = g.lobbyPlayers.filter((p) => p.ready).length;
    const lines = g.lobbyPlayers.map((p) => {
      const uid = this.userFor(g, p.name);
      return `${p.ready ? '✅' : '⏳'} **${p.name}** → ${uid ? mention(uid) : `❓ nicht verknüpft (\`${this.prefix} ich ${p.name}\`)`}`;
    });
    return [`👥 **Lobby** · ${ready}/${g.lobbyPlayers.length} bereit`, ...lines].join('\n');
  }

  private scheduleLobbyStatus(g: ActiveGame, force = false): void {
    clearTimeout(g.lobbyStatusTimer);
    g.lobbyStatusTimer = setTimeout(() => {
      if (g.phase !== 'lobby' || this.game !== g) return;
      const text = this.lobbyStatus(g);
      if (!force && text === g.lobbyStatusSig) return;
      g.lobbyStatusSig = text;
      this.queue(g.channelId, text);
    }, 2000);
  }

  /** Link quiz-base names to Discord users whose display name matches and who wrote in the channel. */
  private autoLink(g: ActiveGame): void {
    const guild = this.d.store.get(g.guildId);
    let changed = false;
    for (const p of g.lobbyPlayers) {
      if (this.userFor(g, p.name)) continue;
      const matches = [...g.seen.entries()].filter(
        ([uid, a]) => !guild.links[uid] && (normalize(a.displayName) === normalize(p.name) || normalize(a.username) === normalize(p.name)),
      );
      if (matches.length === 1) {
        guild.links[matches[0]![0]] = p.name;
        changed = true;
        this.queue(g.channelId, `🔗 Automatisch verknüpft: ${mention(matches[0]![0])} = **${p.name}**`);
      }
    }
    if (changed) this.d.store.save(g.guildId);
  }

  private maybeAutoStart(g: ActiveGame): void {
    if (!this.d.config.discord.autoStart || g.phase !== 'lobby' || g.startRequested || !g.canStart) return;
    if (g.lobbyPlayers.length < this.d.config.game.minPlayers) return;
    if (g.lobbyPlayers.every((p) => this.userFor(g, p.name))) this.requestStart(g);
  }

  private requestStart(g: ActiveGame): void {
    g.startRequested = true;
    g.session.bus.emit('operator:command', { command: 'start', args: [] });
  }

  private knownNames(g: ActiveGame): string[] {
    return (g.phase === 'lobby' || !g.players.length ? g.lobbyPlayers : g.players).map((p) => p.name);
  }

  private nameFor(g: ActiveGame, userId: string): string | null {
    const linked = this.d.store.get(g.guildId).links[userId];
    if (!linked) return null;
    return this.knownNames(g).find((n) => normalize(n) === normalize(linked)) ?? null;
  }

  private userFor(g: ActiveGame, name: string): string | null {
    const links = this.d.store.get(g.guildId).links;
    return Object.entries(links).find(([, n]) => normalize(n) === normalize(name))?.[0] ?? null;
  }

  private who(g: ActiveGame, name: string): string {
    const uid = this.userFor(g, name);
    return uid ? `${mention(uid)} (**${name}**)` : `**${name}**`;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private isLeader(msg: ChatMessage, game: ActiveGame | null): boolean {
    return msg.canManage || !game || game.leaderId === msg.author.id;
  }

  private notLeader(msg: ChatMessage, text = 'Das darf nur die Spielleitung (wer die Lobby erstellt hat) oder ein Server-Admin.'): Promise<void> {
    return this.say(msg.channelId, `🔒 ${text}`);
  }

  private currentRules(guildId: string): GameRules {
    return { ...this.d.config.game, ...this.d.store.get(guildId).rules };
  }

  /** Default selection (no query) or quiz-base search results, cached for 10 minutes. */
  private async getBoards(channelId: string, query = ''): Promise<string[] | null> {
    const key = normalize(query);
    const hit = this.boardCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    try {
      await this.say(channelId, query ? `🔎 Suche „${query}“ auf quiz-base …` : '🔎 Lade Boards von quiz-base …');
      await this.flush(channelId);
      const list = await this.d.listBoards(query || undefined);
      this.boardCache.set(key, { at: Date.now(), list });
      return list;
    } catch (e) {
      await this.say(channelId, `⚠️ Boards konnten nicht geladen werden: ${(e as Error).message}`);
      return null;
    }
  }

  /** Close titles from the default selection, for typos the server-side search does not forgive. */
  private async suggest(query: string): Promise<string[]> {
    const list = this.boardCache.get('')?.list ?? (await this.d.listBoards().catch(() => [] as string[]));
    if (!this.boardCache.has('')) this.boardCache.set('', { at: Date.now(), list });
    const q = normalize(query);
    return list
      .map((t) => ({ t, s: Math.max(similarity(normalize(t), q), ...normalize(t).split(' ').map((w) => similarity(w, q))) }))
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => x.t);
  }

  private notFound(query: string, suggestions: string[]): string {
    const base = `Kein Board zu „${query}“ gefunden.`;
    return suggestions.length ? [`${base} Meintest du (Nummer antworten):`, ...this.numbered(suggestions)].join('\n') : base;
  }

  private numbered(list: string[]): string[] {
    return list.map((t, i) => `\`${i + 1}\` ${t}`);
  }

  private async finish(g: ActiveGame): Promise<void> {
    if (this.game !== g) return;
    this.game = null;
    if (g.phase === 'running' && g.players.length) {
      const ranking = [...g.players].sort((a, b) => b.score - a.score).map((p, i) => `${medal(i)} ${this.who(g, p.name)} — **${p.score}**`);
      this.queue(g.channelId, ['🏁 **Spiel beendet.** Endstand:', ...ranking].join('\n'));
    }
    clearTimeout(g.lobbyTimeout);
    clearTimeout(g.lobbyStatusTimer);
    g.offs.forEach((off) => off());
    await g.session.close().catch(() => {});
    await this.flush(g.channelId);
  }

  /** Send now (flushes anything queued first so order is kept). */
  private async say(channelId: string, text: string): Promise<void> {
    this.queue(channelId, text);
    await this.flush(channelId);
  }

  /** Coalesce bursts of game events into few messages (Discord rate limits ~5 msg / 5 s). */
  private queue(channelId: string, text: string): void {
    const box = this.outbox.get(channelId) ?? { lines: [] };
    box.lines.push(text);
    this.outbox.set(channelId, box);
    if (!box.timer) box.timer = setTimeout(() => void this.flush(channelId), 600);
  }

  private async flush(channelId: string): Promise<void> {
    const box = this.outbox.get(channelId);
    if (!box?.lines.length) return;
    clearTimeout(box.timer);
    box.timer = undefined;
    const lines = box.lines.splice(0);
    let chunk = '';
    for (const l of lines) {
      if (chunk && chunk.length + l.length + 2 > 1900) {
        await this.d.gateway.send(channelId, chunk).catch((e) => log.warn(`send: ${(e as Error).message}`));
        chunk = '';
      }
      chunk = chunk ? `${chunk}\n\n${l}` : l;
    }
    if (chunk) await this.d.gateway.send(channelId, chunk).catch((e) => log.warn(`send: ${(e as Error).message}`));
  }

  /** For tests / shutdown. */
  get activeGame(): Readonly<ActiveGame> | null {
    return this.game;
  }

  async shutdown(): Promise<void> {
    if (this.game) {
      await this.say(this.game.channelId, '👋 Der Quiz-Host fährt herunter, das Spiel wird beendet.');
      await this.game.session.endGame().catch(() => {});
      await this.finish(this.game);
    }
  }
}
