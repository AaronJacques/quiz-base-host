import net from 'node:net';
import type { Readable, Writable } from 'node:stream';

/**
 * A tiny TCP multiplexer over one byte stream (stdin/stdout of `ssh … docker run -i …`).
 *
 * `qbhost login --server` needs the DevTools port of a headless Chromium in a container on the VPS, but the
 * server allows no SSH port forwarding. So the Mac side listens on 127.0.0.1, and every TCP connection becomes
 * a channel in frames over the ssh session; the container side opens the matching connection to the DevTools
 * port on its own loopback. The relay is a byte pipe: it never parses, logs or stores what it carries (that
 * traffic includes the user's keystrokes on their way to the login form).
 *
 * Wire format: one hello line `QBRELAY <version>\n` from the container side (bytes before it are skipped,
 * e.g. stray output of an entrypoint), then frames `[type u8][channel u32 BE][length u32 BE][payload]`.
 */
export const RELAY_PROTOCOL = 1;
const MAGIC = 'QBRELAY ';
const MAX_PRELUDE = 64 * 1024;
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_CHANNELS = 64;

export const Frame = {
  /** Mac → container: a new TCP connection. */
  Open: 1,
  Data: 2,
  /** Either way: the connection ended. */
  Close: 3,
  /** Container → Mac: the relay is over (login seen, time up, …) – close the listener now. */
  Done: 4,
  /** Container → Mac: final result, JSON `{ ok: boolean }`. */
  Result: 5,
} as const;
export type FrameType = (typeof Frame)[keyof typeof Frame];

export const helloLine = (version = RELAY_PROTOCOL) => `${MAGIC}${version}\n`;

export function encodeFrame(type: FrameType, channel: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(channel >>> 0, 1);
  head.writeUInt32BE(payload.length, 5);
  return Buffer.concat([head, payload]);
}

export interface DecodedFrame {
  type: number;
  channel: number;
  payload: Buffer;
}

/**
 * Incremental decoder; with `hello`, first waits for (and reports) the hello line. Complete lines before it
 * (entrypoint output, the server script's `QBBOT …` line) go to `line`.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private greeted: boolean;
  private prelude = 0;

  constructor(
    private onFrame: (f: DecodedFrame) => void,
    private opts: { hello?: (version: number) => void; line?: (text: string) => void } = {},
  ) {
    this.greeted = !opts.hello;
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.greeted) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) {
        if (this.prelude + this.buf.length > MAX_PRELUDE) throw new Error('relay: no hello line');
        return;
      }
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      this.prelude += nl + 1;
      const at = line.indexOf(MAGIC);
      if (at < 0) {
        if (this.prelude > MAX_PRELUDE) throw new Error('relay: no hello line');
        this.opts.line?.(line.toString('utf8'));
        continue;
      }
      const version = Number(line.subarray(at + MAGIC.length).toString('latin1').trim());
      this.greeted = true;
      this.opts.hello!(Number.isFinite(version) ? version : NaN);
    }
    while (this.buf.length >= 9) {
      const len = this.buf.readUInt32BE(5);
      if (len > MAX_FRAME) throw new Error('relay: frame too large');
      if (this.buf.length < 9 + len) return;
      const frame = { type: this.buf.readUInt8(0), channel: this.buf.readUInt32BE(1), payload: this.buf.subarray(9, 9 + len) };
      this.buf = this.buf.subarray(9 + len);
      this.onFrame(frame);
    }
  }
}

/**
 * Frame writer with backpressure: while `out` (the ssh pipe) is full, all TCP sockets feeding it pause, so
 * nothing piles up in memory; they resume on 'drain'.
 */
function writer(out: Writable, sockets: Map<number, net.Socket>) {
  let blocked = false;
  return (type: FrameType, channel: number, payload?: Buffer) => {
    if (!out.writable || out.destroyed) return;
    if (out.write(encodeFrame(type, channel, payload)) || blocked) return;
    blocked = true;
    for (const s of sockets.values()) s.pause();
    out.once('drain', () => {
      blocked = false;
      for (const s of sockets.values()) s.resume();
    });
  };
}

/** The peer closed a channel: flush what is still buffered for it (FIN after the data), then let it go. */
function endGently(s: net.Socket): void {
  s.end();
  setTimeout(() => s.destroy(), 5000).unref();
}

export interface RemoteRelay {
  /** Tells the Mac side to close its listener and drops all connections to the DevTools port. */
  done(): void;
  result(ok: boolean): void;
  /** Number of open channels (for tests). */
  readonly open: number;
}

/**
 * Container side: hello on `output`, then for each Open frame a TCP connection via `connect` (the DevTools
 * port on 127.0.0.1). `onEnd` fires when `input` ends – the Mac side or the ssh session is gone.
 */
export function serveRelay(opts: { input: Readable; output: Writable; connect: () => net.Socket; onEnd?: () => void }): RemoteRelay {
  const sockets = new Map<number, net.Socket>();
  const send = writer(opts.output, sockets);
  let finished = false;
  opts.output.write(helloLine());

  const drop = (id: number, notify: boolean) => {
    const s = sockets.get(id);
    if (!s) return;
    sockets.delete(id);
    if (notify) {
      s.destroy();
      send(Frame.Close, id);
    } else endGently(s);
  };
  const reader = new FrameReader((f) => {
    if (finished) return;
    if (f.type === Frame.Open) {
      if (sockets.has(f.channel) || sockets.size >= MAX_CHANNELS) return void send(Frame.Close, f.channel);
      const s = opts.connect();
      sockets.set(f.channel, s);
      s.on('data', (d: Buffer) => send(Frame.Data, f.channel, d));
      s.on('error', () => {});
      s.on('close', () => drop(f.channel, true));
    } else if (f.type === Frame.Data) {
      sockets.get(f.channel)?.write(f.payload);
    } else if (f.type === Frame.Close) {
      drop(f.channel, false);
    }
  });
  const end = () => {
    for (const s of sockets.values()) s.destroy();
    sockets.clear();
    opts.onEnd?.();
  };
  opts.input.on('data', (c: Buffer) => {
    try {
      reader.push(c);
    } catch {
      end();
    }
  });
  opts.input.once('end', end);
  opts.input.once('close', end);
  return {
    done() {
      if (finished) return;
      finished = true;
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
      send(Frame.Done, 0);
    },
    result(ok: boolean) {
      send(Frame.Result, 0, Buffer.from(JSON.stringify({ ok })));
    },
    get open() {
      return sockets.size;
    },
  };
}

export interface LocalRelay {
  /** The bound port on 127.0.0.1. */
  readonly port: number;
  /** Closes the listener and every connection; the port is free afterwards. */
  close(): Promise<void>;
  readonly open: number;
}

/** Mac side: listens on 127.0.0.1:`port` only and turns each connection into a channel over `output`. */
export async function listenRelay(opts: {
  port: number;
  output: Writable;
  /** Frames from the container side are fed in with `feed` (the caller owns the reader and the hello). */
}): Promise<LocalRelay & { feed(f: DecodedFrame): void }> {
  const sockets = new Map<number, net.Socket>();
  const send = writer(opts.output, sockets);
  let next = 1;
  let closed = false;
  const server = net.createServer((s) => {
    if (closed || sockets.size >= MAX_CHANNELS) return void s.destroy();
    const id = next++;
    sockets.set(id, s);
    send(Frame.Open, id);
    s.on('data', (d: Buffer) => send(Frame.Data, id, d));
    s.on('error', () => {});
    s.on('close', () => {
      if (sockets.delete(id)) send(Frame.Close, id);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: opts.port, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    feed(f) {
      if (f.type === Frame.Data) sockets.get(f.channel)?.write(f.payload);
      else if (f.type === Frame.Close) {
        const s = sockets.get(f.channel);
        sockets.delete(f.channel);
        if (s) endGently(s);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const gone = new Promise<void>((r) => server.close(() => r()));
      for (const s of sockets.values()) s.destroy();
      sockets.clear();
      await gone;
    },
    get open() {
      return sockets.size;
    },
  };
}
