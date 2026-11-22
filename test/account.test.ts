import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountKeeper,
  formatLoginHistory,
  formatLoginStatus,
  freshStatus,
  LoginStatusStore,
  shortError,
  type KeeperProbe,
  type LoginChange,
  type LoginStatus,
} from '../src/account.ts';
import type { ResponseWatch } from '../src/browser/driver.ts';
import { ProfileBusyError } from '../src/browser/profile-lock.ts';
import { ConfigSchema } from '../src/config.ts';

const SB = 'https://abcdefgh.supabase.co/auth/v1';
const REFRESH = `${SB}/token?grant_type=refresh_token`;
const T0 = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let dir: string;
let stderr: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'qbaccount-'));
  vi.useFakeTimers({ now: T0 });
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => (stderr.push(String(chunk)), true));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cfg = (account: Record<string, unknown> = {}, browser: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ browser: { headless: true, profileDir: path.join(dir, 'profile'), ...browser }, account: { statusFile: path.join(dir, 'login-status.json'), ...account } });

interface ProbePlan {
  /** What the user menu says; a function gets the abort signal. */
  state?: boolean | null | ((signal: AbortSignal) => Promise<boolean | null>);
  /** Auth responses the page produces while the menu is read. */
  during?: (watch: ResponseWatch) => void;
  busy?: boolean;
  openError?: Error;
  closeMs?: number;
}

function harness(opts: { account?: Record<string, unknown>; browser?: Record<string, unknown>; idle?: () => boolean; random?: () => number } = {}) {
  const config = cfg(opts.account, opts.browser);
  const store = new LoginStatusStore(config.account.statusFile);
  const plans: ProbePlan[] = [];
  const calls = { open: 0, close: 0, preempt: [] as (() => void)[] };
  const changes: LoginChange[] = [];
  const keeper = new AccountKeeper({
    config,
    store,
    isIdle: opts.idle,
    random: opts.random ?? (() => 0.5),
    onChange: (_s, c) => void changes.push(c),
    openProbe: async (_signal, watch, onPreempt): Promise<KeeperProbe> => {
      calls.open++;
      calls.preempt.push(onPreempt);
      const plan = plans.shift() ?? { state: true };
      if (plan.busy) throw new ProfileBusyError('game');
      if (plan.openError) throw plan.openError;
      return {
        loginState: async (signal) => {
          plan.during?.(watch);
          return typeof plan.state === 'function' ? plan.state(signal) : (plan.state ?? null);
        },
        close: async () => {
          calls.close++;
          if (plan.closeMs) await new Promise((r) => setTimeout(r, plan.closeMs));
          return plan.closeMs ?? 120;
        },
      };
    },
  });
  return { config, store, keeper, plans, calls, changes };
}

/** Runs one check while the fake clock moves past the hold. */
async function runCheck(keeper: AccountKeeper, source: 'keepalive' | 'start' = 'keepalive') {
  const p = keeper.check(source);
  await vi.advanceTimersByTimeAsync(30_000);
  return p;
}

const waitForAbort = (signal: AbortSignal) => new Promise<boolean | null>((r) => signal.addEventListener('abort', () => r(null), { once: true }));

describe('AccountKeeper: schedule', () => {
  it('start check after the delay, only while idle', async () => {
    let idle = false;
    const h = harness({ idle: () => idle });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.calls.open).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.calls.open).toBe(0); // a game is running
    idle = true;
    await vi.advanceTimersByTimeAsync(MIN + 30_000); // the next minute's retry + hold
    expect(h.calls.open).toBe(1);
    expect(h.calls.close).toBe(1);
    const s = h.store.read();
    expect(s.state).toBe('ok');
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({ source: 'start', result: 'ok', refresh: 'none', closeMs: 120 });
    expect(stderr.join('')).toMatch(/🔐 quiz-base-Anmeldung \(start\): angemeldet · keine Erneuerung · .* · Browser zu in 0,1 s/);
    await h.keeper.stop();
  });

  it('a busy profile: no history entry, another try 10 min later', async () => {
    const h = harness({ account: { startCheckDelaySec: 5 } });
    h.plans.push({ busy: true }, { state: true });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.calls.open).toBe(1);
    expect(h.store.read().history).toHaveLength(0);
    expect(h.store.read().state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(h.calls.open).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.calls.open).toBe(2);
    expect(h.store.read().history.map((c) => c.result)).toEqual(['ok']);
    await h.keeper.stop();
  });

  it.each([
    [0, 6 * HOUR - 30 * MIN],
    [1, 6 * HOUR + 30 * MIN],
  ])('keep-alive interval with jitter (random %d)', async (rnd, gap) => {
    const h = harness({ account: { startCheckDelaySec: 1 }, random: () => rnd });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls.open).toBe(1);
    await vi.advanceTimersByTimeAsync(25_000); // hold (20 s) + close
    const first = h.store.read();
    const checkedAt = Date.parse(first.history[0]!.at) + first.history[0]!.ms;
    expect(Date.parse(first.nextDueAt!)).toBe(checkedAt + gap);
    await vi.advanceTimersByTimeAsync(Date.parse(first.nextDueAt!) - Date.now() - 1000);
    expect(h.calls.open).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.calls.open).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.store.read().history.map((c) => c.source)).toEqual(['start', 'keepalive']);
    await h.keeper.stop();
  });

  it('after a game: one check afterGameCheckSec later (instead of the start check)', async () => {
    const h = harness({ account: { startCheckDelaySec: 120, afterGameCheckSec: 60 } });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(30_000);
    h.keeper.gameEnded();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.calls.open).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls.open).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.calls.open).toBe(1); // the start check is gone
    expect(h.store.read().history.map((c) => c.source)).toEqual(['after-game']);
    await h.keeper.stop();
  });

  it('a refresh during the check: 2 s more, then close; the result says what the page did', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ state: true, during: (w) => w.onResponse({ url: REFRESH, status: 200 }) });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1000 + 2100);
    expect(h.calls.close).toBe(1);
    const s = h.store.read();
    expect(s.history[0]).toMatchObject({ result: 'ok', refresh: { status: 200 } });
    expect(s.authHistory).toEqual([expect.objectContaining({ kind: 'refresh', status: 200, source: 'start' })]);
    expect(stderr.join('')).toMatch(/angemeldet · Sitzung erneuert \(200\)/);
    await h.keeper.stop();
  });

  it('a refresh arriving while holding ends the hold early', async () => {
    const h = harness({ account: { startCheckDelaySec: 1, holdSec: 20 } });
    let watch: ResponseWatch | null = null;
    h.plans.push({ state: true, during: (w) => void (watch = w) });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1000 + 5000);
    expect(h.calls.close).toBe(0);
    watch!.onResponse({ url: REFRESH, status: 200 });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls.close).toBe(1);
    await h.keeper.stop();
  });

  it('interrupt → aborted, the browser is closed', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ state: waitForAbort });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls.open).toBe(1);
    h.keeper.interrupt('Spiel startet');
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.close).toBe(1);
    expect(h.store.read().history[0]).toMatchObject({ result: 'aborted' });
    expect(h.store.read().state).toBe('unknown');
    await h.keeper.stop();
  });

  it('preemption by the profile lock aborts the check too', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ state: waitForAbort });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1500);
    h.calls.preempt[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls.close).toBe(1);
    expect(h.store.read().history[0]!.result).toBe('aborted');
    await h.keeper.stop();
  });

  it('a launch error (e.g. SingletonLock of another process) → error, short message without URL', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ openError: new Error('Failed to launch: https://abcdefgh.supabase.co/x?token=1 SingletonLock\nstack…') });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1500);
    const c = h.store.read().history[0]!;
    expect(c.result).toBe('error');
    expect(c.error).toBe('Failed to launch: <URL> SingletonLock');
    expect(c.refresh).toBeUndefined();
    expect(h.calls.close).toBe(0);
    await h.keeper.stop();
  });

  it('stop() waits for the clean close', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ state: waitForAbort, closeMs: 3000 });
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(1500);
    let stopped = false;
    const p = h.keeper.stop().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(stopped).toBe(true);
    expect(h.calls.close).toBe(1);
    // Nothing runs after stop().
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(h.calls.open).toBe(1);
  });

  it('disabled with driver orca or keepAliveHours 0 – no runs, report/authWatch still write', async () => {
    expect(harness({ browser: { driver: 'orca' } }).keeper.enabled).toBe(false);
    const h = harness({ account: { keepAliveHours: 0, startCheckDelaySec: 1 } });
    expect(h.keeper.enabled).toBe(false);
    h.keeper.start();
    h.keeper.gameEnded();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(h.calls.open).toBe(0);
    h.keeper.report(true, 'lobby');
    expect(h.store.read().state).toBe('ok');
    expect(harness().keeper.enabled).toBe(true);
  });
});

describe('AccountKeeper: state changes', () => {
  it('ok → lost calls onChange exactly once, lost → lost not again', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.keeper.report(true, 'board-create');
    expect(h.changes).toEqual([{ before: 'unknown', after: 'ok', source: 'board-create', notifiedLostAt: null }]);
    h.plans.push({ state: false }, { state: false });
    expect(await runCheck(h.keeper)).toBe('lost');
    h.keeper.report(false, 'lobby');
    await runCheck(h.keeper);
    expect(h.changes.map((c) => `${c.before}→${c.after}`)).toEqual(['unknown→ok', 'ok→lost']);
    const s = h.store.read();
    expect(s.lostAt).toBe(s.history[1]!.at); // the first loss of the episode
    expect(stderr.join('')).toMatch(/\[konto\].*🔐 quiz-base-Anmeldung \(keepalive\): abgemeldet/);
  });

  it('a refused refresh in the game browser → lost; with the code in the status line', () => {
    const h = harness();
    h.keeper.report(true, 'lobby');
    const w = h.keeper.authWatch('game');
    w.onResponse({ url: REFRESH, status: 400, errorCode: 'session_expired' });
    const s = h.store.read();
    expect(s.state).toBe('lost');
    expect(s.authHistory.at(-1)).toMatchObject({ kind: 'refresh', status: 400, code: 'session_expired', source: 'game' });
    expect(h.changes.at(-1)).toMatchObject({ before: 'ok', after: 'lost', source: 'game' });
    expect(stderr.join('')).toMatch(/Sitzungserneuerung abgelehnt \(400 session_expired, Spiel\)/);
    expect(formatLoginStatus(s, Date.now(), 'npx qbhost login --server quizmaster-vps')).toBe(
      'quiz-base-Anmeldung: abgemeldet seit 13:00 (Erneuerung abgelehnt: 400 session_expired) → npx qbhost login --server quizmaster-vps',
    );
  });

  it('a successful refresh in the game browser → ok; 5xx changes nothing', () => {
    const h = harness();
    const w = h.keeper.authWatch('board');
    w.onResponse({ url: REFRESH, status: 503 });
    expect(h.store.read().state).toBe('unknown');
    w.onResponse({ url: REFRESH, status: 200 });
    expect(h.store.read().state).toBe('ok');
    expect(stderr.join('')).toMatch(/Sitzung erneuert \(Board-Anlage\)/);
  });

  it('signup and logout of the page are warned about (evidence for an anonymous session)', () => {
    const h = harness();
    const w = h.keeper.authWatch('game');
    w.onResponse({ url: `${SB}/signup`, status: 200 });
    w.onResponse({ url: `${SB}/logout`, status: 204 });
    const err = stderr.join('');
    expect(err).toMatch(/\x1b\[33m.*Seite hat eine anonyme Sitzung angelegt \(Spiel\)/);
    expect(err).toMatch(/Seite hat sich abgemeldet \(Spiel\)/);
    expect(h.store.read().state).toBe('lost');
  });

  it('during a check the menu decides, not a refused refresh of the same visit', async () => {
    const h = harness();
    h.plans.push({ state: true, during: (w) => w.onResponse({ url: REFRESH, status: 400, errorCode: 'refresh_token_already_used' }) });
    await runCheck(h.keeper);
    expect(h.store.read().state).toBe('ok');
    expect(h.changes.map((c) => c.after)).toEqual(['ok']);
    // Menu unclear: then the refresh decides.
    h.plans.push({ state: null, during: (w) => w.onResponse({ url: REFRESH, status: 401, errorCode: 'session_not_found' }) });
    await runCheck(h.keeper);
    expect(h.store.read().state).toBe('lost');
  });

  it('back to ok after a loss: okSince new, lostAt/notifiedLostAt cleared, notifiedLostAt of before in the change', () => {
    const h = harness();
    h.keeper.report(false, 'lobby');
    h.keeper.markNotified(Date.now());
    vi.setSystemTime(T0 + HOUR);
    h.keeper.report(true, 'login');
    const s = h.store.read();
    expect(s).toMatchObject({ state: 'ok', okSince: new Date(T0 + HOUR).toISOString(), lostAt: null, notifiedLostAt: null });
    expect(h.changes.at(-1)).toEqual({ before: 'lost', after: 'ok', source: 'login', notifiedLostAt: new Date(T0).toISOString() });
  });

  it('the subscription (onChange) gets changes too, a throwing listener does not escape', () => {
    const h = harness();
    const seen: string[] = [];
    const off = h.keeper.onChange((_s, c) => void seen.push(c.after));
    h.keeper.onChange(() => {
      throw new Error('boom');
    });
    h.keeper.report(true, 'lobby');
    off();
    h.keeper.report(false, 'lobby');
    expect(seen).toEqual(['ok']);
  });
});

describe('LoginStatusStore', () => {
  it('missing or corrupt file → fresh unknown', () => {
    const file = path.join(dir, 'x.json');
    expect(new LoginStatusStore(file).read()).toEqual(freshStatus());
    writeFileSync(file, '{kaputt');
    expect(new LoginStatusStore(file).read().state).toBe('unknown');
    writeFileSync(file, JSON.stringify({ version: 2, state: 'ok' }));
    expect(new LoginStatusStore(file).read().state).toBe('unknown');
  });

  it('holds no token, at most 30 entries each, collapses repeated user lookups', () => {
    const h = harness();
    const w = h.keeper.authWatch('game');
    for (let i = 0; i < 40; i++) {
      h.keeper.report(i % 2 === 0, 'lobby');
      w.onResponse({ url: REFRESH, status: i % 2 ? 200 : 400, errorCode: i % 2 ? undefined : 'session_expired' });
    }
    w.onResponse({ url: `${SB}/user`, status: 200 });
    w.onResponse({ url: `${SB}/user`, status: 200 });
    const raw = readFileSync(h.config.account.statusFile, 'utf8');
    for (const bad of ['token', 'access', 'refresh_token', 'supabase', 'http', 'apikey', 'cookie']) expect(raw.toLowerCase()).not.toContain(bad);
    const s = JSON.parse(raw) as LoginStatus;
    expect(s.history).toHaveLength(30);
    expect(s.authHistory).toHaveLength(30);
    expect(s.authHistory.filter((a) => a.kind === 'user')).toHaveLength(1);
  });
});

describe('formatLoginStatus', () => {
  const now = Date.parse('2026-11-22T13:30:00Z'); // 14:30 in Berlin

  it('ok: checked, renewed, next check (Berlin time)', () => {
    const s: LoginStatus = {
      ...freshStatus(),
      state: 'ok',
      okSince: '2026-11-20T14:08:47.000Z',
      lastOkAt: '2026-11-22T13:02:00.000Z',
      lastCheckAt: '2026-11-22T13:02:00.000Z',
      nextDueAt: '2026-11-22T19:10:00.000Z',
      history: [{ at: '2026-11-22T13:02:00.000Z', source: 'keepalive', result: 'ok', refresh: { status: 200 }, ms: 14_000, closeMs: 1200 }],
      authHistory: [{ at: '2026-11-22T13:02:05.000Z', kind: 'refresh', status: 200, source: 'keepalive' }],
    };
    expect(formatLoginStatus(s, now, 'npx qbhost login')).toBe('quiz-base-Anmeldung: angemeldet (geprüft 14:02 Keep-alive, erneuert 14:02, nächste Prüfung ~20:10)');
    expect(formatLoginHistory(s, now)).toEqual(['14:02 Keep-alive: angemeldet · Sitzung erneuert (200) · 14 s · Browser zu in 1,2 s']);
  });

  it('lost: since when, and the command', () => {
    const s: LoginStatus = { ...freshStatus(), state: 'lost', lostAt: '2026-11-20T14:02:26.000Z' };
    expect(formatLoginStatus(s, now, 'npx qbhost login --server quizmaster-vps')).toBe('quiz-base-Anmeldung: abgemeldet seit 20.11. 15:02 → npx qbhost login --server quizmaster-vps');
  });

  it('unknown: not checked yet, or unclear', () => {
    expect(formatLoginStatus(freshStatus(), now, 'x')).toBe('quiz-base-Anmeldung: noch nicht geprüft');
    const s: LoginStatus = { ...freshStatus(), lastCheckAt: '2026-11-22T12:00:00.000Z', history: [{ at: '2026-11-22T12:00:00.000Z', source: 'start', result: 'unclear', ms: 9000 }] };
    expect(formatLoginStatus(s, now, 'x')).toBe('quiz-base-Anmeldung: unklar (zuletzt geprüft 13:00 Start: unklar)');
  });

  it('shortError: first line, no URLs', () => {
    expect(shortError(new Error('net::ERR at https://www.quiz-base.de/?a=b\nmore'))).toBe('net::ERR at <URL>');
  });
});

describe('AccountKeeper: a check started from outside', () => {
  it('a due tick while check() runs keeps the schedule alive', async () => {
    const h = harness({ account: { startCheckDelaySec: 1 } });
    h.plans.push({ state: (sig) => new Promise((r) => setTimeout(() => r(true), 90_000)).then((v) => (sig.aborted ? null : (v as boolean))) }, { state: true });
    const outside = h.keeper.check('page');
    h.keeper.start();
    await vi.advanceTimersByTimeAsync(2000); // start check due, but busy with the outside check
    expect(h.calls.open).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await outside;
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(h.store.read().history.map((c) => c.source)).toEqual(['page', 'start']);
    await h.keeper.stop();
  });
});
