import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
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
  constructor(private config: Config) {
    this.rules = { ...config.game };
  }
  async createLobby() {
    return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
  }
  async run() {
    const judge = createJudge(this.config, this.bus, null, this.meter);
    await new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: 20 }).run(this.ac.signal);
  }
  async endGame() {
    await this.page.endGame();
    this.ac.abort();
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

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbbot-'));
  const config = ConfigSchema.parse({
    game: { revealPauseSec: 0, answerTimeoutSec: 2, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, minPlayers: 2 },
    judge: { cacheFile: path.join(tmp, 'cache.json') },
    llm: { provider: 'none' },
    discord: { dataDir: tmp },
  });
  const gw = new FakeGateway();
  let session: FakeSession | null = null;
  const bot = new QuizBot({
    gateway: gw,
    config,
    store: new GuildStore(tmp),
    createSession: (cfg) => (session = new FakeSession(cfg)),
    listBoards: async () => ['Test Board', 'Anderes Board'],
  });
  return { gw, bot, session: () => session!, config };
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
