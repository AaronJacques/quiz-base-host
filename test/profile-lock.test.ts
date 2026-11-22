import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOpenBrowsers, openBrowserCount, PlaywrightDriver } from '../src/browser/playwright-driver.ts';
import { ProfileBusyError, profileLock, ProfileLock } from '../src/browser/profile-lock.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfileLock', () => {
  it('one after the other', async () => {
    const lock = new ProfileLock();
    const a = await lock.acquire('game');
    expect(lock.holder).toBe('game');
    a.release();
    expect(lock.holder).toBeNull();
    const b = await lock.acquire('board');
    expect(lock.holder).toBe('board');
    b.release();
  });

  it('a second caller waits until the first releases (FIFO)', async () => {
    const lock = new ProfileLock();
    const a = await lock.acquire('game');
    const order: string[] = [];
    const b = lock.acquire('board').then((l) => (order.push('board'), l));
    const c = lock.acquire('other').then((l) => (order.push('other'), l));
    await Promise.resolve();
    expect(order).toEqual([]);
    a.release();
    (await b).release();
    (await c).release();
    expect(order).toEqual(['board', 'other']);
  });

  it('asks a preemptible holder once, then hands the profile to the waiter', async () => {
    const lock = new ProfileLock();
    const onPreempt = vi.fn();
    const keep = await lock.acquire('keepalive', { preemptible: true, onPreempt });
    const game = lock.acquire('game');
    const board = lock.acquire('board');
    expect(onPreempt).toHaveBeenCalledTimes(1);
    keep.release();
    const g = await game;
    expect(g.owner).toBe('game');
    expect(onPreempt).toHaveBeenCalledTimes(1);
    g.release();
    (await board).release();
  });

  it('a non-preemptible holder is never preempted: ProfileBusyError after waitMs', async () => {
    vi.useFakeTimers();
    const lock = new ProfileLock();
    const onPreempt = vi.fn();
    const game = await lock.acquire('game', { onPreempt });
    const waiting = lock.acquire('board', { waitMs: 20_000 });
    const caught = waiting.catch((e) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(lock.holder).toBe('game');
    await vi.advanceTimersByTimeAsync(1);
    const err = await caught;
    expect(err).toBeInstanceOf(ProfileBusyError);
    expect(err.message).toMatch(/Browser-Profil ist gerade belegt \(Spiel\)/);
    expect(onPreempt).not.toHaveBeenCalled();
    game.release();
    // The timed-out waiter is gone from the queue: the profile is free again.
    expect(lock.holder).toBeNull();
  });

  it('waitMs 0 on a busy profile fails at once', async () => {
    const lock = new ProfileLock();
    const game = await lock.acquire('game');
    await expect(lock.acquire('keepalive', { waitMs: 0 })).rejects.toBeInstanceOf(ProfileBusyError);
    game.release();
  });

  it('two paths are independent, the same path (also relative) shares one lock', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qblock-'));
    const a = profileLock(path.join(dir, 'profile'));
    expect(profileLock(path.join(dir, 'profile-search'))).not.toBe(a);
    expect(profileLock(path.relative(process.cwd(), path.join(dir, 'profile')))).toBe(a);
    const l1 = await a.acquire('game');
    const l2 = await profileLock(path.join(dir, 'profile-search')).acquire('other', { waitMs: 0 });
    l1.release();
    l2.release();
  });

  it('release twice is harmless (does not free the next holder)', async () => {
    const lock = new ProfileLock();
    const a = await lock.acquire('game');
    const b = lock.acquire('board');
    a.release();
    const lb = await b;
    a.release();
    expect(lock.holder).toBe('board');
    lb.release();
    lb.release();
    expect(lock.holder).toBeNull();
  });
});

describe('PlaywrightDriver and the profile lock (without Chromium)', () => {
  it('a failing launch releases the profile', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qblock-'));
    // A file where the profile directory should be: launchPersistentContext fails before any browser starts.
    const profileDir = path.join(dir, 'not-a-dir');
    (await import('node:fs')).writeFileSync(profileDir, 'x');
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'game' });
    await expect(d.open()).rejects.toThrow();
    expect(profileLock(profileDir).holder).toBeNull();
    expect(openBrowserCount()).toBe(0);
    await d.close(); // harmless
    expect(profileLock(profileDir).holder).toBeNull();
  }, 30000);

  it('a driver waiting for the profile gives up with ProfileBusyError and holds nothing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qblock-'));
    const profileDir = path.join(dir, 'profile');
    const game = await profileLock(profileDir).acquire('game');
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'keepalive', lockWaitMs: 0 });
    await expect(d.open()).rejects.toBeInstanceOf(ProfileBusyError);
    expect(profileLock(profileDir).holder).toBe('game');
    game.release();
  });

  it('close() while open() still waits for the profile cancels the open', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qblock-'));
    const profileDir = path.join(dir, 'profile');
    const game = await profileLock(profileDir).acquire('game');
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'board' });
    const opening = d.open().catch((e) => e);
    await d.close();
    game.release();
    const err = await opening;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/beim Öffnen geschlossen/);
    expect(profileLock(profileDir).holder).toBeNull();
  });

  it('closeOpenBrowsers with nothing open returns 0 at once', async () => {
    expect(await closeOpenBrowsers(1000)).toBe(0);
  });
});

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)('PlaywrightDriver with Chromium: lock, passive watch, close', () => {
  it('holds the profile while open, reports watched responses (status + code only), waits for a running request on close', async () => {
    const seenBodies: string[] = [];
    const site = http.createServer((req, res) => {
      if (req.url === '/auth/bad') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error_code: 'session_expired', msg: 'x' }));
      }
      if (req.url === '/auth/good') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'SECRET-TOKEN', refresh_token: 'SECRET-REFRESH' }));
      }
      if (req.url === '/auth/slow') {
        // A token refresh still running when the browser is closed.
        setTimeout(() => {
          seenBodies.push('slow-done');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }, 1200);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>test</h1></body></html>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const responses: { url: string; status: number; errorCode?: string }[] = [];
    const d = new PlaywrightDriver({
      profileDir,
      headless: true,
      owner: 'game',
      watch: { match: (u) => u.includes('/auth/'), onResponse: (r) => responses.push(r), settleMs: 5000 },
    });
    try {
      await d.open(base);
      expect(profileLock(profileDir).holder).toBe('game');
      // Never two browsers on one profile.
      await expect(new PlaywrightDriver({ profileDir, headless: true, owner: 'keepalive', lockWaitMs: 0 }).open()).rejects.toBeInstanceOf(ProfileBusyError);
      await d.evaluate(`(fetch('/auth/bad'), fetch('/auth/good'), 1)`);
      for (let i = 0; i < 50 && responses.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      expect(responses.map((r) => [r.status, r.errorCode]).sort()).toEqual([
        [200, undefined],
        [400, 'session_expired'],
      ]);
      expect(JSON.stringify(responses)).not.toContain('SECRET');
      await d.evaluate(`(fetch('/auth/slow'), 1)`);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await d.close();
      site.close();
    }
    expect(seenBodies).toEqual(['slow-done']); // close waited for it
    expect(d.lastCloseMs).toBeGreaterThanOrEqual(900);
    expect(profileLock(profileDir).holder).toBeNull();
    expect(openBrowserCount()).toBe(0);
  }, 60000);

  it('closeOpenBrowsers closes every open browser and frees the profiles', async () => {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'qbprofile-'));
    const d = new PlaywrightDriver({ profileDir, headless: true, owner: 'board' });
    await d.open();
    expect(openBrowserCount()).toBe(1);
    expect(await closeOpenBrowsers(10_000)).toBe(1);
    expect(openBrowserCount()).toBe(0);
    expect(profileLock(profileDir).holder).toBeNull();
    await d.close(); // harmless afterwards
  }, 60000);
});
