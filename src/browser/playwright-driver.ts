import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Browser, type Request } from 'playwright';
import { sleep } from '../core/logger.ts';
import { jsonWrap, parseJsonResult, readWatchedResponse, type BrowserDriver, type ResponseWatch } from './driver.ts';
import { profileLock, type LockOwner, type ProfileLease } from './profile-lock.ts';

export { readWatchedResponse } from './driver.ts';

const LAUNCH_ARGS = [
  // Host must be able to start YouTube audio without a real user gesture.
  '--autoplay-policy=no-user-gesture-required',
];

export interface PlaywrightDriverOptions {
  profileDir: string;
  headless: boolean;
  /**
   * Also opens Chromium's DevTools port (only for `qbhost login --remote-stdio`). Chromium binds it to
   * 127.0.0.1 and keeps its Host and Origin checks, so web pages cannot reach it.
   */
  remoteDebuggingPort?: number;
  /** Who holds the profile lock while this browser is open (default `other`). */
  owner?: LockOwner;
  /** May be asked to give the profile back early (the idle keep-alive). */
  preemptible?: boolean;
  /** Called once when somebody else waits for the profile (only with `preemptible`). */
  onPreempt?: () => void;
  /** How long `open()` waits for the profile (default 20 000; 0 = fail at once with ProfileBusyError). */
  lockWaitMs?: number;
  /** Passively follows the page's own requests (status, error code) – see ResponseWatch. */
  watch?: ResponseWatch;
}

/** Chromium arguments for the given options. */
export function launchArgs(opts: Pick<PlaywrightDriverOptions, 'remoteDebuggingPort'>): string[] {
  const args = [...LAUNCH_ARGS];
  if (opts.remoteDebuggingPort) args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`, '--remote-debugging-address=127.0.0.1');
  return args;
}

/** Every PlaywrightDriver with an open browser (for the last safety net on shutdown). */
const OPEN = new Set<PlaywrightDriver>();

/**
 * Launches its own (visible) Chromium with a persistent profile. Holds the profile lock from `open()` to the
 * end of `close()` – also when the launch, the first page load or the close fails.
 */
export class PlaywrightDriver implements BrowserDriver {
  readonly name = 'playwright';
  private context?: BrowserContext;
  private page?: Page;
  private lease?: ProfileLease;
  private closing: Promise<void> | null = null;
  private inflight = new Set<Request>();
  private lastWatchedAt = 0;
  private closeMs: number | null = null;
  /** open() is waiting for the profile or launching; a close() meanwhile cancels it. */
  private opening = false;
  private cancelOpen = false;

  constructor(private opts: PlaywrightDriverOptions) {}

  /** Duration of the last `close()` in ms (waiting for watched requests included); null before the first close. */
  get lastCloseMs(): number | null {
    return this.closeMs;
  }

  async open(url?: string): Promise<void> {
    if (this.context) {
      if (url) await this.goto(url);
      return;
    }
    this.opening = true;
    this.cancelOpen = false;
    try {
      await this.launch();
    } finally {
      this.opening = false;
    }
    try {
      if (this.cancelOpen) throw new Error('Browser wurde beim Öffnen geschlossen');
      if (this.opts.watch) this.follow(this.context!, this.opts.watch);
      this.page = this.context!.pages()[0] ?? (await this.context!.newPage());
      if (url) await this.goto(url);
    } catch (e) {
      // Nobody may hold an open browser they do not know about – close it, free the profile.
      await this.close().catch(() => {});
      throw e;
    }
  }

  private async launch(): Promise<void> {
    const lease = await profileLock(this.opts.profileDir).acquire(this.opts.owner ?? 'other', {
      preemptible: this.opts.preemptible,
      onPreempt: this.opts.onPreempt,
      waitMs: this.opts.lockWaitMs,
    });
    try {
      if (this.cancelOpen) throw new Error('Browser wurde beim Öffnen geschlossen');
      this.context = await chromium.launchPersistentContext(path.resolve(this.opts.profileDir), {
        headless: this.opts.headless,
        viewport: this.opts.headless ? { width: 1440, height: 1000 } : null,
        args: launchArgs(this.opts),
        // Our own shutdown ends the game on quiz-base and closes the browser. Playwright's handlers would
        // close it first and, on SIGINT, call process.exit(130) – no clean end of the game, no goodbye.
        // (The browser still dies with the process: Playwright's exit hook stays.)
        handleSIGINT: false,
        handleSIGTERM: false,
      });
    } catch (e) {
      lease.release();
      throw e;
    }
    this.lease = lease;
    OPEN.add(this);
  }

  /** Counts watched requests while they run and reports their responses (status, error code only). */
  private follow(context: BrowserContext, watch: ResponseWatch): void {
    // Preflights carry no answer of the auth server – only the real request counts.
    const watched = (r: Request) => r.method() !== 'OPTIONS' && watch.match(r.url());
    const done = (r: Request) => {
      if (this.inflight.delete(r)) this.lastWatchedAt = Date.now();
    };
    context.on('request', (r) => {
      if (!watched(r)) return;
      this.inflight.add(r);
      this.lastWatchedAt = Date.now();
    });
    context.on('requestfinished', done);
    context.on('requestfailed', done);
    context.on('response', (res) => {
      const req = res.request();
      if (!watched(req)) return;
      const url = res.url();
      void readWatchedResponse(res.status(), () => res.json())
        .then((r) => watch.onResponse({ url, ...r }))
        .catch(() => {});
    });
  }

  private get p(): Page {
    if (!this.page) throw new Error('Browser not opened');
    return this.page;
  }

  async goto(url: string): Promise<void> {
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async currentUrl(): Promise<string> {
    return this.p.url();
  }

  async evaluate<T>(expression: string): Promise<T> {
    return parseJsonResult<T>(await this.p.evaluate(jsonWrap(expression)));
  }

  async screenshot(file: string): Promise<string> {
    await this.p.screenshot({ path: file });
    return file;
  }

  /**
   * Waits for watched requests still running (≤ settleMs, then a short pause so the page can store a new
   * token), closes the browser and always frees the profile. Concurrent calls share one close.
   */
  close(): Promise<void> {
    if (this.opening) this.cancelOpen = true;
    this.closing ??= this.doClose().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    const t0 = Date.now();
    try {
      if (ctx) {
        if (this.opts.watch) await this.settle(this.opts.watch.settleMs ?? 5000);
        await ctx.close();
      }
    } finally {
      if (ctx) this.closeMs = Date.now() - t0;
      this.inflight.clear();
      OPEN.delete(this);
      const lease = this.lease;
      this.lease = undefined;
      lease?.release();
    }
  }

  private async settle(settleMs: number): Promise<void> {
    const end = Date.now() + settleMs;
    while (this.inflight.size && Date.now() < end) await sleep(100);
    // A finished refresh: give the page a moment to write the new session (cookie) before the browser goes.
    const quiet = 500 - (Date.now() - this.lastWatchedAt);
    if (this.lastWatchedAt && quiet > 0) await sleep(quiet);
  }
}

/**
 * Closes every open PlaywrightDriver in parallel, giving up after `timeoutMs`. Returns how many were open.
 * Last safety net on shutdown: a browser killed with the process loses what it has not written yet.
 */
export async function closeOpenBrowsers(timeoutMs: number): Promise<number> {
  const open = [...OPEN];
  if (!open.length) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(open.map((d) => d.close())),
    new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return open.length;
}

/** Number of open PlaywrightDrivers (diagnostics, tests). */
export function openBrowserCount(): number {
  return OPEN.size;
}

/** Attaches to an already running Chrome (`--remote-debugging-port=9222`). */
export class CdpDriver implements BrowserDriver {
  readonly name = 'cdp';
  private browser?: Browser;
  private page?: Page;

  constructor(private opts: { cdpUrl: string; baseUrl: string }) {}

  async open(url?: string): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.opts.cdpUrl);
    const pages = this.browser.contexts().flatMap((c) => c.pages());
    this.page = pages.find((p) => p.url().includes('quiz-base.de')) ?? pages[0];
    if (!this.page) {
      const ctx = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.page = await ctx.newPage();
    }
    if (url && !this.page.url().includes('quiz-base.de')) await this.goto(url);
  }

  private get p(): Page {
    if (!this.page) throw new Error('Browser not attached');
    return this.page;
  }

  async goto(url: string): Promise<void> {
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async currentUrl(): Promise<string> {
    return this.p.url();
  }

  async evaluate<T>(expression: string): Promise<T> {
    return parseJsonResult<T>(await this.p.evaluate(jsonWrap(expression)));
  }

  async screenshot(file: string): Promise<string> {
    await this.p.screenshot({ path: file });
    return file;
  }

  async close(): Promise<void> {
    // Never close the user's own Chrome – just detach.
    await this.browser?.close().catch(() => {});
  }
}
