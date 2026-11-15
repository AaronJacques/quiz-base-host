import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '../core/logger.ts';
import { durationMs, encodeWav, resample, toMono, type Pcm } from './audio.ts';
import { CloudError, cloudFetch, safeBaseUrl } from './http.ts';
import type { UsageSink } from './providers.ts';
import { cleanTranscript, promptTerms, type SpeechToText, type SttOptions } from './stt.ts';

const log = createLogger('stt');

export interface DeepgramSttOptions {
  /** `https://api.eu.deepgram.com` (EU endpoint, requests never leave the EU); tests point it at a local fake server. */
  baseUrl: string;
  /** From `.env` (`voice.deepgram.keyEnv`) – never logged, never in an error message. */
  apiKey: string;
  /** e.g. `nova-3` (keyterms work with Nova-3 only). */
  model: string;
  language: string;
  /** Send `promptTerms(prompt)` as `keyterm` parameters. */
  keyterms: boolean;
  usage?: UsageSink;
}

/**
 * Last-resort bound for one request. The real timeout is the fallback's (`voice.sttTimeoutMs`, it aborts
 * through `signal`); this only ends a request nobody bounds (e.g. `tools/stt-probe.ts --engine cloud`).
 */
const REQUEST_LIMIT_MS = 30_000;

/** Deepgram allows 500 tokens across all keyterms and advises 20–50 terms; the bot's prompt has fewer. */
const MAX_KEYTERMS = 50;

/**
 * Deepgram speech-to-text, pre-recorded (`POST /v1/listen`, docs: developers.deepgram.com/reference/
 * speech-to-text/listen-pre-recorded). The utterance goes as WAV 16 kHz mono; `mip_opt_out=true` is always
 * set and cannot be switched off – without it Deepgram may keep the audio to train its models (Model
 * Improvement Program). No own timeout and no fallback: `FallbackStt` does both and aborts via `signal`.
 * Node's `fetch` keeps the connection alive between utterances (no extra TLS handshake each time).
 */
export class DeepgramStt implements SpeechToText {
  readonly engine: string;
  readonly cloud = true;

  constructor(private readonly o: DeepgramSttOptions) {
    // The key goes with every request: never in clear text over the network, never to a non-URL.
    if (!safeBaseUrl(o.baseUrl)) throw new Error('Deepgram: baseUrl muss mit https:// beginnen (http:// nur zu 127.0.0.1 oder localhost)');
    this.engine = `deepgram:${o.model}`;
  }

  /** The request URL: fixed parameters, then one `keyterm` per term of the prompt (URL-encoded, at most 50). */
  url(prompt = ''): string {
    const q = new URLSearchParams({ model: this.o.model, language: this.o.language, punctuate: 'true' });
    if (this.o.keyterms) for (const term of promptTerms(prompt, MAX_KEYTERMS)) q.append('keyterm', term);
    q.set('mip_opt_out', 'true'); // fixed: never part of the Model Improvement Program
    return `${this.o.baseUrl.replace(/\/+$/, '')}/v1/listen?${q}`;
  }

  async transcribe(pcm: Pcm, prompt = '', opts: SttOptions = {}): Promise<string> {
    const wav = encodeWav(resample(toMono(pcm), 16000));
    const t0 = Date.now();
    const res = await cloudFetch(this.url(prompt), {
      method: 'POST',
      headers: { Authorization: `Token ${this.o.apiKey}`, 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wav),
      timeoutMs: REQUEST_LIMIT_MS,
      signal: opts.signal,
      service: 'Deepgram',
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (opts.signal?.aborted) throw new CloudError('timeout', 'Deepgram: abgebrochen (Frist abgelaufen)');
      throw new CloudError('server', 'Deepgram: Antwort ist kein JSON');
    }
    const { transcript, billedSec } = parseListen(body);
    try {
      this.o.usage?.record({ engine: this.engine, audioSec: durationMs(pcm) / 1000, billedSec });
    } catch {
      /* counting never breaks recognition */
    }
    const text = cleanTranscript(transcript);
    log.debug(`STT ${Date.now() - t0} ms (${this.engine}): "${transcript}"${text !== transcript.trim() ? ` → "${text}"` : ''}`);
    return text;
  }

  async close(): Promise<void> {}
}

/**
 * The transcript of a `/v1/listen` answer (`results.channels[0].alternatives[0].transcript`) and the
 * billed duration (`metadata.duration`). No speech (no channel, no alternative, no transcript) → ''. An
 * answer that is not shaped like that at all → `CloudError('server')`.
 */
export function parseListen(body: unknown): { transcript: string; billedSec?: number } {
  const b = body as { results?: { channels?: unknown }; metadata?: { duration?: unknown } } | null;
  if (!b || typeof b !== 'object' || !b.results || typeof b.results !== 'object' || !Array.isArray(b.results.channels)) {
    throw new CloudError('server', 'Deepgram: unerwartete Antwort (results.channels fehlt)');
  }
  const channel = b.results.channels[0] as { alternatives?: unknown } | undefined;
  if (channel !== undefined && (typeof channel !== 'object' || channel === null || (channel.alternatives !== undefined && !Array.isArray(channel.alternatives)))) {
    throw new CloudError('server', 'Deepgram: unerwartete Antwort (alternatives)');
  }
  const alt = (channel?.alternatives as { transcript?: unknown }[] | undefined)?.[0];
  const t = alt?.transcript;
  if (t !== undefined && t !== null && typeof t !== 'string') throw new CloudError('server', 'Deepgram: unerwartete Antwort (transcript)');
  const d = b.metadata?.duration;
  return { transcript: t ?? '', billedSec: typeof d === 'number' && Number.isFinite(d) ? d : undefined };
}

/**
 * Is the endpoint reachable? Only DNS + TCP (+ TLS for https), no HTTP request: costs nothing and needs
 * no key. (Deepgram documents no key-free ping; the management API needs the key.) Resolves with the ms.
 */
export function deepgramReachable(baseUrl: string, timeoutMs = 5000): Promise<number> {
  const u = new URL(baseUrl);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    const done = (e?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (e) reject(e);
      else resolve(Date.now() - t0);
    };
    const timer = setTimeout(() => done(new Error(`${u.hostname} antwortet nicht innerhalb von ${timeoutMs / 1000} s`)), timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => done());
    socket.once('error', (e: NodeJS.ErrnoException) => done(new Error(`${u.hostname} nicht erreichbar (${e.code ?? e.message})`)));
  });
}
