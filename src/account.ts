import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResponseWatch } from './browser/driver.ts';
import { PlaywrightDriver } from './browser/playwright-driver.ts';
import { ProfileBusyError } from './browser/profile-lock.ts';
import type { Config } from './config.ts';
import { createLogger, sleep } from './core/logger.ts';
import { quizBaseAuthWatch, type AuthEvent, type AuthKind } from './site/auth.ts';
import { BoardEditorPage } from './site/editor/page.ts';

/**
 * The bot's quiz-base account: keeps the login fresh while idle and records what is known about it.
 *
 * - `LoginStatusStore`: `.qbhost/login-status.json` – states, timestamps, status codes and Supabase error codes.
 *   Never a token, cookie, header, body or URL.
 * - `AccountKeeper`: a short headless visit of quiz-base after the start, after each game and every
 *   `account.keepAliveHours` (only while idle). The page itself renews its session on that visit; we only read
 *   the user menu and watch the status of the page's own auth requests. It gives the profile back at once when a
 *   game or a board creation needs it (profile lock, preemptible).
 */

const log = createLogger('konto');

export type LoginState = 'ok' | 'lost' | 'unknown';
export type CheckSource = 'start' | 'keepalive' | 'after-game' | 'board-create' | 'lobby' | 'login' | 'page';
export type AuthSource = CheckSource | 'game' | 'board';

export interface LoginCheck {
  at: string;
  source: CheckSource;
  result: 'ok' | 'lost' | 'unclear' | 'aborted' | 'error' | 'busy';
  /** What the page did during this check. */
  refresh?: { status: number; code?: string } | 'none';
  ms: number;
  closeMs?: number;
  /** Short message, no URL, no body. */
  error?: string;
  /** What the user menu said (keep-alive checks); a refused refresh does not overrule a logged-in menu. */
  menu?: boolean | null;
}

export interface AuthRecord {
  at: string;
  kind: AuthKind;
  status: number;
  code?: string;
  source: AuthSource;
}

export interface LoginStatus {
  version: 1;
  state: LoginState;
  /** First ok after unknown/lost ≈ time of the login. */
  okSince: string | null;
  lastOkAt: string | null;
  /** First lost of this episode. */
  lostAt: string | null;
  /** A loss DM went out for this episode (survives restarts: one DM per loss). */
  notifiedLostAt: string | null;
  lastCheckAt: string | null;
  nextDueAt: string | null;
  lastAuth: { at: string; kind: AuthKind; status: number; code?: string } | null;
  /** Newest last, at most 30. */
  history: LoginCheck[];
  /** Newest last, at most 30. */
  authHistory: AuthRecord[];
}

export interface LoginChange {
  before: LoginState;
  after: LoginState;
  source: string;
  /** `notifiedLostAt` before this change – a "wieder angemeldet" message only makes sense if a loss message went out. */
  notifiedLostAt: string | null;
}

export interface StoreUpdate {
  before: LoginState;
  after: LoginState;
  status: LoginStatus;
  notifiedLostAt: string | null;
}

const MAX_ENTRIES = 30;
const STATES: LoginState[] = ['ok', 'lost', 'unknown'];
const iso = (ms: number) => new Date(ms).toISOString();

export function freshStatus(): LoginStatus {
  return {
    version: 1,
    state: 'unknown',
    okSince: null,
    lastOkAt: null,
    lostAt: null,
    notifiedLostAt: null,
    lastCheckAt: null,
    nextDueAt: null,
    lastAuth: null,
    history: [],
    authHistory: [],
  };
}

/** State effect of a refresh response: 2xx = renewed, 400/401/403 = refused (session gone); anything else says nothing. */
function refreshEffect(status: number): LoginState | null {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 400 || status === 401 || status === 403) return 'lost';
  return null;
}

/** `.qbhost/login-status.json`. Every call reads the file again, so the bot and the CLI (`doctor`, `login`) agree. */
export class LoginStatusStore {
  constructor(
    readonly file: string,
    private now: () => number = Date.now,
  ) {}

  /** Missing or corrupt → a fresh 'unknown' status. */
  read(): LoginStatus {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LoginStatus>;
      if (raw?.version !== 1 || !STATES.includes(raw.state as LoginState)) return freshStatus();
      return {
        ...freshStatus(),
        ...raw,
        history: Array.isArray(raw.history) ? raw.history.slice(-MAX_ENTRIES) : [],
        authHistory: Array.isArray(raw.authHistory) ? raw.authHistory.slice(-MAX_ENTRIES) : [],
      };
    } catch {
      return freshStatus();
    }
  }

  /** Adds a check (not 'busy': the profile was in use, nothing was checked) and applies its state. */
  record(c: LoginCheck): StoreUpdate {
    return this.update((s) => {
      if (c.result === 'busy') return;
      s.lastCheckAt = c.at;
      if (c.result === 'ok') setOk(s, c.at);
      else if (c.result === 'lost') setLost(s, c.at);
      else if (c.refresh && c.refresh !== 'none') {
        // Menu unclear: the refresh of the same visit says what it can – a 2xx only confirms an existing ok
        // (an anonymous session renews with 200 too), a refusal is a loss unless the menu showed the account.
        const effect = refreshEffect(c.refresh.status);
        if (effect === 'ok') confirmOk(s, c.at);
        else if (effect === 'lost' && c.menu !== true) setLost(s, c.at);
      }
      s.history.push(c);
      s.history = s.history.slice(-MAX_ENTRIES);
    });
  }

  /** Adds an auth request of the page. With `applyState` (default), a refresh/login/logout also changes the state. */
  noteAuth(e: AuthEvent, source: AuthSource, opts: { applyState?: boolean } = {}): StoreUpdate {
    return this.update((s) => {
      const at = iso(e.at);
      const entry: AuthRecord = { at, kind: e.kind, status: e.status, source };
      if (e.code) entry.code = e.code;
      s.lastAuth = { at, kind: e.kind, status: e.status, ...(e.code ? { code: e.code } : {}) };
      const last = s.authHistory[s.authHistory.length - 1];
      // The page asks for the user on every load – keep one entry per run of identical ones.
      if (e.kind === 'user' && last?.kind === 'user' && last.status === e.status && last.source === source && last.code === e.code) last.at = at;
      else s.authHistory.push(entry);
      s.authHistory = s.authHistory.slice(-MAX_ENTRIES);
      if (opts.applyState === false) return;
      if (e.kind === 'refresh') {
        // A 2xx refresh only confirms an ok: quiz-base renews an anonymous session the same way, so it never
        // turns unknown/lost into ok. Only the menu, report(true) and a password login do that.
        const effect = refreshEffect(e.status);
        if (effect === 'ok') confirmOk(s, at);
        else if (effect === 'lost') setLost(s, at);
      } else if (e.kind === 'login' && e.ok) setOk(s, at);
      else if (e.kind === 'logout' && e.ok) setLost(s, at);
    });
  }

  markNotified(at: number): void {
    this.update((s) => {
      s.notifiedLostAt = iso(at);
    });
  }

  setNextDue(at: number | null): void {
    this.update((s) => {
      s.nextDueAt = at === null ? null : iso(at);
    });
  }

  private update(fn: (s: LoginStatus) => void): StoreUpdate {
    const s = this.read();
    const before = s.state;
    const notifiedLostAt = s.notifiedLostAt;
    fn(s);
    this.write(s);
    return { before, after: s.state, status: s, notifiedLostAt };
  }

  private write(s: LoginStatus): void {
    try {
      mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (e) {
      // Diagnostics only – a read-only data dir must not break a game or a login.
      log.debug(`Anmeldestatus nicht gespeichert: ${(e as Error).message}`);
    }
  }
}

function setOk(s: LoginStatus, at: string): void {
  if (s.state !== 'ok') {
    s.okSince = at;
    s.lostAt = null;
    s.notifiedLostAt = null;
  }
  s.state = 'ok';
  s.lastOkAt = at;
}

/** Evidence that an existing login still works – never a change of state. */
function confirmOk(s: LoginStatus, at: string): void {
  if (s.state === 'ok') s.lastOkAt = at;
}

function setLost(s: LoginStatus, at: string): void {
  if (s.state !== 'lost') s.lostAt = at;
  s.state = 'lost';
}

// ───────────────────────────── keeper ─────────────────────────────

/** What a login check needs from the opened profile (tests swap in a fake). */
export interface KeeperProbe {
  loginState(signal: AbortSignal): Promise<boolean | null>;
  /** Closes the browser (waiting for running token requests) and returns how long that took. */
  close(): Promise<number>;
}

export interface AccountKeeperDeps {
  config: Config;
  store: LoginStatusStore;
  /** idle = no game, no board being generated/created, no voice room (A2 wires QuizBot). Default: always idle. */
  isIdle?: () => boolean;
  onChange?: (status: LoginStatus, change: LoginChange) => void;
  /** Tests: opens the profile and returns a minimal page handle. */
  openProbe?: (signal: AbortSignal, watch: ResponseWatch, onPreempt: () => void) => Promise<KeeperProbe>;
  now?: () => number;
  random?: () => number;
}

type ChangeListener = (status: LoginStatus, change: LoginChange) => void;

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Longest pause between two looks at the schedule. */
const TICK_MS = 5 * MINUTE;
/** Retry while not idle. */
const NOT_IDLE_RETRY_MS = MINUTE;
/** Retry after the profile was in use. */
const BUSY_RETRY_MS = 10 * MINUTE;
/** stop() waits at most this long for a running check to close its browser. */
const STOP_WAIT_MS = 8000;
/**
 * Opening the page and reading the user menu take at most this long; then the check is aborted and the browser
 * closed. Holding afterwards is bounded by `account.holdSec` itself (any value up to 120 s), closing by the driver.
 */
const RUN_LIMIT_MS = 60_000;
/** Navigation limit of the keep-alive browser (Playwright's default is 30 s). */
const KEEPALIVE_NAV_MS = 20_000;
/** After an error or an unclear result: try again this soon (a refused refresh with a logged-in menu: sooner), at most MAX_RETRIES times in a row. */
const RETRY_MS = 30 * MINUTE;
const CONFLICT_RETRY_MS = 15 * MINUTE;
const MAX_RETRIES = 2;

export class AccountKeeper {
  /** browser.driver === 'playwright' && keepAliveHours > 0 */
  readonly enabled: boolean;
  private readonly cfg: Config['account'];
  private readonly store: LoginStatusStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly openProbe: NonNullable<AccountKeeperDeps['openProbe']>;
  private readonly listeners = new Set<ChangeListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  /** Start or after-game check, once. */
  private oneShot: { source: CheckSource; at: number } | null = null;
  private keepAliveAt = Infinity;
  private busyUntil = 0;
  private running: Promise<LoginCheck['result']> | null = null;
  private ac: AbortController | null = null;
  /** Retries in a row after error/unclear. */
  private retries = 0;
  /** The last check saw a logged-in menu but a refused refresh. */
  private lastConflict = false;

  constructor(private d: AccountKeeperDeps) {
    this.cfg = d.config.account;
    this.store = d.store;
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.openProbe = d.openProbe ?? ((signal, watch, onPreempt) => this.openBrowser(signal, watch, onPreempt));
    this.enabled = d.config.browser.driver === 'playwright' && this.cfg.keepAliveHours > 0;
  }

  /** Command for logging in again (`account.loginCommand`). */
  get loginCommand(): string {
    return this.cfg.loginCommand;
  }

  /** Start check after `startCheckDelaySec`, then the keep-alive schedule (timers are unref'd). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.enabled) {
      this.store.setNextDue(null);
      return;
    }
    const t = this.now();
    this.keepAliveAt = t + this.cfg.keepAliveHours * HOUR;
    this.oneShot = { source: 'start', at: t + this.cfg.startCheckDelaySec * 1000 };
    this.writeNextDue();
    this.arm();
  }

  /** Stops the timers, aborts a running check and waits for its clean close (≤ 8 s). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.interrupt('Herunterfahren');
    const running = this.running;
    if (!running) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running.catch(() => {}), new Promise<void>((r) => (t = setTimeout(r, STOP_WAIT_MS)))]);
    clearTimeout(t);
  }

  /** Aborts a running check (a game, a voice room or a board creation is starting). */
  interrupt(reason: string): void {
    if (!this.ac || this.ac.signal.aborted) return;
    log.info(`🔐 Anmeldeprüfung abgebrochen (${reason})`);
    this.ac.abort();
  }

  /** A game ended: check once more `afterGameCheckSec` later, as soon as the bot is idle. Replaces a pending start check. */
  gameEnded(): void {
    if (!this.enabled || this.stopped || !this.started) return;
    if (this.oneShot?.source === 'start') this.oneShot = null;
    if (this.cfg.afterGameCheckSec > 0) this.oneShot = { source: 'after-game', at: this.now() + this.cfg.afterGameCheckSec * 1000 };
    this.writeNextDue();
    this.arm();
  }

  /** Login state seen elsewhere (board editor, own-board lobby). */
  report(ok: boolean | null, source: CheckSource): void {
    const c: LoginCheck = { at: iso(this.now()), source, result: ok === true ? 'ok' : ok === false ? 'lost' : 'unclear', ms: 0 };
    const r = this.store.record(c);
    if (ok === false) log.warn(`🔐 quiz-base-Anmeldung (${source}): abgemeldet`);
    else log.info(`🔐 quiz-base-Anmeldung (${source}): ${ok ? 'angemeldet' : 'unklar'}`);
    this.emitIfChanged(r, source);
  }

  /** Passive observation for the game's and the board creation's browser. */
  authWatch(source: 'game' | 'board'): ResponseWatch {
    return quizBaseAuthWatch((e) => this.onAuth(e, source, true), this.now);
  }

  status(): LoginStatus {
    return this.store.read();
  }

  /** Subscribes to state changes (in addition to `deps.onChange`). Returns the unsubscribe function. */
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** A loss message went out (one per loss, also across restarts). */
  markNotified(at: number): void {
    this.store.markNotified(at);
  }

  /**
   * Gives the profile back now: aborts a running check and waits until its browser is closed (≤ timeoutMs).
   * `interrupt()` does the same without waiting; the profile lock also preempts the check by itself.
   */
  async release(timeoutMs = 10_000): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.interrupt('Profil wird gebraucht');
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running.catch(() => {}), new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }

  /** Runs one check now (unless one is running – then its result; after stop(): nothing, 'aborted'). Never throws. */
  check(source: CheckSource): Promise<LoginCheck['result']> {
    if (this.stopped) return Promise.resolve('aborted');
    if (this.running) return this.running;
    const ac = new AbortController();
    this.ac = ac;
    this.running = this.doRun(source, ac)
      .catch((e) => {
        log.warn(`🔐 Anmeldeprüfung (${source}): ${shortError(e)}`);
        return 'error' as const;
      })
      .finally(() => {
        this.running = null;
        if (this.ac === ac) this.ac = null;
      });
    return this.running;
  }

  // ───────────── schedule ─────────────

  private arm(delayMs?: number): void {
    if (this.stopped || !this.enabled || !this.started) return;
    if (this.timer) clearTimeout(this.timer);
    let at = Math.min(this.oneShot?.at ?? Infinity, this.keepAliveAt);
    if (this.busyUntil > at) at = this.busyUntil;
    const delay = delayMs ?? Math.min(Math.max(at - this.now(), 1000), TICK_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // A check started from outside (check()) is still running – look again later, keep the timer alive.
    if (this.running) return this.arm(NOT_IDLE_RETRY_MS);
    const t = this.now();
    const shot = this.oneShot && this.oneShot.at <= t ? this.oneShot : null;
    const source: CheckSource | null = shot ? shot.source : this.keepAliveAt <= t ? 'keepalive' : null;
    if (!source || t < this.busyUntil) return this.arm();
    if (!this.idle()) return this.arm(NOT_IDLE_RETRY_MS);
    const result = await this.check(source);
    if (this.stopped) return;
    if (result === 'busy') {
      this.busyUntil = this.now() + BUSY_RETRY_MS;
    } else {
      if (shot && this.oneShot === shot) this.oneShot = null;
      // quiz-base unreachable or the menu unclear: visit again soon instead of after keepAliveHours (a few times).
      if ((result === 'error' || result === 'unclear') && this.retries < MAX_RETRIES) {
        this.retries++;
        this.keepAliveAt = this.now() + (this.lastConflict ? CONFLICT_RETRY_MS : RETRY_MS);
      } else {
        this.retries = 0;
        this.keepAliveAt = this.now() + this.cfg.keepAliveHours * HOUR + (this.random() * 2 - 1) * this.cfg.keepAliveJitterMin * MINUTE;
      }
    }
    this.writeNextDue();
    this.arm();
  }

  private idle(): boolean {
    try {
      return this.d.isIdle?.() ?? true;
    } catch {
      return false;
    }
  }

  private writeNextDue(): void {
    const at = Math.max(Math.min(this.oneShot?.at ?? Infinity, this.keepAliveAt), this.busyUntil);
    this.store.setNextDue(Number.isFinite(at) ? at : null);
  }

  // ───────────── one check ─────────────

  private async doRun(source: CheckSource, ac: AbortController): Promise<LoginCheck['result']> {
    const t0 = this.now();
    const seen: { refresh: { status: number; code?: string } | null; wake: () => void } = { refresh: null, wake: () => {} };
    const watch = quizBaseAuthWatch((e) => {
      // During a check the menu decides; the refresh counts only if the menu stays unclear (see record()).
      this.onAuth(e, source, false);
      if (e.kind !== 'refresh') return;
      seen.refresh = { status: e.status, ...(e.code ? { code: e.code } : {}) };
      seen.wake();
    }, this.now);

    let probe: KeeperProbe | null = null;
    let result: LoginCheck['result'] = 'unclear';
    let menu: boolean | null | undefined;
    let error: string | undefined;
    let closeMs: number | undefined;
    let timedOut = false;
    this.lastConflict = false;
    // A hanging page (or Chromium start) must not keep the profile: abort – which closes the browser – if opening and
    // reading the menu take longer than RUN_LIMIT_MS. The hold that follows has its own bound (holdSec).
    const deadline = setTimeout(() => {
      timedOut = true;
      log.warn(`🔐 Anmeldeprüfung (${source}): Zeitlimit (${RUN_LIMIT_MS / 1000} s) – breche ab`);
      ac.abort();
    }, RUN_LIMIT_MS);
    deadline.unref?.();
    try {
      probe = await this.openProbe(ac.signal, watch, () => this.interrupt('Profil wird für ein Spiel oder ein Board gebraucht'));
    } catch (e) {
      if (e instanceof ProfileBusyError) {
        log.info(`🔐 Anmeldeprüfung (${source}) verschoben: ${e.message}`);
        return 'busy';
      }
      result = ac.signal.aborted ? 'aborted' : 'error';
      error = shortError(e);
    }
    if (probe) {
      try {
        const v = ac.signal.aborted ? null : await probe.loginState(ac.signal);
        clearTimeout(deadline);
        menu = v;
        result = v === true ? 'ok' : v === false ? 'lost' : ac.signal.aborted ? 'aborted' : 'unclear';
        if (!ac.signal.aborted) {
          // Give the page time to renew the session: 2 s more after a refresh, else up to holdSec for one.
          const hold = new AbortController();
          seen.wake = () => hold.abort();
          if (seen.refresh) await sleep(2000, ac.signal);
          else await sleep(this.cfg.holdSec * 1000, AbortSignal.any([ac.signal, hold.signal]));
        }
      } catch (e) {
        if (result === 'unclear') {
          result = ac.signal.aborted ? 'aborted' : 'error';
          error = shortError(e);
        }
      } finally {
        seen.wake = () => {};
        closeMs = await probe.close().catch((e) => {
          error ??= `Schließen: ${shortError(e)}`;
          return undefined;
        });
      }
    }
    clearTimeout(deadline);
    if (timedOut && result === 'aborted') {
      result = 'error';
      error ??= `Zeitlimit (${RUN_LIMIT_MS / 1000} s)`;
    }
    // Logged-in menu, but the page's refresh of the same visit was refused: do not trust either – look again soon.
    if (result === 'ok' && seen.refresh && refreshEffect(seen.refresh.status) === 'lost') {
      result = 'unclear';
      this.lastConflict = true;
      log.warn(`🔐 quiz-base-Anmeldung (${source}): Menü angemeldet, aber Erneuerung abgelehnt (${seen.refresh.status}${seen.refresh.code ? ` ${seen.refresh.code}` : ''}) – prüfe in ${CONFLICT_RETRY_MS / MINUTE} min noch einmal`);
    }

    const c: LoginCheck = { at: iso(t0), source, result, ms: this.now() - t0 };
    if (probe) c.refresh = seen.refresh ?? 'none';
    if (menu !== undefined) c.menu = menu;
    if (closeMs !== undefined) c.closeMs = closeMs;
    if (error) c.error = error;
    const before = this.store.read();
    const r = this.store.record(c);
    const line = `🔐 quiz-base-Anmeldung (${source}): ${checkLine(c)}${r.after === 'lost' && result !== 'aborted' ? lostTail(before, this.now()) : ''}`;
    if (r.after === 'lost' && r.before !== 'lost') log.warn(line);
    else log.info(line);
    this.emitIfChanged(r, source);
    return result;
  }

  /**
   * Real probe: headless Chromium on the bot's profile, preemptible, never waits for the profile. An abort
   * (interrupt, preemption, stop, time limit) closes the browser at once – also while it is still starting or the
   * page hangs; close() still waits for a running token request (settle) before it frees the profile.
   */
  private async openBrowser(signal: AbortSignal, watch: ResponseWatch, onPreempt: () => void): Promise<KeeperProbe> {
    const c = this.d.config;
    const driver = new PlaywrightDriver({
      profileDir: c.browser.profileDir,
      headless: true,
      owner: 'keepalive',
      preemptible: true,
      onPreempt,
      lockWaitMs: 0,
      watch,
      navTimeoutMs: KEEPALIVE_NAV_MS,
    });
    const onAbort = () => void driver.close().catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error('Anmeldeprüfung abgebrochen');
      await driver.open(c.baseUrl);
    } catch (e) {
      signal.removeEventListener('abort', onAbort);
      await driver.close().catch(() => {});
      throw e;
    }
    const page = new BoardEditorPage(driver, c.baseUrl);
    return {
      loginState: async (sig) => {
        await sleep(1500, sig);
        return sig.aborted ? null : page.loginState({ signal: sig });
      },
      close: async () => {
        signal.removeEventListener('abort', onAbort);
        await driver.close();
        return driver.lastCloseMs ?? 0;
      },
    };
  }

  private onAuth(e: AuthEvent, source: AuthSource, applyState: boolean): void {
    const r = this.store.noteAuth(e, source, { applyState });
    const where = SOURCE_LABEL[source];
    const code = `${e.status}${e.code ? ` ${e.code}` : ''}`;
    if (e.kind === 'refresh' && e.ok) {
      // A 200 renews whatever session the page has – also an anonymous one. Whether the account is logged in only
      // the menu says (the state), so the line claims nothing more.
      if (applyState) log.info(`🔐 Token-Erneuerung der Seite (${code}, ${where})${r.after === 'ok' ? '' : ' – Konto nicht bestätigt, evtl. anonyme Sitzung'}`);
    } else if (e.kind === 'refresh' && !e.ok) log.warn(`🔐 Seite: Sitzungserneuerung abgelehnt (${code}, ${where})`);
    else if (e.kind === 'signup') log.warn(`🔐 Seite hat eine anonyme Sitzung angelegt (${where})`);
    else if (e.kind === 'logout') log.warn(`🔐 Seite hat sich abgemeldet (${where})`);
    else if (e.kind === 'login') log.info(`🔐 Seite: Anmeldung ${e.ok ? 'erfolgreich' : `abgelehnt (${code})`} (${where})`);
    else log.debug(`🔐 Seite: Benutzer abgefragt (${code}, ${where})`);
    if (applyState) this.emitIfChanged(r, source);
  }

  private emitIfChanged(r: StoreUpdate, source: string): void {
    if (r.before === r.after) return;
    const change: LoginChange = { before: r.before, after: r.after, source, notifiedLostAt: r.notifiedLostAt };
    for (const cb of [this.d.onChange, ...this.listeners]) {
      if (!cb) continue;
      try {
        cb(r.status, change);
      } catch (e) {
        log.warn(`Anmeldestatus-Meldung fehlgeschlagen: ${(e as Error).message}`);
      }
    }
  }
}

// ───────────────────────────── formatting ─────────────────────────────

const SOURCE_LABEL: Record<AuthSource, string> = {
  start: 'Start',
  keepalive: 'Keep-alive',
  'after-game': 'nach dem Spiel',
  'board-create': 'Board-Anlage',
  lobby: 'Lobby',
  login: 'Anmeldung',
  page: 'Seite',
  game: 'Spiel',
  board: 'Board-Anlage',
};

/** German label of a check or auth source ("Keep-alive", "Spiel", …) – for the loss DM. */
export function loginSourceLabel(source: string): string {
  return SOURCE_LABEL[source as AuthSource] ?? source;
}

const RESULT_LABEL: Record<LoginCheck['result'], string> = {
  ok: 'angemeldet',
  lost: 'abgemeldet',
  unclear: 'unklar',
  aborted: 'abgebrochen',
  error: 'Fehler',
  busy: 'Profil belegt',
};

/** First line of an error, without URLs (they can carry project refs or queries), at most 160 characters. */
export function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return (msg.split('\n')[0] ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<URL>').slice(0, 160);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '')} s`;

function refreshText(r: LoginCheck['refresh']): string | null {
  if (!r) return null;
  if (r === 'none') return 'keine Erneuerung';
  return refreshEffect(r.status) === 'ok' ? `Token erneuert (${r.status})` : `Erneuerung abgelehnt (${r.status}${r.code ? ` ${r.code}` : ''})`;
}

function checkLine(c: LoginCheck): string {
  const parts = [c.error && c.result === 'error' ? `Fehler: ${c.error}` : RESULT_LABEL[c.result]];
  const r = refreshText(c.refresh);
  if (r) parts.push(r);
  if (c.ms) parts.push(seconds(c.ms));
  if (c.closeMs !== undefined) parts.push(`Browser zu in ${seconds(c.closeMs)}`);
  return parts.join(' · ');
}

/** Last successful refresh since the login was confirmed (okSince) – an earlier one may be an anonymous session's. */
function renewalSinceOk(s: LoginStatus): AuthRecord | undefined {
  if (!s.okSince) return undefined;
  const since = Date.parse(s.okSince);
  return [...s.authHistory].reverse().find((a) => a.kind === 'refresh' && refreshEffect(a.status) === 'ok' && Date.parse(a.at) >= since);
}

function lastRenewal(s: LoginStatus): string | null {
  return renewalSinceOk(s)?.at ?? s.okSince;
}

function lostTail(before: LoginStatus, now: number): string {
  if (!before.okSince) return '';
  const renewed = lastRenewal(before);
  const hours = renewed ? Math.round((now - Date.parse(renewed)) / HOUR) : null;
  return ` · angemeldet seit ${when(before.okSince, now)}${hours !== null ? ` (seit ${hours} h ohne Erneuerung)` : ''}`;
}

const TIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function parts(ms: number): Record<string, string> {
  return Object.fromEntries(TIME.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Berlin time (the server runs in UTC): "14:02" today, otherwise "20.11. 15:08". */
export function when(at: string | number, now: number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '?';
  const a = parts(ms);
  const b = parts(now);
  const time = `${a.hour}:${a.minute}`;
  return a.day === b.day && a.month === b.month && a.year === b.year ? time : `${a.day}.${a.month}. ${time}`;
}

export function loginStatusIcon(s: LoginStatus): string {
  return s.state === 'ok' ? '✅' : s.state === 'lost' ? '❌' : 'ℹ️';
}

/** One German line for `doctor` and `!quiz status`. Contains no tokens, no URLs, no game content. */
export function formatLoginStatus(s: LoginStatus, now: number, loginCommand: string): string {
  const head = 'quiz-base-Anmeldung: ';
  const last = s.history[s.history.length - 1];
  if (s.state === 'lost') {
    const r = [...s.authHistory].reverse().find((a) => a.kind === 'refresh');
    const why = r && refreshEffect(r.status) === 'lost' ? ` (Erneuerung abgelehnt: ${r.status}${r.code ? ` ${r.code}` : ''})` : '';
    return `${head}abgemeldet seit ${s.lostAt ? when(s.lostAt, now) : '?'}${why} → ${loginCommand}`;
  }
  if (s.state === 'ok') {
    const bits: string[] = [];
    if (s.lastCheckAt) bits.push(`geprüft ${when(s.lastCheckAt, now)}${last ? ` ${SOURCE_LABEL[last.source]}` : ''}`);
    const renewed = renewalSinceOk(s);
    if (renewed) bits.push(`erneuert ${when(renewed.at, now)}`);
    if (s.nextDueAt) bits.push(`nächste Prüfung ~${when(s.nextDueAt, now)}`);
    return `${head}angemeldet${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }
  if (!s.lastCheckAt || !last) return `${head}noch nicht geprüft`;
  return `${head}unklar (zuletzt geprüft ${when(s.lastCheckAt, now)} ${SOURCE_LABEL[last.source]}: ${RESULT_LABEL[last.result]})`;
}

/** The last `n` checks as short lines (doctor). */
export function formatLoginHistory(s: LoginStatus, now: number, n = 5): string[] {
  return s.history.slice(-n).map((c) => `${when(c.at, now)} ${SOURCE_LABEL[c.source]}: ${checkLine(c)}`);
}
