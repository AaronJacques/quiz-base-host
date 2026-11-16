type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const color: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

let threshold: Level = (process.env.QBHOST_LOG as Level) || 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const log = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < order[threshold]) return;
    const ts = new Date().toLocaleTimeString('de-DE');
    const tail = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    // stderr keeps stdout free for the operator console.
    process.stderr.write(`${color[level]}${ts} [${scope}]\x1b[0m ${msg}${tail}\n`);
  };
  return {
    debug: (m, e) => log('debug', m, e),
    info: (m, e) => log('info', m, e),
    warn: (m, e) => log('warn', m, e),
    error: (m, e) => log('error', m, e),
  };
}

/** Wait `ms`. With a `signal` the wait ends early (resolves, never rejects) as soon as it is aborted. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal?.aborted) return r();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      r();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
