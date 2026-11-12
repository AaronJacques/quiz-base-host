import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';
import {
  colognePhonetic,
  hedgeWords,
  isNonAnswer,
  normalize,
  numbers,
  referenceVariants,
  similarity,
  spellingSimilarity,
  tokens,
  vowelSkeleton,
} from './normalize.ts';

/** Words around a contained solution that add nothing ("ich glaube Tatooine"). Anything else might be another candidate. */
const FILLER = new Set(['ich', 'glaube', 'denke', 'meine', 'sage', 'tippe', 'wuerde', 'sagen', 'wohl', 'also', 'aeh', 'aehm', 'hm', 'ok', 'okay', 'ja', 'klar', 'natuerlich', 'antwort', 'lautet']);

/** A spoken answer that sounds like the solution also has to be spelled roughly like it to be accepted without the LLM. */
const SPOKEN_MIN_SPELLING = 0.6;

/** Same digits / number words ("Rocky 4" ≠ "Rocky 2", "Rocky vier" = "Rocky 4"); articles ("eine") do not count. */
const sameNumbers = (a: string, b: string) => {
  const nums = (s: string) => [...new Set(numbers(s.replace(/\b(ein|eine|einen|einem|einer|eines)\b/gi, ' ')))].sort((p, q) => p - q);
  const x = nums(a);
  const y = nums(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
};

/**
 * Deterministic, free judge. It is intentionally conservative about saying
 * "wrong": it only rejects empty / non-answers or (if configured) very
 * dissimilar answers. Everything in between is "unsure" so the cascade can
 * escalate to the LLM. It never accepts an answer that hedges ("Paris oder
 * London", "nicht Paris", "1988 1989") – the LLM rule says that is wrong.
 */
export class FuzzyJudge implements AnswerJudge {
  constructor(private opts: { acceptThreshold: number; rejectThreshold: number; rejectDissimilar: boolean }) {}

  async judge({ reference, answer, spoken }: JudgeInput): Promise<JudgeResult> {
    if (isNonAnswer(answer)) return { verdict: 'wrong', method: 'rule', confidence: 1, reason: 'keine Antwort' };
    if (!reference) return { verdict: 'unsure', method: 'fuzzy', confidence: 0, reason: 'keine Referenz' };

    const variants = referenceVariants(reference);
    const ansNorm = normalize(answer);
    if (variants.some((v) => normalize(v) === ansNorm)) return { verdict: 'correct', method: 'fuzzy', confidence: 1, reason: 'exakt' };
    if (hedgeWords(answer, reference).length) return { verdict: 'unsure', method: 'fuzzy', confidence: 0, reason: 'legt sich nicht fest' };

    const ansTokens = new Set(tokens(answer));
    const refTokens = new Set(tokens(reference));
    let best = 0;
    /** Set when something speaks for the answer although it is not accepted – then it is never rejected as dissimilar. */
    let hold: string | null = null;

    for (const v of variants) {
      const vNorm = normalize(v);

      // Pure numeric reference ("4", "1989", "42,195 km") → compare numbers.
      const vNums = numbers(v);
      const vWords = tokens(v).filter((t) => !/^\d/.test(t) && !['km', 'm', 'kg', 'jahre', 'mal'].includes(t));
      if (vNums.length === 1 && vWords.length === 0) {
        const a = [...new Set(numbers(answer))];
        if (a.length === 1 && a[0] === vNums[0]) return { verdict: 'correct', method: 'fuzzy', confidence: 0.95, reason: 'Zahl stimmt' };
        // "1987 1988 1989" – several numbers, one of them right.
        if (a.includes(vNums[0]!)) return { verdict: 'unsure', method: 'fuzzy', confidence: 0.5, reason: 'mehrere Zahlen' };
        // A purely numeric solution is unambiguous – a different number is wrong, no LLM needed.
        if (a.length && variants.length <= 2) return { verdict: 'wrong', method: 'fuzzy', confidence: 0.9, reason: 'falsche Zahl' };
      }

      // Short reference fully contained in the answer ("auf Tatooine" vs "Tatooine").
      const vTokens = tokens(v);
      if (vTokens.length && vTokens.length <= 3 && vTokens.every((t) => ansTokens.has(t))) {
        const extra = [...ansTokens].filter((t) => !vTokens.includes(t) && !refTokens.has(t) && !FILLER.has(t));
        if (!extra.length) return { verdict: 'correct', method: 'fuzzy', confidence: 0.93, reason: 'enthält Lösung' };
        hold ??= 'enthält Lösung und mehr'; // "London Paris Rom" may list candidates → LLM
      }

      const sim = similarity(v, answer);
      if (sameNumbers(v, answer)) best = Math.max(best, sim);
      else if (sim >= this.opts.acceptThreshold) hold ??= 'andere Zahl'; // "Apollo 13" vs "Apollo 11" – close, but not the same
      // Spoken answers: compare how they sound (Kölner Phonetik over the whole phrase) –
      // but digits/number words, vowels and the rough spelling have to match as well.
      if (spoken && vNorm.replace(/\s/g, '').length >= 5) {
        const pa = tokens(answer).map(colognePhonetic).join('');
        const pv = tokens(v).map(colognePhonetic).join('');
        if (pa && pa === pv) {
          if (sameNumbers(answer, v) && vowelSkeleton(answer) === vowelSkeleton(v) && spellingSimilarity(answer, v) >= SPOKEN_MIN_SPELLING) {
            return { verdict: 'correct', method: 'fuzzy', confidence: 0.9, reason: 'klingt gleich' };
          }
          hold ??= 'klingt ähnlich';
        }
      }
    }

    if (best >= this.opts.acceptThreshold) return { verdict: 'correct', method: 'fuzzy', confidence: best, reason: `ähnlich (${best.toFixed(2)})` };
    if (hold) return { verdict: 'unsure', method: 'fuzzy', confidence: best, reason: hold };
    // Speech recognition merges and splits words ("Preakidad") – judge spoken answers also by the spelling without spaces.
    const rejectBy = spoken ? Math.max(best, ...variants.map((v) => spellingSimilarity(v, answer))) : best;
    if (this.opts.rejectDissimilar && rejectBy < this.opts.rejectThreshold)
      return { verdict: 'wrong', method: 'fuzzy', confidence: 1 - rejectBy, reason: `unähnlich (${rejectBy.toFixed(2)})` };
    return { verdict: 'unsure', method: 'fuzzy', confidence: best };
  }
}
