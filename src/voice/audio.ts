/** Minimal PCM helpers (s16le) – no ffmpeg needed for the voice pipeline. */
export interface Pcm {
  rate: number;
  channels: number;
  /** Interleaved 16-bit samples. */
  samples: Int16Array;
}

export function durationMs(p: Pcm): number {
  return (p.samples.length / p.channels / p.rate) * 1000;
}

export function toMono(p: Pcm): Pcm {
  if (p.channels === 1) return p;
  const n = Math.floor(p.samples.length / p.channels);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < p.channels; c++) sum += p.samples[i * p.channels + c]!;
    out[i] = Math.round(sum / p.channels);
  }
  return { rate: p.rate, channels: 1, samples: out };
}

/** Linear-interpolation resampler – plenty for speech. Mono or interleaved multi-channel. */
export function resample(p: Pcm, rate: number): Pcm {
  if (p.rate === rate) return p;
  const ch = p.channels;
  const inFrames = Math.floor(p.samples.length / ch);
  const outFrames = Math.max(1, Math.round((inFrames * rate) / p.rate));
  const out = new Int16Array(outFrames * ch);
  const step = p.rate / rate;
  for (let i = 0; i < outFrames; i++) {
    const pos = i * step;
    const i0 = Math.min(inFrames - 1, Math.floor(pos));
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const f = pos - i0;
    for (let c = 0; c < ch; c++) out[i * ch + c] = Math.round(p.samples[i0 * ch + c]! * (1 - f) + p.samples[i1 * ch + c]! * f);
  }
  return { rate, channels: ch, samples: out };
}

export function toChannels(p: Pcm, channels: number): Pcm {
  if (p.channels === channels) return p;
  const mono = toMono(p);
  if (channels === 1) return mono;
  const out = new Int16Array(mono.samples.length * channels);
  for (let i = 0; i < mono.samples.length; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = mono.samples[i]!;
  return { rate: p.rate, channels, samples: out };
}

/** Root mean square loudness (0 … 32767). */
export function rms(p: Pcm): number {
  if (!p.samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < p.samples.length; i++) sum += p.samples[i]! * p.samples[i]!;
  return Math.sqrt(sum / p.samples.length);
}

export function concat(parts: Pcm[]): Pcm {
  const first = parts[0];
  if (!first) return { rate: 48000, channels: 2, samples: new Int16Array(0) };
  const total = parts.reduce((n, p) => n + p.samples.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p.samples, off);
    off += p.samples.length;
  }
  return { rate: first.rate, channels: first.channels, samples: out };
}

export function pcmFromBuffer(buf: Buffer, rate: number, channels: number): Pcm {
  const copy = Buffer.from(buf); // aligned copy
  return { rate, channels, samples: new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2)) };
}

export function pcmToBuffer(p: Pcm): Buffer {
  return Buffer.from(p.samples.buffer, p.samples.byteOffset, p.samples.byteLength);
}

export function encodeWav(p: Pcm): Buffer {
  const data = pcmToBuffer(p);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(p.channels, 22);
  h.writeUInt32LE(p.rate, 24);
  h.writeUInt32LE(p.rate * p.channels * 2, 28);
  h.writeUInt16LE(p.channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Parses a 16-bit PCM WAV (any chunk order, e.g. macOS `say` adds a FLLR chunk). */
export function decodeWav(buf: Buffer): Pcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Keine WAV-Datei');
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Nur 16-bit-WAV unterstützt (ist ${bits})`);
      const end = Math.min(buf.length, body + (size === 0xffffffff || size === 0 ? buf.length : size));
      return pcmFromBuffer(buf.subarray(body, end), rate, channels);
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV ohne data-Chunk');
}
