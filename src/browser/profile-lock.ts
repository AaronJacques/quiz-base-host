import path from 'node:path';

/**
 * One browser at a time per Chromium profile, inside this process.
 *
 * Game, board creation, login check and the idle keep-alive all open the same logged-in profile. Two
 * Chromiums on one profile fight over the cookie store (and the second launch fails on `SingletonLock`).
 * A preemptible holder (the keep-alive) is asked to stop as soon as someone else waits for the profile.
 * Between processes Chromium's own `SingletonLock` still protects the profile – a launch then fails.
 */
export type LockOwner = 'game' | 'board' | 'keepalive' | 'login' | 'other';

export interface ProfileLease {
  readonly owner: LockOwner;
  /** Idempotent. */
  release(): void;
}

const OWNER_LABEL: Record<LockOwner, string> = {
  game: 'Spiel',
  board: 'Board-Anlage',
  keepalive: 'Anmeldeprüfung',
  login: 'Anmeldung',
  other: 'anderer Browser',
};

export class ProfileBusyError extends Error {
  constructor(readonly holder: LockOwner | null) {
    super(`Das Browser-Profil ist gerade belegt (${OWNER_LABEL[holder ?? 'other']}). Gleich noch einmal versuchen.`);
    this.name = 'ProfileBusyError';
  }
}

export interface AcquireOptions {
  /** The holder may be asked to give the profile back early (onPreempt). */
  preemptible?: boolean;
  /** Called once when somebody waits for the profile while this (preemptible) holder has it. */
  onPreempt?: () => void;
  /** How long to wait for the profile; 0 = try once. Default 20 000. */
  waitMs?: number;
}

interface Holder {
  owner: LockOwner;
  preemptible: boolean;
  onPreempt?: () => void;
  preempted: boolean;
}

interface Waiter {
  owner: LockOwner;
  opts: AcquireOptions;
  resolve: (lease: ProfileLease) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProfileLock {
  private current: Holder | null = null;
  private queue: Waiter[] = [];

  get holder(): LockOwner | null {
    return this.current?.owner ?? null;
  }

  /** Waits for the profile (FIFO). A preemptible holder is asked to stop first. Rejects with ProfileBusyError after waitMs. */
  acquire(owner: LockOwner, opts: AcquireOptions = {}): Promise<ProfileLease> {
    if (!this.current && !this.queue.length) return Promise.resolve(this.grant(owner, opts));
    const waitMs = opts.waitMs ?? 20_000;
    if (waitMs <= 0) return Promise.reject(new ProfileBusyError(this.holder ?? this.queue[0]?.owner ?? null));
    return new Promise<ProfileLease>((resolve, reject) => {
      const w: Waiter = {
        owner,
        opts,
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(w);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new ProfileBusyError(this.holder));
        }, waitMs),
      };
      this.queue.push(w);
      this.preemptCurrent();
    });
  }

  private preemptCurrent(): void {
    const c = this.current;
    if (!c || !c.preemptible || c.preempted) return;
    c.preempted = true;
    try {
      c.onPreempt?.();
    } catch {
      // A failing callback must not block the waiter – the holder still releases on its own.
    }
  }

  private grant(owner: LockOwner, opts: AcquireOptions): ProfileLease {
    const holder: Holder = { owner, preemptible: !!opts.preemptible, onPreempt: opts.onPreempt, preempted: false };
    this.current = holder;
    let released = false;
    return {
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.current !== holder) return;
        this.current = null;
        this.next();
      },
    };
  }

  private next(): void {
    const w = this.queue.shift();
    if (!w) return;
    clearTimeout(w.timer);
    w.resolve(this.grant(w.owner, w.opts));
    if (this.queue.length) this.preemptCurrent();
  }
}

const LOCKS = new Map<string, ProfileLock>();

/** One lock per resolved profile path. */
export function profileLock(profileDir: string): ProfileLock {
  const key = path.resolve(profileDir);
  let lock = LOCKS.get(key);
  if (!lock) LOCKS.set(key, (lock = new ProfileLock()));
  return lock;
}
