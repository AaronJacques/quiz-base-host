import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
import { jsonWrap, parseJsonResult, type BrowserDriver } from './driver.ts';

const run = promisify(execFile);

interface OrcaReply<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

/**
 * Drives a tab in Orca's built-in browser through the `orca` CLI, so the game
 * is visible inside Orca next to the agent. Each call is one short CLI
 * invocation (~250 ms), which is fine for a 500 ms poll loop.
 */
export class OrcaDriver implements BrowserDriver {
  readonly name = 'orca';
  private pageId?: string;

  constructor(private opts: { bin: string; pageId?: string }) {
    this.pageId = opts.pageId;
  }

  private async orca<T>(args: string[]): Promise<T> {
    const { stdout } = await run(this.opts.bin, [...args, '--json'], { maxBuffer: 20 * 1024 * 1024 });
    const reply = JSON.parse(stdout) as OrcaReply<T>;
    if (!reply.ok) throw new Error(`orca ${args[0]} failed: ${reply.error?.code ?? ''} ${reply.error?.message ?? stdout}`);
    return reply.result as T;
  }

  private get page(): string {
    if (!this.pageId) throw new Error('Orca tab not opened');
    return this.pageId;
  }

  async open(url?: string): Promise<void> {
    if (this.pageId) {
      if (url) {
        const current = await this.currentUrl().catch(() => '');
        if (!current.includes('quiz-base.de')) await this.goto(url);
      }
      return;
    }
    const res = await this.orca<{ browserPageId: string }>(['tab', 'create', '--url', url ?? 'about:blank']);
    this.pageId = res.browserPageId;
    await this.orca(['wait', '--page', this.page, '--load', 'load']).catch(() => {});
  }

  async goto(url: string): Promise<void> {
    await this.orca(['goto', '--page', this.page, '--url', url]);
    await this.orca(['wait', '--page', this.page, '--load', 'load']).catch(() => {});
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.orca<{ result: unknown }>(['eval', '--page', this.page, '--expression', jsonWrap(expression)]);
    return parseJsonResult<T>(res.result);
  }

  async screenshot(file: string): Promise<string> {
    const res = await this.orca<{ path: string }>(['screenshot', '--page', this.page]);
    await copyFile(res.path, file);
    return file;
  }

  async close(): Promise<void> {
    // Leave the tab open – it belongs to the user's Orca workspace.
  }
}
