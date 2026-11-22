// The real keep-alive browser (AccountKeeper without a fake probe) and PlaywrightDriver's failure paths, against a
// local HTTP server with throwaway profiles. Never quiz-base, never the real profile.
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountKeeper, LoginStatusStore } from '../src/account.ts';
import { closeOpenBrowsers, openBrowserCount, PlaywrightDriver } from '../src/browser/playwright-driver.ts';
import { profileLock } from '../src/browser/profile-lock.ts';
import { ConfigSchema } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';

setLogLevel('error');

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  await closeOpenBrowsers(10_000);
});

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
}

function keeperFor(baseUrl: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qbkeep-'));
  const config = ConfigSchema.parse({ baseUrl, browser: { headless: true, profileDir: path.join(dir, 'profile') }, account: { statusFile: path.join(dir, 'status.json'), holdSec: 5 } });
  const store = new LoginStatusStore(config.account.statusFile);
  return { config, store, keeper: new AccountKeeper({ config, store }), profileDir: config.browser.profileDir };
}

async function until(pred: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasChromium)('A1-F1: the keep-alive gives the profile back at once', () => {
  it('preempted while the page still loads: the game gets the profile within seconds, not a ProfileBusyError', async () => {
    const base = await serve((_req, res) => {
      setTimeout(() => res.end('<html><body>langsam</body></html>'), 25_000);
    });
    const { keeper, profileDir } = keeperFor(base);
    const run = keeper.check('keepalive');
    await until(() => profileLock(profileDir).holder === 'keepalive');
    await new Promise((r) => setTimeout(r, 1500)); // Chromium started, goto running
    const t0 = Date.now();
    const game = await profileLock(profileDir).acquire('game', { waitMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await run).toBe('aborted');
    expect(openBrowserCount()).toBe(0);
    game.release();
  }, 60_000);

  it('preempted while the page hangs (evaluate never returns): the game still gets the profile', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>hängt</h1><script>setTimeout(() => { for (;;) {} }, 200)</script></body></html>');
    });
    const { keeper, profileDir } = keeperFor(base);
    const run = keeper.check('keepalive');
    await until(() => profileLock(profileDir).holder === 'keepalive');
    await new Promise((r) => setTimeout(r, 4000)); // menu read (after 1.5 s) is stuck in evaluate
    const t0 = Date.now();
    const game = await profileLock(profileDir).acquire('game', { waitMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await run).toBe('aborted');
    game.release();
  }, 60_000);

  it('stop() with a hanging page: afterwards the profile is free and no browser is open', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><script>setTimeout(() => { for (;;) {} }, 200)</script></body></html>');
    });
    const { keeper, profileDir } = keeperFor(base);
    keeper.start();
    void keeper.check('keepalive');
    await until(() => profileLock(profileDir).holder === 'keepalive');
    await new Promise((r) => setTimeout(r, 4000));
    await keeper.stop();
    expect(profileLock(profileDir).holder).toBeNull();
    expect(openBrowserCount()).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasChromium)('A1-F6/F7: PlaywrightDriver failure paths free the profile', () => {
  it('close() during the Chromium start returns only when the browser is closed', async () => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'game' });
    const opening = d.open().catch((e) => e);
    await new Promise((r) => setImmediate(r));
    expect(profileLock(profileDir).holder).toBe('game');
    await d.close();
    expect(openBrowserCount()).toBe(0);
    expect(profileLock(profileDir).holder).toBeNull();
    expect((await opening).message).toMatch(/beim Öffnen geschlossen/);
  }, 60_000);

  it('goto fails → profile free, nothing open (A1-F7b)', async () => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'board' });
    await expect(d.open('http://127.0.0.1:1/')).rejects.toThrow();
    expect(profileLock(profileDir).holder).toBeNull();
    expect(openBrowserCount()).toBe(0);
  }, 60_000);

  it('context.close() throws → profile free anyway (A1-F7c)', async () => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'game' });
    await d.open();
    const ctx = (d as any).context;
    const real = ctx.close.bind(ctx);
    ctx.close = async () => {
      await real();
      throw new Error('kaputt');
    };
    await expect(d.close()).rejects.toThrow('kaputt');
    expect(profileLock(profileDir).holder).toBeNull();
    expect(openBrowserCount()).toBe(0);
  }, 60_000);

  it('context.close() hangs → after closeTimeoutMs the profile is free', async () => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'game', closeTimeoutMs: 500 });
    await d.open();
    const ctx = (d as any).context;
    const real = ctx.close.bind(ctx);
    ctx.close = () => new Promise<void>(() => {});
    const t0 = Date.now();
    await expect(d.close()).rejects.toThrow('Browser schließt nicht');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(profileLock(profileDir).holder).toBeNull();
    await real();
  }, 60_000);
});
