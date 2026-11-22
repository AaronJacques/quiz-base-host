import { afterEach, describe, expect, it, vi } from 'vitest';
import { fatalErrorHandler, onFatalError, onStopSignal } from '../src/core/signals.ts';

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
  vi.useRealTimers();
});

describe('onStopSignal', () => {
  it('one SIGTERM → stop once', async () => {
    const stop = vi.fn();
    const exit = vi.fn();
    off = onStopSignal(stop, { exit });
    process.emit('SIGTERM' as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('a repeat within graceMs is ignored', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const beforeForceExit = vi.fn(async () => {});
    off = onStopSignal(stop, { exit, graceMs: 2000, beforeForceExit });
    process.emit('SIGINT' as any);
    await vi.advanceTimersByTimeAsync(1000);
    process.emit('SIGINT' as any);
    await vi.advanceTimersByTimeAsync(100);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(beforeForceExit).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a second signal after graceMs closes the browsers first, then exit(130)', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let closed = () => {};
    const exit = vi.fn((c: number) => void order.push(`exit ${c}`));
    off = onStopSignal(() => new Promise<void>(() => {}), {
      exit,
      graceMs: 2000,
      beforeForceExit: () => new Promise<void>((r) => (closed = () => (order.push('browsers closed'), r()))),
    });
    process.emit('SIGTERM' as any);
    await vi.advanceTimersByTimeAsync(2500);
    process.emit('SIGTERM' as any);
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).not.toHaveBeenCalled();
    closed();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['browsers closed', 'exit 130']);
  });

  it('a hanging beforeForceExit: exit after forceTimeoutMs', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    off = onStopSignal(() => new Promise<void>(() => {}), { exit, graceMs: 100, forceTimeoutMs: 3000, beforeForceExit: () => new Promise(() => {}) });
    process.emit('SIGINT' as any);
    await vi.advanceTimersByTimeAsync(200);
    process.emit('SIGINT' as any);
    await vi.advanceTimersByTimeAsync(2999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('a third signal while the browsers close exits at once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    off = onStopSignal(() => new Promise<void>(() => {}), { exit, graceMs: 100, beforeForceExit: () => new Promise(() => {}) });
    process.emit('SIGINT' as any);
    await vi.advanceTimersByTimeAsync(200);
    process.emit('SIGINT' as any);
    process.emit('SIGINT' as any);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('the returned function removes the handlers', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const stop = vi.fn();
    const remove = onStopSignal(stop, { exit: vi.fn() });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual([before[0]! + 1, before[1]! + 1]);
    remove();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('stop budget on the server', () => {
  it('Docker gives the bot 60 s (compose and the login script)', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8')).toMatch(/^\s*stop_grace_period: 60s$/m);
    const script = readFileSync(new URL('../tools/server-login.sh', import.meta.url), 'utf8');
    expect(script).toContain('d stop -t 60 "$bot"');
    expect(script).not.toContain('stop -t 40');
  });
});

describe('fatalErrorHandler / onFatalError (uncaught exception)', () => {
  it('reports, closes the browsers first, then exit(1)', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let closed = () => {};
    const handler = fatalErrorHandler(() => new Promise<void>((r) => (closed = () => (order.push('browsers closed'), r()))), {
      exit: (c) => void order.push(`exit ${c}`),
      report: (t) => void order.push(t.split(':')[0]!),
    });
    handler(new Error('boom'));
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['❌ Unerwarteter Fehler – schließe die Browser und beende']);
    closed();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['❌ Unerwarteter Fehler – schließe die Browser und beende', 'browsers closed', 'exit 1']);
  });

  it('a hanging close: exit after timeoutMs; a second exception exits at once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const handler = fatalErrorHandler(() => new Promise(() => {}), { exit, timeoutMs: 3000, report: () => {} });
    handler(new Error('a'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(exit).not.toHaveBeenCalled();
    handler(new Error('b'));
    expect(exit).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it('onFatalError installs one uncaughtException listener and removes it again', () => {
    const before = process.listenerCount('uncaughtException');
    const off = onFatalError(async () => {}, { exit: vi.fn(), report: () => {} });
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    off();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('cli wires it for discord and host, closing the browsers', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli.match(/onFatalError\(\(\) => closeOpenBrowsers\(3000\)/g)?.length).toBe(2);
  });
});

describe('fatalErrorHandler keeps secrets out of the log (A1-F11)', () => {
  const TOKEN = 'MTA5ODc2NTQzMjEw.GaBcDe.discord-token-xyz';

  it('by default blanks out secret environment variables in message and stack', () => {
    const before = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = TOKEN;
    try {
      const lines: string[] = [];
      const handler = fatalErrorHandler(async () => {}, { exit: () => {}, report: (t) => void lines.push(t) });
      const e = new Error(`401 for ${TOKEN}`);
      e.stack = `Error: 401 for ${TOKEN}\n    at login (ws.js:1:1) Bot ${TOKEN}`;
      handler(e);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(TOKEN);
      expect(lines[0]).toContain('401 for ***');
      expect(lines[0]).toContain('at login');
    } finally {
      if (before === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = before;
    }
  });

  it('uses the secrets it is given (cli passes the config-aware list)', () => {
    const lines: string[] = [];
    const handler = fatalErrorHandler(async () => {}, { exit: () => {}, report: (t) => void lines.push(t), secrets: () => ['custom-secret-value'] });
    handler(new Error('oops custom-secret-value'));
    expect(lines[0]).toContain('oops ***');
  });

  it('cli and the Discord bot use the shared helper (no own redaction)', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli.match(/secrets: \(\) => secretValues\(config\)/g)?.length).toBe(2);
    const bot = readFileSync(new URL('../src/discord/index.ts', import.meta.url), 'utf8');
    expect(bot).toContain('redactedError(e, [token, ...secretValues(config)])');
    expect(bot).not.toMatch(/function redact\(/);
  });
});
