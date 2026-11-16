// `qbhost login --server`: relay protocol, Mac side against a fake ssh, container side against a local page,
// and tools/server-login.sh against fake sudo/docker (with the real `timeout`). No network beyond 127.0.0.1/::1,
// no real ssh, no Docker, no quiz-base.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { launchArgs } from '../src/browser/playwright-driver.ts';
import { encodeFrame, Frame, FrameReader, helloLine, listenRelay, serveRelay, type DecodedFrame } from '../src/browser/stdio-relay.ts';
import { loadConfig } from '../src/config.ts';
import { botBefore, checkLocalPort, remoteCommand, runRemoteLoginStdio, runServerLogin, shellQuote, sshArgs, validHost, validPort } from '../src/server-login.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'tools/server-login.sh');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbhost-server-login-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const portOpen = (port: number, host = '127.0.0.1') =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const get = (port: number, p: string, slow = false) =>
  new Promise<Buffer>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          parts.push(c);
          if (slow) {
            res.pause();
            setTimeout(() => res.resume(), 1);
          }
        });
        res.on('end', () => resolve(Buffer.concat(parts)));
        res.on('error', reject);
      })
      .once('error', reject);
  });
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('relay frames', () => {
  it('decodes frames split into single bytes and skips output before the hello line', () => {
    const got: DecodedFrame[] = [];
    let version = 0;
    const r = new FrameReader((f) => got.push(f), { hello: (v) => (version = v) });
    const bytes = Buffer.concat([
      Buffer.from('Sprachmodelle prüfen …\n'),
      Buffer.from(helloLine()),
      encodeFrame(Frame.Open, 7),
      encodeFrame(Frame.Data, 7, Buffer.from('GET /json')),
      encodeFrame(Frame.Close, 7),
    ]);
    for (const b of bytes) r.push(Buffer.from([b]));
    expect(version).toBe(1);
    expect(got.map((f) => [f.type, f.channel, f.payload.toString()])).toEqual([
      [Frame.Open, 7, ''],
      [Frame.Data, 7, 'GET /json'],
      [Frame.Close, 7, ''],
    ]);
  });

  it('gives up when no hello line comes', () => {
    const r = new FrameReader(() => {}, { hello: () => {} });
    expect(() => r.push(Buffer.alloc(70 * 1024, 0x41))).toThrow(/hello/);
  });

  const pair = async (target: number) => {
    const toRemote = new PassThrough();
    const toMac = new PassThrough();
    const state = { remoteEnded: false, done: false };
    const remote = serveRelay({ input: toRemote, output: toMac, connect: () => net.connect({ host: '127.0.0.1', port: target }), onEnd: () => (state.remoteEnded = true) });
    const local = await listenRelay({ port: 0, output: toRemote });
    const reader = new FrameReader((f) => (f.type === Frame.Done ? (state.done = true) : local.feed(f)), { hello: () => {} });
    toMac.on('data', (c: Buffer) => reader.push(c));
    return { remote, local, toRemote, state };
  };

  it('carries HTTP both ways and closes the port and all connections when done', async () => {
    const devtools = http.createServer((req, res) => res.end(`ok ${req.url}`));
    await new Promise<void>((r) => devtools.listen(0, '127.0.0.1', r));
    const { remote, local, toRemote, state } = await pair((devtools.address() as net.AddressInfo).port);

    expect((await get(local.port, '/json/list')).toString()).toBe('ok /json/list');
    expect((await get(local.port, '/json/version')).toString()).toBe('ok /json/version');

    remote.done();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.done).toBe(true);
    expect(remote.open).toBe(0);
    await local.close();
    expect(await portOpen(local.port)).toBe(false);
    toRemote.end();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.remoteEnded).toBe(true);
    devtools.close();
  });

  it('delivers everything before a close, also to a slow reader (no data dropped)', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 7, 0x62);
    const devtools = http.createServer((_req, res) => {
      res.setHeader('connection', 'close');
      res.end(big);
    });
    await new Promise<void>((r) => devtools.listen(0, '127.0.0.1', r));
    const { local } = await pair((devtools.address() as net.AddressInfo).port);
    for (let i = 0; i < 2; i++) expect((await get(local.port, '/big', true)).length).toBe(big.length);
    await local.close();
    devtools.close();
  }, 30000);

  it('binds the Mac listener to 127.0.0.1 only', async () => {
    const local = await listenRelay({ port: 0, output: new PassThrough() });
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    for (const i of ifaces) expect(await portOpen(local.port, i!.address)).toBe(false);
    expect(await portOpen(local.port, '::1')).toBe(false);
    await local.close();
  });
});

describe('arguments', () => {
  it('accepts ssh host aliases, nothing ssh could read as an option', () => {
    expect(validHost('quizmaster-vps')).toBe(true);
    expect(validHost('admin@203.0.113.10')).toBe(true);
    for (const bad of ['-oProxyCommand=touch x', 'a b', '', 'host;rm', '$(id)']) expect(validHost(bad)).toBe(false);
    expect(() => sshArgs('-oProxyCommand=x', 'true')).toThrow(/Server-Name/);
  });

  it('builds a binary-clean ssh call that forwards nothing and sends the local script inline', () => {
    const args = sshArgs('quizmaster-vps', remoteCommand('login'));
    expect(args.slice(0, 3)).toEqual(['-T', '-e', 'none']);
    const opts = args.filter((_, i) => args[i - 1] === '-o');
    for (const o of ['ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ControlPath=none', 'RemoteCommand=none', 'Tunnel=no'])
      expect(opts).toContain(o);
    expect(args.at(-2)).toBe('quizmaster-vps');
    const cmd = args.at(-1)!;
    expect(cmd.startsWith("bash -c '#!/usr/bin/env bash")).toBe(true);
    expect(cmd.endsWith("' qbhost-login login")).toBe(true);
    expect(cmd).not.toContain('/opt/quizmaster/app/tools'); // never runs a file from the release folder
  });

  it('quotes the script so the remote shell runs it unchanged', () => {
    // The script itself is full of single quotes, $ and backticks – all must reach bash literally.
    const script = "printf '%s|' \"$0\" \"$@\"; printf '%s' 'a $HOME `x` \"q\"'";
    const out = execFileSync('sh', ['-c', remoteCommand('logout', { script })]).toString();
    expect(out).toBe('qbhost-login|logout|a $HOME `x` "q"');
    expect(execFileSync('sh', ['-c', remoteCommand('status', { script, before: 'stopped' })]).toString()).toBe('qbhost-login|status|stopped|a $HOME `x` "q"');
    expect(remoteCommand('status', { script })).toMatch(/ qbhost-login status unknown$/);
    expect(botBefore('QBBOT running')).toBe('running');
    expect(botBefore('QBBOT stopped\r')).toBe('stopped');
    expect(botBefore('QBBOT maybe')).toBeUndefined();
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('opens the DevTools port only when asked, bound to 127.0.0.1', () => {
    expect(launchArgs({}).some((a) => a.includes('remote-debugging'))).toBe(false);
    expect(launchArgs({ remoteDebuggingPort: 9223 })).toEqual(expect.arrayContaining(['--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1']));
  });

  it('checks the local port: valid, free on 127.0.0.1 and nobody on [::1]', async () => {
    for (const bad of [NaN, 0, -1, 70000, 9223.5]) {
      expect(validPort(bad)).toBe(false);
      await expect(checkLocalPort(bad)).rejects.toThrow(/kein gültiger Port/);
    }
    const port = await freePort();
    await expect(checkLocalPort(port)).resolves.toBeUndefined();
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(port, '127.0.0.1', r));
    await expect(checkLocalPort(port)).rejects.toThrow(/belegt/);
    busy.close();
    const v6 = net.createServer();
    const v6ok = await new Promise<boolean>((r) => {
      v6.once('error', () => r(false));
      v6.listen(port, '::1', () => r(true));
    });
    if (v6ok) {
      await expect(checkLocalPort(port)).rejects.toThrow(/\[::1\]/);
      v6.close();
    }
  });
});

describe('runServerLogin (Mac side) with a fake ssh', () => {
  const fakeSsh = path.join(tmp, 'ssh');
  const sigintFile = path.join(tmp, 'sigint');
  // The shell part proves the inherited SIGINT disposition: it only survives `kill -INT $$` if ssh ignores it.
  writeFileSync(
    fakeSsh,
    `#!/bin/sh\nkill -INT $$\necho survived >> "${sigintFile}"\nexec "${process.execPath}" --import tsx "${path.join(ROOT, 'test/fixtures/fake-ssh.ts')}" "$@"\n`,
  );
  chmodSync(fakeSsh, 0o755);
  let n = 0;

  const start = async (mode: string, extra: Partial<Parameters<typeof runServerLogin>[0]> = {}, status = '0', before = 'running') => {
    const lines: string[] = [];
    const port = await freePort();
    const id = `${mode}-${++n}`;
    const argv = path.join(tmp, `argv-${id}.json`);
    const calls = path.join(tmp, `calls-${id}.txt`);
    process.env.FAKE_MODE = mode;
    process.env.FAKE_ARGV = argv;
    process.env.FAKE_CALLS = calls;
    process.env.FAKE_STATUS = status;
    process.env.FAKE_BEFORE = before;
    const run = runServerLogin({ host: 'quizmaster-vps', ssh: fakeSsh, port, yes: true, log: (l) => lines.push(l), ...extra });
    const sessions = () =>
      existsSync(calls)
        ? readFileSync(calls, 'utf8')
            .trim()
            .split('\n')
            .map((l) => ({ mode: l.split(' ')[0], pid: Number(l.split(' ')[1]), arg: l.split(' ')[2] ?? '' }))
        : [];
    return { run, lines, port, argv, sessions };
  };
  const noneAlive = (sessions: { pid: number }[]) => sessions.every((s) => !alive(s.pid));

  it('relays chrome://inspect requests, closes everything when the login is detected, then checks the bot', async () => {
    const { run, lines, port, argv, sessions } = await start('relay');
    expect(await until(() => lines.some((l) => l.includes('Tunnel steht')))).toBe(true);
    expect(lines.join('\n')).toContain(`127.0.0.1:${port} eintragen`);
    const list = JSON.parse((await get(port, '/json/list')).toString());
    expect(list).toEqual({ url: '/json/list', host: `127.0.0.1:${port}` }); // Host header passes unchanged
    expect((await get(port, '/big')).length).toBe(4 * 1024 * 1024);
    await get(port, '/login-done').catch(() => {});
    expect(await run).toBe(0);
    expect(lines.join('\n')).toMatch(/Der Bot ist bei quiz-base angemeldet[\s\S]*Kontrolle: Der Bot läuft/);
    expect(await portOpen(port)).toBe(false);
    expect(sessions().map((s) => s.mode)).toEqual(['login', 'status']);
    expect(sessions()[1]?.arg).toBe('running'); // the state before the run, from the QBBOT line
    expect(noneAlive(sessions())).toBe(true);
    const args = JSON.parse(readFileSync(argv, 'utf8')) as string[];
    expect(args).toContain('ClearAllForwardings=yes');
    expect(readFileSync(sigintFile, 'utf8')).toContain('survived'); // ssh ignores Ctrl+C, qbhost hangs up
  }, 30000);

  it('says how to start the bot when it ran before and does not run afterwards', async () => {
    const { run, lines, port } = await start('relay', {}, '3');
    expect(await until(() => lines.some((l) => l.includes('Tunnel steht')))).toBe(true);
    await get(port, '/login-done').catch(() => {});
    expect(await run).toBe(3);
    expect(lines.at(-1)).toMatch(/Der Bot lief vorher und läuft jetzt nicht\. Starten: ssh quizmaster-vps 'sudo docker start/);
  }, 30000);

  it('a bot that was off before stays off – no warning, no start command', async () => {
    const { run, lines, port, sessions } = await start('relay', {}, '4', 'stopped');
    expect(await until(() => lines.some((l) => l.includes('Tunnel steht')))).toBe(true);
    await get(port, '/login-done').catch(() => {});
    expect(await run).toBe(0);
    expect(sessions()[1]?.arg).toBe('stopped');
    expect(lines.at(-1)).toBe('ℹ️  Kontrolle: Der Bot war vorher aus und bleibt aus.');
    expect(lines.join('\n')).not.toMatch(/docker start/);
  }, 30000);

  it('without a QBBOT line (script failed early) the check asks with "unknown" and advises no start', async () => {
    const { run, lines, sessions } = await start('old', {}, '4', 'none');
    expect(await run).toBe(1);
    expect(sessions()[1]?.arg).toBe('unknown');
    expect(lines.at(-1)).toMatch(/qbhost hat ihn nicht gestoppt/);
    expect(lines.join('\n')).not.toMatch(/docker start/);
  }, 30000);

  it('Ctrl+C closes the port at once, hangs up over stdin and still checks the bot', async () => {
    const ac = new AbortController();
    const { run, lines, port, sessions } = await start('relay', { signal: ac.signal, graceMs: 5000 });
    expect(await until(() => portOpen(port))).toBe(true);
    const t0 = Date.now();
    ac.abort();
    expect(await until(async () => !(await portOpen(port)), 500)).toBe(true);
    expect(await run).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(4000); // ended by stdin EOF, not by the kill after graceMs
    expect(lines.join('\n')).toMatch(/Abgebrochen[\s\S]*Kontrolle: Der Bot läuft/);
    expect(sessions().map((s) => s.mode)).toEqual(['login', 'status']);
    expect(noneAlive(sessions())).toBe(true);
  }, 30000);

  it('stops after the time limit: port closed, no process left', async () => {
    const { run, lines, port, sessions } = await start('relay', { limitMs: 1500, graceMs: 200 });
    expect(await until(() => portOpen(port))).toBe(true);
    expect(await run).not.toBe(0);
    expect(lines.join('\n')).toMatch(/15 Minuten sind um/);
    expect(await portOpen(port)).toBe(false);
    expect(noneAlive(sessions())).toBe(true);
  }, 30000);

  it('kills an ssh that ignores EOF and SIGTERM', async () => {
    const { run, port, sessions } = await start('stubborn', { limitMs: 1500, graceMs: 200 });
    expect(await until(() => portOpen(port))).toBe(true);
    await run;
    expect(await portOpen(port)).toBe(false);
    expect(await until(() => noneAlive(sessions()), 3000)).toBe(true);
  }, 30000);

  it('says "erst deployen" when the server image does not know the command yet', async () => {
    const { run, lines } = await start('old');
    expect(await run).toBe(1);
    expect(lines.join('\n')).toMatch(/Erst deployen/);
  }, 30000);

  it('refuses a different protocol version and hangs up', async () => {
    const { run, lines, port } = await start('version', { graceMs: 200 });
    expect(await run).not.toBe(0);
    expect(lines.join('\n')).toMatch(/erst deployen/);
    expect(await portOpen(port)).toBe(false);
  }, 30000);

  it('asks unambiguously before stopping the bot and starts nothing on "no"', async () => {
    const questions: string[] = [];
    const { run, argv, sessions } = await start('relay', { yes: false, confirm: async (q) => (questions.push(q), false) });
    expect(await run).toBe(1);
    expect(questions[0]).toBe('Der Bot wird für die Anmeldung kurz gestoppt; ein laufendes Spiel bricht dabei ab. Jetzt stoppen?');
    expect(existsSync(argv)).toBe(false);
    expect(sessions()).toEqual([]);
  });

  it('checks the port before anything happens on the server', async () => {
    const busy = net.createServer();
    const port = await freePort();
    await new Promise<void>((r) => busy.listen(port, '127.0.0.1', r));
    const calls = path.join(tmp, 'calls-busy.txt');
    process.env.FAKE_CALLS = calls;
    let asked = false;
    await expect(runServerLogin({ host: 'quizmaster-vps', ssh: fakeSsh, port, confirm: async () => (asked = true) })).rejects.toThrow(/belegt/);
    await expect(runServerLogin({ host: 'quizmaster-vps', ssh: fakeSsh, port: NaN, yes: true })).rejects.toThrow(/kein gültiger Port/);
    busy.close();
    expect(asked).toBe(false);
    expect(existsSync(calls)).toBe(false);
  });

  it('logout runs the server script and the bot check', async () => {
    const { run, lines, sessions } = await start('relay', { logout: true });
    expect(await run).toBe(0);
    expect(sessions().map((s) => s.mode)).toEqual(['logout', 'status']);
    expect(sessions()[1]?.arg).toBe('running');
    expect(lines.join('\n')).toMatch(/Kontrolle: Der Bot läuft/);
  });
});

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)('runRemoteLoginStdio (container side) against a local page', () => {
  it('writes only the hello line and frames to stdout and ends when stdin ends', async () => {
    const site = http.createServer((_req, res) => res.end('<html><body><h1>kein quiz-base</h1></body></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const profile = path.join(tmp, 'profile-remote');
    const config = loadConfig(path.join(tmp, 'none.json'), { browser: { profileDir: profile } } as any);
    config.baseUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const { log } = console;
    const done = runRemoteLoginStdio(config, { input, output, devtoolsPort: await freePort() });
    setTimeout(() => input.end(), 4000);
    await done;
    site.close();
    expect(console.log).toBe(log);
    const all = Buffer.concat(chunks);
    expect(all.subarray(0, helloLine().length).toString()).toBe(helloLine());
    const frames: DecodedFrame[] = [];
    const reader = new FrameReader((f) => frames.push(f));
    reader.push(all.subarray(helloLine().length));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect([Frame.Data, Frame.Close, Frame.Done, Frame.Result]).toContain(f.type);
    const bytes = frames.reduce((n, f) => n + 9 + f.payload.length, helloLine().length);
    expect(bytes).toBe(all.length); // nothing else on stdout
  }, 60000);
});

const hasTimeout = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v timeout']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTimeout)('tools/server-login.sh with fake sudo/docker and the real timeout', () => {
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const write = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  const IMAGE = 'sha256:' + 'ab'.repeat(32);
  write('sudo', '[ "$1" = -n ] && shift; exec "$@"');
  write(
    'docker',
    `echo "$*" >> "$DOCKER_LOG"
case $1 in
  ps) [ "$FAKE_NOBOT" = 1 ] || { [ -f "$DOCKER_LOG.deployed" ] && echo bot999 || echo bot123; } ;;
  info) [ "$FAKE_INFO_FAIL" = 1 ] && exit 1; echo "\${FAKE_LIVERESTORE:-false}" ;;
  update) [ "$FAKE_UPDATE_FAIL" = 1 ] && [ "$3" != always ] && exit 1 ;;
  inspect)
    [ "$2" = -f ] || { [ "$FAKE_LOGIN_EXISTS" = 1 ]; exit; }
    case $3 in
      *State.Restarting*) r=\${FAKE_RUNNING:-true}; [ "$4" = bot999 ] && r=true; echo "$r/\${FAKE_RESTARTING:-false}" ;;
      *State.Running*) [ "$4" = bot999 ] && echo true || echo "\${FAKE_RUNNING:-true}" ;;
      *.Image*) echo "${IMAGE}" ;;
      *Config.User*) echo "\${FAKE_USER-1000:1000}" ;;
      *RestartPolicy*) echo "\${FAKE_POLICY:-unless-stopped}" ;;
      *qbhost.config.json*) echo /srv/qb/qbhost.config.json ;;
      */app/.qbhost*) echo /srv/qb/data ;;
    esac ;;
  run) case " $* " in
         *" --entrypoint sh "*)
           # The helper's script runs for real, with /d mapped to FAKE_DATA (a real temp folder).
           args=("$@"); script=; for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -c ] && script=\${args[i+1]}; done
           p=\${args[\${#args[@]}-1]}
           exec sh -c "$script" qbhost-helper "$FAKE_DATA\${p#/d}" ;;
         *" stat "*) echo 1001:1002 ;;
         *print-profile-dir*) [ -n "\${FAKE_PROFILE+x}" ] && echo "$FAKE_PROFILE" || echo /app/.qbhost/profile ;;
         *remote-stdio*) case $FAKE_RUN in
             fail) exit 125 ;;
             hang) exec sleep 30 ;;
             ignore-term) trap '' TERM; while :; do sleep 0.2; done ;;
             deploy) touch "$DOCKER_LOG.deployed"; cat ;;
             *) cat ;;
           esac ;;
       esac ;;
esac
exit 0`,
  );

  /** A fresh "data/" folder for the helper (real path: the helper compares readlink -f results). */
  const dataDir = () => realpathSync(mkdtempSync(path.join(tmp, 'data-')));
  const runScript = (args: string[], env: Record<string, string> = {}, input = 'relay-bytes', signal?: NodeJS.Signals) =>
    new Promise<{ code: number | null; stdout: string; stderr: string; calls: string[]; ms: number }>((resolve) => {
      const log = path.join(tmp, `docker-${Math.random().toString(36).slice(2)}.log`);
      writeFileSync(log, '');
      const t0 = Date.now();
      const child = spawn('bash', [SCRIPT, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, FAKE_DATA: dataDir(), ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.stdin.end(input);
      if (signal) {
        const timer = setInterval(() => {
          if (readFileSync(log, 'utf8').includes('remote-stdio')) {
            clearInterval(timer);
            setTimeout(() => child.kill(signal), 100);
          }
        }, 20);
      }
      child.on('close', (code) => resolve({ code, stdout, stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), ms: Date.now() - t0 }));
    });
  /** The state-changing steps, in order. */
  const steps = (calls: string[]) =>
    calls.flatMap((c) => {
      const w = c.split(' ');
      if (w[0] === 'run') {
        if (c.includes('print-profile-dir')) return ['print'];
        if (c.includes('--entrypoint sh')) return [c.includes('mkdir -p') ? 'mkdir' : c.includes('rm -rf') ? 'rmprofile' : 'check'];
        if (c.includes('--entrypoint stat')) return ['stat'];
        if (c.includes('remote-stdio')) return ['login'];
      }
      if (w[0] === 'stop') return [w.at(-1) === 'qbhost-login' ? 'stop-login' : `stop:${w.at(-1)}`];
      if (w[0] === 'rm') return [`rm:${w.at(-1)}`];
      if (w[0] === 'start') return [`start:${w.at(-1)}`];
      if (w[0] === 'update') return [`update:${w[2]}`];
      return [];
    });
  const loginRun = (calls: string[]) => calls.find((c) => c.includes('remote-stdio'))!.split(' ');

  it('passes bash -n', () => {
    execFileSync('bash', ['-n', SCRIPT]);
  });

  it('login: checks first, stops the bot, runs the container with only the profile writable, starts the bot', async () => {
    const r = await runScript(['login']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('QBBOT running\nrelay-bytes'); // state line, then the container's stdout unchanged
    expect(steps(r.calls)).toEqual(['print', 'mkdir', 'update:always', 'stop:bot123', 'rm:qbhost-login', 'login', 'stop-login', 'rm:qbhost-login', 'start:bot123', 'update:unless-stopped']);
    const run = loginRun(r.calls);
    const mounts = run.filter((_, i) => run[i - 1] === '--mount');
    const writable = mounts.filter((m) => !m.endsWith(',readonly'));
    expect(writable).toEqual(['type=bind,src=/srv/qb/data/profile,dst=/app/.qbhost/profile']); // exactly one
    expect(mounts).toContain('type=bind,src=/srv/qb/qbhost.config.json,dst=/app/qbhost.config.json,readonly');
    expect(run).not.toContain('-v');
    expect(run).not.toContain('--volume');
    for (const want of ['-i', '--rm', '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', IMAGE]) expect(run).toContain(want);
    const tmpfs = run.filter((_, i) => run[i - 1] === '--tmpfs');
    expect(tmpfs.map((t) => t.split(':')[0])).toEqual(['/app/.qbhost', '/tmp']);
    expect(tmpfs[0]).toContain('uid=1000,gid=1000');
    expect(run.join(' ')).toContain('--log-driver none');
    expect(run.join(' ')).toContain('no-new-privileges:true');
    for (const never of ['--env-file', '-p', '--publish', '--privileged', '--network']) expect(run).not.toContain(never);
    expect(run.join(' ')).not.toContain('.env');
    expect(r.stderr).toMatch(/Bot läuft wieder/);
  });

  it('everything that can fail fails before the bot is stopped', async () => {
    const cases: Record<string, string>[] = [{ FAKE_PROFILE: '' }, { FAKE_PROFILE: '/etc/passwd' }, { FAKE_PROFILE: '/app/.qbhost/../x' }, { FAKE_PROFILE: '/app/.qbhost/home' }, { FAKE_PROFILE: '/app/.qbhost/voice/p' }, { FAKE_NOBOT: '1' }];
    for (const env of cases) {
      const r = await runScript(['login'], env);
      expect(r.code).toBe(1);
      expect(steps(r.calls).filter((s) => s.startsWith('stop') || s.startsWith('update') || s === 'login')).toEqual([]);
    }
  });

  it('starts the bot again when the login container fails', async () => {
    const r = await runScript(['login'], { FAKE_RUN: 'fail' });
    expect(r.code).toBe(125);
    expect(steps(r.calls).slice(-4)).toEqual(['stop-login', 'rm:qbhost-login', 'start:bot123', 'update:unless-stopped']);
  });

  it('kills a docker run that ignores SIGTERM after the limit (timeout -k) and starts the bot', async () => {
    const r = await runScript(['login'], { FAKE_RUN: 'ignore-term', QBHOST_LOGIN_LIMIT: '1', QBHOST_LOGIN_GRACE: '1' });
    expect(r.code).toBe(137);
    expect(r.ms).toBeLessThan(8000);
    expect(steps(r.calls).slice(-4)).toEqual(['stop-login', 'rm:qbhost-login', 'start:bot123', 'update:unless-stopped']);
  }, 20000);

  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    it(`starts the bot again when the script gets ${sig}`, async () => {
      const r = await runScript(['login'], { FAKE_RUN: 'hang' }, '', sig);
      expect(r.code).not.toBe(0);
      expect(steps(r.calls).slice(-2)).toEqual(['start:bot123', 'update:unless-stopped']);
    }, 20000);
  }

  it('leaves a stopped bot stopped (and its restart policy alone)', async () => {
    const r = await runScript(['login'], { FAKE_RUNNING: 'false' });
    expect(r.code).toBe(0);
    expect(steps(r.calls).filter((s) => /^(stop:|start|update)/.test(s))).toEqual([]);
  });

  it('a deploy during the login: says so and does not start the old container', async () => {
    const r = await runScript(['login'], { FAKE_RUN: 'deploy' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/neu deployt/);
    expect(steps(r.calls)).not.toContain('start:bot123');
  });

  it('takes the owner of data/ when the bot container has no user', async () => {
    const r = await runScript(['login'], { FAKE_USER: '' });
    expect(steps(r.calls)[0]).toBe('stat');
    expect(loginRun(r.calls)).toContain('1001:1002');
  });

  it('logout deletes only the profile the bot uses and starts the bot again', async () => {
    const data = dataDir();
    mkdirSync(path.join(data, 'chrome/Default'), { recursive: true });
    writeFileSync(path.join(data, 'keep.json'), '{}');
    const r = await runScript(['logout'], { FAKE_PROFILE: '/app/.qbhost/chrome', FAKE_DATA: data });
    expect(r.code).toBe(0);
    const rm = r.calls.find((c) => c.includes('rm -rf'))!;
    expect(rm).toContain(`--mount type=bind,src=/srv/qb/data,dst=/d --entrypoint sh ${IMAGE} -c `);
    expect(rm).toMatch(/ qbhost-helper \/d\/chrome$/);
    expect(rm).toContain('--network none');
    expect(existsSync(path.join(data, 'chrome'))).toBe(false);
    expect(existsSync(path.join(data, 'keep.json'))).toBe(true);
    expect(steps(r.calls)).toEqual(['print', 'check', 'update:always', 'stop:bot123', 'rm:qbhost-login', 'rmprofile', 'stop-login', 'rm:qbhost-login', 'start:bot123', 'update:unless-stopped']);
  });

  it('reports the state before the run on stdout before anything changes (QBBOT)', async () => {
    expect((await runScript(['login'])).stdout).toBe('QBBOT running\nrelay-bytes');
    expect((await runScript(['login'], { FAKE_RUNNING: 'false' })).stdout).toBe('QBBOT stopped\nrelay-bytes');
  });

  it('status: exit 0 if the bot runs, 3 with a start command only if it ran before, 4 if it was off before', async () => {
    const fast = { QBHOST_STATUS_WAIT: '1', QBHOST_STATUS_START_WAIT: '1', QBHOST_STATUS_STABLE: '1' };
    const ok = await runScript(['status', 'running'], fast);
    expect(ok.code).toBe(0);
    expect(steps(ok.calls)).toEqual([]); // read-only
    const off = await runScript(['status', 'running'], { ...fast, FAKE_RUNNING: 'false' });
    expect(off.code).toBe(3);
    expect(off.stderr).toMatch(/lief vorher[\s\S]*sudo docker start bot123/);
    const loop = await runScript(['status', 'running'], { ...fast, FAKE_RESTARTING: 'true', QBHOST_STATUS_START_WAIT: '2', QBHOST_STATUS_STABLE: '2' });
    expect(loop.code).toBe(3); // a crash loop is not "running"
    for (const before of ['stopped', 'unknown', 'bogus']) {
      const r = await runScript(['status', before], { ...fast, FAKE_RUNNING: 'false' });
      expect(r.code).toBe(4);
      expect(r.stderr).not.toMatch(/docker start/);
    }
  }, 40000);

  it('status warns with the reset command when the restart policy is still "always"', async () => {
    const fast = { QBHOST_STATUS_WAIT: '1', QBHOST_STATUS_START_WAIT: '1', QBHOST_STATUS_STABLE: '1' };
    const r = await runScript(['status', 'running'], { ...fast, FAKE_POLICY: 'always' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/steht noch auf "always"[\s\S]*sudo docker update --restart unless-stopped bot123/);
    expect((await runScript(['status', 'running'], fast)).stderr).not.toMatch(/always/);
  });

  it('a failed reset of the restart policy is reported with the command to fix it', async () => {
    const r = await runScript(['login'], { FAKE_UPDATE_FAIL: '1' });
    expect(r.code).toBe(0);
    expect(steps(r.calls).slice(-2)).toEqual(['start:bot123', 'update:unless-stopped']);
    expect(r.stderr).toMatch(/blieb auf "always"[\s\S]*sudo docker update --restart unless-stopped bot123/);
  });

  it('with live-restore (or when unknown) the restart policy is left alone', async () => {
    const cases: Record<string, string>[] = [{ FAKE_LIVERESTORE: 'true' }, { FAKE_INFO_FAIL: '1' }];
    for (const env of cases) {
      const r = await runScript(['login'], env);
      expect(r.code).toBe(0);
      expect(steps(r.calls).filter((s) => s.startsWith('update'))).toEqual([]);
      expect(steps(r.calls)).toContain('start:bot123');
      expect(r.stderr).toMatch(/live-restore/);
    }
  });

  it('refuses "." and empty path segments in the profile path before the bot is stopped', async () => {
    for (const p of ['/app/.qbhost/.', '/app/.qbhost/./profile', '/app/.qbhost//profile', '/app/.qbhost/profile/', '/app/.qbhost/a/../profile']) {
      const r = await runScript(['login'], { FAKE_PROFILE: p });
      expect(r.code).toBe(1);
      expect(steps(r.calls)).toEqual(['print']);
    }
  });

  it('refuses a profile path through a symlink (login and logout) before the bot is stopped', async () => {
    const data = dataDir();
    const outside = dataDir();
    writeFileSync(path.join(outside, 'secret'), 'x');
    symlinkSync(outside, path.join(data, 'profile'));
    for (const mode of ['login', 'logout']) {
      const r = await runScript([mode], { FAKE_DATA: data });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Symlink/);
      expect(steps(r.calls).filter((s) => /^(stop|update|login|rmprofile)/.test(s))).toEqual([]);
    }
    symlinkSync(outside, path.join(data, 'link'));
    const deep = await runScript(['login'], { FAKE_DATA: data, FAKE_PROFILE: '/app/.qbhost/link/profile' });
    expect(deep.code).toBe(1);
    expect(existsSync(path.join(outside, 'secret'))).toBe(true);
  });

  it('refuses unknown modes without touching docker', async () => {
    const r = await runScript(['shell']);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
