import { formatLoginStatus, loginSourceLabel, when, type LoginChange, type LoginStatus } from '../account.ts';
import type { BoardStudio } from '../board-studio.ts';
import type { Config } from '../config.ts';
import type { EventBus, HostEvents } from '../core/events.ts';
import { createLogger } from '../core/logger.ts';
import type { PlayerState } from '../core/types.ts';
import { normalize, similarity } from '../judge/normalize.ts';
import { applyRule, findRule, formatRuleValue, pickRules, scoreFor, type GameRules } from '../modes/tafelquiz/rules.ts';
import type { LobbyInfo } from '../session.ts';
import { BoardCreateFlow } from './board-flow.ts';
import { helpText, rankingLines, rulesText } from './format.ts';
import { mention, type ChatGateway, type ChatMessage } from './gateway.ts';
import { formatBoard, parsePick, parsePickWithContext } from './pick-parser.ts';
import type { GuildStore } from './store.ts';
import { VoiceBridge } from './voice-bridge.ts';
import { asksBack, confirmReply, confirmWaits, endAskReply, extractAnswer, hasStrongKeyword, isBuzz, mentionsCard, speechNorm, spokenNumber, spokenToDigits, stripWakeWord, voiceCommand } from '../voice/commands.ts';
import { ANSWER_KEYWORD_LINE, CONFIRM_AGAIN_LINE, END_ASK_LINE, END_KEEP_LINE, gameOverLine, GOODBYE_LINE, pickHintLine, START_LINE, startMissingLine, VOICE_HELP } from '../voice/narration.ts';
import type { LocalStt, SpeechToText } from '../voice/stt.ts';
import type { Speaker } from '../voice/transport.ts';
import type { TextToSpeech } from '../voice/tts.ts';
import { forSpeech, VoiceHost, type Attention } from '../voice/voice-host.ts';

const log = createLogger('discord');

/** What the bot needs from a game session (GameSession implements it; tests use a fake). */
export interface SessionLike {
  readonly bus: EventBus;
  readonly rules: GameRules;
  readonly meter: { summary(): string };
  /** `own`: the board was created by this bot (own quiz-base account), not a public one. */
  createLobby(board: string, opts?: { own?: boolean }): Promise<LobbyInfo>;
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
  /** Local speech recognition + synthesis; without it the voice commands report "not set up". */
  voice?: VoiceKit | null;
  /** Board generator (`!quiz erstellen`); without it the command reports "not set up". */
  boards?: BoardStudio | null;
  /** The quiz-base account keeper (login watch, keep-alive); without it no login line and no DMs. */
  account?: AccountSource | null;
}

/** What the bot needs from the quiz-base account keeper (`AccountKeeper` implements it; tests use a fake). */
export interface AccountSource {
  /** Command for logging in again (`account.loginCommand`). */
  readonly loginCommand: string;
  status(): LoginStatus;
  /** A game, a voice room or a board creation starts: abort a running login check. */
  interrupt(reason: string): void;
  gameEnded(): void;
  /** State changes (ok ↔ lost …); returns the unsubscribe function. */
  onChange(cb: (status: LoginStatus, change: LoginChange) => void): () => void;
  /** A loss DM went out (one per loss, also across restarts). */
  markNotified(at: number): void;
}

export interface VoiceKit {
  /** The precise main model (spoken answers). */
  stt: SpeechToText;
  /** Optional fast model for everything else (`voice.whisperFastModel`). */
  fastStt?: SpeechToText;
  /** Cloud routing (`voice.sttCloudFor`): the 'confirm' and 'wake' engines, if they differ from `fastStt`. */
  confirmStt?: SpeechToText;
  wakeStt?: SpeechToText;
  /** Cloud routing: the local engines for everyone who may not be heard by the cloud (`VoiceHostDeps`). */
  localStt?: LocalStt | null;
  localFastStt?: LocalStt | null;
  tts: TextToSpeech;
  /** Loads the models up front so the first sentence is not delayed. */
  warmup(): Promise<void>;
}

interface VoiceSession {
  host: VoiceHost;
  bridge: VoiceBridge;
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  idleTimer?: NodeJS.Timeout;
  /**
   * Leaving after the game: the goodbye is queued, `done` once it is spoken (or after `GOODBYE_MAX_MS`);
   * `stop` ends the wait (and its time limit) early; `cancelled`: a new game came – stay.
   */
  leaving?: { done: Promise<void>; stop: () => void; cancelled: boolean };
  seq: number;
  /** "Sprache gestört" was posted while no game ran (in a game: `hinted`). */
  troubled?: boolean;
}

/** Posted once per game when recognition is down and nothing local takes over. */
const VOICE_TROUBLE_LINE = '⚠️ Sprache gestört – bitte tippen';

const VOICE_IDLE_MS = 20 * 60_000;
/** How long a plain "Ja" answers "Soll ich das Spiel beenden?". */
const END_ASK_MS = 20_000;
/** Leaving after the game waits for the last announcements – at most this long, if speech hangs. */
const GOODBYE_MAX_MS = 30_000;
/** A spoken answer still waiting for "Ja" this close to the end of the time for "Ja" is submitted as said. */
const PENDING_SUBMIT_MS = 1500;
/** An unclear reply to "Paris?" of at most this many words gets one "Ja oder nein?". */
const CONFIRM_AGAIN_MAX_WORDS = 4;
/** Without keyword and without an answer waiting, utterances up to this many words are logged (no text, rule 8). */
const NO_KEYWORD_LOG_WORDS = 6;
/** After a keyword without an answer ("Meine Antwort ist …" + pause), the next utterance within this time completes it. */
const OPEN_KEYWORD_MS = 8000;
/** A loss DM that reached nobody is tried again this often, this far apart (and at the next start). */
const LOGIN_DM_RETRIES = 3;
const LOGIN_DM_RETRY_MS = 60 * 60_000;
/** Shutdown: ending the game on quiz-base and the goodbye in the voice channel get at most this long. */
const SHUTDOWN_END_GAME_MS = 15_000;
const SHUTDOWN_GOODBYE_MS = 8000;
/** Answers that are really "wait a second". */
const STALLING = /^(äh+m*|ähm|hm+|mh+|moment|einen moment|warte|wart mal|lass mich (kurz )?(überlegen|nachdenken)|ich überlege|gute frage|ok|okay|also)$/;

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
  /** When the current answer time runs out (epoch ms, D0). */
  answerDeadline: number;
  /** The latest moment for the "Ja" to an asked-back answer: the answer time plus `game.confirmGraceSec` (epoch ms). */
  confirmUntil: number;
  /**
   * A spoken answer that was repeated back ("Paris?") and waits for "Ja": said at `at` (epoch ms);
   * `reasked` once "Ja oder nein?" followed an unclear reply.
   */
  pending: { player: string; answer: string; at: number; reasked: boolean } | null;
  /**
   * The keyword was said without an answer ("Meine Antwort ist …" + pause): until `until` (epoch ms) the next
   * utterance of `player` is what follows it.
   */
  openKeyword: { player: string; until: number } | null;
  /** Submits a pending answer unconfirmed (or drops it, `confirmAtDeadline` off) just before the time for "Ja" runs out. */
  pendingTimer?: NodeJS.Timeout;
  /** An answer was handed in and the verdict is not there yet. */
  judging: boolean;
  /** The judge is unsure and waits for the leader's "richtig"/"falsch". */
  operatorNeeded: boolean;
  /** For overruling after the verdict: the open question, the last ask and the last verdict (cleared with the next card). */
  lastQuestion: HostEvents['host:question'] | null;
  lastAsk: HostEvents['host:await-answer'] | null;
  lastVerdict: { player: string; answer: string; correct: boolean; delta: number; points: number; viaBuzzer: boolean } | null;
  buzzerOpen: boolean;
  /** Who answered the open question already (the picker, wrong buzzers) – they may not buzz again. */
  answered: Set<string>;
  /** The leader made the last answer correct before the buzzer opened → end the buzzer round right away. */
  closeBuzzer: boolean;
  /** Authors who wrote in the game channel – used for automatic name linking. */
  seen: Map<string, { username: string; displayName: string }>;
  hinted: Set<string>;
  /** The leader was asked "Soll ich das Spiel beenden?" – until then a plain spoken "Ja"/"Nein" answers it. */
  endAsk: { userId: string; until: number } | null;
  /** The last ambiguous pick ("Sport" → "Wie viele Punkte?"), so the reply ("300") completes it. */
  pickContext: string | null;
  /** LLM reasons are held back until the reveal – they often contain the solution. */
  reasons: string[];
  lobbyStatusSig: string;
  lobbyStatusTimer?: NodeJS.Timeout;
  lobbyTimeout?: NodeJS.Timeout;
  offs: (() => void)[];
}

type Handler = (msg: ChatMessage, args: string[], game: ActiveGame | null) => Promise<void>;

/** Reply to `!quiz neu` / `erstellen` / `anlegen` once the shutdown has begun. */
const SHUTTING_DOWN_LINE = '⏳ Der Quiz-Host fährt gerade herunter. Gleich bin ich wieder da, dann bitte noch einmal.';
const BUSY_ELSEWHERE = '🎲 Ich hoste gerade ein Spiel auf einem anderen Server. Sobald es vorbei ist, bin ich wieder frei.';

/**
 * Discord front-end for the quiz host. Maps chat commands and messages to the
 * game's EventBus and renders host events as chat messages. All game logic
 * stays in the TafelquizController – this class only translates.
 */
export class QuizBot {
  private game: ActiveGame | null = null;
  private boardCache = new Map<string, { at: number; list: string[] }>();
  private _menu: BoardMenu | null = null;
  /** The open board menu; who asked it may be heard by the cloud from the moment it is set (`refreshCloud`). */
  private get menu(): BoardMenu | null {
    return this._menu;
  }
  private set menu(m: BoardMenu | null) {
    this._menu = m;
    this.refreshCloud();
  }
  private outbox = new Map<string, { lines: string[]; timer?: NodeJS.Timeout }>();
  private commands: Record<string, Handler>;
  private voice: VoiceSession | null = null;
  /** `used` of a spoken message (⏱ measurement), for the answer path that posts its own transcript. */
  private voiceUsed = new WeakMap<ChatMessage, () => void>();
  /** Since when each person may be heard by the cloud without a break (`refreshCloud`); absent = not now. */
  private cloudSince = new Map<string, number>();
  private voiceJoining: Promise<void> | null = null;
  private shuttingDown = false;
  private boards: BoardCreateFlow | null;
  /** The loss DM: one delivery at a time, retries while nobody got it. */
  private lossNotice: { sending: Promise<void> | null; timer?: NodeJS.Timeout; tries: number } = { sending: null, tries: 0 };
  private ownersWarned = false;
  private accountOff: (() => void) | null = null;

  constructor(private d: BotDeps) {
    this.boards = d.boards
      ? new BoardCreateFlow({
          gateway: d.gateway,
          config: d.config,
          studio: d.boards,
          say: (channelId, text) => this.say(channelId, text),
          blockedBy: (guildId) =>
            this.game
              ? this.game.guildId === guildId
                ? `🎲 Während ein Spiel läuft, lege ich keine Boards an (Spiel und Editor teilen sich den Browser). Nach dem Spiel gern.`
                : BUSY_ELSEWHERE
              : null,
          onBusy: () => this.d.account?.interrupt('Board-Anlage'),
          closing: () => (this.shuttingDown ? SHUTTING_DOWN_LINE : null),
        })
      : null;
    const c = this.commands = {} as Record<string, Handler>;
    const alias = (names: string[], h: Handler) => names.forEach((n) => (c[n] = h));
    alias(['hilfe', 'help', '?'], (m) => this.reply(m, helpText(this.prefix), VOICE_HELP));
    alias(['boards', 'karten', 'liste'], (m, a) => this.cmdBoards(m, a));
    alias(['neu', 'new', 'lobby-neu'], (m, a, g) => this.cmdNew(m, a, g));
    alias(['erstellen', 'generiere', 'generieren', 'baue', 'bauen'], (m, a) =>
      this.boards ? this.boards.command(m, a) : this.reply(m, '🔇 Der Board-Generator ist hier nicht eingerichtet.'),
    );
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
    alias(['voice', 'sprache', 'stimme', 'vc'], (m, a) => this.cmdVoice(m, a));
    alias(['wiederholen', 'nochmal', 'repeat'], (m, _a, g) => this.cmdRepeat(m, g));
    d.gateway.onMessage((m) => this.onMessage(m).catch((e) => log.error(`Nachricht: ${(e as Error).stack ?? e}`)));
    this.accountOff = d.account?.onChange((status, change) => this.onLoginChange(status, change)) ?? null;
  }

  private get prefix(): string {
    return this.d.config.discord.prefix;
  }

  // ───────────────────────────── routing ─────────────────────────────

  async onMessage(msg: ChatMessage): Promise<void> {
    this.refreshCloud(); // synchronous: what the last message changed (menu, links) counts from now on
    if (msg.author.isBot || !msg.guildId) return;
    // With configured channels the bot lives only there – prefix and @mentions elsewhere are ignored.
    const allowed = this.d.config.discord.channelIds;
    if (allowed.length && !allowed.includes(msg.channelId)) return;
    // One game at a time, owned by the server it was created on – other servers neither see nor control it.
    const game = this.game?.guildId === msg.guildId ? this.game : null;
    if (game && msg.channelId === game.channelId) game.seen.set(msg.author.id, { username: msg.author.username, displayName: msg.author.displayName });

    const cmd = this.parseCommand(msg);
    if (cmd) {
      const handler = this.commands[cmd.name];
      if (handler) return handler(msg, cmd.args, game);
      // "@Bot Waluigi" during a game = an answer / pick, not an unknown command.
      if (game && msg.channelId === game.channelId) return this.onGameInput(msg, game, [cmd.name, ...cmd.args].join(' '));
      return this.reply(msg, `Kenne ich nicht: \`${cmd.name}\`. \`${this.prefix} hilfe\` zeigt alle Befehle.`);
    }
    if (game && msg.channelId === game.channelId) return this.onGameInput(msg, game, msg.content);
    if (this.boards && (await this.boards.onMessage(msg))) return;
    if (!game && this.menuWaitsFor(msg.author.id, msg.channelId)) {
      const raw = msg.content.trim();
      const n = msg.viaVoice ? spokenNumber(raw) : null;
      const text = n !== null ? String(n) : raw;
      if (!text || text.startsWith('//')) return;
      if (/^(abbrechen|abbruch|stop|cancel|nein)$/i.test(text)) {
        this.menu = null;
        return this.reply(msg, 'Okay, keine neue Lobby.');
      }
      await this.chooseBoard(msg, text);
    }
  }

  /**
   * Does the open board menu take this person's next message in this channel as their choice? Only the
   * person who asked, in its channel, before it expires (`MENU_TTL_MS`). The one condition for taking the
   * reply (`onMessage`), listening closely (`attention`) and the cloud (`mayUseCloudNow`).
   */
  private menuWaitsFor(userId: string, channelId: string): boolean {
    const m = this.menu;
    return !!m && m.askedBy === userId && m.channelId === channelId && Date.now() < m.expires;
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
    if (!list.length) return this.reply(msg, this.notFound(query, await this.suggest(query)));
    this.menu = { channelId: msg.channelId, options: list.slice(0, MENU_SIZE), askedBy: null, expires: Date.now() + MENU_TTL_MS };
    await this.reply(msg, [
      query ? `**📚 Boards zu „${query}“** (${list.length})` : `**📚 Tafelquiz-Boards** (Auswahl von quiz-base; \`${this.prefix} boards <suche>\` findet mehr)`,
      ...this.numbered(this.menu.options),
      list.length > MENU_SIZE ? `… und ${list.length - MENU_SIZE} weitere – genauer suchen.` : '',
      `Starten mit \`${this.prefix} neu <Nr>\` oder \`${this.prefix} neu <Name>\``,
    ].filter(Boolean).join('\n'));
  }

  private async cmdNew(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (this.shuttingDown) return this.reply(msg, SHUTTING_DOWN_LINE);
    if (game) return this.reply(msg, `Es läuft schon ein Spiel in <#${game.channelId}>. Die Spielleitung kann es mit \`${this.prefix} ende\` beenden.`);
    if (this.game) return this.reply(msg, BUSY_ELSEWHERE);
    if (this.boards?.creating) return this.reply(msg, '⏳ Ich lege gerade ein Board auf quiz-base an. In einer Minute bin ich frei.');
    this.stayInVoice(msg.guildId!);
    const text = args.join(' ').trim();
    if (text) return this.chooseBoard(msg, text);
    // No board named → ask instead of picking one.
    const list = await this.getBoards(msg.channelId);
    if (!list) return;
    this.menu = { channelId: msg.channelId, options: list.slice(0, 10), askedBy: msg.author.id, expires: Date.now() + MENU_TTL_MS };
    await this.reply(msg, [
      `🎲 ${mention(msg.author.id)}, **welches Quiz** wollt ihr spielen? Schreib den Namen (oder einen Teil davon), ich suche auf quiz-base.`,
      'Oder nimm eins der beliebten Boards per Nummer:',
      ...this.numbered(this.menu.options),
      '`abbrechen` bricht ab.',
    ].join('\n'), `Welches Quiz wollt ihr spielen? Sag den Namen oder eine Nummer. Zum Beispiel: ${this.spokenMenu(this.menu.options, 4)}`);
  }

  /** Resolves a board from a number or a name and creates the lobby – or asks back when it is not unambiguous. */
  private async chooseBoard(msg: ChatMessage, text: string): Promise<void> {
    const menu = this.menu?.channelId === msg.channelId && Date.now() < this.menu.expires ? this.menu : null;
    if (/^\d+$/.test(text)) {
      const options = menu?.options ?? (await this.getBoards(msg.channelId));
      if (!options) return;
      const board = options[Number(text) - 1];
      if (!board) return this.reply(msg, `Nummer ${text} gibt es nicht${options.length ? ` (1–${options.length})` : ''}. Schreib sonst den Namen des Quiz.`);
      return this.createGame(msg, board);
    }
    const query = text.replace(/^["„“']+|["„“']+$/g, '').replace(/[.!?]+$/, '').trim();
    // Boards this bot created (own quiz-base account) are not in the public search.
    const own = this.d.boards?.findOwn(query) ?? [];
    if (own.length === 1) {
      if (this.accountStatus()?.state === 'lost')
        await this.say(msg.channelId, '⚠️ Ich bin bei quiz-base gerade nicht angemeldet – ich versuche es trotzdem (der Stand kann veraltet sein).');
      return this.createGame(msg, own[0]!.title, true);
    }
    if (msg.viaVoice) void this.speak(`Ich suche ${query}.`);
    let results = await this.getBoards(msg.channelId, query);
    if (!results) return;
    if (!results.length && query.includes(' ')) {
      // Spoken/typed titles rarely match exactly ("Allgemeinwissen-Quiz V1") – retry with the most telling word.
      const word = query.split(/[\s\-–]+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0];
      if (word) results = (await this.getBoards(msg.channelId, word)) ?? [];
      const close = results.filter((t) => similarity(normalize(t), normalize(query)) >= 0.8);
      if (close.length === 1) return this.createGame(msg, close[0]!);
    }
    const exact = results.filter((t) => normalize(t) === normalize(query));
    if (exact.length === 1) return this.createGame(msg, exact[0]!);
    if (results.length === 1) return this.createGame(msg, results[0]!);

    const options = results.length ? results.slice(0, MENU_SIZE) : await this.suggest(query);
    this.menu = { channelId: msg.channelId, options, askedBy: msg.author.id, expires: Date.now() + MENU_TTL_MS };
    if (!results.length) {
      return this.reply(
        msg,
        this.notFound(query, options) + ' Schreib einen anderen Namen oder `abbrechen`.',
        `Zu ${query} habe ich kein Board gefunden. ${options.length ? `Meinst du vielleicht: ${this.spokenMenu(options, 3)} Sag die Nummer oder einen anderen Namen.` : 'Sag einen anderen Namen.'}`,
      );
    }
    await this.reply(msg, [
      `🤔 Zu „${query}“ passen ${results.length} Boards. Welches meinst du? Antworte mit der **Nummer** (oder genauerem Namen, \`abbrechen\`):`,
      ...this.numbered(options),
      results.length > MENU_SIZE ? `… und ${results.length - MENU_SIZE} weitere.` : '',
    ].filter(Boolean).join('\n'), `Dazu passen ${results.length} Boards. ${this.spokenMenu(options, 5)} Welche Nummer?`);
  }

  private async createGame(msg: ChatMessage, board: string, own = false): Promise<void> {
    // A lobby created now would never be ended on quiz-base (the shutdown ends only the game it found).
    if (this.shuttingDown) return this.reply(msg, SHUTTING_DOWN_LINE);
    if (this.game) return this.reply(msg, this.game.guildId === msg.guildId ? `Es läuft schon ein Spiel in <#${this.game.channelId}>.` : BUSY_ELSEWHERE);
    this.menu = null;
    const guild = this.d.store.get(msg.guildId!);
    const config: Config = { ...this.d.config, game: { ...this.d.config.game, ...guild.rules, autoStart: false, publicBoard: undefined } };
    const session = this.d.createSession(config);
    const g: ActiveGame = {
      guildId: msg.guildId!, channelId: msg.channelId, leaderId: msg.author.id, board, session, lobby: null, phase: 'creating',
      lobbyPlayers: [], canStart: false, startRequested: false, players: [], turn: null, lastTurnSig: '', questionOpen: false,
      awaiting: null, answerDeadline: 0, confirmUntil: 0, pending: null, openKeyword: null, judging: false, operatorNeeded: false, lastQuestion: null, lastAsk: null, lastVerdict: null, buzzerOpen: false, answered: new Set(), closeBuzzer: false,
      seen: new Map([[msg.author.id, { username: msg.author.username, displayName: msg.author.displayName }]]),
      hinted: new Set(), endAsk: null, pickContext: null, reasons: [], lobbyStatusSig: '', offs: [],
    };
    this.game = g;
    this.d.account?.interrupt('Spiel startet'); // a login check gives the browser profile back
    this.attach(g);
    if (msg.voiceChannelId && !this.voice && this.voiceReady && this.d.config.voice.autoJoin) {
      void this.joinVoice(msg.guildId!, msg.voiceChannelId, msg.channelId).catch((e) => this.say(msg.channelId, `⚠️ Voice: ${(e as Error).message}`));
    }
    await this.say(msg.channelId, `⏳ Erstelle eine Tafelquiz-Lobby mit **${board}** …`);
    void this.speakFor(g.guildId, `Alles klar, ich erstelle eine Lobby mit ${board}.`);
    try {
      g.lobby = await session.createLobby(board, own ? { own: true } : undefined);
    } catch (e) {
      log.error(`Lobby: ${(e as Error).message}`);
      await this.reply(msg, `⚠️ Lobby konnte nicht erstellt werden: ${(e as Error).message}`, 'Die Lobby konnte ich leider nicht erstellen. Details stehen im Chat.');
      return this.finish(g, { stayInVoice: true });
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
    void this.speakFor(g.guildId, 'Die Lobby ist offen! Den Link findet ihr im Chat. Gebt auf quiz-base euren Namen ein und klickt auf: Ich bin bereit.');
    g.lobbyTimeout = setTimeout(() => {
      if (this.game === g && g.phase === 'lobby') {
        void this.say(g.channelId, `⌛ Die Lobby wurde nicht innerhalb von ${this.d.config.discord.lobbyTimeoutMin} Minuten gestartet und wird geschlossen.`);
        void g.session
          .endGame()
          .catch((e) => log.warn(`Lobby schließen: ${(e as Error).message}`))
          .then(() => this.finish(g))
          .catch((e) => log.error(`Lobby-Timeout: ${(e as Error).stack ?? e}`));
      }
    }, this.d.config.discord.lobbyTimeoutMin * 60_000);
    session
      .run()
      .catch(async (e) => {
        log.error(`Spiel: ${(e as Error).stack ?? e}`);
        await this.say(g.channelId, `⚠️ Das Spiel ist abgebrochen: ${(e as Error).message}`);
      })
      .finally(() => this.finish(g))
      .catch((e) => log.error(`Spielende: ${(e as Error).stack ?? e}`));
  }

  private async cmdMe(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    const name = args.join(' ').trim();
    if (!name) {
      const current = this.d.store.get(msg.guildId!).links[msg.author.id];
      return this.reply(msg, current ? `Du bist mit **${current}** verknüpft.` : `Schreib \`${this.prefix} ich <dein Name in quiz-base>\`.`);
    }
    // Spoken "ich bin …" is often no name at all ("ich bin dran", "ich bin fertig"): by voice only names of the lobby count.
    if (msg.viaVoice) {
      const inLobby = game ? this.knownNames(game) : [];
      if (!inLobby.some((n) => normalize(n) === normalize(name)))
        return this.reply(
          msg,
          `🔗 „${name}“ ist kein Name aus der Lobby${inLobby.length ? ` (gerade drin: ${inLobby.join(', ')})` : ''}. Verknüpfen: \`${this.prefix} ich <dein quiz-base-Name>\`.`,
          'Den Namen finde ich nicht in der Lobby.',
        );
    }
    await this.link(msg, msg.author.id, name, game);
  }

  private async cmdLink(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    const target = msg.mentions[0];
    const name = args.filter((a) => !/^<@!?\d+>$/.test(a)).join(' ').trim();
    if (!target || !name) return this.reply(msg, `So geht's: \`${this.prefix} link @user <quiz-base-Name>\``);
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
    await this.reply(msg, `🔗 ${mention(userId)} = **${name}**${note}`);
    if (game?.phase === 'lobby') {
      this.scheduleLobbyStatus(game, true);
      this.maybeAutoStart(game);
    }
  }

  private async cmdStatus(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game) {
      const login = this.loginLine();
      return this.reply(msg, `Gerade läuft kein Spiel. \`${this.prefix} neu\` startet eins.${login ? `\n🔐 ${login}` : ''}`, 'Gerade läuft kein Spiel.');
    }
    if (game.phase === 'lobby') return this.reply(msg, this.lobbyStatus(game));
    return this.cmdScores(msg, game);
  }

  private async cmdStart(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game || game.phase !== 'lobby') return this.reply(msg, 'Es gibt keine offene Lobby.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    if (!game.canStart) {
      const waiting = game.lobbyPlayers.filter((p) => !p.ready).map((p) => p.name);
      const ready = game.lobbyPlayers.length - waiting.length;
      return this.reply(
        msg,
        `Noch nicht alle sind in quiz-base bereit (${ready}/${game.lobbyPlayers.length}).${waiting.length ? ` Es fehlt noch: ${waiting.join(', ')}.` : ''}`,
        startMissingLine(waiting, game.lobbyPlayers.length),
      );
    }
    const unlinked = game.lobbyPlayers.filter((p) => !this.userFor(game, p.name)).map((p) => p.name);
    if (unlinked.length) await this.reply(msg, `⚠️ Nicht verknüpft: ${unlinked.join(', ')}. Sie können nicht per Chat wählen oder antworten (die Spielleitung kann mit \`${this.prefix} nimm\` helfen).`);
    this.requestStart(game);
    // Starting on quiz-base takes a few seconds – say right away that it was heard.
    if (msg.viaVoice) void this.speak(START_LINE);
  }

  private async cmdRules(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    const guild = this.d.store.get(msg.guildId!);
    if (args[0]?.toLowerCase() === 'reset') {
      if (game && !this.isLeader(msg, game)) return this.notLeader(msg);
      guild.rules = {};
      this.d.store.save(msg.guildId!);
      // Only the adjustable rules – autoStart/publicBoard stay as the bot set them, the voice bonus stays too.
      if (game) Object.assign(game.session.rules, pickRules(this.d.config.game));
      return this.reply(msg, '📏 Regeln auf Standard zurückgesetzt.\n' + rulesText(this.currentRules(msg.guildId!), this.prefix));
    }
    if (args.length >= 2) return this.cmdRule(msg, args, game);
    await this.reply(msg, rulesText(game ? game.session.rules : this.currentRules(msg.guildId!), this.prefix));
  }

  private async cmdRule(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (game && !this.isLeader(msg, game)) return this.notLeader(msg, 'Während eines Spiels darf nur die Spielleitung Regeln ändern.');
    const [name = '', ...rest] = args;
    const spec = findRule(name);
    if (!spec || !rest.length) return this.reply(msg, `So geht's: \`${this.prefix} regel <name> <wert>\` – Namen siehst du mit \`${this.prefix} regeln\`.`);
    const guild = this.d.store.get(msg.guildId!);
    const rules = this.currentRules(msg.guildId!);
    const err = applyRule(rules, spec, rest.join(''));
    if (err) return this.reply(msg, `⚠️ ${err}`);
    (guild.rules as any)[spec.key] = rules[spec.key];
    this.d.store.save(msg.guildId!);
    if (game) (game.session.rules as any)[spec.key] = rules[spec.key];
    await this.reply(msg, `📏 ${spec.label}: **${formatRuleValue(rules, spec)}**${game ? ' (gilt ab der nächsten Frage)' : ''}`);
  }

  private async cmdBoard(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game?.turn) return this.reply(msg, 'Gerade ist kein Brett offen.');
    await this.reply(msg, this.turnText(game, game.turn));
  }

  private async cmdScores(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game?.players.length) return this.reply(msg, 'Noch keine Punkte.');
    await this.reply(msg, '📊 ' + this.scoreLine(game));
  }

  private async cmdPickFor(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!game?.turn || game.questionOpen) return this.reply(msg, 'Gerade wird keine Karte gewählt.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    await this.handlePick(msg, game, args.join(' '), '@operator', true);
  }

  private async cmdOverride(msg: ChatMessage, game: ActiveGame | null, command: 'r' | 'f' | 'skip'): Promise<void> {
    if (!game || game.phase !== 'running') return this.reply(msg, 'Gerade läuft keine Frage.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    // An answer is expected right now, or the judge asks the leader → the decision replaces it.
    if (game.awaiting || game.operatorNeeded) {
      game.session.bus.emit('operator:command', { command, args: [] });
      return this.d.gateway.react(msg, '👍');
    }
    if (game.judging) return this.reply(msg, '⏳ Ich bewerte gerade noch – danach kannst du überstimmen.');
    if (command === 'skip') {
      if (!game.buzzerOpen) return this.reply(msg, 'Gerade gibt es nichts zu überspringen.');
      game.session.bus.emit('operator:command', { command: 'skip', args: [] });
      return this.reply(msg, '⏭️ Buzzer-Runde beendet, gleich kommt die Lösung.');
    }
    await this.overrideLastVerdict(msg, game, command === 'r');
  }

  /** "richtig"/"falsch" after the verdict: corrects the points of the last verdict until the next card is picked. */
  private async overrideLastVerdict(msg: ChatMessage, game: ActiveGame, correct: boolean): Promise<void> {
    const v = game.lastVerdict;
    if (!v) return this.reply(msg, `Gerade gibt es keine Bewertung zum Überstimmen. Punkte korrigieren: \`${this.prefix} korrektur <Name> <±Punkte>\``);
    const target = scoreFor(v.points, correct, v.viaBuzzer, game.session.rules);
    const fix = target - v.delta;
    if (v.correct === correct && fix === 0) return this.reply(msg, `**${v.player}**: „${v.answer}“ ist schon als ${correct ? 'richtig' : 'falsch'} gewertet.`);
    game.lastVerdict = { ...v, correct, delta: target };
    if (fix) game.session.bus.emit('operator:command', { command: 'punkte', args: [v.player, String(fix)] });
    // A solved question needs no more buzzing.
    if (correct && game.questionOpen) {
      if (game.buzzerOpen) game.session.bus.emit('operator:command', { command: 'skip', args: [] });
      else game.closeBuzzer = true;
    }
    const pts = fix ? ` (${fix > 0 ? '+' : '−'}${Math.abs(fix)})` : '';
    await this.reply(
      msg,
      `✏️ Korrigiert: **${v.player}** „${v.answer}“ zählt als ${correct ? 'richtig' : 'falsch'}${pts}.`,
      `Korrigiert: ${v.player}, ${correct ? 'richtig' : 'falsch'}.${fix ? ` ${fix > 0 ? 'Plus' : 'Minus'} ${Math.abs(fix)}.` : ''}`,
    );
  }

  private async cmdCorrect(msg: ChatMessage, args: string[], game: ActiveGame | null): Promise<void> {
    if (!game || game.phase !== 'running') return this.reply(msg, 'Gerade läuft kein Spiel.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    const delta = Number(args[args.length - 1]?.replace('+', ''));
    const raw = args.slice(0, -1).join(' ');
    const name = game.players.find((p) => normalize(p.name) === normalize(raw))?.name;
    if (!name || !Number.isFinite(delta)) return this.reply(msg, `So geht's: \`${this.prefix} korrektur <Name> <±Punkte>\``);
    game.session.bus.emit('operator:command', { command: 'punkte', args: [name, String(delta)] });
    await this.reply(msg, `✏️ ${name}: ${delta > 0 ? '+' : ''}${delta}`);
  }

  private async cmdEnd(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (!game) return this.reply(msg, 'Gerade läuft kein Spiel.');
    if (!this.isLeader(msg, game)) return this.notLeader(msg);
    await this.say(msg.channelId, '🛑 Spiel wird beendet …');
    // A spoken answer still waiting for "Ja" is discarded – the cut-off question gets no verdict.
    this.dropPending(game);
    game.awaiting = null;
    if (this.voice?.guildId === game.guildId) {
      this.voice.bridge.detach(); // no more "…, du bist dran" while the game shuts down
      this.voice.host.clear();
    }
    void this.speakFor(game.guildId, 'Okay, wir hören hier auf.');
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
        await this.reply(
          msg,
          `${mention(msg.author.id)} du bist noch nicht verknüpft: \`${this.prefix} ich <dein quiz-base-Name>\``,
          `${msg.author.displayName}, ich weiß noch nicht, wer du auf quiz-base bist. Sag: Quizmaster, ich bin, und deinen Namen.`,
        );
      }
      return;
    }

    if (game.awaiting && game.awaiting.player === name) {
      if (msg.viaVoice) return this.onSpokenAnswer(game, name, trimmed, this.voiceUsed.get(msg));
      this.submitAnswer(game, name, trimmed, false);
      await this.d.gateway.react(msg, '📝');
      return;
    }

    if (game.turn && !game.questionOpen) {
      if (game.turn.player === name) return this.handlePick(msg, game, msg.viaVoice ? spokenToDigits(trimmed) : trimmed, name, !!msg.viaVoice);
      // Over voice, others discuss cards all the time – only correct typed attempts.
      if (!msg.viaVoice && parsePick(trimmed, game.turn.grid).kind !== 'none') await this.reply(msg, `Gerade ist **${game.turn.player}** am Zug.`);
    }
  }

  /**
   * Spoken answers: only "Meine Antwort ist …" counts – everything else the answerer says
   * is thinking aloud. The bot repeats the answer once ("Paris?"); "Ja" submits it,
   * "Nein" discards it, a new "Meine Antwort ist …" replaces it. An unclear short reply gets one
   * "Ja oder nein?". The "Ja" has at least `game.confirmGraceSec` (up to the answer time plus that);
   * then the answer counts as said (`game.confirmAtDeadline`) or lapses.
   */
  private onSpokenAnswer(game: ActiveGame, name: string, text: string, used?: () => void): void {
    const waiting = game.pending?.player === name ? game.pending : null;
    const opened = game.openKeyword?.player === name && Date.now() <= game.openKeyword.until ? game.openKeyword : null;
    game.openKeyword = null;
    let said = extractAnswer(text);
    // A question to the others in between ("Ben, was meinst du?") is no answer: the keyword stays open, nothing is asked.
    if (said === null && opened && asksBack(text)) {
      game.openKeyword = opened;
      return log.debug(`🎙 ${name}: Frage nach dem Schlüsselwort – keine Antwort, höre weiter`);
    }
    // "Meine Antwort ist" + pause + "Paris": the cut-off keyword's answer comes as its own utterance – unless that is
    // a plain "Ja"/"Nein" to the answer still waiting.
    if (said === null && opened && !(waiting && confirmReply(text, waiting.answer))) said = extractAnswer(`Meine Antwort ist ${text}`);
    // The bare keyword without verb while "Paris?" waits ("Ja, meine finale Antwort") is a reply to it, below.
    // With its verb ("Genau, meine Antwort ist …") the answer is still to come: keep listening, never a "Ja".
    if (said !== null && (said.trim() || !waiting || hasStrongKeyword(text))) {
      const answer = cleanSpokenAnswer(said);
      if (!answer) {
        // "Meine Antwort ist … ähm" – keep listening; the next utterance completes it.
        game.openKeyword = { player: name, until: Date.now() + OPEN_KEYWORD_MS };
        return log.debug(`🎙 ${name}: Schlüsselwort ohne Antwort – höre weiter`);
      }
      game.endAsk = null; // a new answer: the game goes on
      used?.();
      this.transcript(name, text);
      const now = Date.now();
      // Time is (nearly) up, grace included – no time left for "Ja": the answer counts as said.
      if (now >= game.confirmUntil - PENDING_SUBMIT_MS) {
        void this.speak(`${answer}.`, 'confirm');
        return this.submitAnswer(game, name, answer, true);
      }
      const pending = { player: name, answer: answer.slice(0, 200), at: now, reasked: false };
      game.pending = pending;
      void this.speak(`${answer}?`, 'confirm', true);
      this.armPending(game, pending);
      // Judging may start now – "Ja" then takes the result. Only the controller listens (nothing public, rule 5);
      // it also gives the answer time its grace for "Ja".
      game.session.bus.emit('player:answer-pending', { player: name, answer: pending.answer });
      return;
    }
    const pending = waiting;
    const reply = pending ? confirmReply(text, pending.answer) : null;
    if (pending && reply) {
      used?.();
      this.transcript(name, text);
      if (reply === 'yes') return this.submitAnswer(game, name, pending.answer, true);
      this.dropPending(game);
      return void this.speak('Okay. Deine Antwort?', 'confirm', true);
    }
    const words = speechNorm(text).split(' ').filter(Boolean).length;
    if (pending) {
      // Neither yes nor no ("Hä", "Was?", "Ja, war das richtig?"): ask once, never ignore it silently – not after
      // "Ja, Moment" (they want time) or a long sentence (talk with the others).
      if (!pending.reasked && words <= CONFIRM_AGAIN_MAX_WORDS && !confirmWaits(text)) {
        pending.reasked = true;
        used?.();
        log.info(`🎙 ${name}: Rückfrage unklar (${words} Wörter) – frage nach`);
        void this.speak(CONFIRM_AGAIN_LINE, 'confirm', true);
      } else log.debug(`🎙 ${name}: Rückfrage – weder Ja noch Nein (${words} Wörter)`);
      return;
    }
    // Thinking aloud – no text in the log (rule 8). Remind once per game, in case someone forgets the keyword.
    if (words && words <= NO_KEYWORD_LOG_WORDS) log.info(`🎙 ${name}: ohne Schlüsselwort (${words} Wörter)`);
    const hint = `answer-keyword:${name}`;
    if (!game.hinted.has(hint) && text.split(/\s+/).length <= 5 && !text.trim().endsWith('?')) {
      game.hinted.add(hint);
      void this.speak(ANSWER_KEYWORD_LINE, 'confirm', true);
    }
  }

  /**
   * The time for "Ja" to `p`: the full grace after the answer was heard, at least until `PENDING_SUBMIT_MS` before the
   * answer time ends, never past `confirmUntil` (the controller waits 3 s longer). With grace 0: `PENDING_SUBMIT_MS`
   * before the answer time ends, as before.
   */
  private armPending(g: ActiveGame, p: NonNullable<ActiveGame['pending']>): void {
    clearTimeout(g.pendingTimer);
    const a = g.awaiting;
    const graceMs = g.confirmUntil - g.answerDeadline;
    const due = graceMs > 0
      ? Math.min(g.confirmUntil, Math.max(g.answerDeadline - PENDING_SUBMIT_MS, p.at + graceMs))
      : g.answerDeadline - PENDING_SUBMIT_MS;
    g.pendingTimer = setTimeout(() => {
      if (g.pending !== p || g.awaiting !== a) return;
      // Visible in the log and the chat (no recognised text, rule 8), not spoken: the verdict follows at once, and
      // another sentence in front of it would delay it by its own length.
      const counts = g.session.rules.confirmAtDeadline;
      log.info(`🎙 ${p.player}: kein Ja bis Fristende – ${counts ? 'Antwort zählt wie gesagt' : 'Antwort verfällt'}`);
      this.queue(g.channelId, `-# ⏱️ Kein „Ja“ von ${p.player} bis Fristende – ${counts ? 'die Antwort zählt wie gesagt' : 'die Antwort verfällt'}.`);
      // Off: the answer lapses – the controller ends its wait right after it, with the usual timeout.
      if (counts) this.submitAnswer(g, p.player, p.answer, true);
      else this.dropPending(g);
    }, Math.max(0, due - Date.now()));
  }

  private submitAnswer(game: ActiveGame, name: string, answer: string, spoken: boolean): void {
    clearTimeout(game.pendingTimer);
    game.pending = null;
    game.openKeyword = null;
    game.awaiting = null;
    game.judging = true;
    game.session.bus.emit('player:answer', { player: name, answer: answer.slice(0, 200), spoken });
  }

  private transcript(name: string, text: string): void {
    const v = this.voice;
    if (!v) return;
    log.info(`🎙 ${name}: „${text}“`);
    this.queue(this.voiceText(v), `-# 🎙️ ${name}: „${text}“`);
  }

  private async handlePick(msg: ChatMessage, game: ActiveGame, text: string, player: string, verbose: boolean): Promise<void> {
    const { res, context } = parsePickWithContext(text, game.turn!.grid, game.pickContext);
    game.pickContext = context;
    switch (res.kind) {
      case 'ok':
        game.endAsk = null; // the game goes on – a later "Ja" belongs to the card, not to "Spiel beenden?"
        game.session.bus.emit('player:pick', { player, col: res.cell.col, row: res.cell.row });
        await this.d.gateway.react(msg, '👍');
        return;
      case 'taken': {
        const free = game.turn!.grid.filter((c) => c.col === res.cell.col && !c.answered).map((c) => c.points);
        return this.reply(msg, `❌ **${res.cell.category} ${res.cell.points}** ist schon weg. ${free.length ? `In ${res.cell.category} noch frei: ${free.join(', ')}.` : `${res.cell.category} ist leer.`}`);
      }
      case 'ambiguous':
      case 'invalid':
        return this.reply(msg, `🤔 ${res.hint}`);
      case 'none': {
        if (!verbose || !game.session.rules.pickHint) return;
        // Spoken: only once per turn, only after the bot asked for a card – not between a verdict
        // and the next turn, not while the turn is being announced – and only for what sounds like a card,
        // never for side talk.
        if (msg.viaVoice && !mentionsCard(text, game.turn!.grid)) return;
        const once = `pick-hint:${game.turn!.player}:${game.turn!.open.length}`;
        if (game.hinted.has(once) || !this.voice?.bridge.turnAnnounced) return;
        game.hinted.add(once);
        await this.say(msg.channelId, '🤔 Welche Karte? Z.B. `Nintendo 200`.');
        void this.speak(pickHintLine(game.turn!.open[0]), 'hint', true);
      }
    }
  }

  // ───────────────────────────── host events → chat ─────────────────────────────

  private attach(g: ActiveGame): void {
    const on = <K extends keyof HostEvents>(e: K, h: (p: HostEvents[K]) => void) =>
      g.offs.push(
        g.session.bus.on(e, (p) => {
          try {
            h(p);
          } finally {
            this.refreshCloud(); // who may be heard by the cloud can change with every game event
          }
        }),
      );
    const ch = g.channelId;
    if (this.voice?.guildId === g.guildId) this.voice.bridge.attach(g.session.bus, g.session.rules);

    on('host:lobby', (l) => {
      const before = new Set(g.lobbyPlayers.map((p) => p.name));
      const joined = l.players.filter((p) => !before.has(p.name)).map((p) => p.name);
      if (joined.length && g.phase === 'lobby') void this.speakFor(g.guildId, `${joined.join(' und ')} ${joined.length > 1 ? 'sind' : 'ist'} da.`);
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
        case 'buzzer-open':
          g.buzzerOpen = true;
          this.queue(ch, `🔔 ${n.text}`);
          if (g.closeBuzzer) setTimeout(() => g.session.bus.emit('operator:command', { command: 'skip', args: [] }), 0); // after the controller listens
          g.closeBuzzer = false;
          break;
        case 'buzzed':
          g.buzzerOpen = false;
          this.queue(ch, `🔔 ${who} hat gebuzzert!`);
          break;
        case 'no-buzz':
          g.buzzerOpen = false;
          this.queue(ch, `· ${n.text}`);
          break;
        case 'reminder':
          this.queue(ch, `⏰ ${who}, du bist dran – schreib z.B. \`${g.turn?.open[0]?.category ?? 'Kategorie'} ${g.turn?.open[0]?.points ?? 100}\`.`);
          break;
        case 'operator-needed':
          g.operatorNeeded = true;
          this.queue(ch, `❓ ${n.text} (${mention(g.leaderId)}: \`${this.prefix} richtig\` / \`${this.prefix} falsch\`)`);
          if (n.detail) void this.d.gateway.sendDirect(g.leaderId, `❓ ${n.detail}\nIm Channel mit \`${this.prefix} richtig\` oder \`${this.prefix} falsch\` antworten.`).catch(() => {});
          break;
        default:
          this.queue(ch, `${n.kind === 'board-switch' ? '🔀' : '·'} ${n.text}`);
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
      this.dropPending(g);
      const sig = `${t.player}|${t.board.active}|${t.open.length}`;
      if (sig === g.lastTurnSig) return; // re-emitted after a reminder – no need to repost the board
      g.lastTurnSig = sig;
      g.pickContext = null;
      this.queue(ch, this.turnText(g, t));
    });
    on('host:question', (q) => {
      g.questionOpen = true;
      g.answered = new Set();
      g.lastQuestion = q;
      g.lastVerdict = null; // a new card: overruling the previous one is over
      g.closeBuzzer = false;
      const extras = [q.hasImage ? '🖼 Bild auf quiz-base' : '', q.hasAudio ? '🎵 Audio läuft auf quiz-base' : ''].filter(Boolean).join(' · ');
      const opts = q.options.length ? '\n' + q.options.map((o, i) => `**${'ABCDEFGH'[i] ?? i + 1}**) ${o}`).join('   ') : '';
      this.queue(ch, `❔ **${q.category || 'Frage'} · ${q.points} Punkte**\n> ${q.text}${opts}${extras ? `\n${extras}` : ''}`);
    });
    on('host:await-answer', (a) => {
      g.awaiting = a;
      g.lastAsk = a;
      g.judging = false;
      g.operatorNeeded = false;
      g.buzzerOpen = false;
      g.answerDeadline = Date.now() + a.timeoutSec * 1000;
      // Room for the "Ja" after the answer time – the controller waits as long once an answer is asked back.
      g.confirmUntil = g.answerDeadline + g.session.rules.confirmGraceSec * 1000;
      this.dropPending(g); // a spoken answer arms its own timer for "Ja" (armPending)
      const how = this.voice ? 'Schreib sie hier rein oder sag „Meine Antwort ist …“' : 'Schreib sie einfach hier rein';
      this.queue(ch, `✍️ ${this.who(g, a.player)}, deine Antwort? ${how} (${a.timeoutSec} s).`);
    });
    on('host:verdict', (v) => {
      g.answered.add(v.player);
      g.awaiting = null;
      g.judging = false;
      g.operatorNeeded = false;
      this.dropPending(g);
      g.lastVerdict = { player: v.player, answer: v.answer, correct: v.correct, delta: v.delta, points: g.lastQuestion?.points ?? 0, viaBuzzer: !!g.lastAsk?.viaBuzzer };
      const delta = v.delta ? ` **${v.delta > 0 ? '+' : '−'}${Math.abs(v.delta)}**` : '';
      this.queue(ch, `${v.correct ? '✅' : '❌'} **${v.player}**: „${v.answer}“ ist ${v.correct ? 'richtig' : 'falsch'}${delta}`);
      if (v.reason && !v.correct && v.answer && !v.answer.startsWith('(')) g.reasons.push(`${v.player}: ${v.reason}`);
    });
    on('host:reveal', ({ answer }) => {
      g.buzzerOpen = false;
      g.questionOpen = false;
      // The question is over – also when it was skipped while "Paris?" waited for "Ja" (`!quiz skip`, the page moved
      // on): that answer lapses, no answer is expected any more, and nothing is being judged.
      this.dropPending(g);
      g.awaiting = null;
      g.judging = false;
      const why = g.reasons.splice(0).map((r) => `-# ${r}`).join('\n');
      this.queue(ch, `${answer ? `💡 Lösung: **${answer}**\n` : ''}${why ? `${why}\n` : ''}📊 ${this.scoreLine(g)}`);
    });
    on('host:game-over', ({ players }) => {
      g.phase = 'over';
      this.queue(ch, ['🏁 **Spiel vorbei!**', ...rankingLines(players, (n) => this.who(g, n)), `-# Host-Kosten: ${g.session.meter.summary()}`].join('\n'));
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
    if (this.voice && this.voice.guildId === g.guildId) {
      for (const m of this.d.gateway.voiceMembers?.(g.guildId, this.voice.voiceChannelId) ?? []) if (!g.seen.has(m.id)) g.seen.set(m.id, m);
    }
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
    const unlinked = g.lobbyPlayers.filter((p) => !this.userFor(g, p.name)).map((p) => p.name);
    if (g.lobbyPlayers.length < this.d.config.game.minPlayers) {
      // Too few for the automatic start – say so once instead of waiting silently ("!quiz los" still starts).
      if (g.lobbyPlayers.length && !unlinked.length && g.lobbyPlayers.every((p) => p.ready) && !g.hinted.has('few-players')) {
        g.hinted.add('few-players');
        this.queue(g.channelId, `✅ Alle bereit. Von selbst starte ich erst ab ${this.d.config.game.minPlayers} Spielern – ${mention(g.leaderId)}, mit \`${this.prefix} los\` geht es trotzdem los.`);
      }
      return;
    }
    if (!unlinked.length) return this.requestStart(g);
    if (this.voice && g.lobbyPlayers.every((p) => p.ready) && !g.hinted.has(`voice-unlinked:${unlinked.join()}`)) {
      g.hinted.add(`voice-unlinked:${unlinked.join()}`);
      void this.speakFor(g.guildId, `Alle sind bereit, aber ich weiß noch nicht, wer ${unlinked.join(' und ')} ist. Sagt: Quizmaster, ich bin, und euren Namen.`);
    }
  }

  private requestStart(g: ActiveGame): void {
    g.startRequested = true;
    g.session.bus.emit('operator:command', { command: 'start', args: [] });
  }

  private knownNames(g: ActiveGame): string[] {
    return (g.phase === 'lobby' || !g.players.length ? g.lobbyPlayers : g.players).map((p) => p.name);
  }

  private dropPending(g: ActiveGame): void {
    clearTimeout(g.pendingTimer);
    g.pending = null;
    g.openKeyword = null;
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

  /** Game leader or server admin – of the server the game runs on; admin rights elsewhere count for nothing. */
  private isLeader(msg: ChatMessage, game: ActiveGame | null): boolean {
    if (!game) return true;
    if (msg.guildId !== game.guildId) return false;
    return msg.canManage || game.leaderId === msg.author.id;
  }

  private notLeader(msg: ChatMessage, text = 'Das darf nur die Spielleitung (wer die Lobby erstellt hat) oder ein Server-Admin.'): Promise<void> {
    return this.reply(msg, `🔒 ${text}`);
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

  private spokenMenu(list: string[], max: number): string {
    return list.slice(0, max).map((t, i) => `${i + 1}: ${t}.`).join(' ');
  }

  private numbered(list: string[]): string[] {
    return list.map((t, i) => `\`${i + 1}\` ${t}`);
  }

  /** `stayInVoice`: the lobby could not even be created – the players may simply try again. */
  private async finish(g: ActiveGame, opts: { stayInVoice?: boolean } = {}): Promise<void> {
    if (this.game !== g) return;
    this.game = null;
    this.refreshCloud();
    if (g.phase === 'running' && g.players.length) {
      this.queue(g.channelId, ['🏁 **Spiel beendet.** Endstand:', ...rankingLines(g.players, (n) => this.who(g, n))].join('\n'));
      void this.speakFor(g.guildId, gameOverLine(g.players));
    }
    clearTimeout(g.lobbyTimeout);
    clearTimeout(g.lobbyStatusTimer);
    this.dropPending(g); // a spoken answer still waiting for "Ja": its timer must not fire on the closed session
    g.offs.forEach((off) => off());
    if (this.voice?.guildId === g.guildId) {
      this.voice.bridge.detach();
      this.voice.host.latencySummary(); // ⏱ bilanz of this game – also when it broke off
      if (!opts.stayInVoice && !this.shuttingDown && this.d.config.voice.leaveOnGameEnd) this.leaveAfterGame(this.voice);
    }
    this.touchVoice();
    await g.session.close().catch(() => {});
    await this.flush(g.channelId);
    this.d.account?.gameEnded();
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

  /** The shutdown has begun (first step of `shutdownBot`): from now on no new lobbies and no board creation. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.menu = null;
  }

  /** Ends the game (on quiz-base at most `SHUTDOWN_END_GAME_MS`), closes its browser and leaves the voice channel (goodbye at most `SHUTDOWN_GOODBYE_MS`). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true; // one goodbye only ("Ich muss leider los"), not the one after the game as well
    this.accountOff?.();
    this.accountOff = null;
    clearTimeout(this.lossNotice.timer);
    const g = this.game; // the game may already be finished (and this.game null) once endGame() returns
    if (g) {
      await this.say(g.channelId, '👋 Der Quiz-Host fährt herunter, das Spiel wird beendet.');
      const ended = await within(g.session.endGame().catch(() => {}), SHUTDOWN_END_GAME_MS);
      if (!ended) log.warn('Spiel auf quiz-base nicht rechtzeitig beendet');
      await this.finish(g); // closes the game's browser
    }
    await this.leaveVoice(null, 'Ich muss leider los. Tschüss!', '', SHUTDOWN_GOODBYE_MS);
  }

  // ───────────────────────────── quiz-base account ─────────────────────────────

  /** No game, no board being generated or created, no voice room: the account keeper may use the browser profile. */
  isIdleForMaintenance(): boolean {
    return !this.game && !this.boards?.busyAny && !this.voice && !this.voiceJoining && !this.shuttingDown;
  }

  /**
   * After the gateway login: a loss nobody was told about yet (the DM failed, or the bot stopped before it went
   * out) is reported now. A loss that was reported (`notifiedLostAt`) is not reported again.
   */
  reportPendingLoss(): void {
    const s = this.accountStatus();
    if (s?.state === 'lost' && s.notifiedLostAt === null) this.sendLossNotice(lossSource(s));
  }

  private accountStatus(): LoginStatus | null {
    try {
      return this.d.account?.status() ?? null;
    } catch (e) {
      log.warn(`Anmeldestatus: ${(e as Error).message}`);
      return null;
    }
  }

  /** "quiz-base-Anmeldung: …" for `!quiz status` – no game content, no URLs. */
  private loginLine(): string | null {
    const s = this.accountStatus();
    return s ? formatLoginStatus(s, Date.now(), this.d.account!.loginCommand) : null;
  }

  /** Called synchronously by the keeper: must not throw (rule 10); the DMs run in the background. */
  private onLoginChange(status: LoginStatus, change: LoginChange): void {
    try {
      if (this.shuttingDown) return;
      // No flapping by construction: the store turns lost → ok only on a confirmation (user menu, own-board lobby,
      // board saved, password login) – never on a mere renewal of the page, which may be an anonymous session.
      if (change.after === 'lost' && status.notifiedLostAt === null) this.sendLossNotice(change.source);
      else if (change.before === 'lost' && change.after === 'ok') {
        this.lossNotice.tries = 0;
        clearTimeout(this.lossNotice.timer);
        this.lossNotice.timer = undefined;
        // "wieder da" only if the owner heard about the loss.
        if (change.notifiedLostAt !== null) void this.sendBackNotice(status);
      }
    } catch (e) {
      log.warn(`Anmeldestatus-Meldung: ${(e as Error).message}`);
    }
  }

  private sendLossNotice(source: string): void {
    const n = this.lossNotice;
    if (n.sending) return;
    clearTimeout(n.timer);
    n.timer = undefined;
    n.sending = this.deliverLossNotice(source)
      .catch((e) => log.warn(`Anmeldung verloren, DM: ${(e as Error).message}`))
      .finally(() => (n.sending = null));
  }

  private async deliverLossNotice(source: string): Promise<void> {
    const acc = this.d.account;
    const s = this.accountStatus();
    if (!acc || !s || this.shuttingDown || s.state !== 'lost' || s.notifiedLostAt !== null) return;
    const delivered = await this.dmOwners(lossText(s, source, acc.loginCommand, this.prefix));
    const n = this.lossNotice;
    if (delivered > 0) {
      n.tries = 0;
      log.info(`🔐 Verlust der quiz-base-Anmeldung per DM gemeldet (${delivered} Empfänger)`);
      // Back meanwhile: no mark (it would stick to the next loss), but say so.
      if (this.accountStatus()?.state === 'lost') acc.markNotified(Date.now());
      else void this.sendBackNotice(this.accountStatus()!);
      return;
    }
    if (this.shuttingDown) return;
    if (n.tries < LOGIN_DM_RETRIES) {
      n.tries++;
      log.warn(`🔐 Verlust der quiz-base-Anmeldung: DM nicht zugestellt – neuer Versuch in ${LOGIN_DM_RETRY_MS / 60_000} min (${n.tries}/${LOGIN_DM_RETRIES})`);
      n.timer = setTimeout(() => {
        n.timer = undefined;
        try {
          this.sendLossNotice(source);
        } catch (e) {
          log.warn(`Anmeldung verloren, DM: ${(e as Error).message}`);
        }
      }, LOGIN_DM_RETRY_MS);
      n.timer.unref?.();
    } else {
      log.warn(`🔐 Verlust der quiz-base-Anmeldung: DM nicht zugestellt – sichtbar in \`${this.prefix} status\` und \`qbhost doctor\`, neuer Versuch beim nächsten Start`);
    }
  }

  private async sendBackNotice(s: LoginStatus): Promise<void> {
    try {
      const now = Date.now();
      await this.dmOwners(`✅ **quiz-base-Anmeldung wieder da** (${when(s.lastOkAt ?? now, now)}).`);
    } catch (e) {
      log.warn(`Anmeldung wieder da, DM: ${(e as Error).message}`);
    }
  }

  /** DM to every owner; returns how many got it. Never throws. */
  private async dmOwners(text: string): Promise<number> {
    const ids = await this.ownerIds();
    if (!ids.length) {
      if (!this.ownersWarned) log.warn('Keine Besitzer-ID für Betriebsmeldungen – discord.ownerIds setzen');
      this.ownersWarned = true;
      return 0;
    }
    let delivered = 0;
    for (const id of ids) {
      try {
        await this.d.gateway.sendDirect(id, text);
        delivered++;
      } catch (e) {
        log.warn(`Betriebsmeldung per DM an ${id} nicht zugestellt: ${(e as Error).message}`);
      }
    }
    return delivered;
  }

  /** `discord.ownerIds`, else the owner(s) of the Discord application. */
  private async ownerIds(): Promise<string[]> {
    const configured = this.d.config.discord.ownerIds;
    if (configured.length) return configured;
    try {
      return (await this.d.gateway.ownerIds?.()) ?? [];
    } catch (e) {
      log.warn(`Besitzer der Discord-App: ${(e as Error).message}`);
      return [];
    }
  }

  // ───────────────────────────── voice ─────────────────────────────

  private get voiceReady(): boolean {
    return !!this.d.voice && !!this.d.gateway.joinVoice && this.d.config.voice.enabled;
  }

  /** Chat reply; if the message was spoken, also answer by voice (`spoken` or a speakable version of `text`). */
  private async reply(msg: ChatMessage, text: string, spoken?: string): Promise<void> {
    await this.say(msg.channelId, text);
    if (msg.viaVoice) void this.speak(spoken ?? briefSpeech(text));
  }

  /** Game announcements: only into a voice channel on the game's server. */
  private speakFor(guildId: string, text: string): Promise<void> {
    return this.voice?.guildId === guildId ? this.speak(text) : Promise.resolve();
  }

  /** `interruptible`: hints and prompts the person on turn may talk over (barge-in). */
  private speak(text: string, key?: string, interruptible = false): Promise<void> {
    return this.voice ? this.voice.bridge.say(text, key, { interruptible }).catch((e) => log.warn(`Sprechen: ${(e as Error).message}`)) : Promise.resolve();
  }

  private async cmdVoice(msg: ChatMessage, args: string[]): Promise<void> {
    // Voice belongs to the running game – another server must not pull the bot out of it.
    if (this.game && this.game.guildId !== msg.guildId) return this.reply(msg, BUSY_ELSEWHERE);
    if (/^(aus|off|stop|raus|leave|verlassen)$/i.test(args[0] ?? '')) {
      if (!this.voice || this.voice.guildId !== msg.guildId) return this.reply(msg, 'Ich bin in keinem Voice-Channel.');
      // During a game only the leader sends the bot out; the game goes on in the chat.
      const g = this.voiceGame();
      if (g && !this.isLeader(msg, g)) return this.notLeader(msg, 'Während eines Spiels schickt mich nur die Spielleitung aus dem Voice-Channel.');
      return this.leaveVoice(msg.channelId, 'Okay, ich gehe. Bis zum nächsten Quiz!', g ? ' Das Spiel läuft hier im Chat weiter.' : '');
    }
    if (!this.voiceReady) return this.reply(msg, '🔇 Die Sprachsteuerung ist auf diesem Rechner nicht eingerichtet: `npx qbhost voice-setup` (siehe docs/VOICE.md).');
    if (!msg.voiceChannelId) return this.reply(msg, '🎧 Geh zuerst in einen Voice-Channel, dann komme ich dazu.');
    // Moving the bot away from the game's voice channel is the leader's call, like sending it out.
    const g = this.voiceGame();
    if (g && this.voice && this.voice.voiceChannelId !== msg.voiceChannelId && !this.isLeader(msg, g))
      return this.notLeader(msg, 'Während eines Spiels holt mich nur die Spielleitung in einen anderen Voice-Channel.');
    try {
      await this.joinVoice(msg.guildId!, msg.voiceChannelId, msg.channelId);
    } catch (e) {
      await this.reply(msg, `⚠️ Voice: ${(e as Error).message}`);
    }
  }

  private async joinVoice(guildId: string, voiceChannelId: string, textChannelId: string): Promise<void> {
    if (this.voiceJoining) return this.voiceJoining;
    if (this.voice?.voiceChannelId === voiceChannelId) return;
    this.d.account?.interrupt('Voice-Channel'); // a login check gives the browser profile back
    this.voiceJoining = (async () => {
      if (this.voice) await this.leaveVoice(null);
      const kit = this.d.voice!;
      const vc = this.d.config.voice;
      await this.say(textChannelId, '⏳ Komme in den Voice-Channel …');
      const [transport] = await Promise.all([this.d.gateway.joinVoice!(guildId, voiceChannelId, { silenceMs: vc.silenceMs, maxSpeechSec: vc.maxSpeechSec }), kit.warmup()]);
      const host = new VoiceHost({
        transport,
        stt: kit.stt,
        fastStt: kit.fastStt,
        confirmStt: kit.confirmStt,
        wakeStt: kit.wakeStt,
        localStt: kit.localStt,
        localFastStt: kit.localFastStt,
        cloudAllowed: (speaker, startedAt) => this.cloudAllowed(speaker.id, startedAt),
        tts: kit.tts,
        cfg: vc,
        onTrouble: () => this.voiceTrouble(host),
        prompt: () => this.voicePrompt(),
        onSpeech: (speaker, text, used) => this.onSpeech(speaker, text, used),
        attention: (speaker) => this.attention(speaker.id),
        mayInterrupt: (speaker) => this.onTurn(speaker.id),
        onClose: () => {
          // The room went away by itself (Discord disconnect, kick): give the extra time back and stop narrating.
          const v = this.voice;
          if (v?.host !== host) return;
          const g = this.voiceGame();
          clearTimeout(v.idleTimer);
          v.leaving?.stop();
          v.bridge.detach();
          this.voice = null;
          if (g) this.queue(g.channelId, `🔇 Die Voice-Verbindung ist weg. \`${this.prefix} voice\` holt mich zurück.`);
        },
      });
      const bridge = new VoiceBridge(host, { scoresEvery: vc.scoresEvery, extraTimeSec: vc.extraTimeSec, board: () => this.game?.board ?? 'dem Quiz' });
      this.voice = { host, bridge, guildId, textChannelId, voiceChannelId, seq: 0 };
      const g = this.voiceGame();
      if (g) {
        bridge.attach(g.session.bus, g.session.rules);
        this.autoLink(g);
      }
      this.touchVoice();
      await this.say(textChannelId, `🎙️ Ich bin im Voice-Channel <#${voiceChannelId}> und höre zu, solange ich drin bin. Aufnahmen werden nicht gespeichert, nur Erkanntes, auf das ich reagiere, schreibe ich hier mit. Sprachbefehle: „Quizmaster, Hilfe“.`);
      void this.speak(
        this.voiceGame()
          ? 'Hallo! Ich bin euer Quizmaster und höre ab jetzt zu.'
          : 'Hallo! Ich bin euer Quizmaster und höre ab jetzt zu. Sagt: Quizmaster, neues Quiz, und den Namen des Quiz.',
      );
    })().finally(() => (this.voiceJoining = null));
    return this.voiceJoining;
  }

  /** Recognition is down without a local fallback: ask people to type – once per game (once per stay without a game). */
  private voiceTrouble(host: VoiceHost): void {
    const v = this.voice;
    if (v?.host !== host) return;
    const g = this.voiceGame();
    if (g) {
      if (g.hinted.has('voice-trouble')) return;
      g.hinted.add('voice-trouble');
      this.queue(g.channelId, VOICE_TROUBLE_LINE);
    } else {
      if (v.troubled) return;
      v.troubled = true;
      this.queue(v.textChannelId, VOICE_TROUBLE_LINE);
    }
  }

  /** `goodbyeMaxMs`: the goodbye is cut off after this long (shutdown). */
  private async leaveVoice(textChannelId: string | null, goodbye?: string, note = '', goodbyeMaxMs?: number): Promise<void> {
    const v = this.voice;
    if (!v) return;
    this.voice = null;
    clearTimeout(v.idleTimer);
    const leaving = v.leaving;
    v.leaving = undefined;
    v.bridge.detach();
    // The goodbye after the game is queued already: let it finish (time-limited) instead of saying a second one.
    if (goodbye) {
      const said = (leaving ? leaving.done : v.host.say(goodbye)).catch(() => {});
      await (goodbyeMaxMs === undefined ? said : within(said, goodbyeMaxMs));
    }
    leaving?.stop();
    await v.host.close().catch(() => {});
    if (textChannelId) await this.say(textChannelId, `👋 Voice-Channel verlassen.${note}`);
  }

  /**
   * After the game: a short goodbye behind the last announcements (final scores), then out of the channel.
   * Runs in the background – closing the game does not wait for it. Stays if a new game starts on this
   * server meanwhile; leaves anyway after `GOODBYE_MAX_MS` if speech hangs.
   */
  private leaveAfterGame(v: VoiceSession): void {
    if (v.leaving) return;
    let stop = () => {};
    const stopped = new Promise<void>((r) => (stop = r));
    const timer = setTimeout(stop, GOODBYE_MAX_MS);
    const done = Promise.race([v.host.say(GOODBYE_LINE), stopped]).finally(() => clearTimeout(timer));
    const leaving = { done, stop, cancelled: false };
    v.leaving = leaving;
    void done
      .then(() => {
        if (this.voice !== v || v.leaving !== leaving) return; // left, moved or replaced meanwhile
        v.leaving = undefined;
        if (leaving.cancelled || this.game?.guildId === v.guildId) return; // a new game (or its menu) here – stay
        return this.leaveVoice(v.textChannelId);
      })
      .catch((e) => log.warn(`Voice verlassen: ${(e as Error).message}`));
  }

  /** `!quiz neu` on this server while the bot is about to leave after a game: it stays (menu, lobby, a failed lobby). */
  private stayInVoice(guildId: string): void {
    const v = this.voice;
    if (v?.guildId === guildId && v.leaving) v.leaving.cancelled = true;
  }

  /** Leaves an idle voice channel after a while without a game or speech. */
  private touchVoice(): void {
    const v = this.voice;
    if (!v) return;
    clearTimeout(v.idleTimer);
    v.idleTimer = setTimeout(() => {
      if (this.voice === v && !this.game) void this.leaveVoice(v.textChannelId, 'Hier ist es still geworden. Ich verabschiede mich!').catch((e) => log.warn(`Voice verlassen: ${(e as Error).message}`));
      else this.touchVoice();
    }, VOICE_IDLE_MS);
  }

  /** Vocabulary hints for the recogniser – categories, names, board titles. Never solutions. */
  private voicePrompt(): string {
    const g = this.voiceGame();
    const words = ['Quizmaster', 'Meine Antwort ist', 'Hier'];
    if (g?.turn) {
      // Point values, so "hundert" is not heard as "Hunde" or "Jahrhundert".
      const points = [...new Set(g.turn.grid.map((c) => c.points))].sort((a, b) => a - b);
      if (points.length) words.push(`${g.turn.categories[0] ?? 'Sport'} für ${points[0]}`, ...points.map(String));
      words.push(...g.turn.categories);
    }
    if (g) words.push(...this.knownNames(g));
    if (!g && this.menu) words.push(...this.menu.options.slice(0, 6));
    return words.join(', ').slice(0, 400);
  }

  /**
   * Who the bot listens to right now. Only the person whose turn it is (and, while the
   * buzzer is open, everyone who may still buzz) is transcribed in full; for everyone
   * else only "Quizmaster, …" at the start of an utterance gets through.
   */
  private attention(userId: string): Attention {
    const a = this.turnAttention(userId);
    // Asked "Soll ich das Spiel beenden?": a plain "Ja" must get through (fast model, local like any confirmation).
    // Also while the asker is answering a question: 'answer' may be Parakeet (`voice.parakeetFor`), which writes a
    // lone "Ja" as "Yeah". 'confirm' hears a new "Meine Antwort ist …" a second time with the answer engine.
    const ask = this.voiceGame()?.endAsk;
    return (a === 'wake' || a === 'answer') && ask?.userId === userId && Date.now() <= ask.until ? 'confirm' : a;
  }

  private turnAttention(userId: string): Attention {
    const g = this.voiceGame();
    if (!g) return this.voice && this.menuWaitsFor(userId, this.voiceText(this.voice)) ? 'full' : 'wake';
    if (g.phase !== 'running') return 'wake';
    const name = this.nameFor(g, userId);
    const now = this.expectedPlayer(g);
    if (!name) {
      // Unlinked: listen only if the expected speaker is unlinked too – it might be them (→ hint).
      return now && !this.userFor(g, now) ? 'full' : 'wake';
    }
    if (this.voice?.bridge.buzzerOpen) return 'full';
    if (now !== name) return 'wake';
    // The answerer needs the precise model – except for "Ja"/"Nein" after "Paris?" (the host checks for a new answer).
    // … and for the rest of a keyword cut off at a pause ("Meine Antwort ist" + "Paris") – that is an answer.
    if (g.awaiting?.player === name) return g.pending?.player === name && g.openKeyword?.player !== name ? 'confirm' : 'answer';
    return 'full'; // picking a card
  }

  /**
   * May an utterance of this person that began at `startedAt` go to a cloud recogniser (`voice.stt:
   * deepgram`)? Only if they were allowed to speak (`mayUseCloudNow`) the whole time: already when it began
   * and still now, without a break (`cloudSince`). Who starts talking before their turn is heard locally.
   */
  private cloudAllowed(userId: string, startedAt: number): boolean {
    this.refreshCloud();
    const since = this.cloudSince.get(userId);
    return since !== undefined && Number.isFinite(startedAt) && since <= startedAt;
  }

  /**
   * Who may be heard by the cloud right now: someone clearly identified who may speak now – the linked
   * player on turn (pick, answer, "Ja"), while the buzzer is open the linked players who may still buzz,
   * and without a game whoever opened the menu. Never unlinked people (spectators, a player whose quiz-base
   * name is not linked), never in the lobby or after the game. They are heard locally; a locally heard wake
   * word lets their command through (VoiceHost).
   */
  private mayUseCloudNow(userId: string): boolean {
    const g = this.voiceGame();
    // Exactly while the menu takes their spoken reply: not after it expired, was chosen from or replaced.
    if (!g) return !!this.voice && this.menuWaitsFor(userId, this.voiceText(this.voice));
    if (g.phase !== 'running') return false;
    const name = this.nameFor(g, userId);
    if (!name) return false;
    if (g.buzzerOpen) return !g.answered.has(name);
    return this.expectedPlayer(g) === name;
  }

  /**
   * Updates `cloudSince` after every change of game state – after each bus event, when the game ends, and
   * (synchronously, adding no tick) at the start of each chat message and utterance, which sees what the one
   * before changed; also on every `cloudAllowed`. A person who is not allowed any more loses their
   * timestamp, one who just became allowed gets "now" (noticed late at worst, which only makes it later).
   * So losing and regaining the permission during an utterance resets it.
   */
  private refreshCloud(): void {
    const v = this.voice;
    if (!v) return void this.cloudSince.clear();
    const now = Date.now();
    const ids = new Set([...Object.keys(this.d.store.get(v.guildId).links), ...(this.menu?.askedBy ? [this.menu.askedBy] : [])]);
    for (const id of [...this.cloudSince.keys()]) if (!ids.has(id) || !this.mayUseCloudNow(id)) this.cloudSince.delete(id);
    for (const id of ids) if (!this.cloudSince.has(id) && this.mayUseCloudNow(id)) this.cloudSince.set(id, now);
  }

  /** Whose input the game waits for: the answerer, or who picks the next card. */
  private expectedPlayer(g: ActiveGame): string | null {
    return g.awaiting?.player ?? (g.turn && !g.questionOpen ? g.turn.player : null);
  }

  /** The person on turn – the only one who may talk over the bot's hints and prompts (barge-in). */
  private onTurn(userId: string): boolean {
    const g = this.voiceGame();
    if (!g || g.phase !== 'running') return false;
    const name = this.nameFor(g, userId);
    return !!name && this.expectedPlayer(g) === name;
  }

  private async onSpeech(speaker: Speaker, text: string, used: () => void = () => {}): Promise<void> {
    this.refreshCloud();
    const v = this.voice;
    if (!v) return;
    this.touchVoice();
    const msg: ChatMessage = {
      id: `voice-${++v.seq}`,
      // Spoken input belongs to the game's channel, wherever the bot was called into voice.
      channelId: this.voiceText(v),
      guildId: v.guildId,
      author: { id: speaker.id, username: speaker.username, displayName: speaker.displayName, isBot: false },
      content: text,
      mentionsBot: false,
      mentions: [],
      canManage: false,
      voiceChannelId: v.voiceChannelId,
      viaVoice: true,
    };
    this.voiceUsed.set(msg, used); // spoken answers mark it where they post their transcript
    const g = this.voiceGame();
    const transcript = () => {
      used(); // ⏱: the bot acts on this utterance
      log.info(`🎙 ${speaker.displayName}: „${text}“`);
      this.queue(msg.channelId, `-# 🎙️ ${speaker.displayName}: „${text}“`);
    };

    const rest = stripWakeWord(text, this.d.config.voice.wakeWords);
    // Normalising after the wake word drops the "?" – a question never ends the game by itself.
    const question = /\?\s*$/.test(text.trim());

    // 0) The reply to "Soll ich das Spiel beenden?": a plain "Ja"/"Nein" (also "Quizmaster, ja") from who was asked.
    // It is the newer question, so it wins over a spoken answer waiting for "Ja" – that one stays open.
    if (g?.endAsk) {
      if (Date.now() > g.endAsk.until) g.endAsk = null;
      else if (g.endAsk.userId === speaker.id) {
        const reply = endAskReply(rest ?? text, question);
        if (reply) {
          transcript();
          g.endAsk = null;
          if (reply === 'yes') return this.cmdEnd(msg, g);
          return this.reply(msg, '▶️ Okay, es geht weiter.', END_KEEP_LINE);
        }
      }
    }

    // "Quizmaster, meine Antwort ist Paris" / "Quizmaster, ja" from the person answering is the answer, not a command.
    // The keyword without a verb and a "no" only when they are no command as well: "Quizmaster, Antwort bitte
    // wiederholen" repeats, "Quizmaster, stopp" still asks "Spiel beenden?" (the answer stays open). "richtig"/"falsch"
    // are a "Ja"/"Nein" to the own waiting answer, never the leader's verdict on it.
    // Everybody else keeps the command ("Quizmaster, wiederhole die Frage" stays one: no keyword, no yes/no).
    const answerer = g?.phase === 'running' && g.awaiting ? this.nameFor(g, speaker.id) : null;
    let asAnswer = false;
    if (rest !== null && g && answerer && answerer === g.awaiting?.player) {
      const pend = g.pending?.player === answerer ? g.pending.answer : null;
      const cmd = voiceCommand(rest, { question, categories: g.turn?.categories });
      const isCommand = cmd !== null && !(pend !== null && (cmd.name === 'richtig' || cmd.name === 'falsch'));
      const answers = (t: string) => {
        if (hasStrongKeyword(t) || (extractAnswer(t) !== null && !isCommand)) return true;
        const reply = pend === null ? null : confirmReply(t, pend);
        return reply === 'yes' || (reply === 'no' && !isCommand);
      };
      if (answers(text)) asAnswer = true;
      else if (answers(rest)) {
        asAnswer = true;
        msg.content = rest; // a custom wake word the answer patterns do not know
      }
    }

    // 1) "Quizmaster, …" commands.
    if (rest !== null && !asAnswer) {
      transcript();
      const cmd = voiceCommand(rest, { question, categories: g?.turn?.categories });
      if (!cmd) return void this.speak('Das habe ich nicht verstanden. Sag: Quizmaster, Hilfe.');
      // "Quizmaster, stopp" may mean "stop talking" – ending the game takes the whole phrase.
      if (cmd.name === 'ende?') {
        if (!g) return this.reply(msg, 'Gerade läuft kein Spiel.');
        if (!this.isLeader(msg, g)) return this.notLeader(msg);
        g.endAsk = { userId: speaker.id, until: Date.now() + END_ASK_MS };
        return this.reply(msg, `🛑 Spiel beenden? Sag „Ja“ (oder „Quizmaster, Spiel beenden“), „Nein“ spielt weiter – oder schreib \`${this.prefix} ende\`.`, END_ASK_LINE);
      }
      if (cmd.name === 'wiederholen') return v.bridge.repeat();
      if (cmd.name === 'brett' && g?.turn) return v.bridge.freeCards();
      if (cmd.name === 'stand' && g) return v.bridge.scores();
      if (cmd.name === 'hilfe') return void this.speak(VOICE_HELP);
      if (g && msg.channelId === g.channelId) g.seen.set(speaker.id, speaker);
      return this.commands[cmd.name]?.(msg, cmd.args, g);
    }

    // 2) Buzzer by voice.
    if (!asAnswer && g?.phase === 'running' && v.bridge.buzzerOpen && isBuzz(text)) {
      const name = this.nameFor(g, speaker.id);
      if (!name) return;
      transcript();
      g.session.bus.emit('player:buzz', { player: name });
      return;
    }

    // 3) Picks, answers and menu replies – only from the person who is expected to speak.
    if (g) {
      const name = this.nameFor(g, speaker.id);
      const expected = !!name && ((g.awaiting && g.awaiting.player === name) || (g.turn && !g.questionOpen && g.turn.player === name));
      if (!expected) {
        if (!name && g.phase === 'running') return this.onMessage(msg); // unlinked → hint once
        return;
      }
      // Answers post their own transcript (only keyword answers and "Ja/Nein"); picks only when they are picks.
      if (!g.awaiting && g.turn && parsePick(spokenToDigits(text), g.turn.grid).kind !== 'none') transcript();
      return this.onMessage(msg);
    }
    if (this.menu?.askedBy === speaker.id) {
      transcript();
      return this.onMessage(msg);
    }
  }

  /** The game the voice room belongs to – only one on the same server as the voice channel. */
  private voiceGame(): ActiveGame | null {
    return this.voice && this.game?.guildId === this.voice.guildId ? this.game : null;
  }

  /** Where voice input and transcripts belong: the game's channel while a game runs on the voice's server. */
  private voiceText(v: VoiceSession): string {
    const g = this.game;
    return g && g.guildId === v.guildId ? g.channelId : v.textChannelId;
  }

  private async cmdRepeat(msg: ChatMessage, game: ActiveGame | null): Promise<void> {
    if (this.voice?.guildId === msg.guildId) this.voice.bridge.repeat();
    if (!msg.viaVoice && game?.turn) await this.reply(msg, this.turnText(game, game.turn));
  }
}

/** Strips spoken fillers ("Ähm, ich glaube das ist …"); '' if it was only stalling. */
export function cleanSpokenAnswer(text: string): string {
  const prefix = /^\s*(äh+m*|ähm|hm+|also|okay|ok|ja|na ja|naja|ich (glaube|denke|würde sagen|sage|tippe auf|tippe)|meine antwort ist|mein antwort ist|meiner antwort ist|die antwort ist|das ist|das sind|das war|es ist|ist es)([,.!…:\s]+|$)/i;
  let t = text.trim();
  for (let prev = ''; prev !== t && prefix.test(t) && t.replace(prefix, '').trim(); ) {
    prev = t;
    t = t.replace(prefix, '').trim();
  }
  t = t.replace(/[.!…]+$/, '').trim();
  return STALLING.test(t.toLowerCase().replace(/[,.!?…]/g, '').trim()) ? '' : t;
}

/** A speakable short version of a chat message: first lines, no markdown, max ~280 chars. */
function briefSpeech(text: string): string {
  const s = forSpeech(text.split('\n').slice(0, 3).join('\n'));
  if (s.length <= 280) return s;
  const cut = s.slice(0, 280);
  return cut.slice(0, Math.max(cut.lastIndexOf('. '), 120)) + '.';
}

/** Waits for `p` at most `ms`; true if it settled in time. Never rejects. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => (t = setTimeout(() => r(false), ms))),
  ]).finally(() => clearTimeout(t));
}

const REFUSED = new Set([400, 401, 403]);

/** Where the current loss was seen: the latest lost check, else the latest refused renewal or logout of the page. */
function lossSource(s: LoginStatus): string {
  const check = [...s.history].reverse().find((c) => c.result === 'lost');
  const auth = [...s.authHistory].reverse().find((a) => (a.kind === 'refresh' && REFUSED.has(a.status)) || a.kind === 'logout');
  if (check && (!auth || check.at >= auth.at)) return check.source;
  return auth?.source ?? 'unbekannt';
}

/**
 * The loss DM: when and where it was noticed, the command to log in again, what still works. Only times, sources,
 * status codes and Supabase error codes – never game content, solutions, editor links or URLs (rule 5).
 */
export function lossText(s: LoginStatus, source: string, loginCommand: string, prefix: string, now = Date.now()): string {
  const refresh = [...s.authHistory].reverse().find((a) => a.kind === 'refresh');
  const why = refresh && REFUSED.has(refresh.status) ? `, Grund: Erneuerung abgelehnt (${refresh.status}${refresh.code ? ` ${refresh.code}` : ''})` : '';
  return [
    `⚠️ **quiz-base-Anmeldung verloren** (bemerkt ${when(s.lostAt ?? now, now)} · ${loginSourceLabel(source)}).`,
    `Eigene Boards (\`${prefix} neu <eigenes Board>\`, \`${prefix} erstellen … anlegen\`) gehen erst nach einer neuen Anmeldung: \`${loginCommand}\``,
    `Öffentliche Boards gehen weiter. Zuletzt angemeldet: ${s.lastOkAt ? when(s.lastOkAt, now) : 'unbekannt'}${why}.`,
    'Anleitung: docs/DEPLOY.md → „quiz-base-Anmeldung auf dem Server“.',
  ].join('\n');
}
