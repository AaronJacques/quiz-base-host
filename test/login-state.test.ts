import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideLogin, loginStateWith } from '../src/site/editor/page.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('decideLogin', () => {
  const r = (value: boolean | null, at = 0) => ({ at, value });
  it('true on the first true', () => expect(decideLogin([r(true)])).toBe(true));
  it('only unclear reads → null', () => expect(decideLogin([r(null), r(null, 2500), r(null, 5000)])).toBeNull());
  it('one "logged out" alone is not enough', () => expect(decideLogin([r(false)])).toBeNull());
  it('two "logged out" ≥ 2 s apart → false', () => expect(decideLogin([r(false, 0), r(false, 2500)])).toBe(false));
  it('"logged out" then "logged in" → true', () => expect(decideLogin([r(false, 0), r(true, 2500)])).toBe(true));
  it('two "logged out" too close together → null', () => expect(decideLogin([r(false, 0), r(false, 500)])).toBeNull());
  it('an unclear read in between does not matter', () => expect(decideLogin([r(false, 0), r(null, 2500), r(false, 5000)])).toBe(false));
});

describe('loginStateWith', () => {
  it('stops at the first true', async () => {
    const read = vi.fn().mockResolvedValue(true);
    expect(await loginStateWith(read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('false needs a second read 2.5 s later', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(false);
    const p = loginStateWith(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await p).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a slow page: unclear, unclear, then logged in', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const p = loginStateWith(read);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('three unclear reads (or a failing read) → null, never "logged out"', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('page gone')).mockResolvedValueOnce(false);
    const p = loginStateWith(read);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('an abort stops further reads', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const read = vi.fn().mockResolvedValue(null);
    const p = loginStateWith(read, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
