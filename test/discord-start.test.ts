import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeeperProbe, LoginStatus } from '../src/account.ts';
import { QuizBaseBoardStudio, type BoardStudioOptions } from '../src/board-studio.ts';
import { buildBoard, type BoardOut } from '../src/boardgen/index.ts';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { SessionLike } from '../src/discord/bot.ts';
import { parseCreateArgs } from '../src/discord/create-parser.ts';
import type { ChatMessage } from '../src/discord/gateway.ts';
import { startDiscordBot, type BotGateway, type DiscordBotOptions, type RunningBot } from '../src/discord/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import type { GameSessionOptions } from '../src/session.ts';

/**
 * The real start path of `qbhost discord` (`startDiscordBot`) – keeper, bot, sessions, board studio and shutdown
 * wired as in production. Only Discord, the browser and process signals are replaced (review V4, A2-F1).
 */

setLogLevel('error');

class StartGateway implements BotGateway {
  botUserId = 'bot';
  sent: string[] = [];
  dmTo: { userId: string; text: string }[] = [];
  calls: string[] = [];
  failLogin = false;
  private handler?: (m: ChatMessage) => void | Promise<void>;
  onMessage(h: (m: ChatMessage) => void | Promise<void>) {
    this.handler = h;
  }
  async login() {
    this.calls.push('login');
    if (this.failLogin) throw new Error('Discord-Token ungültig');
  }
  async destroy() {
    this.calls.push('gateway.destroy');
  }
  async send(_c: string, text: string) {
    this.sent.push(text);
  }
  async sendDirect(userId: string, text: string) {
    this.dmTo.push({ userId, text });
  }
  async react() {}
  private n = 0;
  async write(content: string, user = { id: 'u-admin', name: 'Chefin' }) {
    await this.handler!({
      id: String(++this.n), channelId: 'chan', guildId: 'guild',
      author: { id: user.id, username: user.name.toLowerCase(), displayName: user.name, isBot: false },
      content, mentionsBot: false, mentions: [], canManage: true,
    });
  }
  all() {
    return this.sent.join('\n---\n');
  }
}

/** A lobby that stays open until it is ended or closed. */
class LobbySession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  log: string[] = [];
  private done!: () => void;
  private finished = new Promise<void>((r) => (this.done = r));
  constructor(config: Config) {
    this.rules = { ...config.game };
  }
  async createLobby() {
    this.log.push('createLobby');
    return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
  }
  run() {
    return this.finished;
  }
  async endGame() {
    this.log.push('endGame');
    this.done();
  }
  async close() {
    this.log.push('close');
    this.done();
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const started: RunningBot[] = [];
let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of stops) await s().catch(() => {});
  stops = [];
  for (const r of started) r.keeper.stop().catch(() => {});
  started.length = 0;
  setLogLevel('error');
});

function seed(file: string, s: Partial<LoginStatus>) {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(file, JSON.stringify({
    version: 1, state: 'unknown', okSince: null, lastOkAt: null, lostAt: null, notifiedLostAt: null, lastCheckAt: null, nextDueAt: null, lastAuth: null,
    history: [{ at, source: 'keepalive', result: 'lost', ms: 9000 }], authHistory: [], ...s,
  }));
}

async function start(account: Record<string, unknown> = {}, extra: DiscordBotOptions = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbstart-'));
  const statusFile = path.join(tmp, 'login-status.json');
  const { seed: seeded, ...accountCfg } = account as { seed?: Partial<LoginStatus> };
  if (seeded) seed(statusFile, seeded);
  const config = ConfigSchema.parse({
    voice: { enabled: false },
    llm: { provider: 'none' },
    boardgen: { dir: path.join(tmp, 'boards'), provider: 'claude-cli' },
    judge: { cacheFile: path.join(tmp, 'cache.json') },
    browser: { profileDir: path.join(tmp, 'profile') },
    discord: { dataDir: path.join(tmp, 'discord'), ownerIds: ['owner1'] },
    account: { statusFile, startCheckDelaySec: 3600, loginCommand: 'npx qbhost login --server testhost', ...accountCfg },
  });
  const gw = new StartGateway();
  const probes: string[] = [];
  let probeResult: boolean | null = true;
  const openProbe = async (): Promise<KeeperProbe> => {
    probes.push('open');
    return { loginState: async () => probeResult, close: async () => 0 };
  };
  const sessions: { session: LobbySession; opts: GameSessionOptions }[] = [];
  let boardOpts: BoardStudioOptions | null = null;
  let studio: QuizBaseBoardStudio | null = null;
  let stop: (() => Promise<void>) | null = null;
  let forceClose: (() => Promise<unknown>) | null = null;
  const closeBrowsers = vi.fn(async (_ms: number) => {
    gw.calls.push(`closeBrowsers:${_ms}`);
    return 0;
  });
  const running = await startDiscordBot(config, {
    gateway: gw,
    token: 'test-token-123456',
    processHandlers: false,
    listBoards: async (q?: string) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
    keeperDeps: { openProbe },
    createSession: (cfg, opts) => {
      const session = new LobbySession(cfg);
      sessions.push({ session, opts });
      return session;
    },
    createBoards: (cfg, opts) => {
      boardOpts = opts;
      return (studio = new QuizBaseBoardStudio(cfg, opts));
    },
    closeBrowsers,
    onStop: (fn, o) => {
      stop = async () => void (await fn());
      forceClose = o?.beforeForceExit ?? null;
      return () => {};
    },
    exit: vi.fn(),
    ...extra,
  });
  started.push(running);
  stops.push(() => (stop ? stop() : Promise.resolve()));
  const r = {
    ...running, gw, config, statusFile, probes, sessions, closeBrowsers,
    setProbe: (v: boolean | null) => (probeResult = v),
    boardOpts: () => boardOpts!,
    studio: () => studio!,
    stop: async () => {
      const s = stop!;
      stop = null;
      await s();
    },
    forceClose: () => forceClose!(),
  };
  return r;
}

/** Captures info/warn lines (stderr) while `fn` runs. */
async function logged(fn: () => Promise<void>): Promise<string> {
  let out = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  setLogLevel('info');
  try {
    await fn();
  } finally {
    spy.mockRestore();
    setLogLevel('error');
  }
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('startDiscordBot: Verdrahtung des Anmeldewächters (A2-F1)', () => {
  it('startet den Wächter nach dem Login: Log, nextDueAt in der Status-Datei', async () => {
    let r!: Awaited<ReturnType<typeof start>>;
    const out = await logged(async () => void (r = await start()));
    expect(r.gw.calls[0]).toBe('login');
    expect(out).toContain('🔐 Anmeldewächter an: erste Prüfung in 3600 s, dann alle 6 h im Leerlauf');
    const s = JSON.parse(readFileSync(r.statusFile, 'utf8')) as LoginStatus;
    expect(Date.parse(s.nextDueAt!) - Date.now()).toBeGreaterThan(3_500_000);
  });

  it('Start-Prüfung nur im Leerlauf: ein Spiel unterbricht und verschiebt sie; nach dem Spiel prüft er (gameEnded); Verlust → DM', async () => {
    const r = await start({ startCheckDelaySec: 1, afterGameCheckSec: 1, holdSec: 5 });
    const interrupt = vi.spyOn(r.keeper, 'interrupt');
    r.setProbe(false);
    // Game before the start check: the keeper must not open the profile while it runs.
    await r.gw.write('!quiz neu 1');
    expect(interrupt).toHaveBeenCalledWith('Spiel startet');
    await until(() => r.bot.activeGame?.phase === 'lobby');
    await sleep(2500);
    expect(r.probes).toHaveLength(0);
    await r.gw.write('!quiz ende');
    await until(() => !r.bot.activeGame);
    await until(() => r.probes.length === 1, 4000); // after-game check, once idle
    await until(() => r.gw.dmTo.length === 1, 8000); // after holdSec (the page may still renew)
    expect(r.gw.dmTo[0]!.userId).toBe('owner1');
    expect(r.gw.dmTo[0]!.text).toContain('`npx qbhost login --server testhost`');
  }, 20000);

  it('Spiel und Board-Anlage melden ihre Anmeldung an den Wächter (authWatch + report)', async () => {
    const r = await start();
    await r.gw.write('!quiz neu 1');
    await until(() => r.sessions.length === 1);
    const { opts } = r.sessions[0]!;
    expect(opts.auth?.match('https://ref.supabase.co/auth/v1/token?grant_type=refresh_token')).toBe(true);
    opts.onLogin!(true, 'lobby');
    expect(r.keeper.status().state).toBe('ok');
    r.boardOpts().onLogin!(false, 'board-create');
    expect(r.keeper.status().state).toBe('lost');
    expect(r.keeper.status().history.at(-1)!.source).toBe('board-create');
    await until(() => r.gw.dmTo.length === 1);
    expect(r.boardOpts().auth?.match('https://ref.supabase.co/auth/v1/user')).toBe(true);
  });

  it('meldet beim Start einen Verlust, der noch nicht gemeldet war (genau eine DM), einen gemeldeten nicht', async () => {
    const lost = { state: 'lost' as const, lostAt: new Date(Date.now() - 3_600_000).toISOString() };
    const r = await start({ seed: { ...lost, notifiedLostAt: null } });
    await until(() => r.gw.dmTo.length === 1);
    expect(r.gw.dmTo[0]!.text).toContain('quiz-base-Anmeldung verloren');
    await until(() => r.keeper.status().notifiedLostAt !== null);
    const r2 = await start({ seed: { ...lost, notifiedLostAt: new Date().toISOString() } });
    await sleep(100);
    expect(r2.gw.dmTo).toHaveLength(0);
  });

  it('Stopp-Signal: Herunterfahren in Reihenfolge (neue Lobbys sperren → Wächter → Spiel → Browser → Discord), loggt die Dauer; zweites Signal schließt die Browser', async () => {
    const r = await start();
    await r.gw.write('!quiz neu 1');
    await until(() => r.bot.activeGame?.phase === 'lobby');
    // Spies call through; the call order is compared across them.
    const spies = {
      beginShutdown: vi.spyOn(r.bot, 'beginShutdown'),
      keeperStop: vi.spyOn(r.keeper, 'stop'),
      botShutdown: vi.spyOn(r.bot, 'shutdown'),
      closeBrowsers: r.closeBrowsers,
      destroy: vi.spyOn(r.gw, 'destroy'),
    };
    r.closeBrowsers.mockClear();
    let resolved = false;
    void r.stopped.then(() => (resolved = true));
    const session = r.sessions[0]!.session;
    const out = await logged(() => r.stop());
    const order = Object.entries(spies)
      .map(([name, spy]) => ({ name, at: spy.mock.invocationCallOrder[0] ?? Infinity }))
      .sort((a, b) => a.at - b.at)
      .map((e) => e.name);
    expect(order).toEqual(['beginShutdown', 'keeperStop', 'botShutdown', 'closeBrowsers', 'destroy']);
    expect(r.closeBrowsers).toHaveBeenCalledWith(7000);
    expect(session.log).toEqual(expect.arrayContaining(['endGame', 'close']));
    expect(out).toMatch(/Heruntergefahren in \d+,\d s/);
    await until(() => resolved);
    await r.forceClose();
    expect(r.closeBrowsers).toHaveBeenLastCalledWith(3000);
  });

  it('Login scheitert: Wächter gestoppt, Browser geschlossen, Fehler weitergereicht', async () => {
    const gw = new StartGateway();
    gw.failLogin = true;
    const closeBrowsers = vi.fn(async () => 0);
    await expect(start({}, { gateway: gw, closeBrowsers })).rejects.toThrow('Discord-Token ungültig');
    expect(closeBrowsers).toHaveBeenCalledWith(3000);
  });
});

describe('Herunterfahren: keine neuen Lobbys und Boards (A2-F2)', () => {
  it('!quiz neu, eine Menü-Antwort und !quiz erstellen werden abgelehnt, sobald das Herunterfahren begonnen hat', async () => {
    const r = await start();
    await r.gw.write('!quiz neu'); // menu is open
    r.bot.beginShutdown();
    r.gw.sent = [];
    await r.gw.write('1'); // menu answer (menu closed by beginShutdown → ignored)
    await r.gw.write('!quiz neu 1');
    await r.gw.write('!quiz erstellen Weltraum 2x2');
    expect(r.sessions).toHaveLength(0);
    expect(r.gw.all().match(/Der Quiz-Host fährt gerade herunter/g)).toHaveLength(2);
    expect(r.gw.all()).not.toContain('Neues Board erzeugen?');
  });

  it('eine offene Board-Anfrage („ja“) und ein Entwurf („anlegen“) starten nichts mehr', async () => {
    const r = await start();
    const studio = r.studio();
    const create = vi.spyOn(studio, 'create');
    const generate = vi.spyOn(studio, 'generate');
    // A stored draft for "Weltraum 2x2" → "erstellen" offers it (confirm-create), "Mond 2x2" asks for "ja".
    const { spec } = parseCreateArgs('Weltraum 2x2', studio.defaults(''));
    const out: BoardOut = {
      title: 'Weltraum Quiz', description: 'Test', supercategories: ['Weltraum'],
      categories: Array.from({ length: spec.categories * spec.boards }, (_, c) => ({
        name: `Rubrik${c + 1}`,
        questions: Array.from({ length: spec.rows }, (_, q) => ({ question: `Frage ${c}/${q}?`, answer: `Lösung${c}${q}`, variants: [], wrongOptions: [], difficulty: q + 1 })),
      })),
    };
    studio.store.saveDraft(buildBoard(out, spec, { model: 'sonnet', costUsd: 0.08, calls: 2, reviewed: [], warnings: [] }));
    await r.gw.write('!quiz erstellen Weltraum 2x2');
    await until(() => r.gw.all().includes('Schreib `anlegen`'));
    await r.gw.write('!quiz erstellen Mond 2x2', { id: 'u-other', name: 'Zweite' });
    await until(() => r.gw.all().includes('Neues Board erzeugen?'));
    r.bot.beginShutdown();
    r.gw.sent = [];
    await r.gw.write('anlegen');
    await r.gw.write('ja', { id: 'u-other', name: 'Zweite' });
    await until(() => (r.gw.all().match(/Der Quiz-Host fährt gerade herunter/g) ?? []).length === 2);
    expect(create).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
