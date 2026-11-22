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
  stripDialogueDash,
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

  async judge({ question, reference, answer: raw, spoken, options }: JudgeInput): Promise<JudgeResult> {
    // Speech recognition writes dialogue dashes ("- 1977") – no minus sign.
    const answer = spoken ? stripDialogueDash(raw) : raw;
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

/**
 * Units: "42 km", "4 Mal", "1977 Einwohner" – no content of their own, but they have to agree when both sides name one
 * ("6 Tage" is not "6 Wochen"). Spellings of the same unit map to one name.
 */
const UNIT_NAMES: Record<string, string> = {
  km: 'km', kilometer: 'km', m: 'm', meter: 'm', cm: 'cm', zentimeter: 'cm', mm: 'mm', millimeter: 'mm',
  kg: 'kg', kilogramm: 'kg', g: 'g', gramm: 'g', t: 't', tonne: 't', tonnen: 't', l: 'l', liter: 'l', ml: 'ml', milliliter: 'ml',
  jahr: 'jahr', jahre: 'jahr', jahren: 'jahr', mal: 'mal', prozent: 'prozent', grad: 'grad',
  euro: 'euro', eur: 'euro', dollar: 'dollar', usd: 'dollar',
  sekunde: 's', sekunden: 's', s: 's', sek: 's', minute: 'min', minuten: 'min', min: 'min', stunde: 'h', stunden: 'h', h: 'h', std: 'h',
  tag: 'tag', tage: 'tag', tagen: 'tag', woche: 'woche', wochen: 'woche', monat: 'monat', monate: 'monat', monaten: 'monat',
  punkte: 'punkte', stueck: 'stueck', stk: 'stueck', einwohner: 'einwohner', menschen: 'menschen', personen: 'personen', spieler: 'spieler',
  folgen: 'folgen', episoden: 'episoden', staffeln: 'staffeln', filme: 'filme',
};
/** Words around a number that add nothing ("im Jahr 1977", "1979 glaube ich", "meine Antwort lautet 4"). */
const NUMBER_FILLER = new Set([...FILLER, 'im', 'jahr', 'anno', 'denke', 'so', 'es', 'ist', 'das', 'war', 'sind', 'und', 'minus']);

/** Months and seasons: "Mai 1977" answers a question for the year with the year (only then they are fillers). */
const YEAR_FILLER = new Set([
  'januar', 'jaenner', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember',
  'fruehling', 'fruehjahr', 'sommer', 'herbst', 'winter',
]);

/** Estimates and limits: then a close number may count – the LLM decides. */
const ESTIMATE = /\b(?:ca|circa|zirka|etwa|ungefaehr|rund|mehr als|ueber|bis zu|mindestens|hoechstens|knapp)\b|schaetz/;
const ROMAN = /^(?=[IVXLCDM]{1,6}$)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
/** The question asks for a year (a short list on purpose – "wann" is enough). */
const YEAR_QUESTION = /in welchem jahr|welches jahr|\bwann\b|im jahr|jahreszahl|\berschien|\bkam\b.*\braus\b/;

/** A text seen as numbers: the values and the words that are left besides units and fillers. */
interface NumberView {
  values: NumberToken[];
  /** Words that are no number, unit, filler, stop word or word of the question (set, as by `tokens()`). */
  content: Set<string>;
  /** Units named ("tag", "km"), by their one name. */
  units: Set<string>;
  /** Only numbers (and units/fillers) – nothing else said. */
  onlyNumber: boolean;
  /** Has digits inside a word ("h2o", "70er") – then the number rules stay out. */
  partial: boolean;
  /** The words the numbers were read from (`numberParts`). */
  words: string[];
}

/** `asked`: words of the question – "acht Beine" for "Wie viele Beine …?" says only the number. */
function numberView(s: string, asked: ReadonlySet<string>): NumberView {
  const { words, numbers: found } = numberParts(s);
  const whole = found.filter((t) => !t.partial);
  const covered = new Set<number>();
  for (const t of whole) for (let i = t.from; i <= t.to; i++) covered.add(i);
  const content = new Set<string>();
  const units = new Set<string>();
  words.forEach((w, i) => {
    const t = w.replace(/^\.+|\.+$/g, '');
    if (!t || covered.has(i)) return;
    const unit = UNIT_NAMES[t];
    // "im Jahr 1977": "Jahr" after "im" is a filler, not the unit "Jahre".
    if (unit && !(t === 'jahr' && words[i - 1] === 'im')) units.add(unit);
    if (unit || STOPWORDS.has(t) || NUMBER_FILLER.has(t) || asked.has(t)) return;
    // "ein Tor" for "Wie viele Tore …?", "acht Beine" for "Wie viele Beine hat …?": singular and plural of a question word.
    if (/^[a-z]{3,}$/.test(t) && ['e', 'n', 'en', 'er', 's'].some((end) => asked.has(t + end) || (t.endsWith(end) && asked.has(t.slice(0, -end.length))))) return;
    content.add(t);
  });
  // A lone article is a number only if nothing else is said ("eine" – not "Eine neue Hoffnung").
  const values = whole.every((t) => t.article) && whole.length === 1 && !content.size ? whole : whole.filter((t) => !t.article);
  const partial = found.some((t) => t.partial);
  return { values, content, units, onlyNumber: !content.size && !partial && values.length > 0, partial, words };
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const isYear = (t: NumberToken) => !t.ordinal && !t.decimal && !t.magnitude && Number.isInteger(t.value) && t.value >= 1000 && t.value <= 2099;
const result = (verdict: 'correct' | 'wrong' | 'unsure', reason: string): JudgeResult => ({ verdict, method: 'fuzzy', confidence: verdict === 'unsure' ? 0.5 : 0.95, reason });

/** Places after the decimal point ("3,14" → 2). */
function decimals(x: number): number {
  if (Number.isInteger(x)) return 0;
  return /\.(\d+)$/.exec(String(x))?.[1]?.length ?? 0;
}

/** One value rounded or cut to fewer places than the other ("42" / "42,2" for 42,195, "3,14" for 3,14159 and back; not "3,2"). */
function rounded(x: number, v: number): boolean {
  const dx = decimals(x);
  const dv = decimals(v);
  if (dx === dv) return false;
  const [short, long, d] = dx < dv ? [x, v, dx] : [v, x, dv];
  const f = 10 ** d;
  return sameValue(short, Math.round(long * f) / f) || sameValue(short, Math.trunc(long * f) / f);
}

/**
 * Other readings of an answer that came out as several numbers: digit groups ("12 000", "1 500 000", "19 77"), the sum
 * ("eine Million 500000", "1900 77", "2 tausend 14") and a year in two parts ("19 77"). Any of them may be meant.
 */
function joinedReadings(view: NumberView): number[] {
  const t = view.values;
  const out = [t.reduce((sum, x) => sum + x.value, 0)];
  if (t.every((x) => !x.words && !x.decimal && !x.ordinal && x.from === x.to)) {
    const joined = t.map((x) => view.words[x.from]!.replace(/\.+$/, '')).join('');
    if (/^\d+$/.test(joined)) out.push(parseInt(joined, 10));
  }
  if (t.length === 2 && t[0]!.value >= 11 && t[0]!.value <= 20 && t[1]!.value >= 0 && t[1]!.value <= 99) out.push(t[0]!.value * 100 + t[1]!.value);
  return out;
}

/**
 * Numbers and years decide without the LLM (R0–R3): a different number is wrong, the same number right – whether
 * written as digits or words ("neunzehnhundertneunundsiebzig" is 1979, not 1977). Estimates, ranges, roman numerals,
 * "1.500" (thousands or decimal?), "Millionen" on one side only and different units are left to the LLM (null).
 * "Wrong" only when nothing speaks for the answer: a number the solution names anywhere (also in brackets: "1977
 * (1978 in Deutschland)"), a rounding or another reading of the same digits leave it to the LLM.
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
  // Words of the question say nothing ("acht Beine" for "Wie viele Beine …?") – if the solution uses them as well or is
  // only a number. Otherwise they may tell candidates apart ("Rocky 4 oder Rambo 2?" – "Rocky 2" is not "Rambo 2").
  const refWords = new Set(tokens(reference));
  const refOnlyNumber = numberView(reference, new Set()).onlyNumber;
  const yearQuestion = YEAR_QUESTION.test(q);
  const asked = new Set(tokens(question).filter((w) => refOnlyNumber || refWords.has(w)));
  // "Mai 1977" for 1977 – but if the solution names a month itself ("Mai 1977"), "Juni 1977" is not the same.
  const answerAsked = yearQuestion && ![...refWords].some((w) => YEAR_FILLER.has(w)) ? new Set([...asked, ...YEAR_FILLER]) : asked;
  const a = numberView(answer, answerAsked);
  const r = numberView(reference, asked);
  // "6 Wochen" for "6 Tage", "1,5 Stunden" for "90 Minuten": units differ – maybe a conversion, the LLM decides.
  if (a.units.size && r.units.size && !sameSet(a.units, r.units)) return null;
  const plainVariants = variants.filter((v) => !isFormula(v) && !hasMathValue(v)).map((v) => numberView(v, asked));
  /** Every number the solution names, in brackets as well – an answer with one of them is never wrong here. */
  const named = rFound.filter((t) => !t.partial && !t.article).map((t) => t.value);
  const isNamed = (x: number) => named.some((v) => sameValue(x, v));
  const wrong = (xs: number[], reason: string) => (xs.some(isNamed) ? null : result('wrong', reason));

  // R1 – a solution that is only a number.
  const solutions = plainVariants.filter((v) => v.onlyNumber && v.values.length === 1).map((v) => v.values[0]!.value);
  if (solutions.length && a.onlyNumber) {
    const values = a.values.map((t) => t.value);
    if (values.length >= 2) {
      // "1987 1988 1989" – several numbers, one of them right; "12 000", "eine Million 500000" – one number in parts.
      if ([...values, ...joinedReadings(a)].some((x) => solutions.some((v) => sameValue(x, v)))) return result('unsure', 'mehrere Zahlen');
      if (values.some((x) => solutions.some((v) => rounded(x, v)))) return result('unsure', 'gerundet');
      return wrong(values, 'falsche Zahlen');
    }
    const x = values[0]!;
    if (solutions.some((v) => sameValue(x, v))) return result('correct', 'Zahl stimmt');
    const t = a.values[0]!;
    // "siebenundsiebzig" / "77" for 1977, when the question asks for the year.
    if (yearQuestion && Number.isInteger(x) && x >= 10 && x <= 99 && !t.ordinal && solutions.some((v) => Number.isInteger(v) && v >= 1000 && v <= 2099 && v % 100 === x))
      return result('correct', 'Kurzform des Jahres');
    // "42" or "42,2" for 42,195 km, "3,14" for 3,14159 – a usual rounding or not? The LLM knows (prompt rule).
    if (solutions.some((v) => rounded(x, v))) return result('unsure', 'gerundet');
    return wrong([x], 'falsche Zahl');
  }

  // R2 – the same words and one number ("Apollo 11" / "Apollo 13", "Rot 2" / "Rot Vier", "1. Weltkrieg" / "Erster Weltkrieg").
  if (a.values.length === 1 && a.content.size && !a.partial) {
    const x = a.values[0]!.value;
    for (const v of plainVariants) {
      if (v.values.length !== 1 || !v.content.size || v.partial || !sameSet(v.content, a.content)) continue;
      if (sameValue(v.values[0]!.value, x)) return result('correct', 'Zahl stimmt');
      if (rounded(x, v.values[0]!.value)) return result('unsure', 'gerundet');
      return wrong([x], 'falsche Zahl');
    }
  }

  // R3 – the year in a longer solution ("25. Mai 1977"), when the question asks for the year.
  if (yearQuestion && a.onlyNumber && a.values.length === 1 && isYear(a.values[0]!)) {
    const years = numberParts(refRaw.replace(/\([^)]*\)/g, ' ')).numbers.filter((t) => !t.partial && isYear(t) && !t.words);
    if (years.length === 1) return sameValue(years[0]!.value, a.values[0]!.value) ? result('correct', 'Jahr stimmt') : wrong([a.values[0]!.value], 'falsches Jahr');
  }
  return null;
}
