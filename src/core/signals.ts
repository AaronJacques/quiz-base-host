/**
 * Runs `stop` once on SIGINT/SIGTERM – the clean shutdown (the bot still says goodbye).
 *
 * One Ctrl+C often arrives twice: the terminal signals the whole process group, and `tsx` relays the
 * signal to its child as well when the child does not report it within 30 ms. With `process.once`, that
 * second SIGINT hit Node's default handler and killed the process mid-goodbye. Repeats within `graceMs`
 * are therefore ignored; a later one (pressing Ctrl+C again) forces the exit.
 * With `beforeForceExit`, that forced exit first closes what must not die with the process (the browsers:
 * a killed Chromium loses a token it has not written yet) – at most `forceTimeoutMs`; a third signal exits at once.
 * Returns a function that removes the handlers.
 */
export function onStopSignal(
  stop: () => Promise<void> | void,
  opts: { graceMs?: number; exit?: (code: number) => void; beforeForceExit?: () => Promise<unknown>; forceTimeoutMs?: number } = {},
): () => void {
  const graceMs = opts.graceMs ?? 2000;
  const forceTimeoutMs = opts.forceTimeoutMs ?? 3000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let firstAt = 0;
  let forcing = false;
  const handler = () => {
    if (firstAt) {
      if (forcing) return exit(130);
      if (Date.now() - firstAt <= graceMs) return;
      if (!opts.beforeForceExit) return exit(130);
      forcing = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        Promise.resolve()
          .then(opts.beforeForceExit)
          .catch(() => {}),
        new Promise<void>((r) => {
          timer = setTimeout(r, forceTimeoutMs);
        }),
      ]).finally(() => {
        clearTimeout(timer);
        exit(130);
      });
      return;
    }
    firstAt = Date.now();
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

/**
 * Last resort for an exception nobody caught (rule 10 should prevent it; without a handler Node ends at once and
 * Playwright's exit hook kills Chromium, which can lose a token it renewed moments ago): report it, run
 * `beforeExit` (close the browsers) for at most `timeoutMs`, then `exit(1)`. A second one while closing exits at once.
 */
export function fatalErrorHandler(
  beforeExit: () => Promise<unknown>,
  opts: { exit?: (code: number) => void; timeoutMs?: number; report?: (text: string) => void } = {},
): (e: unknown) => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const report = opts.report ?? ((text: string) => process.stderr.write(`${text}\n`));
  const timeoutMs = opts.timeoutMs ?? 3000;
  let closing = false;
  return (e: unknown) => {
    try {
      report(`❌ Unerwarteter Fehler – schließe die Browser und beende: ${(e as Error)?.stack ?? String(e)}`);
    } catch {
      // Reporting must not stop the exit.
    }
    if (closing) return exit(1);
    closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      Promise.resolve()
        .then(beforeExit)
        .catch(() => {}),
      new Promise<void>((r) => {
        timer = setTimeout(r, timeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      exit(1);
    });
  };
}

/** Installs fatalErrorHandler on 'uncaughtException'. Returns a function that removes it. */
export function onFatalError(beforeExit: () => Promise<unknown>, opts: Parameters<typeof fatalErrorHandler>[1] = {}): () => void {
  const handler = fatalErrorHandler(beforeExit, opts);
  process.on('uncaughtException', handler);
  return () => void process.off('uncaughtException', handler);
}
