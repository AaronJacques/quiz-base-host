import type { AnswerJudge, ChoiceOption, JudgeInput, JudgeResult } from './judge.ts';
import type { NumberToken } from './number-words.ts';
import {
  colognePhonetic,
  hasMathValue,
  hedgeWords,
  isFormula,
  isNonAnswer,
  mathKey,
  mathValue,
  normalize,
  numberParts,
  numbers,
  referenceVariants,
  sameValue,
  similarity,
  spellingSimilarity,
  STOPWORDS,
  stripUrls,
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
    const byNumber = judgeNumbers(question, reference, variants, answer);
    if (byNumber) return byNumber;
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

      // A formula answer with a value ("2³") against a purely numeric solution (plain numbers: see judgeNumbers).
      const vNums = numbers(v);
      const vWords = tokens(v).filter((t) => !/^\d/.test(t) && !['km', 'm', 'kg', 'jahre', 'mal', 'minus'].includes(t));
      if (answerValue !== null && !restates && vNums.length === 1 && vWords.length === 0) {
        if (sameValue(answerValue, vNums[0]!)) return { verdict: 'correct', method: 'fuzzy', confidence: 0.95, reason: 'Zahl stimmt' };
        if (variants.length <= 2) return { verdict: 'wrong', method: 'fuzzy', confidence: 0.9, reason: 'falsche Zahl' };
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

// ───────────────────────────── numbers ─────────────────────────────

/** Units: "42 km", "4 Mal", "1977 Einwohner" – they are no content of their own. */
const NUMBER_UNITS = new Set([
  'km', 'm', 'cm', 'mm', 'kg', 'g', 't', 'l', 'ml', 'jahr', 'jahre', 'jahren', 'mal', 'prozent', 'grad', 'euro', 'eur', 'dollar', 'usd',
  'meter', 'kilometer', 'gramm', 'kilogramm', 'tonnen', 'liter', 'minuten', 'min', 'sekunden', 's', 'stunden', 'h', 'tage', 'monate',
  'wochen', 'punkte', 'stueck', 'stk', 'einwohner', 'menschen', 'personen', 'spieler', 'folgen', 'episoden', 'staffeln', 'filme',
]);
/** Words around a number that add nothing ("im Jahr 1977", "1979 glaube ich", "meine Antwort lautet 4"). */
const NUMBER_FILLER = new Set(['im', 'jahr', 'anno', 'ich', 'glaube', 'denke', 'wohl', 'so', 'es', 'ist', 'das', 'war', 'sind', 'meine', 'antwort', 'lautet', 'und', 'minus']);

/** Estimates and limits: then a close number may count – the LLM decides. */
const ESTIMATE = /\b(?:ca|circa|zirka|etwa|ungefaehr|rund|mehr als|ueber|bis zu|mindestens|hoechstens|knapp)\b|schaetz/;
const ROMAN = /^(?=[IVXLCDM]{1,6}$)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
/** The question asks for a year (a short list on purpose – "wann" is enough). */
const YEAR_QUESTION = /in welchem jahr|welches jahr|\bwann\b|im jahr|jahreszahl|\berschien|\bkam\b.*\braus\b/;

/** A text seen as numbers: the values and the words that are left besides units and fillers. */
interface NumberView {
  values: NumberToken[];
  /** Words that are no number, unit, filler or stop word (set, as by `tokens()`). */
  content: Set<string>;
  /** Only numbers (and units/fillers) – nothing else said. */
  onlyNumber: boolean;
  /** Has digits inside a word ("h2o", "70er") – then the number rules stay out. */
  partial: boolean;
}

function numberView(s: string): NumberView {
  const { words, numbers: found } = numberParts(s);
  const whole = found.filter((t) => !t.partial);
  const covered = new Set<number>();
  for (const t of whole) for (let i = t.from; i <= t.to; i++) covered.add(i);
  const content = new Set<string>();
  words.forEach((w, i) => {
    const t = w.replace(/^\.+|\.+$/g, '');
    if (!t || covered.has(i) || STOPWORDS.has(t) || NUMBER_UNITS.has(t) || NUMBER_FILLER.has(t)) return;
    content.add(t);
  });
  // A lone article is a number only if nothing else is said ("eine" – not "Eine neue Hoffnung").
  const values = whole.every((t) => t.article) && whole.length === 1 && !content.size ? whole : whole.filter((t) => !t.article);
  const partial = found.some((t) => t.partial);
  return { values, content, onlyNumber: !content.size && !partial && values.length > 0, partial };
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const isYear = (t: NumberToken) => !t.ordinal && !t.decimal && !t.magnitude && Number.isInteger(t.value) && t.value >= 1000 && t.value <= 2099;
const result = (verdict: 'correct' | 'wrong' | 'unsure', reason: string): JudgeResult => ({ verdict, method: 'fuzzy', confidence: verdict === 'unsure' ? 0.5 : 0.95, reason });

/**
 * Numbers and years decide without the LLM (R0–R3): a different number is wrong, the same number right – whether
 * written as digits or words ("neunzehnhundertneunundsiebzig" is 1979, not 1977). Estimates, ranges, roman numerals,
 * "1.500" (thousands or decimal?) and "Millionen" on one side only are left to the LLM (null).
 */
export function judgeNumbers(question: string, reference: string, variants: string[], answer: string): JudgeResult | null {
  if (hasMathValue(answer)) return null;
  const q = normalize(question);
  const ref = normalize(reference);
  const refRaw = stripUrls(reference);
  // R0 – special cases.
  if (ESTIMATE.test(q) || ESTIMATE.test(ref) || /[~±≈]/.test(refRaw + question)) return null;
  if (/\d\s*[–-]\s*\d/.test(refRaw) || /\b(?:bis|zwischen)\b/.test(ref)) return null;
  if (refRaw.split(/[^A-Za-z]+/).some((t) => ROMAN.test(t))) return null;
  const aFound = numberParts(answer).numbers;
  const rFound = numberParts(reference).numbers;
  if ([...aFound, ...rFound].some((t) => t.ambiguous)) return null;
  if (aFound.some((t) => t.magnitude) !== rFound.some((t) => t.magnitude)) return null;
  const a = numberView(answer);
  const yearQuestion = YEAR_QUESTION.test(q);
  const plainVariants = variants.filter((v) => !isFormula(v) && !hasMathValue(v)).map(numberView);

  // R1 – a solution that is only a number.
  const solutions = plainVariants.filter((v) => v.onlyNumber && v.values.length === 1).map((v) => v.values[0]!.value);
  if (solutions.length && a.onlyNumber) {
    const values = a.values.map((t) => t.value);
    if (values.length >= 2) {
      // "1987 1988 1989" – several numbers, one of them right.
      if (values.some((x) => solutions.some((v) => sameValue(x, v)))) return result('unsure', 'mehrere Zahlen');
      return result('wrong', 'falsche Zahlen');
    }
    const x = values[0]!;
    if (solutions.some((v) => sameValue(x, v))) return result('correct', 'Zahl stimmt');
    const t = a.values[0]!;
    // "siebenundsiebzig" / "77" for 1977, when the question asks for the year.
    if (yearQuestion && Number.isInteger(x) && x >= 10 && x <= 99 && !t.ordinal && solutions.some((v) => Number.isInteger(v) && v >= 1000 && v <= 2099 && v % 100 === x))
      return result('correct', 'Kurzform des Jahres');
    // "42" for 42,195 km – a usual rounding or not? The LLM knows (prompt rule).
    if (Number.isInteger(x) && solutions.some((v) => !Number.isInteger(v) && Math.abs(x - v) < 1)) return result('unsure', 'gerundet');
    return result('wrong', 'falsche Zahl');
  }

  // R2 – the same words and one number ("Apollo 11" / "Apollo 13", "Rot 2" / "Rot Vier", "1. Weltkrieg" / "Erster Weltkrieg").
  if (a.values.length === 1 && a.content.size && !a.partial) {
    for (const v of plainVariants) {
      if (v.values.length !== 1 || !v.content.size || v.partial || !sameSet(v.content, a.content)) continue;
      return sameValue(v.values[0]!.value, a.values[0]!.value) ? result('correct', 'Zahl stimmt') : result('wrong', 'falsche Zahl');
    }
  }

  // R3 – the year in a longer solution ("25. Mai 1977"), when the question asks for the year.
  if (yearQuestion && a.onlyNumber && a.values.length === 1 && isYear(a.values[0]!)) {
    const years = numberParts(refRaw.replace(/\([^)]*\)/g, ' ')).numbers.filter((t) => !t.partial && isYear(t) && !t.words);
    if (years.length === 1) return sameValue(years[0]!.value, a.values[0]!.value) ? result('correct', 'Jahr stimmt') : result('wrong', 'falsches Jahr');
  }
  return null;
}
