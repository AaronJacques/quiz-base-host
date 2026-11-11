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
