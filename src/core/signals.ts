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
