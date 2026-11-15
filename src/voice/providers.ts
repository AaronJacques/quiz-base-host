import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import type { Pcm } from './audio.ts';
import { apiKey, CloudError, redact, type CloudErrorKind } from './http.ts';
import { DeepgramStt } from './stt-deepgram.ts';
import { WhisperServerStt, type LocalStt, type SpeechToText, type SttOptions } from './stt.ts';
import type { Attention } from './voice-host.ts';

const log = createLogger('voice');

/**
 * Speech recognition providers: which engine hears which `attention`, and what happens when the cloud
 * fails (docs/VOICE.md "Erkennung: lokal oder Cloud"). With `voice.stt: whisper` nothing here wraps the
 * local engines – the local path stays exactly as it was.
 */

/** Usage of a cloud engine (T6 counts it; until then nobody listens). */
export interface UsageSink {
  record(u: { engine: string; audioSec?: number; billedSec?: number; chars?: number; extras?: string[] }): void;
}

/**
 * Recognition failed and there is no local engine to take over (`cloudFallback: none`, or the local one
 * failed too). The voice host tells the bot (`onTrouble`), which asks people to type.
 */
export class SttTrouble extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttTrouble';
  }
}

export interface BreakerOptions {
  /** Failures in a row that pause the cloud. */
  threshold?: number;
  cooldownMs: number;
  /** For messages, e.g. `Deepgram`. */
  service?: string;
  now?: () => number;
}

/**
 * Circuit breaker for one cloud engine. Timeouts, network errors, 429, 5xx and unknown 4xx count;
 * `threshold` of them in a row pause the cloud for `cooldownMs` (only local). After that one new try:
 * success closes it, another failure pauses again. 401/403 (`auth`, key wrong) and 402 (`quota`, credit
 * used up): off until restart, one warning. 400/413/422 (`request`): only that request was bad, nothing counts.
 */
export class Breaker {
  private fails = 0;
  private openUntil = 0;
  private dead = false;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly service: string;

  constructor(private o: BreakerOptions) {
    this.now = o.now ?? Date.now;
    this.threshold = o.threshold ?? 3;
    this.service = o.service ?? 'Cloud';
  }

  /** `off` = until restart (key wrong), `open` = pausing, `closed` = cloud in use. */
  get state(): 'closed' | 'open' | 'off' {
    if (this.dead) return 'off';
    return this.now() < this.openUntil ? 'open' : 'closed';
  }

  allow(): boolean {
    return this.state === 'closed';
  }

  ok(): void {
    this.fails = 0;
    this.openUntil = 0;
  }

  fail(kind: CloudErrorKind): void {
    if (kind === 'auth' || kind === 'quota') {
      if (!this.dead) {
        const why = kind === 'auth' ? `${this.service}-Schlüssel ungültig` : `${this.service}-Guthaben aufgebraucht`;
        log.warn(`${why} – Cloud-Erkennung bis zum Neustart aus, höre lokal`);
      }
      this.dead = true; // no audio goes out any more
      return;
    }
    if (kind === 'request') return;
    this.fails++;
    if (this.fails >= this.threshold) {
      this.openUntil = this.now() + this.o.cooldownMs;
      log.warn(`${this.service}: ${this.fails} Fehler in Folge – ${Math.round(this.o.cooldownMs / 1000)} s nur lokale Erkennung, dann neuer Versuch`);
    }
  }
}

export interface FallbackSttOptions {
  /** Per cloud try: then the request is aborted and the same utterance goes to the fallback. */
  timeoutMs: number;
  breaker: Breaker;
  usage?: UsageSink;
  /** Strings that must never reach a log line (the API key). */
  secrets?: string[];
}

/**
 * A cloud engine with a local fallback. Each utterance tries the cloud once (if the breaker allows), at
 * most `timeoutMs`: the request is aborted then, and a late answer is dropped – only one result per
 * utterance. On failure the same audio goes to `fallback` right away. Without a fallback (or when it fails
 * too) it throws `SttTrouble`. Never runs both engines at once (1 vCPU: the local one would eat the saving).
 */
export class FallbackStt implements SpeechToText {
  readonly engine: string;
  /** May send the audio to the cloud – never a "local only" engine, whatever its fallback is. */
  readonly cloud = true;

  constructor(
    readonly primary: SpeechToText,
    readonly fallback: SpeechToText | null,
    private o: FallbackSttOptions,
  ) {
    this.engine = primary.engine ?? 'cloud';
  }

  async warmup(): Promise<void> {
    await this.primary.warmup?.();
  }

  async transcribe(pcm: Pcm, prompt = '', opts: SttOptions = {}): Promise<string> {
    if (!this.o.breaker.allow()) return this.local(pcm, prompt, opts, false, this.o.breaker.state === 'off' ? 'bis zum Neustart aus' : 'pausiert nach Fehlern');
    let text: string;
    try {
      text = await this.attempt(pcm, prompt, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw e; // the caller gave up – no fallback for it either
      const kind = kindOf(e);
      const msg = this.clean(e);
      this.o.breaker.fail(kind);
      if (kind !== 'auth' && kind !== 'quota') log.warn(`Cloud-Erkennung (${this.engine}): ${msg}${this.fallback ? ' – höre lokal' : ''}`);
      return this.local(pcm, prompt, opts, true, msg);
    }
    this.o.breaker.ok(); // the adapter itself records the usage of a successful request (real + billed duration)
    return text;
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback?.close()]);
  }

  /** One cloud try, bounded by `timeoutMs` even if the adapter ignores its signal. */
  private attempt(pcm: Pcm, prompt: string, outer?: AbortSignal): Promise<string> {
    const ac = new AbortController();
    const signal = outer ? AbortSignal.any([outer, ac.signal]) : ac.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new CloudError('timeout', `keine Antwort innerhalb von ${this.o.timeoutMs} ms`);
        ac.abort(err);
        reject(err);
      }, this.o.timeoutMs);
      timer.unref?.();
    });
    let call: Promise<string>;
    try {
      call = Promise.resolve(this.primary.transcribe(pcm, prompt, { signal }));
    } catch (e) {
      call = Promise.reject(e); // an adapter that throws instead of rejecting
    }
    call.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  }

  private async local(pcm: Pcm, prompt: string, opts: SttOptions, tried: boolean, reason: string): Promise<string> {
    if (!this.fallback) throw new SttTrouble(`Cloud-Erkennung gestört (${reason}), kein lokaler Rückfall`);
    try {
      opts.onFallback?.(this.fallback.engine ?? 'lokal', tried);
    } catch {
      /* measurement only */
    }
    this.record({ engine: this.engine, extras: ['rueckfall'] });
    try {
      return await this.fallback.transcribe(pcm, prompt, { signal: opts.signal });
    } catch (e) {
      throw new SttTrouble(`Cloud-Erkennung gestört (${reason}), lokaler Rückfall gescheitert: ${this.clean(e)}`);
    }
  }

  private record(u: Parameters<UsageSink['record']>[0]): void {
    try {
      this.o.usage?.record(u);
    } catch {
      /* counting never breaks recognition */
    }
  }

  private clean(e: unknown): string {
    return redact(String((e as Error)?.message ?? e), this.o.secrets ?? []);
  }
}

function kindOf(e: unknown): CloudErrorKind {
  if (e instanceof CloudError) return e.kind;
  const name = (e as Error)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return 'server'; // unknown trouble: counts like a provider error
}

const ATTENTIONS: Attention[] = ['answer', 'confirm', 'full', 'wake'];

/** Which local Whisper model an attention uses: answers the precise main one, the rest the fast one if set. */
type LocalModel = 'main' | 'fast';

export interface SttRoute {
  /** The cloud hears this attention (`voice.sttCloudFor`). */
  cloud: boolean;
  /** The local model that hears it (cloud: the fallback; null = no fallback). */
  local: LocalModel | null;
}

/** The routing as data – `createSttRoutes`, `voiceProblems` and `setupVoice` all follow it. */
export function sttPlan(v: Config['voice']): Record<Attention, SttRoute> {
  const localFor = (a: Attention): LocalModel => (a === 'answer' || !v.whisperFastModel ? 'main' : 'fast');
  const out = {} as Record<Attention, SttRoute>;
  for (const a of ATTENTIONS) {
    const cloud = v.stt !== 'whisper' && v.sttCloudFor.includes(a);
    out[a] = { cloud, local: cloud && v.cloudFallback === 'none' ? null : localFor(a) };
  }
  return out;
}

/** Whisper model files (relative to `dir`) the routing needs: `required` hear on their own, `fallback` only stand in for the cloud. */
export function sttNeeds(v: Config['voice']): { required: string[]; fallback: string[]; cloud: boolean } {
  const file = (m: LocalModel) => (m === 'main' ? v.whisperModel : v.whisperFastModel);
  const required = new Set<string>();
  const fallback = new Set<string>();
  const plan = sttPlan(v);
  for (const a of ATTENTIONS) {
    const r = plan[a];
    if (!r.local) continue;
    (r.cloud ? fallback : required).add(file(r.local));
  }
  for (const m of required) fallback.delete(m);
  return { required: [...required], fallback: [...fallback], cloud: ATTENTIONS.some((a) => plan[a].cloud) };
}

export interface SttRouteDeps {
  /** A local engine (default: `WhisperServerStt`); tests pass fakes. Never a cloud engine (type `LocalStt`). */
  local?: (o: { model: string; port: number }) => LocalStt;
  /** The cloud engine (default: `DeepgramStt` from `voice.deepgram`); it records its own usage. */
  cloud?: (v: Config['voice'], key: string, usage?: UsageSink) => SpeechToText;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  usage?: UsageSink;
}

export interface SttRoutes {
  /** 'answer'. */
  stt: SpeechToText;
  /** 'full' (and 'confirm'/'wake' unless set below); undefined = `stt`. */
  fastStt?: SpeechToText;
  confirmStt?: SpeechToText;
  wakeStt?: SpeechToText;
  /** What `warmup` starts and must succeed: the engines that hear on their own (local ones, the cloud). */
  warm: SpeechToText[];
  /**
   * Local engines that only stand in for the cloud – `warmup` starts them with `warmFallback`, but a
   * failure there (model missing) never stops joining: then there is no fallback (chat notice instead).
   */
  warmFallback: SpeechToText[];
  /**
   * The local main / fast engine, if the routing built one (cloud routing only; undefined = `stt` /
   * `fastStt` are local anyway, null = there is none). Recognition that must not go to the cloud – a
   * failed local route, someone not clearly allowed to speak – uses these, never a cloud route.
   */
  localStt?: LocalStt | null;
  localFastStt?: LocalStt | null;
  /** Every engine, for `close`. */
  all: SpeechToText[];
  breaker?: Breaker;
}

/** The fast model's own whisper-server, next to the main one. */
export function fastWhisperPort(v: Config['voice']): number {
  return v.whisperPort + 1;
}

/**
 * Builds the engines per attention. `voice.stt: whisper` → exactly as before: the main Whisper model for
 * answers, the fast one (if set) for the rest, no wrapper. With a cloud engine, each attention in
 * `sttCloudFor` gets it with the attention's local engine as fallback (`cloudFallback: local`); the
 * others stay local. `wake` is not in the default list: side talk never leaves the server.
 * Throws if the cloud key is missing (`voiceProblems` reports that first).
 */
export function createSttRoutes(v: Config['voice'], deps: SttRouteDeps = {}): SttRoutes {
  const makeLocal = deps.local ?? ((o) => new WhisperServerStt(v, o));
  const locals = new Map<LocalModel, LocalStt>();
  const local = (m: LocalModel): LocalStt => {
    let e = locals.get(m);
    if (!e) {
      e = m === 'main' ? makeLocal({ model: v.whisperModel, port: v.whisperPort }) : makeLocal({ model: v.whisperFastModel, port: fastWhisperPort(v) });
      locals.set(m, e);
    }
    return e;
  };
  const plan = sttPlan(v);

  if (!ATTENTIONS.some((a) => plan[a].cloud)) {
    const stt = local('main');
    const fastStt = v.whisperFastModel ? local('fast') : undefined;
    const all = fastStt ? [stt, fastStt] : [stt];
    return { stt, fastStt, warm: all, warmFallback: [], all };
  }

  const key = apiKey(v.deepgram.keyEnv, deps.env);
  const cloud = (deps.cloud ?? defaultCloud)(v, key, deps.usage);
  const breaker = new Breaker({ cooldownMs: v.cloudCooldownSec * 1000, service: 'Deepgram', now: deps.now });
  const wrapped = new Map<SpeechToText | null, FallbackStt>();
  const route = (a: Attention): SpeechToText => {
    const r = plan[a];
    if (!r.cloud) return local(r.local!);
    const fb = r.local ? local(r.local) : null;
    let w = wrapped.get(fb);
    if (!w) {
      w = new FallbackStt(cloud, fb, { timeoutMs: v.sttTimeoutMs, breaker, usage: deps.usage, secrets: [key] });
      wrapped.set(fb, w);
    }
    return w;
  };
  const routes = { answer: route('answer'), confirm: route('confirm'), full: route('full'), wake: route('wake') };
  const own = new Set(ATTENTIONS.filter((a) => !plan[a].cloud).map((a) => routes[a]));
  const fallbacks = [...wrapped.values()].map((w) => w.fallback).filter((f): f is SpeechToText => !!f && !own.has(f));
  return {
    stt: routes.answer,
    fastStt: routes.full,
    confirmStt: routes.confirm,
    wakeStt: routes.wake,
    warm: [...own, ...wrapped.values()],
    warmFallback: v.warmFallback ? fallbacks : [],
    all: [cloud, ...locals.values()],
    breaker,
    localStt: locals.get('main') ?? null,
    localFastStt: locals.get('fast') ?? null,
  };
}

function defaultCloud(v: Config['voice'], key: string, usage?: UsageSink): SpeechToText {
  const d = v.deepgram;
  return new DeepgramStt({ baseUrl: d.baseUrl, apiKey: key, model: d.sttModel, language: d.language, keyterms: d.keyterms, usage });
}
