import { afterEach, describe, expect, it, vi } from 'vitest';
import { onStopSignal } from '../src/core/signals.ts';

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
