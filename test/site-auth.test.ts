import { describe, expect, it, vi } from 'vitest';
import { readWatchedResponse } from '../src/browser/driver.ts';
import { authKind, quizBaseAuthWatch, type AuthEvent } from '../src/site/auth.ts';

const SB = 'https://abcdefgh.supabase.co/auth/v1';

describe('authKind (quiz-base → Supabase auth)', () => {
  it('classifies the five kinds', () => {
    expect(authKind(`${SB}/token?grant_type=refresh_token`)).toBe('refresh');
    expect(authKind(`${SB}/token?grant_type=password`)).toBe('login');
    expect(authKind(`${SB}/signup`)).toBe('signup');
    expect(authKind(`${SB}/logout?scope=global`)).toBe('logout');
    expect(authKind(`${SB}/user`)).toBe('user');
  });

  it('ignores other hosts, paths and grants', () => {
    expect(authKind('https://www.quiz-base.de/auth/v1/user')).toBeNull();
    expect(authKind('https://supabase.co.evil.example/auth/v1/user')).toBeNull();
    expect(authKind('http://abcdefgh.supabase.co/auth/v1/user')).toBeNull();
    expect(authKind('https://abcdefgh.supabase.co/rest/v1/boards')).toBeNull();
    expect(authKind(`${SB}/token?grant_type=pkce`)).toBeNull();
    expect(authKind(`${SB}/userx`)).toBeNull();
    expect(authKind('kein url')).toBeNull();
  });
});

describe('readWatchedResponse', () => {
  it('never reads the body of a successful response', async () => {
    const readJson = vi.fn(async () => ({ access_token: 'SECRET' }));
    expect(await readWatchedResponse(200, readJson)).toEqual({ status: 200 });
    expect(await readWatchedResponse(302, readJson)).toEqual({ status: 302 });
    expect(readJson).not.toHaveBeenCalled();
  });

  it('takes error_code of an error response', async () => {
    expect(await readWatchedResponse(400, async () => ({ error_code: 'session_expired', msg: 'Session Expired' }))).toEqual({ status: 400, errorCode: 'session_expired' });
    expect(await readWatchedResponse(400, async () => ({ error: 'invalid_grant' }))).toEqual({ status: 400, errorCode: 'invalid_grant' });
  });

  it('keeps nothing that is not a short snake_case code', async () => {
    expect(await readWatchedResponse(400, async () => ({ error: 'x y' }))).toEqual({ status: 400 });
    expect(await readWatchedResponse(401, async () => ({ error_code: 'A'.repeat(10) }))).toEqual({ status: 401 });
    expect(await readWatchedResponse(400, async () => ({ error_code: 'a'.repeat(65) }))).toEqual({ status: 400 });
    expect(await readWatchedResponse(500, async () => 'plain text')).toEqual({ status: 500 });
    expect(await readWatchedResponse(500, async () => Promise.reject(new Error('no json')))).toEqual({ status: 500 });
  });

  it('a body with a token never shows up in the result', async () => {
    const r = await readWatchedResponse(400, async () => ({ access_token: 'SECRET-A', refresh_token: 'SECRET-R', error_code: 'refresh_token_already_used' }));
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r).toEqual({ status: 400, errorCode: 'refresh_token_already_used' });
  });
});

describe('quizBaseAuthWatch', () => {
  it('matches only auth requests and emits events without the URL', () => {
    const events: AuthEvent[] = [];
    const w = quizBaseAuthWatch((e) => events.push(e), () => 1000);
    expect(w.match(`${SB}/token?grant_type=refresh_token`)).toBe(true);
    expect(w.match('https://www.quiz-base.de/')).toBe(false);
    w.onResponse({ url: `${SB}/token?grant_type=refresh_token`, status: 400, errorCode: 'session_expired' });
    w.onResponse({ url: `${SB}/token?grant_type=refresh_token`, status: 200 });
    w.onResponse({ url: 'https://www.quiz-base.de/', status: 200 });
    expect(events).toEqual([
      { kind: 'refresh', ok: false, status: 400, code: 'session_expired', at: 1000 },
      { kind: 'refresh', ok: true, status: 200, at: 1000 },
    ]);
    expect(JSON.stringify(events)).not.toContain('supabase');
    expect(w.settleMs).toBe(5000);
  });

  it('a throwing listener does not escape', () => {
    const w = quizBaseAuthWatch(() => {
      throw new Error('boom');
    });
    expect(() => w.onResponse({ url: `${SB}/user`, status: 200 })).not.toThrow();
  });
});
