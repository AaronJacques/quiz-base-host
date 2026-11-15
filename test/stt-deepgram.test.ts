import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/core/logger.ts';
import { decodeWav, durationMs, type Pcm } from '../src/voice/audio.ts';
import { CloudError } from '../src/voice/http.ts';
import { deepgramReachable, DeepgramStt, parseListen } from '../src/voice/stt-deepgram.ts';

setLogLevel('error');

const KEY = 'dg-test-SECRET-91bd3e77a0';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  socket: unknown;
}

/** Fake Deepgram: records each request; `reply` decides the answer (default: a transcript). */
async function fakeDeepgram() {
  const seen: Seen[] = [];
  const state = {
    reply: (_s: Seen, res: http.ServerResponse): void => void res.end(JSON.stringify(listen('Meine Antwort ist Paris.', 1.5))),
    aborted: 0,
    connections: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    res.on('close', () => {
      if (!res.writableEnded) state.aborted++;
    });
    req.on('end', () => {
      const s = { url: req.url!, headers: req.headers, body: Buffer.concat(chunks), socket: req.socket };
      seen.push(s);
      state.reply(s, res);
    });
  });
  server.on('connection', () => state.connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, state, url, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

function listen(transcript: string | undefined, duration = 1): unknown {
  return { metadata: { request_id: 'x', duration, channels: 1 }, results: { channels: [{ alternatives: transcript === undefined ? [] : [{ transcript, confidence: 0.9 }] }] } };
}

const tone = (ms: number, rate = 48000, channels = 2): Pcm => ({ rate, channels, samples: Int16Array.from({ length: (rate * ms * channels) / 1000 }, (_, i) => Math.round(Math.sin(i / 7) * 6000)) });

/** The query of a request: name → all values, decoded. */
function query(url: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of new URL(url, 'http://x').searchParams) (out[k] ??= []).push(v);
  return out;
}

let fake: Awaited<ReturnType<typeof fakeDeepgram>>;
beforeEach(async () => {
  fake = await fakeDeepgram();
});
afterEach(async () => {
  await fake.close();
});

const make = (o: Partial<ConstructorParameters<typeof DeepgramStt>[0]> = {}) =>
  new DeepgramStt({ baseUrl: fake.url, apiKey: KEY, model: 'nova-3', language: 'de', keyterms: true, ...o });

describe('DeepgramStt: the request', () => {
  it('POST /v1/listen with model, language, punctuate, mip_opt_out=true and one keyterm per prompt term', async () => {
    const stt = make();
    expect(stt.engine).toBe('deepgram:nova-3');
    expect(await stt.transcribe(tone(500), 'Quizmaster, Meine Antwort ist, Sport für 100, Anna, Ben')).toBe('Meine Antwort ist Paris.');
    const s = fake.seen[0]!;
    expect(s.url.startsWith('/v1/listen?')).toBe(true);
    expect(query(s.url)).toEqual({
      model: ['nova-3'],
      language: ['de'],
      punctuate: ['true'],
      keyterm: ['Quizmaster', 'Meine Antwort ist', 'Sport für 100', 'Anna', 'Ben'],
      mip_opt_out: ['true'],
    });
  });

  it('mip_opt_out=true is always there – also without keyterms, with an empty prompt and another model', async () => {
    for (const stt of [make({ keyterms: false }), make({ model: 'nova-3-general', language: 'de-CH' })]) {
      await stt.transcribe(tone(200), '');
      await stt.transcribe(tone(200), 'Anna, Ben');
    }
    expect(fake.seen).toHaveLength(4);
    for (const s of fake.seen) expect(query(s.url).mip_opt_out).toEqual(['true']);
    // Without keyterms or with an empty prompt: no keyterm parameter at all.
    expect(fake.seen.map((s) => query(s.url).keyterm ?? [])).toEqual([[], [], [], ['Anna', 'Ben']]);
    expect(query(fake.seen[2]!.url)).toMatchObject({ model: ['nova-3-general'], language: ['de-CH'] });
    // A trailing slash on baseUrl changes nothing.
    await new DeepgramStt({ baseUrl: `${fake.url}/`, apiKey: KEY, model: 'nova-3', language: 'de', keyterms: true }).transcribe(tone(100));
    expect(fake.seen[4]!.url.startsWith('/v1/listen?')).toBe(true);
  });

  it('keyterms: deduplicated, at most 50, umlauts and spaces URL-encoded', async () => {
    const terms = ['Größe', 'Straße', 'Übersee', 'Größe', 'Jürgen Müller', 'größe', ...Array.from({ length: 80 }, (_, i) => `Begriff${i}`)];
    await make().transcribe(tone(200), terms.join(', '));
    const s = fake.seen[0]!;
    const sent = query(s.url).keyterm!;
    expect(sent).toHaveLength(50);
    expect(sent.slice(0, 4)).toEqual(['Größe', 'Straße', 'Übersee', 'Jürgen Müller']);
    expect(new Set(sent.map((t) => t.toLowerCase())).size).toBe(50);
    // Raw URL: UTF-8 percent-encoded, a space as "+" (both are valid per the keyterm docs), no commas.
    expect(s.url).toContain('keyterm=Gr%C3%B6%C3%9Fe&');
    expect(s.url).toContain('keyterm=J%C3%BCrgen+M%C3%BCller&');
    expect(s.url).not.toMatch(/[äöüßÄÖÜ ,]/);
  });

  it('headers: Authorization Token <key>, Content-Type audio/wav; body: WAV 16 kHz mono 16 bit', async () => {
    const pcm = tone(750); // 48 kHz stereo, as Discord delivers it
    await make().transcribe(pcm);
    const s = fake.seen[0]!;
    expect(s.headers.authorization).toBe(`Token ${KEY}`);
    expect(s.headers['content-type']).toBe('audio/wav');
    const b = s.body;
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.toString('ascii', 8, 12)).toBe('WAVE');
    expect(b.readUInt16LE(20)).toBe(1); // PCM
    expect(b.readUInt16LE(22)).toBe(1); // mono
    expect(b.readUInt32LE(24)).toBe(16000);
    expect(b.readUInt16LE(34)).toBe(16);
    const wav = decodeWav(b);
    expect([wav.rate, wav.channels]).toEqual([16000, 1]);
    expect(durationMs(wav)).toBeCloseTo(750, -1);
  });

  it('reuses the connection between utterances (keep-alive), no new handshake per utterance', async () => {
    const stt = make();
    for (let i = 0; i < 6; i++) await stt.transcribe(tone(500));
    expect(fake.seen).toHaveLength(6);
    // Node's fetch (undici) keeps up to two sockets open and alternates between them – never one per request.
    expect(fake.state.connections).toBeLessThanOrEqual(2);
    expect(new Set(fake.seen.map((s) => s.socket)).size).toBeLessThanOrEqual(2);
  });
});

describe('DeepgramStt: the answer', () => {
  it('cleans the transcript like Whisper; empty or missing transcript → "" without error', async () => {
    const answers: unknown[] = [listen('  [Musik] Hier!  '), listen(''), listen(undefined), { results: { channels: [] } }, { results: { channels: [{}] } }, listen('Vielen Dank.'), { results: { channels: [{ alternatives: [{ transcript: null }] }] } }];
    fake.state.reply = (_s, res) => void res.end(JSON.stringify(answers.shift()));
    const stt = make();
    const got: string[] = [];
    for (let i = 0; i < 7; i++) got.push(await stt.transcribe(tone(100)));
    expect(got).toEqual(['Hier!', '', '', '', '', '', '']);
  });

  it('records the real audio length and the billed duration for the cost counter', async () => {
    const usage: unknown[] = [];
    await make({ usage: { record: (u) => void usage.push(u) } }).transcribe(tone(1250), 'Anna');
    expect(usage).toEqual([{ engine: 'deepgram:nova-3', audioSec: 1.25, billedSec: 1.5 }]);
    // A throwing counter never breaks recognition.
    expect(await make({ usage: { record: () => { throw new Error('voll'); } } }).transcribe(tone(100))).toBe('Meine Antwort ist Paris.');
  });

  it('parseListen: unexpected shapes are CloudError server', () => {
    for (const bad of [null, 'text', [], {}, { results: {} }, { results: { channels: 'x' } }, { results: { channels: ['x'] } }, { results: { channels: [{ alternatives: 'x' }] } }, { results: { channels: [{ alternatives: [{ transcript: 5 }] }] } }]) {
      let e: unknown;
      try {
        parseListen(bad);
      } catch (x) {
        e = x;
      }
      expect(e, JSON.stringify(bad)).toBeInstanceOf(CloudError);
      expect((e as CloudError).kind).toBe('server');
    }
    expect(parseListen(listen('a', 2))).toEqual({ transcript: 'a', billedSec: 2 });
    expect(parseListen({ results: { channels: [] } })).toEqual({ transcript: '', billedSec: undefined });
  });
});

describe('DeepgramStt: errors', () => {
  const fail = (stt: DeepgramStt, opts?: { signal?: AbortSignal }) => stt.transcribe(tone(100), 'Anna', opts).then(() => null, (e: CloudError) => e);

  it('401/403 auth, 402 quota, 408 timeout, 429 rate, 5xx and other 4xx server, 400/413/422 request – the key never in the message', async () => {
    let status = 0;
    fake.state.reply = (s, res) => {
      res.statusCode = status;
      res.end(`{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials: ${s.headers.authorization}"}`);
    };
    const got: Record<number, unknown> = {};
    for (status of [401, 403, 402, 408, 429, 500, 503, 404, 405, 400, 413, 422]) {
      const e = await fail(make());
      expect(e).toBeInstanceOf(CloudError);
      expect(e!.message).not.toContain(KEY);
      got[status] = [e!.kind, e!.status];
    }
    expect(got).toEqual({
      401: ['auth', 401],
      403: ['auth', 403],
      402: ['quota', 402],
      408: ['timeout', 408],
      429: ['rate', 429],
      500: ['server', 500],
      503: ['server', 503],
      404: ['server', 404],
      405: ['server', 405],
      400: ['request', 400],
      413: ['request', 413],
      422: ['request', 422],
    });
  });

  it('broken JSON and a non-JSON body → server', async () => {
    const bodies = ['{"results": {"channels": [', '<html>Bad Gateway</html>'];
    fake.state.reply = (_s, res) => void res.end(bodies.shift());
    for (let i = 0; i < 2; i++) {
      const e = await fail(make());
      expect([e!.kind, e!.message]).toEqual(['server', 'Deepgram: Antwort ist kein JSON']);
    }
  });

  it('aborted per signal (the fallback’s timeout): the request is cut off, kind timeout', async () => {
    fake.state.reply = () => {}; // never answers
    const ac = new AbortController();
    const p = fail(make(), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error('Frist'));
    const e = await p;
    expect(e!.kind).toBe('timeout');
    const t0 = Date.now();
    while (fake.state.aborted === 0 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    expect(fake.state.aborted).toBe(1);
    // Aborted while the body is still coming: also timeout, not "kein JSON".
    fake.state.reply = (_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"results":');
    };
    const ac2 = new AbortController();
    const p2 = fail(make(), { signal: ac2.signal });
    await new Promise((r) => setTimeout(r, 80));
    ac2.abort();
    expect((await p2)!.kind).toBe('timeout');
  });

  it('F5: a redirect is not followed – neither key nor audio reach another place', async () => {
    const other = await fakeDeepgram();
    try {
      fake.state.reply = (_s, res) => {
        res.writeHead(307, { Location: `${other.url}/v1/listen` });
        res.end();
      };
      const e = await fail(make());
      expect(e!.kind).toBe('network');
      expect(other.seen).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('F5: the key is never sent to a non-https address outside this machine', async () => {
    for (const baseUrl of ['http://api.eu.deepgram.com', 'http://127.0.0.2:1', 'api.eu.deepgram.com', 'ftp://api.eu.deepgram.com', '']) {
      expect(() => new DeepgramStt({ baseUrl, apiKey: KEY, model: 'nova-3', language: 'de', keyterms: true }), baseUrl).toThrow(
        'Deepgram: baseUrl muss mit https:// beginnen (http:// nur zu 127.0.0.1 oder localhost)',
      );
    }
    for (const baseUrl of ['https://api.eu.deepgram.com', 'http://127.0.0.1:1234', 'http://localhost:1234']) expect(() => make({ baseUrl })).not.toThrow();
  });

  it('unreachable → network', async () => {
    await fake.close();
    const e = await fail(make());
    expect(e!.kind).toBe('network');
    fake = await fakeDeepgram(); // for afterEach
  });
});

describe('deepgramReachable (doctor, no request, no cost)', () => {
  it('resolves for an open endpoint without sending a request, rejects for a closed one', async () => {
    expect(await deepgramReachable(fake.url)).toBeGreaterThanOrEqual(0);
    expect(fake.seen).toEqual([]);
    const url = fake.url;
    await fake.close();
    await expect(deepgramReachable(url)).rejects.toThrow(/127\.0\.0\.1 nicht erreichbar \(ECONNREFUSED\)/);
    fake = await fakeDeepgram();
  });
});
