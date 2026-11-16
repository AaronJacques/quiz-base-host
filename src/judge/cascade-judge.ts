import { createLogger } from '../core/logger.ts';
import { JudgeCache } from './cache.ts';
import { JUDGE_RULES_VERSION } from './llm-judge.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';

const log = createLogger('judge');

export interface CascadeStage {
  name: string;
  judge: AnswerJudge;
  /** Confident results of this stage are cached (and the cache is checked right before it). */
  cache?: boolean;
  /** Asks a human (operator): never part of an early judgement (`prejudge`). */
  interactive?: boolean;
}

/** What a run over some stages found. */
interface Outcome {
  result: JudgeResult;
  decided: boolean;
  /** A stage threw (LLM error / timeout) – a later run should try again. */
  failed: boolean;
  /** First stage not run yet (the interactive one, after an early judgement). */
  next: number;
  /** The info line that tells how it was decided – logged only once the answer is confirmed. */
  line?: string;
}

const UNSURE: JudgeResult = { verdict: 'unsure', method: 'fuzzy', confidence: 0 };

/**
 * Chain of responsibility: ask each judge in order until one is sure.
 * Typical chain: Fuzzy (free) → Cache (free) → LLM (cheap) → Operator (human).
 * Confident results from expensive stages are cached.
 *
 * `prejudge` runs the same chain without the interactive stage for an answer that still waits for "Ja"; the
 * `judge` of the confirmed answer (same input, same `scope`) then takes that result – one LLM call, not two.
 */
export class CascadeJudge implements AnswerJudge {
  /** Early judgements by scope + verdict key. Only the newest few are kept (see `prejudge`). */
  private early = new Map<string, Promise<Outcome>>();

  constructor(
    private stages: CascadeStage[],
    private cache: JudgeCache | null,
  ) {}

  private static verdictKey(input: JudgeInput): string | null {
    return JudgeCache.verdictKey(input.question, input.reference, input.answer, { spoken: input.spoken, version: JUDGE_RULES_VERSION, media: input.media });
  }

  /** Key of an early judgement: the scope (question + player) and the full verdict key (question, solution, normalised answer). */
  private static earlyKey(input: JudgeInput): string | null {
    if (!input.scope) return null;
    const key = CascadeJudge.verdictKey(input);
    // Media without identity has no verdict key – the raw texts still tell the inputs apart.
    return `${input.scope}␞${key ?? ['nokey', input.question, input.reference ?? '', input.answer, input.spoken ? 's' : ''].join('␟')}`;
  }

  async prejudge(input: JudgeInput): Promise<void> {
    const k = CascadeJudge.earlyKey(input);
    if (!k || this.early.has(k)) return;
    // Only the newest early judgement per scope matters (a replaced answer is never used again): drop older ones.
    for (const old of this.early.keys()) if (old.split('␞')[0] === input.scope || this.early.size > 8) this.early.delete(old);
    const run = this.run({ ...input, prefetch: true }, 0, true);
    this.early.set(k, run);
    await run;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const k = CascadeJudge.earlyKey(input);
    const early = k ? this.early.get(k) : undefined;
    if (k && early) {
      this.early.delete(k);
      const pre = await early;
      if (pre.decided) {
        if (pre.line) log.info(pre.line);
        return pre.result;
      }
      if (!pre.failed) {
        // Sure of nothing without a human: go on with the next stage (operator) – no second LLM call for the same input.
        const rest = await this.run(input, pre.next, false, pre.result);
        return rest.result;
      }
      // The early LLM call failed: try as today.
    }
    return (await this.run(input, 0, false)).result;
  }

  /** Runs the stages from `start`. `early`: stop before an interactive stage, log only on debug. Never rejects. */
  private async run(input: JudgeInput, start: number, early: boolean, initial: JudgeResult = UNSURE): Promise<Outcome> {
    const key = CascadeJudge.verdictKey(input);
    let last = initial;
    let failed = false;
    // Before the "Ja" nothing about the answer may reach the info log (rule 5): only debug then.
    const note = (line: string) => (early ? log.debug(`vorab ${line}`) : log.info(line));
    for (let i = start; i < this.stages.length; i++) {
      const stage = this.stages[i]!;
      if (early && stage.interactive) return { result: last, decided: false, failed, next: i };
      // Check the cache right before the first expensive stage.
      if (stage.cache && this.cache && key) {
        const hit = this.cache.getVerdict(key);
        if (hit) {
          const line = `Cache-Treffer: "${input.answer}" → ${hit.verdict}`;
          note(line);
          return { result: { ...hit, method: 'cache' }, decided: true, failed, next: i, line };
        }
      }
      try {
        last = await stage.judge.judge(input);
      } catch (e) {
        const msg = `${stage.name} fehlgeschlagen: ${(e as Error).message}`;
        if (early) log.debug(`vorab ${msg}`);
        else log.warn(msg);
        failed = true;
        continue;
      }
      // LLM/operator reasons often name the solution – only on debug, the info log is visible before the reveal.
      const publicReason = last.reason && (last.method === 'fuzzy' || last.method === 'rule') ? ` (${last.reason})` : '';
      const line = `${stage.name}: "${input.answer}" → ${last.verdict}${publicReason}`;
      note(line);
      if (last.reason && !publicReason) log.debug(`${stage.name}-Begründung: ${last.reason}`);
      if (last.verdict !== 'unsure') {
        if (stage.cache && this.cache && key) this.cache.setVerdict(key, last);
        return { result: last, decided: true, failed, next: i + 1, line };
      }
    }
    return { result: last, decided: false, failed, next: this.stages.length };
  }
}
