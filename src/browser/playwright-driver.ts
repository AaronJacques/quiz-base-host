import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Browser } from 'playwright';
import { jsonWrap, parseJsonResult, type BrowserDriver } from './driver.ts';

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
}

/** Chromium arguments for the given options. */
export function launchArgs(opts: Pick<PlaywrightDriverOptions, 'remoteDebuggingPort'>): string[] {
  const args = [...LAUNCH_ARGS];
  if (opts.remoteDebuggingPort) args.push(`--remote-debugging-port=${opts.remoteDebuggingPort}`, '--remote-debugging-address=127.0.0.1');
  return args;
}

/** Launches its own (visible) Chromium with a persistent profile. */
export class PlaywrightDriver implements BrowserDriver {
  readonly name = 'playwright';
  private context?: BrowserContext;
  private page?: Page;

  constructor(private opts: PlaywrightDriverOptions) {}

  async open(url?: string): Promise<void> {
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
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    if (url) await this.goto(url);
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

  async close(): Promise<void> {
    await this.context?.close();
  }
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
