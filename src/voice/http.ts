/**
 * HTTP for cloud speech engines: Node's own `fetch` (undici, keep-alive), no SDK. Every failure becomes a
 * `CloudError` whose `kind` decides the fallback (`providers.ts`). Messages never contain the URL (its
 * query may hold keyterms), request headers or the API key.
 */

export type CloudErrorKind = 'timeout' | 'network' | 'rate' | 'server' | 'auth' | 'quota' | 'request';

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/**
 * HTTP status → kind (decides the fallback, see `Breaker`):
 * - 401/403 `auth`: key wrong or without rights – lasting, the cloud goes off until restart.
 * - 402 `quota`: the account's credit is used up – lasting as well, off until restart.
 * - 408 `timeout`, 429 `rate`, 5xx `server`: passing provider trouble, counted.
 * - 400/413/422 `request`: something about this one upload (broken or too big audio, interrupted
 *   upload) – only this request goes local, nothing is counted.
 * - every other 4xx (404, 405, 410, …) `server`: not tied to one utterance (wrong path or model,
 *   endpoint moved), so it is counted and the breaker pauses the cloud instead of sending each utterance.
 */
export function statusKind(status: number): CloudErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate';
  if (status === 400 || status === 413 || status === 422) return 'request';
  return 'server';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * May a key be sent to this base URL? Only `https://`, or plain `http://` to this machine (tests, a local
 * proxy). Anything else (`http://` over the network, no scheme, not a URL) → false.
 */
export function safeBaseUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

export interface CloudInit extends RequestInit {
  /** Gives up after this long (kind `timeout`). */
  timeoutMs: number;
  /** The caller's signal (its own timeout); aborting it also ends with kind `timeout`. */
  signal?: AbortSignal;
  /** Label for messages, e.g. `Deepgram`. */
  service?: string;
}

/**
 * `fetch` with a timeout; resolves only with a 2xx response, everything else throws a `CloudError`.
 * The error text of a failed response is cut short and has the credential headers of the request (the key) removed.
 */
export async function cloudFetch(url: string, init: CloudInit): Promise<Response> {
  const { timeoutMs, signal, service = 'Cloud', ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    // No redirects: the key and the audio go to the configured host or nowhere.
    res = await fetch(url, { ...rest, signal: combined, redirect: 'error' });
  } catch (e) {
    if (combined.aborted) throw new CloudError('timeout', timeout.aborted ? `${service}: keine Antwort innerhalb von ${timeoutMs} ms` : `${service}: abgebrochen (Frist abgelaufen)`);
    throw new CloudError('network', `${service}: nicht erreichbar (${networkReason(e)})`);
  }
  if (res.ok) return res;
  let body = '';
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* no body */
  }
  const kind = statusKind(res.status);
  const detail = redact(body.replace(/\s+/g, ' ').trim(), secretsOf(rest.headers)).slice(0, 160);
  throw new CloudError(kind, `${service}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`, res.status);
}

/**
 * The API key from the environment (`.env`), by the name in the config (`keyEnv`). Never logged: a
 * missing key's error names only the variable.
 */
export function apiKey(envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[envName]?.trim();
  if (!key) throw new Error(`Kein Schlüssel: ${envName} ist nicht gesetzt (in .env eintragen)`);
  return key;
}

/** Removes every secret (and each of its whitespace-separated parts, e.g. the key in `Token <key>`) from `text`. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  const parts = secrets.flatMap((s) => [s, ...s.split(/\s+/)]).filter((s) => s.length >= 6);
  for (const s of [...new Set(parts)].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out;
}

function secretsOf(headers: RequestInit['headers']): string[] {
  if (!headers) return [];
  try {
    const out: string[] = [];
    new Headers(headers).forEach((value, name) => {
      if (/authorization|key|token|secret/i.test(name)) out.push(value);
    });
    return out;
  } catch {
    return [];
  }
}

/** A short reason without the URL (undici puts the cause code there). */
function networkReason(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } };
  return err?.cause?.code ?? err?.name ?? 'Fehler';
}
