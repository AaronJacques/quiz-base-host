import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkLogin, LOGIN_TIMEOUT_MS, watchLogin } from './board-cli.ts';
import { PlaywrightDriver } from './browser/playwright-driver.ts';
import { Frame, FrameReader, listenRelay, RELAY_PROTOCOL, serveRelay, type LocalRelay } from './browser/stdio-relay.ts';
import type { Config } from './config.ts';
import { sleep } from './core/logger.ts';
import { BoardEditorPage } from './site/editor/page.ts';

/**
 * `qbhost login --server <host>`: quiz-base login for the bot on a server without a screen.
 *
 * The server's sshd forbids port forwarding, so qbhost builds the tunnel itself over the stdin/stdout of one
 * ssh session: Mac 127.0.0.1:<port> ⇄ ssh ⇄ `docker run -i … login --remote-stdio` ⇄ 127.0.0.1:9223 inside the
 * container (Chromium's DevTools port). The user opens chrome://inspect on the Mac and logs in on the remote
 * page themselves; qbhost never types, reads form fields or logs the relayed bytes. The session is created on
 * the server (no token is transported) and the whole thing ends after 15 minutes at the latest.
 */

/** Extra flags of `qbhost login` (merged into the CLI's parseArgs options). */
export const LOGIN_CLI_OPTIONS = {
  server: { type: 'string' },
  logout: { type: 'boolean' },
  'remote-stdio': { type: 'boolean' },
  'print-profile-dir': { type: 'boolean' },
} as const;

export const DEFAULT_LOCAL_PORT = 9223;
/** DevTools port inside the login container (its own network namespace – nothing outside reaches it). */
export const CONTAINER_DEVTOOLS_PORT = 9223;
/** The Mac listener is open for at most this long; ssh gets one more minute for start-up and the final check. */
export const SERVER_LOGIN_LIMIT_MS = LOGIN_TIMEOUT_MS;
/** The final bot check waits this long at most (the server side waits up to 90 s for its cleanup). */
const STATUS_TIMEOUT_MS = 150_000;

const SCRIPT = new URL('../tools/server-login.sh', import.meta.url);

export type RemoteMode = 'login' | 'logout' | 'status';

/** An ssh destination as in `~/.ssh/config` – nothing that ssh could take for an option. */
export function validHost(host: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/.test(host);
}

export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** POSIX single-quoting for the remote shell. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The bot's state before a run, as the server script reports it (`QBBOT running|stopped`). */
export type BotBefore = 'running' | 'stopped' | 'unknown';

/** Reads the server script's `QBBOT …` line. */
export function botBefore(line: string): BotBefore | undefined {
  const m = line.match(/^QBBOT (running|stopped)\s*$/);
  return m ? (m[1] as BotBefore) : undefined;
}

/** The remote command: our own copy of tools/server-login.sh, passed inline (stdin stays free for the relay). */
export function remoteCommand(mode: RemoteMode, opts: { before?: BotBefore; script?: string } = {}): string {
  const script = opts.script ?? readFileSync(SCRIPT, 'utf8');
  const arg = mode === 'status' ? ` ${opts.before ?? 'unknown'}` : '';
  return `bash -c ${shellQuote(script)} qbhost-login ${mode}${arg}`;
}

/**
 * ssh arguments. Whatever the user's ~/.ssh/config says, this session forwards nothing (no agent, no X11, no
 * ports, no tunnel device), runs no local command, does not ride on a shared master connection and gets no
 * terminal (binary-clean stdin/stdout, no escape character).
 */
export function sshArgs(host: string, command: string): string[] {
  if (!validHost(host)) throw new Error(`Ungültiger Server-Name: ${host} (wie in ~/.ssh/config, z. B. quizmaster-vps)`);
  const opts = [
    'ForwardAgent=no',
    'ForwardX11=no',
    'ForwardX11Trusted=no',
    'ClearAllForwardings=yes',
    'Tunnel=no',
    'GSSAPIDelegateCredentials=no',
    'PermitLocalCommand=no',
    'ControlMaster=no',
    'ControlPath=none',
    'RemoteCommand=none',
    'RequestTTY=no',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=4',
  ];
  return ['-T', '-e', 'none', ...opts.flatMap((o) => ['-o', o]), host, command];
}

/** Spawns ssh with SIGINT ignored (OpenSSH keeps an inherited SIG_IGN): Ctrl+C reaches only qbhost, which then
 *  ends the session cleanly over stdin. Passphrase prompts on the terminal keep working. */
function spawnSsh(ssh: string, args: string[], stdio: ('pipe' | 'ignore' | 'inherit')[]): ChildProcess {
  return spawn('/bin/sh', ['-c', 'trap "" INT; exec "$0" "$@"', ssh, ...args], { stdio });
}

/** Fails before anything happens on the server if the local port cannot be used. */
export async function checkLocalPort(port: number): Promise<void> {
  if (!validPort(port)) throw new Error(`--port: ${port} ist kein gültiger Port (1–65535).`);
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} ist auf dem Mac belegt – anderen wählen: --port <n>` : e.message)),
    );
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve()));
  });
  // Someone on [::1]:port would answer "localhost:<port>" instead of us – refuse, the user might type there.
  const v6 = await new Promise<boolean>((resolve) => {
    const c = net.connect({ host: '::1', port });
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });
  if (v6) throw new Error(`Auf [::1]:${port} lauscht schon ein anderes Programm – anderen Port wählen: --port <n>`);
}

export interface ServerLoginOptions {
  host: string;
  port?: number;
  logout?: boolean;
  yes?: boolean;
  /** ssh binary (tests use a fake). */
  ssh?: string;
  /** How long the tunnel (the Mac port) may be open, from the moment it opens; default 15 min. */
  limitMs?: number;
  /** Time between ending stdin and SIGTERM/SIGKILL for ssh (default 5 s / 10 s). */
  graceMs?: number;
  /** Like Ctrl+C (tests). */
  signal?: AbortSignal;
  log?: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
}

async function askTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error('Keine Rückfrage möglich (kein Terminal) – mit --yes bestätigen.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(j|ja|y|yes)$/i.test((await rl.question(`${question} [j/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Mac side. Resolves with the exit code; leaves no process and no open port behind. */
export async function runServerLogin(o: ServerLoginOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const ssh = o.ssh ?? 'ssh';
  const mode: RemoteMode = o.logout ? 'logout' : 'login';
  // Everything that can fail locally fails here – before the bot is stopped.
  const args = sshArgs(o.host, remoteCommand(mode));
  if (!o.logout) await checkLocalPort(o.port ?? DEFAULT_LOCAL_PORT);
  const question = o.logout
    ? 'Der Bot wird kurz gestoppt und vergisst die quiz-base-Anmeldung; ein laufendes Spiel bricht dabei ab. Jetzt stoppen?'
    : 'Der Bot wird für die Anmeldung kurz gestoppt; ein laufendes Spiel bricht dabei ab. Jetzt stoppen?';
  if (!o.yes && !(await (o.confirm ?? askTerminal)(question))) {
    log('Abgebrochen, der Bot läuft unverändert.');
    return 1;
  }

  const child = spawnSsh(ssh, args, [o.logout ? 'ignore' : 'pipe', 'pipe', 'inherit']);
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once('error', (e) => {
      log(`❌ ssh ließ sich nicht starten: ${e.message}`);
      resolve(1);
    });
  });
  // The server script reports the bot's state before it changes anything (`QBBOT …`, first line on stdout).
  const seen = { before: 'unknown' as BotBefore };
  const onLine = (text: string) => {
    seen.before = botBefore(text) ?? seen.before;
  };
  let code: number;
  if (o.logout) {
    let rest = '';
    child.stdout!.on('data', (c: Buffer) => {
      const lines = (rest + c.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    code = await guarded(child, exited, log);
  } else code = await relayLogin(child, exited, { ...o, log, onLine });
  const bot = await botStatus(ssh, o.host, seen.before, log);
  return code === 0 && bot === 'off' ? 3 : code;
}

/** Short server steps (logout, status): a first Ctrl+C only explains, a second one kills ssh. */
async function guarded<T>(child: ChildProcess, done: Promise<T>, log: (l: string) => void): Promise<T> {
  let n = 0;
  const onSigint = () => (n++ ? child.kill('SIGKILL') : log('Moment, der Server ist gleich fertig (noch einmal Strg+C bricht hart ab) …'));
  process.on('SIGINT', onSigint);
  try {
    return await done;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * After every run: does the bot run again? Only if it ran before the run is "not running" a problem (with the
 * command that starts it); a bot that was off before stays off – maybe on purpose, maybe a second instance with
 * the same Discord token runs elsewhere.
 */
async function botStatus(ssh: string, host: string, before: BotBefore, log: (l: string) => void): Promise<'running' | 'off' | 'left-off' | 'unknown'> {
  const child = spawnSsh(ssh, sshArgs(host, remoteCommand('status', { before })), ['ignore', 'ignore', 'inherit']);
  const kill = setTimeout(() => child.kill('SIGKILL'), STATUS_TIMEOUT_MS);
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (c) => resolve(c ?? 1));
    child.once('error', () => resolve(1));
  });
  const code = await guarded(child, exited, log);
  clearTimeout(kill);
  if (code === 0) {
    log('✔ Kontrolle: Der Bot läuft.');
    return 'running';
  }
  if (code === 4) {
    log(before === 'stopped' ? 'ℹ️  Kontrolle: Der Bot war vorher aus und bleibt aus.' : 'ℹ️  Kontrolle: Der Bot läuft nicht; qbhost hat ihn nicht gestoppt.');
    return 'left-off';
  }
  if (code === 3) {
    log(`⚠️  Der Bot lief vorher und läuft jetzt nicht. Starten: ssh ${host} 'sudo docker start $(sudo docker ps -aq --filter label=com.docker.compose.service=bot)'`);
    return 'off';
  }
  log(`⚠️  Bot-Zustand unbekannt (Server nicht erreichbar?). Prüfen: ssh ${host} sudo docker ps`);
  return 'unknown';
}

async function relayLogin(
  child: ChildProcess,
  exited: Promise<number>,
  o: ServerLoginOptions & { log: (l: string) => void; onLine: (text: string) => void },
): Promise<number> {
  const { log } = o;
  let relay: LocalRelay | undefined;
  let hello = false;
  let result: boolean | undefined;
  let failure: string | undefined;
  let ended = false;
  let relayOver = false;

  const closeRelay = async () => {
    const r = relay;
    relay = undefined;
    await r?.close();
  };
  // Ends the ssh session: stdin EOF reaches the container (browser closes, trap starts the bot), then a kill.
  const hangUp = () => {
    if (ended) return;
    ended = true;
    child.stdin?.end();
    const grace = o.graceMs ?? 5000;
    const kill = setTimeout(() => child.kill('SIGTERM'), grace);
    const hard = setTimeout(() => child.kill('SIGKILL'), 2 * grace);
    void exited.then(() => {
      clearTimeout(kill);
      clearTimeout(hard);
    });
  };

  let feed: ((f: { type: number; channel: number; payload: Buffer }) => void) | undefined;
  const reader = new FrameReader(
    (f) => {
      if (f.type === Frame.Done) {
        relayOver = true;
        if (relay) log('🔒 Tunnel geschlossen, prüfe die Anmeldung …');
        void closeRelay();
      } else if (f.type === Frame.Result) {
        try {
          result = (JSON.parse(f.payload.toString('utf8')) as { ok?: unknown }).ok === true;
        } catch {
          result = false;
        }
      } else feed?.(f);
    },
    {
      line: o.onLine,
      hello: (version) => {
        hello = true;
        if (version !== RELAY_PROTOCOL) {
          failure = `❌ Server-Stand zu alt bzw. anders als dieser Mac (Protokoll ${version}, erwartet ${RELAY_PROTOCOL}) – erst deployen, dann noch einmal.`;
          return hangUp();
        }
        void listenRelay({ port: o.port ?? DEFAULT_LOCAL_PORT, output: child.stdin! }).then(
          (r) => {
            if (ended || relayOver) return void r.close();
            relay = r;
            feed = r.feed;
            portLimit = setTimeout(timeUp, limitMs);
            log(instructions(r.port));
          },
          (e: NodeJS.ErrnoException) => {
            failure = e.code === 'EADDRINUSE' ? `❌ Port ${o.port ?? DEFAULT_LOCAL_PORT} ist auf dem Mac belegt – anderen wählen: --port <n>` : `❌ ${e.message}`;
            hangUp();
          },
        );
      },
    },
  );
  child.stdout!.on('data', (c: Buffer) => {
    try {
      reader.push(c);
    } catch {
      failure ??= '❌ Unerwartete Ausgabe vom Server – Server-Stand prüfen (erst deployen).';
      void closeRelay();
      hangUp();
    }
  });
  child.stdin!.on('error', () => {});

  const limitMs = o.limitMs ?? SERVER_LOGIN_LIMIT_MS;
  const timeUp = () => {
    failure ??= '⌛ 15 Minuten sind um – Anmeldung abgebrochen.';
    void closeRelay();
    hangUp();
  };
  let portLimit: NodeJS.Timeout | undefined;
  const hardLimit = setTimeout(timeUp, limitMs + 60_000);
  // Ctrl+C: close the port at once and end the session over stdin, so the server shuts the browser down
  // cleanly and starts the bot; a second Ctrl+C kills ssh (the server still cleans up on EOF).
  let interrupts = 0;
  const interrupt = () => {
    if (interrupts++ > 0) return void child.kill('SIGKILL');
    failure ??= 'Abgebrochen – der Server räumt auf und startet den Bot wieder …';
    log(failure);
    void closeRelay();
    hangUp();
  };
  process.on('SIGINT', interrupt);
  o.signal?.addEventListener('abort', interrupt, { once: true });

  const code = await exited;
  clearTimeout(hardLimit);
  clearTimeout(portLimit);
  process.off('SIGINT', interrupt);
  o.signal?.removeEventListener('abort', interrupt);
  ended = true;
  await closeRelay();

  if (failure && !failure.startsWith('Abgebrochen')) log(failure);
  else if (!failure && !hello) log('❌ Der Server hat den Login nicht gestartet (siehe Meldungen oben). Ist der Server-Stand zu alt? Erst deployen, dann noch einmal.');
  if (result === true) {
    log('✅ Der Bot ist bei quiz-base angemeldet. Das Profil bleibt auf dem Server; eigene Boards gehen jetzt.');
    return 0;
  }
  if (result === false) log('❌ Nicht angemeldet. Noch einmal: npx qbhost login --server ' + o.host);
  return code === 0 ? 1 : code;
}

function instructions(port: number): string {
  return [
    `🔐 Tunnel steht: 127.0.0.1:${port} auf diesem Mac → Login-Browser auf dem Server (höchstens 15 Minuten).`,
    '   1. In Chrome chrome://inspect öffnen.',
    `   2. „Configure…“ → 127.0.0.1:${port} eintragen (genau so, nicht „localhost“; nur beim ersten Mal) → „Done“.`,
    `   3. Unter „Remote Target“ bei 127.0.0.1:${port} → quiz-base auf „inspect“ klicken.`,
    '   4. Im DevTools-Fenster links siehst du die Seite (sonst oben das Bildschirm-Symbol „Toggle screencast“).',
    '      Dort oben rechts im Benutzermenü selbst anmelden (E-Mail + Passwort).',
    '   qbhost gibt nichts ein und liest nichts mit. Sobald du angemeldet bist, schließt sich alles von selbst.',
    '   Abbrechen: Strg+C.',
  ].join('\n');
}

/**
 * Container side (`qbhost login --remote-stdio`): headless Chromium with the profile and the DevTools port on
 * the container's loopback, relay on stdin/stdout, same login detection as `qbhost login`. SIGTERM/SIGHUP
 * (docker stop, timeout) end it like a closed stdin: tunnel closed, browser closed cleanly.
 */
export async function runRemoteLoginStdio(
  config: Config,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; devtoolsPort?: number } = { input: process.stdin, output: process.stdout },
): Promise<number> {
  const devtoolsPort = io.devtoolsPort ?? CONTAINER_DEVTOOLS_PORT;
  // stdout is the relay – every message goes to stderr.
  const { log, info } = console;
  console.log = console.info = (...a: unknown[]) => console.error(...a);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  const relay = serveRelay({
    input: io.input as any,
    output: io.output as any,
    connect: () => net.connect({ host: '127.0.0.1', port: devtoolsPort }),
    onEnd: stop,
  });
  const finish = async (ok: boolean | undefined) => {
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    console.log = log;
    console.info = info;
    if (ok !== undefined) relay.result(ok);
    await new Promise<void>((r) => (io.output as any).end(r));
    return ok ? 0 : 1;
  };

  const driver = new PlaywrightDriver({ profileDir: config.browser.profileDir, headless: true, remoteDebuggingPort: devtoolsPort });
  let detected = false;
  try {
    await driver.open(config.baseUrl);
    const page = new BoardEditorPage(driver, config.baseUrl);
    await sleep(1500);
    if (!stopped && (await page.loginState())) {
      console.error('✅ Schon bei quiz-base angemeldet. Profil bleibt gespeichert.');
      relay.done();
      await driver.close().catch(() => {});
      return finish(true);
    }
    await page.openUserMenu().catch(() => {});
    if (!stopped) console.error('🔐 Login-Browser bereit (quiz-base, Benutzermenü offen).');
    detected = await watchLogin(page, Date.now() + LOGIN_TIMEOUT_MS, () => stopped);
  } catch (e) {
    console.error(`❌ Login-Browser: ${(e as Error).message}`);
  }
  // Close the tunnel first (the Mac drops its listener), then the browser with its DevTools port.
  relay.done();
  await driver.close().catch(() => {});
  if (stopped && !detected) return finish(undefined);
  const ok = detected || (await checkLogin(config).catch(() => false));
  console.error(ok ? '✅ Angemeldet.' : '❌ Nicht angemeldet.');
  return finish(ok);
}

/** `qbhost login --print-profile-dir`: the absolute profile path the bot uses (read by tools/server-login.sh). */
export function profileDir(config: Config): string {
  return path.resolve(config.browser.profileDir);
}
