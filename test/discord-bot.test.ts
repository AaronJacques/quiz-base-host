import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { rankingLines } from '../src/discord/format.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
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
  page = new FakeTafelquizPage(
    ['Anna', 'Ben'],
    [
      [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
      [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine' }],
    ],
  );
  private ac = new AbortController();
  board = '';
  constructor(private config: Config) {
    this.rules = { ...config.game };
    // Like GameSession: operator point corrections go straight to the page.
    this.bus.on('operator:command', ({ command, args }) => {
      if (command === 'punkte') void this.page.award(args.slice(0, -1).join(' '), Number(args.at(-1)));
    });
  }
  async createLobby(board: string) {
    this.board = board;
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

function setup(discord: Record<string, unknown> = {}, game: Record<string, unknown> = {}) {
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
    createSession: (cfg) => (session = new FakeSession(cfg)),
    listBoards: async (q?: string) => {
      searches.push(q ?? '');
      const all = ['Test Board', 'Anderes Board', 'Allgemeinwissen Quiz v1', 'Allgemeinwissen Quiz v2', 'Dragon Ball Quiz'];
      return q ? all.filter((t) => t.toLowerCase().includes(q.toLowerCase())) : all.slice(0, 4);
    },
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
