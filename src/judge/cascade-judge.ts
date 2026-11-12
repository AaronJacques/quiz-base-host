import { createLogger } from '../core/logger.ts';
import { JudgeCache } from './cache.ts';
import { JUDGE_RULES_VERSION } from './llm-judge.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';

const log = createLogger('judge');

/**
 * Chain of responsibility: ask each judge in order until one is sure.
 * Typical chain: Fuzzy (free) → Cache (free) → LLM (cheap) → Operator (human).
 * Confident results from expensive stages are cached.
 */
export class CascadeJudge implements AnswerJudge {
  constructor(
    private stages: { name: string; judge: AnswerJudge; cache?: boolean }[],
    private cache: JudgeCache | null,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const key = JudgeCache.verdictKey(input.question, input.reference, input.answer, { spoken: input.spoken, version: JUDGE_RULES_VERSION, media: input.media });
    let last: JudgeResult = { verdict: 'unsure', method: 'fuzzy', confidence: 0 };

    for (const [i, stage] of this.stages.entries()) {
      // Check the cache right before the first expensive stage.
      if (stage.cache && this.cache && key) {
        const hit = this.cache.getVerdict(key);
        if (hit) {
          log.info(`Cache-Treffer: "${input.answer}" → ${hit.verdict}`);
          return { ...hit, method: 'cache' };
        }
      }
      try {
        last = await stage.judge.judge(input);
      } catch (e) {
        log.warn(`${stage.name} fehlgeschlagen: ${(e as Error).message}`);
        continue;
      }
      // LLM/operator reasons often name the solution – only on debug, the info log is visible before the reveal.
      const publicReason = last.reason && (last.method === 'fuzzy' || last.method === 'rule') ? ` (${last.reason})` : '';
      log.info(`${stage.name}: "${input.answer}" → ${last.verdict}${publicReason}`);
      if (last.reason && !publicReason) log.debug(`${stage.name}-Begründung: ${last.reason}`);
      if (last.verdict !== 'unsure') {
        if (stage.cache && this.cache && key) this.cache.setVerdict(key, last);
        return last;
      }
      if (i === this.stages.length - 1) break;
    }
    return last;
  }
}
