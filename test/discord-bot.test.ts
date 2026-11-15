import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type BotDeps, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { rankingLines } from '../src/discord/format.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import type { Pcm } from '../src/voice/audio.ts';
import type { Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import type { BoardStudio } from '../src/board-studio.ts';
import { BoardStore, buildBoard, defaultSpec, fingerprint, type BoardOut, type BoardSpec, type CostEstimate } from '../src/boardgen/index.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel('error');

class FakeGateway implements ChatGateway {
  botUserId = 'bot';
  sent: string[] = [];
  dms: string[] = [];
  reactions: string[] = [];
  private handler?: (m: ChatMessage) => void | Promise<void>;
  onMessage(h: (m: ChatMessage) => void | Promise<void>) {
    this.handler = h;
  }
  async send(_c: string, text: string) {
    this.sent.push(text);
  }
  async sendDirect(_u: string, text: string) {
    this.dms.push(text);
  }
  async react(_m: ChatMessage, emoji: string) {
    this.reactions.push(emoji);
  }
  private n = 0;
  async write(user: { id: string; name: string; admin?: boolean }, content: string, extra: Partial<ChatMessage> = {}) {
    await this.handler!({
      id: String(++this.n), channelId: 'chan', guildId: 'guild',
      author: { id: user.id, username: user.name.toLowerCase(), displayName: user.name, isBot: false },
      content, mentionsBot: false, mentions: [], canManage: !!user.admin, ...extra,
    });
  }
  all() {
    return this.sent.join('\n---\n');
  }
}

/** Real controller + fake quiz-base page behind the SessionLike interface. */
class FakeSession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  page: FakeTafelquizPage;
  private ac = new AbortController();
  board = '';
  lobbyOpts: { own?: boolean } | undefined;
  constructor(
    private config: Config,
    names: string[] = ['Anna', 'Ben'],
  ) {
    this.page = new FakeTafelquizPage(
      names,
      [
        [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
        [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine' }],
      ],
    );
    this.rules = { ...config.game };
    // Like GameSession: operator point corrections go straight to the page.
    this.bus.on('operator:command', ({ command, args }) => {
      if (command === 'punkte') void this.page.award(args.slice(0, -1).join(' '), Number(args.at(-1)));
    });
  }
  async createLobby(board: string, opts?: { own?: boolean }) {
    this.board = board;
    this.lobbyOpts = opts;
    return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
  }
  async run() {
    const judge = createJudge(this.config, this.bus, null, this.meter);
    await new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: 20 }).run(this.ac.signal);
  }
  async endGame() {
    this.ac.abort(); // like GameSession: stop the controller first, then end on the page
    await this.page.endGame();
  }
  async close() {
    this.ac.abort();
  }
}

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

function setup(discord: Record<string, unknown> = {}, game: Record<string, unknown> = {}, players?: string[], extra: Partial<BotDeps> = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbbot-'));
  const config = ConfigSchema.parse({
    game: { revealPauseSec: 0, answerTimeoutSec: 2, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, minPlayers: 2, ...game },
    judge: { cacheFile: path.join(tmp, 'cache.json') },
    llm: { provider: 'none' },
    discord: { dataDir: tmp, ...discord },
  });
  const gw = new FakeGateway();
  let session: FakeSession | null = null;
  const searches: string[] = [];
  const bot = new QuizBot({
    gateway: gw,
    config,
    store: new GuildStore(tmp),
    createSession: (cfg) => (session = new FakeSession(cfg, players)),
    listBoards: async (q?: string) => {
      searches.push(q ?? '');
      const all = ['Test Board', 'Anderes Board', 'Allgemeinwissen Quiz v1', 'Allgemeinwissen Quiz v2', 'Dragon Ball Quiz'];
      return q ? all.filter((t) => t.toLowerCase().includes(q.toLowerCase())) : all.slice(0, 4);
    },
    ...extra,
  });
  return { gw, bot, session: () => session!, created: () => session, searches, config };
}

const anna = { id: 'u-anna', name: 'Anna' };
const ben = { id: 'u-ben', name: 'Benni' };

describe('QuizBot', () => {
  it('runs a whole game from Discord: lobby → link → pick (incl. "schon weg") → answers → result', async () => {
    const { gw, bot, session } = setup();

    await gw.write(anna, '!quiz neu 1');
    await until(() => gw.all().includes('join?code=ABC123'));
    expect(gw.all()).toContain('Test Board');

    // Anna is auto-linked by display name; Benni links himself to "ben" (case-insensitive).
    await gw.write(ben, '!quiz ich ben');
    await until(() => gw.all().includes("Los geht's"));
    expect(gw.all()).toContain('Automatisch verknüpft');
    expect(gw.all()).toContain('<@u-ben> = **Ben**');

    // Anna's turn → she picks via chat.
    await until(() => !!bot.activeGame?.turn && !bot.activeGame.questionOpen);
    await gw.write(ben, 'Sport 100'); // not his turn
    await until(() => gw.all().includes('Gerade ist **Anna** am Zug'));
    await gw.write(anna, 'sport 100');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(anna, 'zehn');
    await until(() => gw.all().includes('„zehn“ ist richtig'));

    // Ben's turn: the taken card is rejected, the free one accepted.
    await until(() => bot.activeGame?.turn?.player === 'Ben' && !bot.activeGame.questionOpen);
    await gw.write(ben, 'Sport 100');
    await until(() => gw.all().includes('**Sport 100** ist schon weg'));
    await gw.write(ben, 'film 200');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(ben, 'tatooine');

    await until(() => gw.all().includes('Spiel vorbei'), 8000);
    expect(session().page.players.find((p) => p.name === 'Anna')!.score).toBe(100);
    expect(session().page.players.find((p) => p.name === 'Ben')!.score).toBe(200);
    expect(gw.all()).toMatch(/🥇 <@u-ben> \(\*\*Ben\*\*\) — \*\*200\*\*/);
    await until(() => bot.activeGame === null);
  }, 20000);

  // Live 12.11.2026: the user played "Schulwissen 1. - 12. Klasse" alone. With minPlayers 2 nothing started
  // automatically – fine – but the documented "!quiz los" (force start) was ignored by the controller as well.
  it('plays alone: "!quiz los" starts below minPlayers, quiz-base ends the game itself, negative final score', async () => {
    const aaron = { id: 'u-aaron', name: 'Aaron' };
    const { gw, bot, session } = setup({}, {}, ['Aaron']);
    await gw.write(aaron, '!quiz neu 1');
    await until(() => gw.all().includes('join?code=ABC123'));
    session().page.autoResults = true;
    await until(() => gw.all().includes('1/1 bereit'));
    await new Promise((r) => setTimeout(r, 200));
    expect(gw.all()).not.toContain("Los geht's"); // one player < minPlayers → no automatic start …
    await until(() => gw.all().includes('`!quiz los` geht es trotzdem los')); // … but the bot says how to start

    await gw.write(aaron, '!quiz los');
    await until(() => gw.all().includes("Los geht's"));
    await until(() => !!bot.activeGame?.turn && !bot.activeGame.questionOpen);
    await gw.write(aaron, 'Sport 100');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(aaron, 'keine Ahnung');
    await until(() => gw.all().includes('„keine Ahnung“ ist falsch'));
    // Always the same player's turn; no buzzer round without anybody else.
    await until(() => bot.activeGame?.turn?.player === 'Aaron' && bot.activeGame.turn.open.length === 1 && !bot.activeGame.questionOpen);
    expect(gw.all()).not.toContain('Buzzer frei');
    await gw.write(aaron, 'Film 200');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(aaron, 'weiß nicht');

    await until(() => gw.all().includes('Spiel vorbei'), 8000);
    expect(session().page.log).not.toContain('endGame'); // quiz-base ended it, nobody clicked "Spiel beenden"
    expect(gw.all()).toMatch(/🏁 \*\*Spiel vorbei!\*\*\n🥇 <@u-aaron> \(\*\*Aaron\*\*\) — \*\*-150\*\*/);
    await until(() => bot.activeGame === null);
    expect(gw.all().match(/Spiel vorbei|Spiel beendet/g)).toHaveLength(1);
  }, 20000);

  it('lets players change the scoring rules via chat and applies them', async () => {
    const { gw, bot, session } = setup();
    await gw.write(anna, '!quiz regel minus 0');
    expect(gw.all()).toContain('Abzug für falsche Antwort: **kein Abzug**');
    await gw.write(anna, '!quiz regel plus 50%');
    await gw.write(anna, '!quiz regel buzzer aus');
    await gw.write(anna, '!quiz regeln');
    expect(gw.all()).toContain('+50 %');

    await gw.write(anna, '!quiz neu Test Board');
    await gw.write(ben, '!quiz ich Ben');
    await until(() => !!bot.activeGame?.turn);
    expect(session().rules.correctFactor).toBe(0.5);
    expect(session().rules.wrongFactor).toBe(0);

    await gw.write(anna, 'Sport 100');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(anna, '7'); // wrong number → no penalty
    await until(() => bot.activeGame?.turn?.player === 'Ben' && !bot.activeGame.questionOpen);
    expect(session().page.players.find((p) => p.name === 'Anna')!.score).toBe(0);

    await gw.write(ben, 'Film 200');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(ben, 'Tatooine');
    await until(() => gw.all().includes('Spiel vorbei'), 8000);
    expect(session().page.players.find((p) => p.name === 'Ben')!.score).toBe(100); // 50 % of 200
  }, 20000);

  it('restricts leader commands and works via @mention', async () => {
    const { gw, bot } = setup();
    await gw.write(anna, 'neu 1', { mentionsBot: true });
    await until(() => gw.all().includes('join?code=ABC123'));
    await gw.write(ben, '!quiz ende');
    expect(gw.all()).toContain('nur die Spielleitung');
    await gw.write({ ...ben, admin: true }, '!quiz ende');
    await until(() => bot.activeGame === null);
  }, 10000);

  it('ignores chatter and unknown users, answers help', async () => {
    const { gw } = setup();
    await gw.write(anna, 'hallo zusammen');
    expect(gw.sent).toHaveLength(0);
    await gw.write(anna, '', { mentionsBot: true });
    expect(gw.all()).toContain('Befehle');
  });
});

describe('QuizBot channel restriction', () => {
  it('ignores prefix and @mentions outside the configured channels', async () => {
    const { gw } = setup({ channelIds: ['chan'] });
    await gw.write(anna, '!quiz hilfe', { channelId: 'other' });
    await gw.write(anna, 'hilfe', { channelId: 'other', mentionsBot: true });
    expect(gw.sent).toHaveLength(0);
    await gw.write(anna, '!quiz hilfe');
    expect(gw.all()).toContain('Befehle');
  });
});

describe('QuizBot board choice', () => {
  it('asks which quiz when none is named and takes the answer of the asker only', async () => {
    const { gw, bot, session, created } = setup();
    await gw.write(anna, '!quiz neu');
    expect(gw.all()).toContain('welches Quiz');
    expect(created()).toBeNull();
    await gw.write(ben, 'Test Board'); // not asked
    expect(created()).toBeNull();
    await gw.write(anna, 'dragon');
    await until(() => !!bot.activeGame?.lobby);
    expect(session().board).toBe('Dragon Ball Quiz');
    expect(gw.all()).toContain('join?code=ABC123');
  });

  it('asks back when several boards match and accepts a number', async () => {
    const { gw, bot, session, created } = setup();
    await gw.write(anna, '!quiz neu allgemeinwissen');
    expect(gw.all()).toContain('passen 2 Boards');
    expect(created()).toBeNull();
    await gw.write(anna, '2');
    await until(() => !!bot.activeGame?.lobby);
    expect(session().board).toBe('Allgemeinwissen Quiz v2');
  });

  it('takes an exact title directly even if it is part of other titles', async () => {
    const { gw, bot, session } = setup();
    await gw.write(anna, '!quiz neu Allgemeinwissen Quiz v1');
    await until(() => !!bot.activeGame?.lobby);
    expect(session().board).toBe('Allgemeinwissen Quiz v1');
  });

  it('suggests close titles when the search finds nothing, and can be cancelled', async () => {
    const { gw, created, searches } = setup();
    await gw.write(anna, '!quiz neu Allgemeinwisen Quiz v1');
    expect(searches).toContain('Allgemeinwisen Quiz v1');
    expect(gw.all()).toContain('Meintest du');
    expect(gw.all()).toContain('Allgemeinwissen Quiz v1');
    await gw.write(anna, 'abbrechen');
    expect(gw.all()).toContain('keine neue Lobby');
    await gw.write(anna, '1');
    expect(created()).toBeNull();
  });

  it('uses the numbers of the last shown list', async () => {
    const { gw, bot, session } = setup();
    await gw.write(anna, '!quiz boards board');
    expect(gw.all()).toContain('`2` Anderes Board');
    await gw.write(anna, '!quiz neu 2');
    await until(() => !!bot.activeGame?.lobby);
    expect(session().board).toBe('Anderes Board');
  });
});

describe('QuizBot secrecy', () => {
  it('never posts LLM reasons before the reveal', async () => {
    const { gw, bot } = setup();
    await gw.write(anna, '!quiz neu 1');
    await gw.write(ben, '!quiz ich Ben');
    await until(() => !!bot.activeGame?.turn);
    const bus = (bot.activeGame as any).session.bus;
    bus.emit('host:verdict', { player: 'Anna', answer: 'Mario', correct: false, delta: -50, reason: 'Lösung wäre Luigi' });
    await new Promise((r) => setTimeout(r, 800));
    expect(gw.all()).not.toContain('Luigi');
    bus.emit('host:reveal', { answer: 'Luigi Mario' });
    await until(() => gw.all().includes('Lösung wäre Luigi'));
    await gw.write(anna, '!quiz ende');
    await until(() => bot.activeGame === null);
  }, 10000);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const score = (s: FakeSession, name: string) => s.page.players.find((p) => p.name === name)!.score;

async function startGame(gw: FakeGateway, bot: QuizBot) {
  await gw.write(anna, '!quiz neu 1');
  await gw.write(ben, '!quiz ich Ben');
  await until(() => !!bot.activeGame?.turn && !bot.activeGame.questionOpen);
}

describe('QuizBot – ending mid-question (F6)', () => {
  it('posts no verdict and clicks nothing on the page after "!quiz ende"', async () => {
    const { gw, bot, session } = setup({}, { answerTimeoutSec: 10 });
    await startGame(gw, bot);
    await gw.write(anna, 'sport 100');
    await until(() => !!bot.activeGame?.awaiting);
    const clicks = session().page.log.length;
    await gw.write(anna, '!quiz ende');
    await until(() => bot.activeGame === null);
    await sleep(300);
    expect(gw.all()).not.toContain('(keine Antwort)');
    expect(gw.all()).not.toContain('Lösung');
    expect(session().page.log.slice(clicks)).toEqual(['endGame']);
    expect(score(session(), 'Anna')).toBe(0);
    expect(gw.all().match(/🥇/g)).toHaveLength(2); // F24: a 0:0 tie has two winners
  }, 15000);
});

describe('QuizBot – servers (F7)', () => {
  it('grants leader rights only on the server of the running game', async () => {
    const { gw, bot, session } = setup();
    await startGame(gw, bot);
    const mallory = { id: 'u-mallory', name: 'Mallory', admin: true };
    const elsewhere = { guildId: 'other-guild', channelId: 'other-chan' };
    await gw.write(mallory, '!quiz regel zeit 5', elsewhere);
    await gw.write(mallory, '!quiz ende', elsewhere);
    await gw.write(mallory, '!quiz korrektur Anna +500', elsewhere);
    await gw.write(mallory, '!quiz neu 1', elsewhere);
    await sleep(300);
    expect(session().rules.answerTimeoutSec).toBe(2);
    expect(bot.activeGame).not.toBeNull();
    expect(score(session(), 'Anna')).toBe(0);
    expect(gw.all()).toContain('auf einem anderen Server');
    await gw.write({ ...ben, admin: true }, '!quiz ende'); // an admin of the game's own server may
    await until(() => bot.activeGame === null);
  }, 15000);
});

describe('QuizBot – overruling after the verdict (F12)', () => {
  it('corrects the points of the last verdict until the next card, and says so honestly otherwise', async () => {
    const { gw, bot, session } = setup({}, { buzzWindowSec: 10, answerTimeoutSec: 5 });
    await startGame(gw, bot);
    await gw.write(anna, '!quiz richtig'); // nothing judged yet
    expect(gw.all()).toContain('keine Bewertung zum Überstimmen');
    expect(gw.reactions).not.toContain('👍');

    await gw.write(anna, 'sport 100');
    await until(() => !!bot.activeGame?.awaiting);
    await gw.write(anna, 'zwölf');
    await until(() => !!bot.activeGame?.buzzerOpen);
    expect(score(session(), 'Anna')).toBe(-50);
    const t0 = Date.now();
    await gw.write(anna, '!quiz richtig'); // the leader overrules during the buzzer window
    await until(() => gw.all().includes('Korrigiert'));
    await until(() => score(session(), 'Anna') === 100);
    // A solved question needs no buzzer round – it ends long before its 10 s.
    await until(() => bot.activeGame?.turn?.player === 'Ben' && !bot.activeGame.questionOpen, 5000);
    expect(Date.now() - t0).toBeLessThan(5000);

    // Still the same verdict until the next card is picked.
    await gw.write(anna, '!quiz falsch');
    await until(() => score(session(), 'Anna') === -50);
    await gw.write(ben, 'film 200');
    await until(() => !!bot.activeGame?.awaiting);
    expect(bot.activeGame?.lastVerdict).toBeNull(); // a new card: the old verdict can no longer be changed
    await gw.write(ben, 'Naboo'); // no LLM → the judge asks the leader
    await until(() => !!bot.activeGame?.operatorNeeded);
    await gw.write(anna, '!quiz falsch');
    await until(() => gw.all().includes('„Naboo“ ist falsch'));
    await until(() => !!bot.activeGame?.buzzerOpen);
    await gw.write(anna, '!quiz skip'); // ends the 10 s buzzer window at once
    await until(() => gw.all().includes('Buzzer-Runde beendet'));
    await until(() => gw.all().includes('Spiel vorbei'), 5000);
    expect(score(session(), 'Anna')).toBe(-50);
    expect(score(session(), 'Ben')).toBe(-100);
  }, 30000);
});

describe('QuizBot – rules reset (F18)', () => {
  it('"regeln reset" restores the adjustable rules but never autoStart from the config', async () => {
    const { gw, bot, session } = setup({}, { autoStart: true, answerTimeoutSec: 7 });
    await gw.write(anna, '!quiz neu 1'); // Ben stays unlinked → the bot must not start
    await until(() => !!bot.activeGame?.lobby);
    await gw.write(anna, '!quiz regel zeit 30');
    expect(session().rules.answerTimeoutSec).toBe(30);
    await gw.write(anna, '!quiz regeln reset');
    expect(session().rules.answerTimeoutSec).toBe(7);
    expect(session().rules.autoStart).toBe(false);
    expect(session().rules.publicBoard).toBeUndefined();
    await sleep(400);
    expect(session().page.phase).toBe('lobby');
    await gw.write(anna, '!quiz ende');
    await until(() => bot.activeGame === null);
  }, 10000);
});

describe('QuizBot – reveal and ranking', () => {
  it('shows the full note in the chat (F23) and gives tied players the same medal (F24)', async () => {
    const { gw, bot } = setup();
    await startGame(gw, bot);
    const bus = (bot.activeGame as unknown as { session: FakeSession }).session.bus;
    const note = '1. September 1939 - In Europa begann der Zweite Weltkrieg mit dem Überfall auf Polen.';
    bus.emit('host:reveal', { answer: note });
    await until(() => gw.all().includes(note));
    expect(rankingLines([{ name: 'A', score: 100 }, { name: 'B', score: 100 }, { name: 'C', score: 50 }])).toEqual(['🥇 **A** — **100**', '🥇 **B** — **100**', '🥉 **C** — **50**']);
    await gw.write(anna, '!quiz ende');
    await until(() => bot.activeGame === null);
  }, 10000);
});

// ───────────────────────────── !quiz erstellen (board generator) ─────────────────────────────

/** Board studio without LLM and browser: generates a fixed board, "creates" it in memory. */
class FakeStudio implements BoardStudio {
  generated = 0;
  created = 0;
  failCreate = false;
  store = new BoardStore(mkdtempSync(path.join(os.tmpdir(), 'qbboards-')));
  private cfg = ConfigSchema.parse({});
  unavailable() {
    return null;
  }
  defaults(topic: string) {
    return defaultSpec(this.cfg, topic);
  }
  estimate(): CostEstimate {
    return { usd: 0.1, calls: 2, model: 'claude-sonnet-5-5', viaSubscription: true };
  }
  existing(spec: BoardSpec) {
    return this.store.byFingerprint(fingerprint(spec));
  }
  async generate(spec: BoardSpec, onProgress?: (t: string) => void) {
    this.generated++;
    onProgress?.('🔎 Prüfrunde …');
    const out: BoardOut = {
      title: `${spec.topic} Quiz`,
      description: 'Ein Test.',
      supercategories: [spec.topic],
      categories: Array.from({ length: spec.categories * spec.boards }, (_, c) => ({
        name: `Rubrik${c + 1}`,
        questions: Array.from({ length: spec.rows }, (_, r) => ({
          question: `Geheimfrage ${c}/${r} über ${'abcdefgh'[c]} mit Stufe ${'wxyz'[r]}?`,
          answer: `Geheimlösung${c}${r}`,
          variants: [],
          wrongOptions: [],
          difficulty: r + 1,
        })),
      })),
    };
    const board = buildBoard(out, spec, { model: 'sonnet', costUsd: 0.08, calls: 2, reviewed: [], warnings: [] });
    return { board, record: this.store.saveDraft(board) };
  }
  load(id: string) {
    return this.store.load(id);
  }
  async create(id: string) {
    if (this.failCreate) throw new Error('Editor lädt nicht');
    this.created++;
    return this.store.markCreated(id, `https://www.quiz-base.de/profil/boards/edit/${id}?format=tafelquiz`);
  }
  findOwn(name: string) {
    return this.store.findCreated(name);
  }
}

const admin = { id: 'u-admin', name: 'Chefin', admin: true };

describe('QuizBot: !quiz erstellen', () => {
  function boardSetup(discord: Record<string, unknown> = {}) {
    const studio = new FakeStudio();
    return { ...setup(discord, {}, undefined, { boards: studio }), studio };
  }

  it('Rückfrage mit Kosten → ja → öffentliche Vorschau ohne Lösungen, DM mit Lösungen → anlegen → Link per DM', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum 2x2 profi');
    expect(gw.all()).toContain('Neues Board erzeugen?');
    expect(gw.all()).toContain('2 Kategorien × 2 Stufen');
    expect(gw.all()).toContain('Profis');
    expect(gw.all()).toContain('Claude-Abo');
    expect(studio.generated).toBe(0);

    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    expect(studio.generated).toBe(1);
    expect(gw.all()).toContain('Weltraum Quiz');
    expect(gw.all()).toContain('Rubrik1');
    // Never questions or solutions in the channel …
    expect(gw.all()).not.toMatch(/Geheimfrage|Geheimlösung/);
    // … but in the DM to the creator.
    expect(gw.dms.join('\n')).toContain('Geheimlösung00');
    expect(gw.dms.join('\n')).toContain('Geheimfrage 0/0');

    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));
    expect(studio.created).toBe(1);
    expect(gw.all()).toContain('`!quiz neu Weltraum Quiz`');
    expect(gw.all()).toContain('privater Entwurf');
    expect(gw.all()).toContain('Veröffentlichen kannst du selbst');
    expect(gw.all()).not.toMatch(/Geheimfrage|Geheimlösung/);
    // The editor link shows the solutions: DM only, never in the channel.
    expect(gw.all()).not.toContain('quiz-base.de/profil/boards/edit/');
    expect(gw.dms.join('\n')).toMatch(/https:\/\/www\.quiz-base\.de\/profil\/boards\/edit\/weltraum-quiz-/);
  });

  it('„öffentlich“: Hinweis, dass Boards als Entwurf gespeichert werden; nicht Teil des Themas', async () => {
    const { gw } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum öffentlich');
    expect(gw.all()).toContain('Thema: **Weltraum**');
    expect(gw.all()).toContain('Veröffentlichen kannst du selbst');
  });

  it('nur Server-Admins oder boardgen.creatorIds', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(anna, '!quiz erstellen Weltraum');
    expect(gw.all()).toContain('🔒');
    expect(studio.generated).toBe(0);
  });

  it('boardgen.creatorIds schaltet einzelne Nutzer frei', async () => {
    const studio = new FakeStudio();
    const { gw, bot } = setup({}, {}, undefined, { boards: studio });
    (bot as unknown as { d: BotDeps }).d.config.boardgen.creatorIds = [anna.id];
    await gw.write(anna, '!quiz erstellen Weltraum');
    expect(gw.all()).toContain('Neues Board erzeugen?');
  });

  it('nur die anfragende Person kann bestätigen', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum');
    await gw.write(anna, 'ja');
    expect(studio.generated).toBe(0);
  });

  it('gilt nur in den erlaubten Channels', async () => {
    const { gw, studio } = boardSetup({ channelIds: ['anderer-channel'] });
    await gw.write(admin, '!quiz erstellen Weltraum');
    expect(gw.sent).toEqual([]);
    expect(studio.generated).toBe(0);
  });

  it('dieselbe Anfrage legt kein zweites Board an; „nochmal“ erzwingt einen neuen Entwurf', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));

    gw.sent = [];
    await gw.write(admin, '!quiz erstellen  weltraum   2x2');
    expect(gw.all()).toContain('Das gleiche Board gibt es schon');
    expect(gw.all()).not.toContain('quiz-base.de/profil/boards/edit/');
    expect(gw.dms.at(-1)).toContain('quiz-base.de/profil/boards/edit/');
    expect(studio.generated).toBe(1);

    gw.sent = [];
    await gw.write(admin, '!quiz erstellen Weltraum 2x2 nochmal');
    expect(gw.all()).toContain('Neues Board erzeugen?');
  });

  it('doppeltes „anlegen“ legt nur einmal an', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    await Promise.all([gw.write(admin, 'anlegen'), gw.write(admin, 'anlegen')]);
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));
    expect(studio.created).toBe(1);
  });

  it('ein vorhandener Entwurf wird ohne neue Kosten wieder angeboten', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    await gw.write(admin, 'abbrechen');
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    expect(gw.all()).toContain('schon einen Entwurf');
    expect(studio.generated).toBe(1);
    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));
  });

  it('Fehler beim Anlegen: Entwurf bleibt, „anlegen“ versucht es erneut', async () => {
    const { gw, studio } = boardSetup();
    studio.failCreate = true;
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('Anlegen hat nicht geklappt'));
    studio.failCreate = false;
    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));
  });

  it('nicht während eines Spiels', async () => {
    const { gw, studio } = boardSetup();
    await gw.write(anna, '!quiz neu 1');
    await until(() => gw.all().includes('join?code=ABC123'));
    await gw.write(admin, '!quiz erstellen Weltraum');
    expect(gw.all()).toContain('Während ein Spiel läuft');
    expect(studio.generated).toBe(0);
  });

  it('ohne Thema: Hilfe zu den Optionen; „erstellen“ öffnet keine Lobby mehr', async () => {
    const { gw, created } = boardSetup();
    await gw.write(admin, '!quiz erstellen');
    expect(gw.all()).toContain('Board erzeugen:');
    expect(gw.all()).toContain('5x4');
    expect(created()).toBeNull();
  });

  it('!quiz neu <eigenes Board> startet die Lobby mit dem eigenen Board', async () => {
    const { gw, studio, session } = boardSetup();
    await gw.write(admin, '!quiz erstellen Weltraum 2x2');
    await gw.write(admin, 'ja');
    await until(() => gw.all().includes('Schreib `anlegen`'));
    await gw.write(admin, 'anlegen');
    await until(() => gw.all().includes('ist auf quiz-base angelegt'));
    await gw.write(anna, '!quiz neu weltraum quiz');
    await until(() => gw.all().includes('join?code=ABC123'));
    expect(session().board).toBe('Weltraum Quiz');
    expect(session().lobbyOpts).toEqual({ own: true });
    expect(studio.created).toBe(1);
  });
});

describe('QuizBot voice: ⏱ latency lines follow what the bot acts on (T1 review F1, F5, F6)', () => {
  /** Plays instantly and remembers what was said; no `onStart` → the play call counts as start. */
  class VoiceRoom implements VoiceTransport {
    label = 'room';
    played: string[] = [];
    private handlers: ((u: Utterance) => void)[] = [];
    constructor(private texts: Map<number, string>) {}
    async play(pcm: Pcm) {
      this.played.push(this.texts.get(pcm.samples[0]!) ?? '?');
    }
    stop() {}
    onUtterance(h: (u: Utterance) => void) {
      this.handlers.push(h);
    }
    onClose() {}
    async close() {}
    speak(speaker: Speaker, text: string) {
      const id = 1000 + this.texts.size;
      this.texts.set(id, text);
      const samples = new Int16Array(8000).fill(4000);
      samples[0] = id;
      const now = Date.now();
      for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
    }
  }

  it('answers and picks get a line and a reaction (the pick → the question read out); thinking aloud only counts; one summary per game', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbvoicelat-'));
    const config = ConfigSchema.parse({
      game: { revealPauseSec: 0, answerTimeoutSec: 5, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, minPlayers: 2 },
      judge: { cacheFile: path.join(tmp, 'cache.json'), strategy: 'fuzzy' },
      llm: { provider: 'none' },
      discord: { dataDir: tmp },
      voice: { ignoreWhileSpeaking: false },
    });
    const texts = new Map<number, string>();
    const room = new VoiceRoom(texts);
    const anna: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
    const ben: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };
    const voice: VoiceKit = {
      stt: { engine: 'whisper:test', transcribe: async (p) => texts.get(p.samples[0]!) ?? '', close: async () => {} },
      tts: {
        engine: 'piper:test',
        synth: async (text) => {
          const id = 1000 + texts.size;
          texts.set(id, text);
          return { rate: 16000, channels: 1, samples: Int16Array.from([id, 0, 0]) };
        },
        close: async () => {},
      },
      warmup: async () => {},
    };
    let handler: (m: ChatMessage) => Promise<void> | void = () => {};
    const gw: ChatGateway = {
      botUserId: 'bot',
      onMessage: (h) => (handler = h),
      send: async () => {},
      sendDirect: async () => {},
      react: async () => {},
      joinVoice: async () => room,
      voiceMembers: () => [anna, ben],
    };
    const type = (content: string) =>
      handler({ id: content, channelId: 'chan', guildId: 'guild', author: { ...anna, isBot: false }, content, mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc' });
    const bot = new QuizBot({
      gateway: gw,
      config,
      store: new GuildStore(tmp),
      createSession: (cfg) => new FakeSession(cfg),
      listBoards: async (q) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
      voice,
    });

    // The ⏱ lines go to the voice logger on info (stderr): collect them, drop other info noise, keep warnings.
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const s = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      const m = s.match(/\[voice\] (⏱ [^\n]*)/);
      if (m) lines.push(m[1]!);
      else if (/^\x1b\[3[13]m/.test(String(chunk))) write.call(process.stderr, chunk);
      return true;
    }) as typeof process.stderr.write;
    setLogLevel('info');
    const erkennung = () => lines.filter((l) => l.startsWith('⏱ erkennung'));
    try {
      await type('!quiz voice');
      await until(() => room.played.some((t) => t.includes('Quizmaster')));

      room.speak(anna, 'Quizmaster, neues Quiz Board');
      await until(() => room.played.some((t) => t.includes('Dazu passen 2 Boards')));
      room.speak(anna, 'Nummer eins');
      await until(() => !!bot.activeGame?.turn, 8000);
      expect(erkennung()).toHaveLength(2); // the command and the menu choice

      // Pick → its reaction is the question read out.
      const before = lines.length;
      room.speak(anna, 'Sport für hundert');
      await until(() => lines.slice(before).some((l) => l.startsWith('⏱ reaktion')));
      const question = room.played.find((t) => t.includes('Wie viele Pins'))!;
      const after = lines.slice(before);
      const r = after.findIndex((l) => l.startsWith('⏱ reaktion'));
      expect(after[r - 1]).toMatch(new RegExp(`^⏱ ansage engine=piper:test zeichen=${question.length} `));
      await until(() => !!bot.activeGame?.awaiting);

      // Thinking aloud: no line, no reaction.
      const n = lines.length;
      room.speak(anna, 'Ähm, zehn, oder?');
      await new Promise((res) => setTimeout(res, 300));
      expect(lines.length).toBe(n);

      room.speak(anna, 'Okay, meine Antwort ist zehn.');
      await until(() => room.played.includes('zehn?'));
      await until(() => lines.slice(n).some((l) => l.startsWith('⏱ reaktion')));
      expect(lines.slice(n)).toContainEqual(expect.stringMatching(/^⏱ ansage engine=piper:test zeichen=5 /)); // "zehn?"
      const said = room.played.length;
      room.speak(anna, 'Ja, genau.');
      await until(() => room.played.slice(said).some((t) => t.startsWith('Richtig')));
      expect(erkennung()).toHaveLength(5);

      await type('!quiz ende');
      await until(() => !bot.activeGame);
      await until(() => lines.some((l) => l.startsWith('⏱ bilanz')));
      await bot.shutdown(); // leaving the channel right after: no second summary
      const bilanz = lines.filter((l) => l.startsWith('⏱ bilanz'));
      expect(bilanz).toHaveLength(1);
      expect(bilanz[0]).toMatch(/^⏱ bilanz n=5 .* verworfen=1 rueckfaelle=0$/);
      for (const l of lines) expect(l).not.toMatch(/Anna|Ben|zehn|Pins|Sport|Board/);
    } finally {
      process.stderr.write = write;
      setLogLevel('error');
    }
  }, 30000);
});
