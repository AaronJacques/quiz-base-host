import { createLogger } from '../core/logger.ts';
import { JudgeCache } from './cache.ts';
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
    const key = JudgeCache.verdictKey(input.question, input.reference, input.answer);
    let last: JudgeResult = { verdict: 'unsure', method: 'fuzzy', confidence: 0 };

    for (const [i, stage] of this.stages.entries()) {
      // Check the cache right before the first expensive stage.
      if (stage.cache && this.cache) {
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
      log.info(`${stage.name}: "${input.answer}" → ${last.verdict}${last.reason ? ` (${last.reason})` : ''}`);
      if (last.verdict !== 'unsure') {
        if (stage.cache && this.cache) this.cache.setVerdict(key, last);
        return last;
      }
      if (i === this.stages.length - 1) break;
    }
    return last;
  }
}
