import type { z } from 'zod';

export type ImageInput =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file'; path: string };

export interface JsonRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  images?: ImageInput[];
  /** Short tag for logs / usage accounting. */
  purpose: string;
  /** Per-request overrides – board generation needs a larger model and longer answers than judging. */
  model?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export interface JsonResponse<T> {
  data: T;
  costUsd?: number;
  ms: number;
}

/**
 * Provider-neutral "ask once, get typed JSON back" interface. The game only
 * ever needs single-shot structured answers, never multi-turn chat, which is
 * what keeps token usage tiny.
 */
export interface LlmClient {
  readonly name: string;
  completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>>;
}

/** Tracks spend across a game so the operator sees what hosting cost. */
export class UsageMeter {
  calls = 0;
  costUsd = 0;
  byPurpose: Record<string, number> = {};

  record(purpose: string, cost = 0): void {
    this.calls++;
    this.costUsd += cost;
    this.byPurpose[purpose] = (this.byPurpose[purpose] ?? 0) + 1;
  }

  summary(): string {
    const parts = Object.entries(this.byPurpose).map(([k, v]) => `${k}: ${v}`);
    return `${this.calls} LLM-Aufrufe (${parts.join(', ') || '–'}), ca. $${this.costUsd.toFixed(4)}`;
  }
}
