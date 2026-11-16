// Fake `ssh` for test/server-login.test.ts: plays the server (FAKE_MODE for the login session, FAKE_STATUS for
// the final bot check), with a fake DevTools HTTP server behind the relay. Appends "<mode> <pid> <status arg>"
// to FAKE_CALLS and writes its argv to FAKE_ARGV (login/logout only). Like the real script, login/logout first
// print `QBBOT <FAKE_BEFORE>` on stdout (unless FAKE_BEFORE is "none").
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { serveRelay } from '../../src/browser/stdio-relay.ts';

const argv = process.argv.slice(2);
const remote = argv.at(-1) ?? '';
const [, mode = '?', arg = ''] = remote.match(/ qbhost-login (\w+)(?: (\w+))?$/) ?? [];
if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, `${mode} ${process.pid} ${arg}\n`);
if (mode === 'status') process.exit(Number(process.env.FAKE_STATUS ?? 0));
if (process.env.FAKE_ARGV) writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv));
const before = process.env.FAKE_BEFORE ?? 'running';
if (mode === 'logout') {
  process.stdout.write(before !== 'none' ? `QBBOT ${before}\n` : '', () => process.exit(0));
  await new Promise(() => {}); // the write callback exits
}
if (before !== 'none') process.stdout.write(`QBBOT ${before}\n`);

const fake = process.env.FAKE_MODE ?? 'relay';
if (fake === 'old') {
  // An image without `login --remote-stdio`.
  process.stderr.write('TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option --remote-stdio\n');
  process.exit(1);
}
if (fake === 'version') {
  process.stdout.write('QBRELAY 99\n');
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  if (fake === 'stubborn') process.on('SIGTERM', () => {}); // only SIGKILL helps
  const big = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const devtools = http.createServer((req, res) => {
    if (req.url === '/login-done') {
      res.end('bye');
      relay.done();
      relay.result(true);
      process.stdout.end(() => process.exit(0));
      return;
    }
    if (req.url === '/big') {
      res.setHeader('connection', 'close');
      res.end(big);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
  });
  await new Promise<void>((r) => devtools.listen(0, '127.0.0.1', r));
  const port = (devtools.address() as net.AddressInfo).port;
  process.stdout.write('stray entrypoint output\n'); // must be skipped by the Mac side
  const relay = serveRelay({
    input: process.stdin,
    output: process.stdout,
    connect: () => net.connect({ host: '127.0.0.1', port }),
    onEnd: () => {
      if (fake !== 'stubborn') process.exit(0);
    },
  });
}
