import { createRequire } from 'node:module';
import { createLogger } from '../core/logger.ts';

const log = createLogger('voice');
const require = createRequire(import.meta.url);

/**
 * Opus for Discord voice, on the WebAssembly build of libopus that ships with `opusscript` – but
 * with our own glue instead of `opusscript/index.js` (and so instead of prism-media's opus streams).
 *
 * Why: that wrapper builds its PCM buffers as `HEAPU16.subarray(ptr)` from a *byte* pointer and hands
 * their `byteOffset` (= 2 × ptr) to the C++ side. Every decoded frame and every frame to encode is
 * written ~7.7 KB away from its buffer, at twice its own address – into whatever else lives in the
 * shared WASM heap. One speaker never reaches that far. With the bot talking (an encoder) and two
 * people speaking at once, slot 0 writes into the decoder state of slot 2:
 * `opus_decoder.c:492 assertion failed … Aborted()`, then malloc is corrupted and `new OpusScript()`
 * traps with `memory access out of bounds` – thrown in the "speaking start" handler, so the process
 * died. On top of that it reserves room for 60 ms of PCM while its C++ side decodes up to 120 ms
 * (an empty packet even as 120 ms of concealment). Regression tests: `test/opus.test.ts`.
 *
 * The build itself has only 64 KB of stack right above its static data (data ends at 59 876, the
 * stack pointer starts at 126 000). Decoding a 120 ms SILK packet needs more and silently overwrites
 * static data – random bytes (a packet that is still DAVE-encrypted) can be such a packet. Up to
 * 60 ms the deepest decode measured ≈ 42 KB, so longer packets are refused; Discord sends 20 ms.
 *
 * The C++ side (`OpusScriptHandler`) has one quirk that this glue mirrors: PCM crosses the boundary
 * as one byte per 16-bit element, so N bytes of s16le PCM occupy 2N bytes of WASM memory.
 */

export const OPUS_RATE = 48000;
export const OPUS_CHANNELS = 2;
/** 20 ms – what Discord sends and expects. */
export const OPUS_FRAME = 960;
const FRAME_BYTES = OPUS_FRAME * OPUS_CHANNELS * 2;
const APPLICATION_AUDIO = 2049;
/** Largest packet we hand to libopus (opusscript's own limit, 3 × 1276 bytes). */
export const MAX_PACKET_BYTES = 3 * 1276;
/** Longest packet we decode: 60 ms (stack limit, see above). */
const MAX_PACKET_SAMPLES = 2880;
/**
 * PCM buffer in WASM memory, one byte per 16-bit element: room for 120 ms of stereo s16le, the frame
 * size the C++ side passes to `opus_decode` – even if a packet were longer than its TOC says.
 */
const PCM_BUFFER_BYTES = 2 * 5760 * OPUS_CHANNELS * 2;

interface OpusHandler {
  /** Returns samples per channel, or a negative libopus error. Writes 2 × samples × channels × 2 bytes at `pcm`. */
  _decode(packet: number, length: number, pcm: number): number;
  /** Reads `bytes` PCM bytes (one per 16-bit element) at `pcm`; returns the packet length or a negative error. */
  _encode(pcm: number, bytes: number, packet: number, frameSize: number): number;
}

/** The parts of opusscript's emscripten module we use. */
export interface OpusNative {
  /** Views are replaced when the memory grows – always read them from the module. */
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  OpusScriptHandler: { new (rate: number, channels: number, application: number): OpusHandler; destroy_handler(h: OpusHandler): void };
}

/** A fresh, private instance of the WASM module (≈2 ms). After a fault the old one is simply dropped. */
export function loadOpusNative(): OpusNative {
  const factory = require('opusscript/build/opusscript_native_wasm.js') as (m?: object) => OpusNative;
  // libopus reports assertion failures on stderr – route them into our log instead.
  return factory({ print: (s: string) => log.debug(`Opus: ${s}`), printErr: (s: string) => log.warn(`Opus: ${s}`) });
}

/**
 * Samples per channel (48 kHz) of an Opus packet according to its TOC byte (RFC 6716 §3.1),
 * 0 for packets libopus must not see: empty (it would conceal 120 ms), longer than 60 ms, oversized,
 * or malformed.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (!packet.length || packet.length > MAX_PACKET_BYTES) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  const perFrame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? [480, 960][config & 1]! : [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (packet.length < 2) return 0;
    frames = packet[1]! & 0x3f;
  }
  const samples = frames * perFrame;
  return samples > 0 && samples <= MAX_PACKET_SAMPLES ? samples : 0;
}

/** One libopus encoder+decoder pair (`OpusScriptHandler`) with correctly placed and sized buffers. */
export class OpusCodec {
  private handle: OpusHandler;
  readonly packetPtr: number;
  readonly pcmPtr: number;

  constructor(readonly native: OpusNative) {
    this.handle = new native.OpusScriptHandler(OPUS_RATE, OPUS_CHANNELS, APPLICATION_AUDIO);
    this.packetPtr = native._malloc(MAX_PACKET_BYTES);
    this.pcmPtr = native._malloc(PCM_BUFFER_BYTES);
    if (!this.packetPtr || !this.pcmPtr) throw new Error('Opus: kein Speicher');
  }

  /** 48 kHz stereo s16le PCM of one packet; null if libopus rejects it. Check `opusPacketSamples` first. */
  decode(packet: Uint8Array): Buffer | null {
    if (!opusPacketSamples(packet)) return null;
    this.native.HEAPU8.set(packet, this.packetPtr);
    const samples = this.handle._decode(this.packetPtr, packet.length, this.pcmPtr);
    if (samples <= 0 || samples > MAX_PACKET_SAMPLES) return null;
    const at = this.pcmPtr >> 1;
    // One byte per element: Buffer.from keeps the low byte of each, which is the PCM byte.
    return Buffer.from(this.native.HEAPU16.subarray(at, at + samples * OPUS_CHANNELS * 2));
  }

  /** One 20 ms frame (48 kHz stereo s16le, exactly 3840 bytes) → one Opus packet. */
  encode(frame: Uint8Array): Buffer {
    if (frame.length !== FRAME_BYTES) throw new Error(`Opus: Frame muss ${FRAME_BYTES} Bytes haben, nicht ${frame.length}`);
    this.native.HEAPU16.set(frame, this.pcmPtr >> 1);
    const len = this.handle._encode(this.pcmPtr, frame.length, this.packetPtr, OPUS_FRAME);
    if (len < 0 || len > MAX_PACKET_BYTES) throw new Error(`Opus-Kodierung: Fehler ${len}`);
    return Buffer.from(this.native.HEAPU8.subarray(this.packetPtr, this.packetPtr + len));
  }

  free(): void {
    this.native.OpusScriptHandler.destroy_handler(this.handle);
    this.native._free(this.packetPtr);
    this.native._free(this.pcmPtr);
  }
}

/**
 * One Opus decoder per speaker, reused across utterances (a speaker's utterances never overlap),
 * all in one private WASM module. `decode` never throws: a packet libopus rejects is skipped, and
 * after any error inside the module (a trap or an emscripten abort leaves its heap untrustworthy)
 * the whole module is dropped – the next packet gets a fresh one. A fault costs one packet.
 */
export class OpusDecoders {
  private native: OpusNative | null = null;
  private codecs = new Map<string, OpusCodec>();
  /** Module replacements so far. */
  faults = 0;

  constructor(private load: () => OpusNative = loadOpusNative) {}

  decode(speaker: string, packet: Uint8Array): Buffer | null {
    if (!opusPacketSamples(packet)) return null;
    try {
      return this.codec(speaker).decode(packet);
    } catch (e) {
      this.fault(e);
      return null;
    }
  }

  private codec(speaker: string): OpusCodec {
    this.native ??= this.load();
    let c = this.codecs.get(speaker);
    if (!c) this.codecs.set(speaker, (c = new OpusCodec(this.native)));
    return c;
  }

  private fault(e: unknown): void {
    this.faults++;
    log.warn(`Opus-Dekodierung fehlgeschlagen (${(e as Error)?.message ?? e}) – starte den Decoder neu`);
    this.native = null; // never call into a broken heap again, not even to free it
    this.codecs.clear();
  }

  /** Frees the decoder of someone who left. */
  release(speaker: string): void {
    const c = this.codecs.get(speaker);
    if (!c) return;
    this.codecs.delete(speaker);
    try {
      c.free();
    } catch (e) {
      this.fault(e);
    }
  }

  close(): void {
    for (const id of [...this.codecs.keys()]) this.release(id);
    this.native = null;
  }
}

/** Encodes the bot's speech into 20 ms Opus packets, in a private module of its own (a decoder fault leaves playback alone). */
export class OpusEncoder {
  private codec: OpusCodec | null = null;
  faults = 0;

  constructor(private load: () => OpusNative = loadOpusNative) {}

  /**
   * 48 kHz stereo s16le PCM → Opus packets, encoded lazily while they are played (the last frame is
   * padded with silence). After an error the module is replaced and this sentence ends early.
   */
  *packets(pcm: Uint8Array): Generator<Buffer> {
    for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
      let frame = pcm.subarray(off, off + FRAME_BYTES);
      if (frame.length < FRAME_BYTES) {
        const padded = new Uint8Array(FRAME_BYTES);
        padded.set(frame);
        frame = padded;
      }
      let packet: Buffer;
      try {
        packet = (this.codec ??= new OpusCodec(this.load())).encode(frame);
      } catch (e) {
        this.faults++;
        this.codec = null;
        log.warn(`Opus-Kodierung fehlgeschlagen (${(e as Error)?.message ?? e}) – starte den Encoder neu`);
        return;
      }
      yield packet;
    }
  }

  close(): void {
    try {
      this.codec?.free();
    } catch {
      /* module is dropped anyway */
    }
    this.codec = null;
  }
}

/**
 * Encode → decode one tone: catches an opusscript build whose C++ side no longer matches this glue
 * (the voice channel is then refused with a clear message instead of producing noise).
 */
export function opusSelfTest(load: () => OpusNative = loadOpusNative): void {
  const native = load();
  const codec = new OpusCodec(native);
  try {
    const frame = Buffer.alloc(FRAME_BYTES);
    let energy = 0;
    for (let f = 0; f < 5; f++) {
      for (let i = 0; i < OPUS_FRAME; i++) {
        const v = Math.round(Math.sin(((f * OPUS_FRAME + i) / OPUS_RATE) * 2 * Math.PI * 440) * 8000);
        frame.writeInt16LE(v, i * 4);
        frame.writeInt16LE(v, i * 4 + 2);
      }
      const pcm = codec.decode(codec.encode(frame));
      if (!pcm || pcm.length !== FRAME_BYTES) throw new Error('Opus-Selbsttest: falsche Länge');
      if (f === 4) for (let i = 0; i < OPUS_FRAME; i++) energy += Math.abs(pcm.readInt16LE(i * 4));
    }
    const mean = energy / OPUS_FRAME; // a 8000-amplitude sine averages ≈ 5100
    if (mean < 2500 || mean > 8000) throw new Error(`Opus-Selbsttest: unerwartetes Signal (${Math.round(mean)})`);
  } finally {
    codec.free();
  }
}
