// A stand-in for src/voice/sherpa_worker.py (same JSON-line protocol), so ParakeetStt is tested without
// Python, sherpa-onnx or a model. Behaviour from environment variables (the worker script path the
// adapter passes as first argument is ignored):
//   FAKE_STATE     folder for counters: starts (one line per start, with pid), overlap (a request came while busy)
//   FAKE_TEXT      text to answer (default "Text <samples>")
//   FAKE_DELAY     ms per recognition (default 0)
//   FAKE_READY_MS  ms before "ready" (default 0)
//   FAKE_HANG      the first n starts never answer a recognition
//   FAKE_CRASH     the first n starts exit(1) on their first recognition
//   FAKE_DIE       exit(3) at once, with a message on stderr
//   FAKE_NO_READY  never says ready
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const state = env.FAKE_STATE;
const startsFile = state ? path.join(state, 'starts') : null;
const nth = startsFile && existsSync(startsFile) ? readFileSync(startsFile, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
if (startsFile) appendFileSync(startsFile, `${process.pid}\n`);
process.on('SIGINT', () => {}); // like the real worker

if (env.FAKE_DIE) {
  process.stderr.write('ModuleNotFoundError: No module named sherpa_onnx\n');
  process.exit(3);
}
const hang = nth <= Number(env.FAKE_HANG ?? 0);
const crash = nth <= Number(env.FAKE_CRASH ?? 0);
const delay = Number(env.FAKE_DELAY ?? 0);
let busy = false;

setTimeout(() => {
  if (!env.FAKE_NO_READY) process.stdout.write(JSON.stringify({ ready: true, loadMs: 7 }) + '\n');
}, Number(env.FAKE_READY_MS ?? 0));

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.op === 'stats') return void process.stdout.write(JSON.stringify({ id: req.id, peakMb: 123 }) + '\n');
  if (busy && state) appendFileSync(path.join(state, 'overlap'), `${req.id}\n`);
  if (crash) process.exit(1);
  if (hang) return;
  busy = true;
  const samples = Buffer.from(req.pcm, 'base64').length / 2;
  setTimeout(() => {
    busy = false;
    process.stdout.write(JSON.stringify({ id: req.id, text: env.FAKE_TEXT ?? `Text ${samples}` }) + '\n');
  }, delay);
});
process.stdin.on('end', () => process.exit(0));
