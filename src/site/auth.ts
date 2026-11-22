import type { ResponseWatch } from '../browser/driver.ts';

/**
 * quiz-base's own requests to its Supabase auth (`https://<ref>.supabase.co/auth/v1/...`), classified.
 * We never call these endpoints ourselves (AGENTS.md) – the page does, and the browser driver only sees the
 * status of its responses (and, for errors, a short `error_code`). See docs/SITE-NOTES.md „Anmeldung“.
 */
export type AuthKind = 'refresh' | 'login' | 'signup' | 'logout' | 'user';

export interface AuthEvent {
  kind: AuthKind;
  /** 2xx */
  ok: boolean;
  status: number;
  /** Supabase `error_code` of an error response (short snake_case), e.g. `session_expired`. */
  code?: string;
  at: number;
}

/** Kind of an auth request of the page, or null for anything else (other hosts, other paths). */
export function authKind(url: string): AuthKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.supabase.co')) return null;
  const m = u.pathname.match(/^\/auth\/v1\/(token|signup|logout|user)\/?$/);
  if (!m) return null;
  if (m[1] === 'token') {
    const grant = u.searchParams.get('grant_type');
    return grant === 'refresh_token' ? 'refresh' : grant === 'password' ? 'login' : null;
  }
  return m[1] as AuthKind;
}

/** A ResponseWatch for the page's auth requests. The event carries no URL (it holds the project ref and the query). */
export function quizBaseAuthWatch(onEvent: (e: AuthEvent) => void, now: () => number = Date.now): ResponseWatch {
  return {
    match: (url) => authKind(url) !== null,
    onResponse: (r) => {
      const kind = authKind(r.url);
      if (!kind) return;
      const e: AuthEvent = { kind, ok: r.status >= 200 && r.status < 300, status: r.status, at: now() };
      if (r.errorCode) e.code = r.errorCode;
      try {
        onEvent(e);
      } catch {
        // Diagnostics must never break the page's own flow.
      }
    },
    settleMs: 5000,
  };
}
