/**
 * Runs `stop` once on SIGINT/SIGTERM – the clean shutdown (the bot still says goodbye).
 *
 * One Ctrl+C often arrives twice: the terminal signals the whole process group, and `tsx` relays the
 * signal to its child as well when the child does not report it within 30 ms. With `process.once`, that
 * second SIGINT hit Node's default handler and killed the process mid-goodbye. Repeats within `graceMs`
 * are therefore ignored; a later one (pressing Ctrl+C again) forces the exit.
 * Returns a function that removes the handlers.
 */
export function onStopSignal(stop: () => Promise<void> | void, opts: { graceMs?: number; exit?: (code: number) => void } = {}): () => void {
  const graceMs = opts.graceMs ?? 2000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let firstAt = 0;
  const handler = () => {
    if (firstAt) {
      if (Date.now() - firstAt > graceMs) exit(130);
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
