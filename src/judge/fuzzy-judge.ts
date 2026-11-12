import type { AnswerJudge, ChoiceOption, JudgeInput, JudgeResult } from './judge.ts';
import {
  colognePhonetic,
  hasMathValue,
  hedgeWords,
  isFormula,
  isNonAnswer,
  mathKey,
  mathValue,
  normalize,
  numbers,
  referenceVariants,
  sameValue,
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

  async judge({ question, reference, answer, spoken, options }: JudgeInput): Promise<JudgeResult> {
    if (isNonAnswer(answer)) return { verdict: 'wrong', method: 'rule', confidence: 1, reason: 'keine Antwort' };
    const choice = options?.length ? judgeChoice(answer, options, !!spoken) : null;
    if (choice) return choice;
    if (!reference) return { verdict: 'unsure', method: 'fuzzy', confidence: 0, reason: 'keine Referenz' };

    const variants = referenceVariants(reference);
    const ansNorm = normalize(answer);
    // normalize() drops operators – formulas compare by mathKey ("v = s * t" is not "v = s / t").
    const formulaAnswer = isFormula(answer);
    const isMath = (v: string) => formulaAnswer || isFormula(v);
    if (variants.some((v) => (isMath(v) ? mathKey(v) === mathKey(answer) : normalize(v) === ansNorm)))
      return { verdict: 'correct', method: 'fuzzy', confidence: 1, reason: 'exakt' };
    const math = judgeMath(question, variants, answer);
    if (math) return math;
    if (hedgeWords(answer, reference).length) return { verdict: 'unsure', method: 'fuzzy', confidence: 0, reason: 'legt sich nicht fest' };
    // "x²", "√2", "3² + 4²": digits inside a formula are no plain numbers ("x²" is not "2", "√2" not "2").
    const answerValue = hasMathValue(answer) ? mathValue(mathKey(answer)) : null;
    const restates = answerValue !== null && restatesQuestion(question, answer);

    const ansTokens = new Set(tokens(answer));
    const refTokens = new Set(tokens(reference));
    let best = 0;
    /** Set when something speaks for the answer although it is not accepted – then it is never rejected as dissimilar. */
    let hold: string | null = null;

    for (const v of variants) {
      const vNorm = normalize(v);

      // Pure numeric reference ("4", "1989", "42,195 km") → compare numbers.
      const vNums = numbers(v);
      const vWords = tokens(v).filter((t) => !/^\d/.test(t) && !['km', 'm', 'kg', 'jahre', 'mal', 'minus'].includes(t));
      if (vNums.length === 1 && vWords.length === 0 && !restates && (answerValue !== null || !hasMathValue(answer))) {
        const a = answerValue !== null ? [answerValue] : [...new Set(numbers(answer))];
        if (a.length === 1 && sameValue(a[0]!, vNums[0]!)) return { verdict: 'correct', method: 'fuzzy', confidence: 0.95, reason: 'Zahl stimmt' };
        // "1987 1988 1989" – several numbers, one of them right.
        if (a.includes(vNums[0]!)) return { verdict: 'unsure', method: 'fuzzy', confidence: 0.5, reason: 'mehrere Zahlen' };
        // A purely numeric solution is unambiguous – a different number is wrong, no LLM needed.
        if (a.length && variants.length <= 2) return { verdict: 'wrong', method: 'fuzzy', confidence: 0.9, reason: 'falsche Zahl' };
      }

      // In a formula order and operators matter ("v = t / s", "πr²" for "2πr") – word similarity says nothing here.
      if (isMath(v)) {
        hold ??= 'Formel';
        continue;
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

/** Letter words as speech recognition writes them ("De" for D). */
const SPOKEN_LETTERS: Record<string, string> = { ah: 'a', be: 'b', beh: 'b', ce: 'c', ceh: 'c', ze: 'c', zeh: 'c', tse: 'c', de: 'd', deh: 'd', dee: 'd' };
const CHOICE_LEAD = /^(?:(?:ich nehme|ich sage|ich tippe auf|ich glaube|meine antwort ist|antwort|option|buchstabe|loesung|nummer)\s+)+/;

/**
 * Multiple choice decides without the LLM: the letter ("D", "Antwort D", "D)") or the exact text of an option.
 * Another option is wrong. Anything else (a paraphrase, a letter that is no option) is left to the next stage.
 */
export function judgeChoice(answer: string, options: ChoiceOption[], spoken: boolean): JudgeResult | null {
  if (!options.some((o) => o.correct)) return null;
  const raw = answer.trim();
  const n = normalize(raw).replace(CHOICE_LEAD, '').replace(/\.+$/, '').trim();
  const letterOf = (w: string) => (/^[a-h]$/.test(w) ? w : spoken ? (SPOKEN_LETTERS[w] ?? null) : null);
  const byLetter = (l: string | null) => (l ? options.findIndex((o) => o.letter.toLowerCase() === l) : -1);
  // Formulas by mathKey (normalize() drops operators: "v = s * t" would equal "v = s / t").
  const sameText = (o: ChoiceOption, text: string) =>
    !!o.label.trim() && (isFormula(o.label) || isFormula(text) ? mathKey(o.label) === mathKey(text) : normalize(o.label) === normalize(text).replace(CHOICE_LEAD, ''));
  let idx = byLetter(letterOf(n));
  if (idx < 0) idx = options.findIndex((o) => sameText(o, raw));
  if (idx < 0) {
    // "D klein", "D) x = 5", "klein (D)": letter and text of the same option.
    const lead = /^\s*([a-h])(?:\s*[).:-]\s*|\s+)(.+)$/i.exec(raw);
    const tail = /^(.+?)(?:\s+|\s*\()([a-h])\)?\s*$/i.exec(raw);
    const pairs: [string, string][] = [];
    if (lead) pairs.push([lead[1]!, lead[2]!]);
    if (tail) pairs.push([tail[2]!, tail[1]!]);
    for (const [l, rest] of pairs) {
      const i = byLetter(l.toLowerCase());
      if (i >= 0 && sameText(options[i]!, rest)) idx = i;
    }
  }
  if (idx < 0) return null;
  const o = options[idx]!;
  return o.correct
    ? { verdict: 'correct', method: 'fuzzy', confidence: 1, reason: `Option ${o.letter}` }
    : { verdict: 'wrong', method: 'fuzzy', confidence: 1, reason: `Option ${o.letter} ist falsch` };
}

/** The answer only repeats a calculation from the question ("Wie viel ist 3² + 4²?" – "3^2+4^2"). */
function restatesQuestion(question: string, answer: string): boolean {
  const a = mathKey(answer);
  return a.length >= 3 && mathKey(question).includes(a);
}

/**
 * Formulas and values: the same formula in another spelling ("a^2+b^2=c^2" for "a² + b² = c²", "2*pi*r" for "2πr")
 * or the same value ("1/2" for "0,5", "√2" for "sqrt(2)") is right. A different formula is never accepted here.
 */
function judgeMath(question: string, variants: string[], answer: string): JudgeResult | null {
  const aKey = mathKey(answer);
  if (!aKey) return null;
  const answerMath = isFormula(answer) || hasMathValue(answer);
  for (const v of variants) {
    if ((answerMath || isFormula(v) || hasMathValue(v)) && mathKey(v) === aKey) return { verdict: 'correct', method: 'fuzzy', confidence: 0.97, reason: 'gleiche Formel' };
  }
  if (!hasMathValue(answer) && !variants.some(hasMathValue)) return null;
  const a = mathValue(aKey);
  if (a === null || restatesQuestion(question, answer)) return null;
  for (const v of variants) {
    const b = mathValue(mathKey(v));
    if (b !== null && sameValue(a, b)) return { verdict: 'correct', method: 'fuzzy', confidence: 0.95, reason: 'gleicher Wert' };
  }
  return null;
}
