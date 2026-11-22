/**
 * Minimal browser abstraction. Everything the host does on quiz-base.de is
 * expressed as "evaluate this JS expression in the page", so any browser that
 * can run JS in a tab can be plugged in (Playwright, Chrome via CDP, Orca's
 * built-in browser, …). Keeping the surface this small is deliberate: all DOM
 * knowledge lives in `src/site/**`, not in the drivers.
 */
export interface BrowserDriver {
  readonly name: string;
  /** Prepare the tab (launch / attach). Navigates to `url` if given. */
  open(url?: string): Promise<void>;
  goto(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  /**
   * Evaluate a synchronous JS *expression* in the page and return its value.
   * The value must be JSON-serialisable.
   */
  evaluate<T>(expression: string): Promise<T>;
  /** Save a PNG of the visible page; returns the file path. */
  screenshot(file: string): Promise<string>;
  close(): Promise<void>;
}

/** Wrap an expression so every driver transports the result as a JSON string. */
export function jsonWrap(expression: string): string {
  return `JSON.stringify((() => { return (${expression}); })())`;
}

export function parseJsonResult<T>(raw: unknown): T {
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

/**
 * Passive observation of the page's own requests (Playwright only): which requests to follow, and what is
 * reported about their responses. Never a body of a successful response (it may hold tokens), never a header.
 */
export interface ResponseWatch {
  match(url: string): boolean;
  /** status; errorCode only for status >= 400 and only a short snake_case code – never a body, never a header. */
  onResponse(r: { url: string; status: number; errorCode?: string }): void;
  /** close() waits this long for watched requests still running (a token refresh must not be cut off). */
  settleMs?: number;
}

const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * What a watched response may tell us: the status, and for an error (>= 400) the `error_code` (or `error`)
 * field of its JSON body if it is a short snake_case code. `readJson` is not called below 400.
 */
export async function readWatchedResponse(status: number, readJson: () => Promise<unknown>): Promise<{ status: number; errorCode?: string }> {
  if (status < 400) return { status };
  const body = await readJson().catch(() => null);
  if (!body || typeof body !== 'object') return { status };
  const b = body as Record<string, unknown>;
  const raw = typeof b.error_code === 'string' ? b.error_code : b.error;
  return typeof raw === 'string' && ERROR_CODE.test(raw) ? { status, errorCode: raw } : { status };
}
