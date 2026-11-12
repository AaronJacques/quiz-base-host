import http from 'node:http';
import { createLogger, sleep } from '../core/logger.ts';
import { decodeWav, durationMs, encodeWav, type Pcm } from './audio.ts';
import type { Speaker, Utterance, VoiceTransport } from './transport.ts';

const log = createLogger('loopback');

/**
 * A voice room over local HTTP, for tests and agent players – no Discord needed.
 *
 *   POST /speak?id=u-anna&name=Anna   body: WAV   → delivered to the bot as an utterance
 *   GET  /played?after=<seq>&wait=<ms>            → [{seq, ms}] of what the bot said (long poll)
 *   GET  /played/<seq>.wav                        → that audio
 *
 * Playback takes real time (scaled by `speed`), so timing behaves like a real room.
 */
export class LoopbackTransport implements VoiceTransport {
  readonly label = 'loopback';
  private server: http.Server;
  private handlers: ((u: Utterance) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private played: { seq: number; pcm: Pcm; at: number }[] = [];
  private waiters: (() => void)[] = [];
  private stopCurrent: (() => void) | null = null;

  constructor(readonly port: number, private speed = 1) {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => {
      res.writeHead(500).end(String(e?.message ?? e));
    }));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', () => {
      log.info(`Loopback-Voice auf http://127.0.0.1:${this.port}`);
      resolve();
    }));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/speak') {
      const body = await readBody(req);
      const pcm = decodeWav(body);
      const speaker: Speaker = { id: url.searchParams.get('id') ?? 'u-test', username: (url.searchParams.get('name') ?? 'test').toLowerCase(), displayName: url.searchParams.get('name') ?? 'Test' };
      const endedAt = Date.now();
      const u: Utterance = { speaker, pcm, startedAt: endedAt - durationMs(pcm), endedAt };
      for (const h of this.handlers) h(u);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ms: Math.round(durationMs(pcm)) }));
    }
    const wav = url.pathname.match(/^\/played\/(\d+)\.wav$/);
    if (wav) {
      const item = this.played.find((p) => p.seq === Number(wav[1]));
      if (!item) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(encodeWav(item.pcm));
    }
    if (url.pathname === '/played') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const wait = Math.min(120_000, Number(url.searchParams.get('wait') ?? 0));
      const end = Date.now() + wait;
      while (!this.played.some((p) => p.seq > after) && Date.now() < end) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, Math.max(1, end - Date.now()));
          this.waiters.push(() => (clearTimeout(t), r()));
        });
      }
      const items = this.played.filter((p) => p.seq > after).map((p) => ({ seq: p.seq, ms: Math.round(durationMs(p.pcm)), at: p.at }));
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items, now: Date.now() }));
    }
    res.writeHead(404).end();
  }

  async play(pcm: Pcm): Promise<void> {
    const seq = (this.played.at(-1)?.seq ?? 0) + 1;
    this.played.push({ seq, pcm, at: Date.now() });
    if (this.played.length > 500) this.played.shift();
    this.waiters.splice(0).forEach((w) => w());
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, durationMs(pcm) / this.speed);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.stopCurrent = done;
    });
    this.stopCurrent = null;
  }

  stop(): void {
    this.stopCurrent?.();
  }

  onUtterance(handler: (u: Utterance) => void): void {
    this.handlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.waiters.splice(0).forEach((w) => w());
    await sleep(10);
    await new Promise<void>((r) => this.server.close(() => r()));
    for (const h of this.closeHandlers) h();
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
