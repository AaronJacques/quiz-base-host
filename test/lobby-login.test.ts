// Lobby with an own board: a missing "Eigenes Board verwenden" counts as "logged out" only when the user menu says
// so (A1-F3), and GameSession reports what it saw (A1-F7d). Fake browser, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDriver } from '../src/browser/driver.ts';
import { ConfigSchema } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { NotLoggedInError, OwnBoardsUnavailableError } from '../src/site/errors.ts';
import { createLobbyWithOwnBoard } from '../src/site/lobby.ts';

setLogLevel('error');

// GameSession gets its browser from createDriver – here the fake below.
const fake = vi.hoisted(() => ({ driver: null as unknown }));
vi.mock('../src/browser/index.ts', () => ({ createDriver: () => fake.driver }));

/** What the fake page shows. `menu`: user menu says logged in (true), logged out (false), or no menu at all (null). */
interface Scene {
  button: boolean;
  menu: boolean | null;
  /** evaluate throws for the button check (navigation, crashed renderer). */
  buttonThrows?: boolean;
}

class FakeLobbyDriver implements BrowserDriver {
  readonly name = 'fake';
  calls: string[] = [];
  private menuOpen = false;
  constructor(public scene: Scene) {}
  async open(): Promise<void> {}
  async goto(url: string): Promise<void> {
    this.calls.push(`goto ${url}`);
  }
  async currentUrl(): Promise<string> {
    return 'https://www.quiz-base.de/create-lobby';
  }
  async screenshot(f: string): Promise<string> {
    return f;
  }
  async close(): Promise<void> {}
  async evaluate<T>(expr: string): Promise<T> {
    const r = (v: unknown) => v as T;
    // Editor probe (user menu).
    if (expr.endsWith('.toggleMenu()')) {
      if (this.scene.menu === null) return r({ ok: false, error: 'Benutzermenü fehlt' });
      this.menuOpen = !this.menuOpen;
      return r({ ok: true });
    }
    if (expr.endsWith('.account()')) {
      return r({ menuOpen: this.menuOpen, loggedIn: this.menuOpen ? this.scene.menu : null, labels: [] });
    }
    // Lobby wizard helpers.
    if (expr.includes(`clickButton('Eigenes Board verwenden').ok`)) {
      this.calls.push('own?');
      if (this.scene.buttonThrows) throw new Error('Execution context was destroyed');
      return r(this.scene.button);
    }
    if (expr.includes('boardTitles().includes(')) return r(true);
    if (expr.includes('clickButton("Tafelquiz", true)')) return r({ ok: true });
    if (expr.includes('heading()==="Tafelquiz"')) return r(true);
    if (expr.includes('boardTitles().some(')) return r(true);
    if (expr.includes('pickBoard(')) return r({ ok: true, title: 'Mein Board' });
    if (expr.includes(`clickButton('Board verwenden', true)`)) return r({ ok: true });
    if (expr.includes(`heading()==='Board Vorschau'`)) return r(true);
    if (expr.includes(`clickButton('Lobby erstellen')`)) return r({ ok: true });
    if (expr.includes(`heading()==='Lobby Warteraum'`)) return r(true);
    throw new Error(`unerwartet: ${expr.slice(-80)}`);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(p: Promise<T>): Promise<T | Error> {
  const out = p.catch((e: Error) => e);
  await vi.advanceTimersByTimeAsync(60_000);
  return out;
}

describe('createLobbyWithOwnBoard: missing button', () => {
  it('menu says logged out (twice) → NotLoggedInError', async () => {
    const err = await settle(createLobbyWithOwnBoard(new FakeLobbyDriver({ button: false, menu: false }), 'https://x', 'Mein Board'));
    expect(err).toBeInstanceOf(NotLoggedInError);
  });

  it('menu says logged in → no lost login, a normal error ("Seite geändert?")', async () => {
    const err = await settle(createLobbyWithOwnBoard(new FakeLobbyDriver({ button: false, menu: true }), 'https://x', 'Mein Board'));
    expect(err).toBeInstanceOf(OwnBoardsUnavailableError);
    expect(err).not.toBeInstanceOf(NotLoggedInError);
    expect((err as OwnBoardsUnavailableError).loggedIn).toBe(true);
    expect((err as Error).message).toMatch(/obwohl der Bot bei quiz-base angemeldet ist/);
  });

  it('no menu / unclear → no lost login (loggedIn null)', async () => {
    const err = await settle(createLobbyWithOwnBoard(new FakeLobbyDriver({ button: false, menu: null }), 'https://x', 'Mein Board'));
    expect(err).toBeInstanceOf(OwnBoardsUnavailableError);
    expect((err as OwnBoardsUnavailableError).loggedIn).toBeNull();
  });

  it('evaluate keeps failing → not "logged out" either', async () => {
    const err = await settle(createLobbyWithOwnBoard(new FakeLobbyDriver({ button: false, buttonThrows: true, menu: true }), 'https://x', 'Mein Board'));
    expect(err).toBeInstanceOf(OwnBoardsUnavailableError);
  });

  it('button there → lobby opens, the menu is not touched', async () => {
    const d = new FakeLobbyDriver({ button: true, menu: false });
    const res = await settle(createLobbyWithOwnBoard(d, 'https://x', 'Mein Board'));
    expect(res).toBeUndefined();
  });
});

describe('GameSession.createLobby with an own board reports the login (A1-F7d)', () => {

  async function session(scene: Scene) {
    fake.driver = new FakeLobbyDriver(scene);
    const { GameSession } = await import('../src/session.ts');
    const seen: (boolean | null)[] = [];
    const config = ConfigSchema.parse({ account: { loginCommand: 'npx qbhost login --server vps' } });
    const s = new GameSession(config, [], { onLogin: (ok, source) => void (expect(source).toBe('lobby'), seen.push(ok)) });
    vi.spyOn(s.page, 'revealCode').mockResolvedValue({ ok: true });
    vi.spyOn(s.page, 'waitFor').mockResolvedValue({ lobbyCode: 'ABCD' } as any);
    return { s, seen };
  }

  it('success → onLogin(true)', async () => {
    const { s, seen } = await session({ button: true, menu: true });
    const info = await settle(s.createLobby('Mein Board', { own: true }));
    expect(info).toMatchObject({ code: 'ABCD' });
    expect(seen).toEqual([true]);
  });

  it('logged out → onLogin(false), the message names the login command', async () => {
    const { s, seen } = await session({ button: false, menu: false });
    const err = await settle(s.createLobby('Mein Board', { own: true }));
    expect(err).toBeInstanceOf(NotLoggedInError);
    expect((err as Error).message).toContain('Neu anmelden: `npx qbhost login --server vps`');
    expect(seen).toEqual([false]);
  });

  it('button missing but logged in → onLogin(true), no login hint', async () => {
    const { s, seen } = await session({ button: false, menu: true });
    const err = await settle(s.createLobby('Mein Board', { own: true }));
    expect(err).toBeInstanceOf(OwnBoardsUnavailableError);
    expect((err as Error).message).not.toContain('Neu anmelden');
    expect(seen).toEqual([true]);
  });

  it('public board → no login report', async () => {
    const { s, seen } = await session({ button: false, menu: false });
    await settle(s.createLobby('Öffentlich').catch(() => {}));
    expect(seen).toEqual([]);
  });
});
