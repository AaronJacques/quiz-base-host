import type { Config } from '../config.ts';
import { MODEL_ALIASES, PRICES } from '../llm/anthropic-api.ts';
import { mcSlots, totalQuestions, type BoardSpec } from './spec.ts';

export type BoardProvider = 'claude-cli' | 'anthropic' | 'none';

export function boardProvider(config: Config): BoardProvider {
  const p = config.boardgen.provider;
  return p === 'inherit' ? config.llm.provider : p;
}

export interface CostEstimate {
  usd: number;
  calls: number;
  model: string;
  /** claude-cli runs on the Claude subscription – no extra money, the dollar value is only the API equivalent. */
  viaSubscription: boolean;
}

/** Thinking tokens per call by effort (adaptive thinking is on for current models). */
const THINKING: Record<Config['boardgen']['effort'], number> = { low: 600, medium: 2500, high: 6000 };

/**
 * Rough pre-run estimate from token heuristics (measured on real runs, see docs/CONFIG.md):
 * generation ≈ 2k prompt + ~170 output tokens per question, review ≈ board as input + some replacements.
 */
export function estimateCost(spec: BoardSpec, config: Config): CostEstimate {
  const b = config.boardgen;
  const model = MODEL_ALIASES[b.model] ?? b.model;
  const [pin, pout] = PRICES[model] ?? PRICES['claude-sonnet-5-5']!;
  const q = totalQuestions(spec);
  const mc = mcSlots(spec).size;
  const think = THINKING[b.effort];
  const genIn = 2200 + 25 * q;
  const genOut = 170 * q + 30 * mc + think;
  const revIn = 2600 + 140 * q;
  const revOut = 300 + 60 * q + think;
  let usd = (genIn * pin + genOut * pout) / 1e6;
  let calls = 1;
  if (b.review) {
    usd += (revIn * pin + revOut * pout) / 1e6;
    calls++;
  }
  return { usd, calls, model, viaSubscription: boardProvider(config) === 'claude-cli' };
}

export function formatUsd(usd: number): string {
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

export function estimateText(e: CostEstimate): string {
  return e.viaSubscription
    ? `über dein Claude-Abo, keine Zusatzkosten (API-Gegenwert ca. ${formatUsd(e.usd)}, ${e.calls} Aufrufe, ${e.model})`
    : `ca. ${formatUsd(e.usd)} (${e.calls} Aufrufe, ${e.model})`;
}
