import type { ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let hooked = false;

/**
 * Kills `proc` when this process exits. One shared `exit` hook for all helpers (whisper-server,
 * Piper), so restarts do not pile up listeners.
 */
export function killOnExit(proc: ChildProcess): void {
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    for (const c of children) c.kill();
  });
}
