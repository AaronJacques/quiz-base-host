import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/core/logger.ts';
import { DiscordVoiceTransport } from '../src/voice/discord-voice.ts';
import { loadOpusNative, MAX_PACKET_BYTES, OpusCodec, OpusDecoders, OpusEncoder, opusPacketSamples, opusSelfTest, type OpusNative } from '../src/voice/opus.ts';
import type { Speaker, Utterance } from '../src/voice/transport.ts';

setLogLevel((process.env.QB_LOG as any) ?? 'error');
const require = createRequire(import.meta.url);

/** 20 ms of a noisy tone, 48 kHz stereo s16le. */
function frame(f: number, hz = 220): Buffer {
  const b = Buffer.alloc(3840);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(Math.sin(((f * 960 + i) / 48000) * 2 * Math.PI * hz) * 8000 + Math.sin(i * 1.7) * 1500);
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
}
const source = new OpusCodec(loadOpusNative());
const packets = Array.from({ length: 50 }, (_, f) => source.encode(frame(f)));
const random = (n: number) => Buffer.from(Array.from({ length: n }, () => (Math.random() * 256) | 0));

/** A code-3 packet with `count` 20 ms frames (VBR). */
function multiFrame(count: number): Buffer {
  const frames = packets.slice(0, count);
  const lens = frames.slice(0, -1).flatMap((f) => {
    const l = f.length - 1;
    return l < 252 ? [l] : [252 + ((l - 252) % 4), (l - 252) >> 2];
  });
  return Buffer.concat([Buffer.from([(frames[0]![0]! & 0xfc) | 3, 0x80 | count, ...lens]), ...frames.map((f) => f.subarray(1))]);
}

describe('opus: packets', () => {
  it('reads the length of a packet from its TOC and refuses what libopus must not see', () => {
    expect(opusPacketSamples(packets[0]!)).toBe(960);
    expect(opusPacketSamples(Buffer.from([0xf8, 0xff, 0xfe]))).toBe(960); // Discord's silence frame
    expect(opusPacketSamples(multiFrame(3))).toBe(2880); // 60 ms
    expect(opusPacketSamples(multiFrame(4))).toBe(0); // 80 ms: deeper than the WASM stack allows for SILK
    expect(opusPacketSamples(Buffer.from([0x5d, 0x00]))).toBe(0); // 2 × 60 ms SILK – overflowed the stack
    expect(opusPacketSamples(Buffer.alloc(0))).toBe(0); // would be 120 ms of concealment
    expect(opusPacketSamples(Buffer.from([0xfb]))).toBe(0); // code 3 without frame count
    expect(opusPacketSamples(Buffer.from([0xfb, 0x00]))).toBe(0); // zero frames
    expect(opusPacketSamples(Buffer.from([0x1b, 0x03]))).toBe(0); // 3 × 60 ms > 120 ms
    expect(opusPacketSamples(Buffer.alloc(MAX_PACKET_BYTES + 1, 0xfc))).toBe(0);
  });
});

describe('opus: codec', () => {
  it('decodes exactly like libopus and writes only into its own buffer', () => {
    const native = loadOpusNative();
    const codec = new OpusCodec(native); // last allocation: the heap behind it is free
    const OpusScript = require('opusscript');
    const stock = new OpusScript(48000, 2); // alone in its module, so its output is still right
    // Stock opusscript hands 2 × ptr to the C++ side – the bug that crashed the bot.
    expect(stock.outPCM.byteOffset).toBe(2 * stock.outPCMPointer);
    const end = codec.pcmPtr + 2 * 5760 * 2 * 2;
    const guard = (from: number, to: number) => native.HEAPU8.fill(0xa5, from, to);
    const intact = (from: number, to: number) => native.HEAPU8.subarray(from, to).every((b) => b === 0xa5);
    guard(end + 16, end + 200_000);
    guard(2 * codec.pcmPtr, 2 * codec.pcmPtr + 50_000); // where stock opusscript would write
    for (const p of [...packets, multiFrame(2), multiFrame(3), Buffer.from([0xf8, 0xff, 0xfe])]) {
      const ours = codec.decode(p);
      const theirs: Buffer = stock.decode(p);
      expect(ours?.equals(theirs)).toBe(true);
    }
    expect(codec.decode(multiFrame(6))).toBeNull();
    for (let i = 0; i < 2000; i++) codec.decode(random(1 + (i % 400))); // ciphertext, garbage
    expect(intact(end + 16, end + 200_000)).toBe(true);
    expect(intact(2 * codec.pcmPtr, 2 * codec.pcmPtr + 50_000)).toBe(true);
    stock.delete();
    codec.free();
  });

  it('survives random bytes (e.g. still DAVE-encrypted packets) without breaking its module', () => {
    // 120 ms SILK packets used to overflow the 64 KB WASM stack into static data – free() then trapped.
    for (let trial = 0; trial < 150; trial++) {
      const codec = new OpusCodec(loadOpusNative());
      for (let i = 0; i < 20; i++) codec.decode(random(2 + ((i * 37 + trial * 11) % 300)));
      const p = random(200);
      p[0] = [0x5d, 0x59, 0x5e, 0x1d][trial % 4]!; // SILK 60 ms frames, 2 of them
      for (let i = 0; i < 5; i++) codec.decode(random(300).fill(p[0]!, 0, 1));
      expect(() => codec.free()).not.toThrow();
    }
  });

  it('round-trips the self test', () => {
    expect(() => opusSelfTest()).not.toThrow();
  });
});

describe('opus: decoder pool (live crash: bot speaking + two people at once)', () => {
  it('keeps two speakers and playback apart on one heap and never throws', () => {
    const pool = new OpusDecoders();
    const enc = new OpusEncoder();
    const ref = { a: new OpusCodec(loadOpusNative()), m: new OpusCodec(loadOpusNative()) };
    let mismatches = 0;
    let played = 0;
    // The order of the live crash: decoders come and go around a playing encoder, many times over.
    for (let round = 0; round < 200; round++) {
      const speech = enc.packets(Buffer.concat(packets.slice(0, 10).map((_, f) => frame(f, 330))));
      for (let f = 0; f < 10; f++) {
        if (!speech.next().done) played++;
        for (const [id, codec] of Object.entries(ref) as ['a' | 'm', OpusCodec][]) {
          const p = round % 7 === 3 && f === 5 ? random(1 + f * 30) : packets[(round + f + (id === 'a' ? 0 : 9)) % 50]!;
          const got = pool.decode(id, p);
          const want = opusPacketSamples(p) ? codec.decode(p) : null;
          if ((got === null) !== (want === null) || (got && !got.equals(want!))) mismatches++;
        }
      }
      if (round % 3 === 0) pool.release('a'); // Aaron pauses: his decoder goes, a new one comes next time
      if (round % 3 === 0) ref.a = (ref.a.free(), new OpusCodec(loadOpusNative()));
    }
    for (const p of [Buffer.alloc(0), random(5000), Buffer.from([0xfb]), multiFrame(6)]) expect(() => pool.decode('a', p)).not.toThrow();
    expect(mismatches).toBe(0);
    expect(pool.faults).toBe(0);
    expect(played).toBe(2000);
    pool.close();
    enc.close();
  });

  it('drops a broken WASM module after a trap and goes on with a fresh one (costs one packet)', () => {
    let loads = 0;
    let trapNext = false;
    const load = (): OpusNative => {
      const native = loadOpusNative();
      if (++loads === 1) {
        // The first module traps once, the way a corrupted heap does.
        const proto = (native.OpusScriptHandler as any).prototype;
        const real = proto._decode;
        proto._decode = function (this: unknown, ...args: unknown[]) {
          if (trapNext) {
            trapNext = false;
            throw new WebAssembly.RuntimeError('memory access out of bounds');
          }
          return real.apply(this, args);
        };
      }
      return native;
    };
    const pool = new OpusDecoders(load);
    expect(pool.decode('a', packets[0]!)?.length).toBe(3840);
    trapNext = true;
    expect(pool.decode('a', packets[1]!)).toBeNull();
    expect(pool.faults).toBe(1);
    expect(pool.decode('a', packets[2]!)?.length).toBe(3840);
    expect(pool.decode('m', packets[3]!)?.length).toBe(3840);
    expect(loads).toBe(2);
  });

  it('encodes speech lazily into 20 ms packets, padding the last frame', () => {
    const enc = new OpusEncoder();
    const pcm = Buffer.concat([frame(0), frame(1), frame(2).subarray(0, 1000)]);
    const out = [...enc.packets(pcm)];
    expect(out).toHaveLength(3);
    const dec = new OpusCodec(loadOpusNative());
    for (const p of out) expect(dec.decode(p)?.length).toBe(3840);
    enc.close();
  });
});

// ───────────────────────────── the Discord receive path ─────────────────────────────

class FakeConnection extends EventEmitter {
  state = { status: 'ready' };
  streams = new Map<string, Readable>();
  receiver = {
    speaking: new EventEmitter(),
    subscribe: (userId: string) => {
      const s = new Readable({ objectMode: true, read() {} });
      this.streams.set(userId, s);
      return s;
    },
  };
  subscribe() {}
  destroy() {
    this.state.status = 'destroyed';
    this.emit('destroyed');
  }
}

describe('DiscordVoiceTransport: receiving', () => {
  const speakers: Record<string, Speaker> = {
    a: { id: 'a', username: 'aaron', displayName: 'Aaron' },
    m: { id: 'm', username: 'marvin', displayName: 'Marvin' },
  };

  it('decodes two people at once, skips bad packets and lets no error escape into Discord', async () => {
    const conn = new FakeConnection();
    const t = new DiscordVoiceTransport(conn as any, {
      guildId: 'g', channelId: 'c', adapterCreator: null as any, silenceMs: 50, maxSpeechSec: 15,
      speaker: (id) => {
        if (id === 'boom') throw new Error('member lookup failed');
        return speakers[id] ?? null;
      },
    });
    const got: Utterance[] = [];
    const started: string[] = [];
    t.onUtterance((u) => got.push(u));
    t.onUtterance(() => {
      throw new Error('a broken handler');
    });
    t.onSpeechStart?.((s) => started.push(s.displayName));
    expect(() => conn.receiver.speaking.emit('start', 'boom')).not.toThrow();
    conn.receiver.speaking.emit('start', 'a');
    conn.receiver.speaking.emit('start', 'm');
    conn.receiver.speaking.emit('start', 'bot'); // no speaker → ignored
    const [sa, sm] = [conn.streams.get('a')!, conn.streams.get('m')!];
    for (let f = 0; f < 30; f++) {
      sa.push(packets[f]!);
      sm.push(packets[(f + 11) % 50]!);
      if (f % 5 === 0) sa.push(random(80)); // e.g. still DAVE-encrypted
      if (f % 7 === 0) sm.push(Buffer.alloc(0));
    }
    sm.push(Buffer.from([0xf8, 0xff, 0xfe]));
    sa.push(null);
    sm.push(null);
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toEqual(['Aaron', 'Marvin']);
    expect(got.map((u) => u.speaker.displayName).sort()).toEqual(['Aaron', 'Marvin']);
    const marvin = got.find((u) => u.speaker.id === 'm')!;
    expect(marvin.pcm.samples.length).toBe(31 * 960 * 2); // 30 packets + the silence frame
    const aaron = got.find((u) => u.speaker.id === 'a')!;
    expect(aaron.pcm.samples.length).toBeGreaterThanOrEqual(30 * 960 * 2); // random bytes may decode as noise, never fail
    await t.close();
  });
});
