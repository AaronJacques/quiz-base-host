import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';
import { colognePhonetic, isNonAnswer, normalize, numbers, referenceVariants, similarity, tokens } from './normalize.ts';

/**
 * Deterministic, free judge. It is intentionally conservative about saying
 * "wrong": it only rejects empty / non-answers or (if configured) very
 * dissimilar answers. Everything in between is "unsure" so the cascade can
 * escalate to the LLM.
 */
export class FuzzyJudge implements AnswerJudge {
  constructor(private opts: { acceptThreshold: number; rejectThreshold: number; rejectDissimilar: boolean }) {}

  async judge({ reference, answer, spoken }: JudgeInput): Promise<JudgeResult> {
    if (isNonAnswer(answer)) return { verdict: 'wrong', method: 'rule', confidence: 1, reason: 'keine Antwort' };
    if (!reference) return { verdict: 'unsure', method: 'fuzzy', confidence: 0, reason: 'keine Referenz' };

    const variants = referenceVariants(reference);
    const ansNorm = normalize(answer);
    const ansTokens = new Set(tokens(answer));
    let best = 0;

    for (const v of variants) {
      const vNorm = normalize(v);
      if (vNorm === ansNorm) return { verdict: 'correct', method: 'fuzzy', confidence: 1, reason: 'exakt' };

      // Pure numeric reference ("4", "1989", "42,195 km") → compare numbers.
      const vNums = numbers(v);
      const vWords = tokens(v).filter((t) => !/^\d/.test(t) && !['km', 'm', 'kg', 'jahre', 'mal'].includes(t));
      if (vNums.length === 1 && vWords.length === 0) {
        const a = numbers(answer);
        if (a.includes(vNums[0]!)) return { verdict: 'correct', method: 'fuzzy', confidence: 0.95, reason: 'Zahl stimmt' };
        // A purely numeric solution is unambiguous – a different number is wrong, no LLM needed.
        if (a.length && variants.length <= 2) return { verdict: 'wrong', method: 'fuzzy', confidence: 0.9, reason: 'falsche Zahl' };
      }

      // Short reference fully contained in the answer ("auf Tatooine" vs "Tatooine").
      const vTokens = tokens(v);
      if (vTokens.length && vTokens.length <= 3 && vTokens.every((t) => ansTokens.has(t)) && ansTokens.size <= vTokens.length + 2) {
        return { verdict: 'correct', method: 'fuzzy', confidence: 0.93, reason: 'enthält Lösung' };
      }

      best = Math.max(best, similarity(v, answer));
      // Spoken answers: compare how they sound (Kölner Phonetik over the whole phrase).
      if (spoken && vNorm.replace(/\s/g, '').length >= 5) {
        const pa = tokens(answer).map(colognePhonetic).join('');
        const pv = tokens(v).map(colognePhonetic).join('');
        if (pa && pa === pv) return { verdict: 'correct', method: 'fuzzy', confidence: 0.9, reason: 'klingt gleich' };
      }
    }

    if (best >= this.opts.acceptThreshold) return { verdict: 'correct', method: 'fuzzy', confidence: best, reason: `ähnlich (${best.toFixed(2)})` };
    if (this.opts.rejectDissimilar && best < this.opts.rejectThreshold)
      return { verdict: 'wrong', method: 'fuzzy', confidence: 1 - best, reason: `unähnlich (${best.toFixed(2)})` };
    return { verdict: 'unsure', method: 'fuzzy', confidence: best };
  }
}
