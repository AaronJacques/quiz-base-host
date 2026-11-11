import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import type { EventBus, HostEvents } from '../../core/events.ts';
import { createLogger } from '../../core/logger.ts';
import type { PlayerState } from '../../core/types.ts';
import type { Channel } from '../channel.ts';

const log = createLogger('web');
const PAGE = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

/** Everything a freshly connected phone needs to render the current situation. */
interface Snapshot {
  lobbyCode: string | null;
  status: string;
  players: PlayerState[];
  turn: HostEvents['host:turn'] | null;
  question: HostEvents['host:question'] | null;
  awaiting: HostEvents['host:await-answer'] | null;
  verdict: HostEvents['host:verdict'] | null;
  reveal: string | null;
  feed: string[];
  over: boolean;
}

/**
 * "Spieler-Pult": a tiny mobile web page served by the host. Players pick
 * questions and type answers here instead of telling a human host via voice.
 * Transport: plain HTTP + Server-Sent Events, no dependencies.
 */
export class WebCompanion implements Channel {
  readonly name = 'web';
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private tokens = new Map<string, string>(); // token → player name
  private bus!: EventBus;
  private snap: Snapshot = {
    lobbyCode: null, status: 'Warte auf Lobby …', players: [], turn: null, question: null,
    awaiting: null, verdict: null, reveal: null, feed: [], over: false,
  };

  constructor(private opts: { port: number; host: string }) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    bus.on('host:status', ({ message }) => {
      this.snap.status = message;
      const m = message.match(/Code ([A-Z0-9]{4,8})/);
      if (m) this.snap.lobbyCode = m[1]!;
      this.push('status', { message });
    });
    bus.on('host:scores', ({ players }) => {
      this.snap.players = players;
      this.push('scores', { players });
    });
    bus.on('host:turn', (t) => {
      Object.assign(this.snap, { turn: t, question: null, awaiting: null, verdict: null, reveal: null });
      this.push('turn', t);
    });
    bus.on('host:question', (q) => {
      Object.assign(this.snap, { question: q, awaiting: null, verdict: null, reveal: null });
      this.push('question', q);
    });
    bus.on('host:await-answer', (a) => {
      this.snap.awaiting = a;
      this.push('await', a);
    });
    bus.on('host:verdict', (v) => {
      Object.assign(this.snap, { verdict: v, awaiting: null });
      this.push('verdict', v);
    });
    bus.on('host:reveal', ({ answer }) => {
      this.snap.reveal = answer;
      this.push('reveal', { answer });
    });
    bus.on('host:say', ({ text }) => {
      this.snap.feed = [...this.snap.feed.slice(-29), text];
      this.push('say', { text });
    });
    bus.on('host:game-over', ({ players }) => {
      Object.assign(this.snap, { over: true, players });
      this.push('over', { players });
    });

    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.json(res, 500, { error: String(e) })));
    await new Promise<void>((r) => this.server!.listen(this.opts.port, this.opts.host, r));
    for (const url of this.urls()) log.info(`Spieler-Pult: ${url}`);
  }

  urls(): string[] {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i!.address);
    return [`http://localhost:${this.opts.port}`, ...ips.map((ip) => `http://${ip}:${this.opts.port}`)];
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/events') return this.sse(req, res);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/join': return this.join(res, body);
        case '/api/pick': return this.pick(res, body);
        case '/api/answer': return this.answer(res, body);
      }
    }
    this.json(res, 404, { error: 'not found' });
  }

  private join(res: http.ServerResponse, body: any): void {
    const name = String(body.name ?? '').trim();
    const code = String(body.code ?? '').trim().toUpperCase();
    if (this.snap.lobbyCode && code !== this.snap.lobbyCode) return this.json(res, 403, { error: 'Falscher Lobby-Code' });
    const known = this.snap.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!known) return this.json(res, 404, { error: `"${name}" ist noch nicht in der quiz-base-Lobby` });
    const token = randomBytes(12).toString('hex');
    this.tokens.set(token, known.name);
    log.info(`${known.name} hat das Spieler-Pult geöffnet`);
    this.json(res, 200, { token, name: known.name });
  }

  private pick(res: http.ServerResponse, body: any): void {
    const player = this.tokens.get(String(body.token));
    if (!player) return this.json(res, 401, { error: 'Bitte neu anmelden' });
    if (this.snap.turn?.player !== player) return this.json(res, 409, { error: 'Du bist nicht am Zug' });
    this.bus.emit('player:pick', { player, col: Number(body.col), row: Number(body.row) });
    this.json(res, 200, { ok: true });
  }

  private answer(res: http.ServerResponse, body: any): void {
    const player = this.tokens.get(String(body.token));
    if (!player) return this.json(res, 401, { error: 'Bitte neu anmelden' });
    const answer = String(body.answer ?? '').slice(0, 200).trim();
    if (this.snap.awaiting?.player !== player) return this.json(res, 409, { error: 'Gerade nicht dran' });
    this.bus.emit('player:answer', { player, answer });
    this.json(res, 200, { ok: true });
  }

  private sse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snap)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  private push(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
