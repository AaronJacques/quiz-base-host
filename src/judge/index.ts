import type { Config } from '../config.ts';
import type { EventBus } from '../core/events.ts';
import type { LlmClient, UsageMeter } from '../llm/client.ts';
import { JudgeCache } from './cache.ts';
import { CascadeJudge, type CascadeStage } from './cascade-judge.ts';
import { FuzzyJudge } from './fuzzy-judge.ts';
import type { AnswerJudge } from './judge.ts';
import { LlmJudge } from './llm-judge.ts';
import { OperatorJudge } from './operator-judge.ts';

export * from './judge.ts';
export { JudgeCache, LlmJudge };

export interface JudgeKit {
  judge: AnswerJudge;
  /** Present when an LLM is configured – used to solve note-less image questions. */
  solver: LlmJudge | null;
  cache: JudgeCache;
}

export function createJudge(config: Config, bus: EventBus, llm: LlmClient | null, meter: UsageMeter): JudgeKit {
  const j = config.judge;
  const cache = new JudgeCache(j.cacheFile);
  const llmJudge = llm ? new LlmJudge(llm, meter) : null;
  const stages: CascadeStage[] = [];

  switch (j.strategy) {
    case 'fuzzy':
      stages.push({ name: 'fuzzy', judge: new FuzzyJudge({ acceptThreshold: j.acceptThreshold, rejectThreshold: j.rejectThreshold, rejectDissimilar: true }) });
      stages.push({ name: 'operator', judge: new OperatorJudge(bus), interactive: true });
      break;
    case 'operator':
      stages.push({ name: 'fuzzy', judge: new FuzzyJudge({ acceptThreshold: j.acceptThreshold, rejectThreshold: j.rejectThreshold, rejectDissimilar: false }) });
      stages.push({ name: 'operator', judge: new OperatorJudge(bus), cache: true, interactive: true });
      break;
    case 'cascade':
    default:
      stages.push({ name: 'fuzzy', judge: new FuzzyJudge({ acceptThreshold: j.acceptThreshold, rejectThreshold: j.rejectThreshold, rejectDissimilar: false }) });
      if (llmJudge) stages.push({ name: 'llm', judge: llmJudge, cache: true });
      stages.push({ name: 'operator', judge: new OperatorJudge(bus), interactive: true });
  }

  return { judge: new CascadeJudge(stages, cache), solver: j.solveMissingNotes ? llmJudge : null, cache };
}
