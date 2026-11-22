/** Text normalisation and similarity helpers – pure functions, fully unit-tested. */

import { numberTokens, type NumberToken } from './number-words.ts';

export { numberTokens, parseNumberWord, type NumberToken } from './number-words.ts';

export const STOPWORDS: ReadonlySet<string> = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'the', 'a', 'an',
  'ist', 'es', 'sind', 'war', 'is', 'it', 'auf', 'in', 'im', 'von', 'vom', 'of', 'und', 'and',
]);

/** A dash plus space at the start ("- 1977", "– Paris"), as speech recognition writes dialogue – no minus sign ("-5" stays). */
export function stripDialogueDash(s: string): string {
  return s.replace(/^\s*[-–—]\s+/, '');
}

export function stripUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, ' ').replace(/www\.\S+/gi, ' ');
}

export function normalize(s: string): string {
  return fold(s)
    .replace(/(\d)[.,](\d)/g, '$1.$2')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower case, umlauts and accents folded, maths as ASCII, a leading minus as the word "minus". */
function fold(s: string): string {
  return markNegatives(
    mathText(
      stripUrls(s)
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss'),
    ),
  )
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bsqrt\b/g, 'wurzel');
}

/**
 * Like `normalize()`, but "1,5" and "1.500" stay apart (German decimal comma vs. thousands dot): the input of
 * `numberTokens`. Other commas and hyphens separate words as in `normalize()`.
 */
export function foldForNumbers(s: string): string {
  return fold(s)
    .replace(/(\d),(?=\d)/g, '$1\u0001')
    .replace(/[^a-z0-9.\u0001 ]+/g, ' ')
    .replace(/\u0001/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────────── formulas ─────────────────────────────

const SUPERSCRIPT: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ˣ': 'x', 'ʸ': 'y', 'ⁱ': 'i', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵏ': 'k', 'ᵗ': 't',
};
const SUBSCRIPT: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₙ': 'n', 'ᵢ': 'i', 'ₖ': 'k', 'ₘ': 'm', 'ₜ': 't',
};
const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'theta',
  ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', µ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma',
  τ: 'tau', υ: 'ypsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', 'Ω': 'omega',
};
const SUPER_RE = new RegExp(`[${Object.keys(SUPERSCRIPT).join('')}]+`, 'g');
const SUB_RE = new RegExp(`[${Object.keys(SUBSCRIPT).join('')}]`, 'g');
const GREEK_RE = new RegExp(`[${Object.keys(GREEK).join('')}]`, 'gi');

/**
 * Unicode math as plain ASCII: "x²" → "x^2", "10⁻³" → "10^-3", "H₂O" → "H2O", "2πr" → "2 pi r",
 * "√2" → " sqrt 2", "·"/"×" → "*", "÷"/"∶" → "/", "−" → "-", "½" → "1/2". quiz-base shows formulas as such
 * Unicode text, players type the ASCII spelling.
 */
export function mathText(s: string): string {
  return s
    .replace(/[¼-¾⅐-⅞]/g, (c) => ` ${c.normalize('NFKD')} `)
    .replace(SUPER_RE, (run) => {
      const v = [...run].map((c) => SUPERSCRIPT[c]).join('');
      return /^-?[0-9a-z]$|^-?\d+$/.test(v) ? `^${v}` : `^(${v})`;
    })
    .replace(SUB_RE, (c) => SUBSCRIPT[c]!)
    .replace(GREEK_RE, (c) => ` ${GREEK[c] ?? GREEK[c.toLowerCase()]} `)
    .replace(/√/g, ' sqrt ')
    .replace(/[×·⋅∙✕]/g, '*')
    .replace(/[÷∶⁄∕]/g, '/')
    .replace(/[−–]/g, '-')
    .replace(/[′’´]/g, "'")
    .replace(/∞/g, ' unendlich ');
}

/** A minus that starts a number ("-5", "x = −7", "bei -5 Grad") becomes the word "minus"; "10-3" and "1914 - 1918" stay. */
function markNegatives(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '-') {
      let j = i + 1;
      while (s[j] === ' ') j++;
      if (/\d/.test(s[j] ?? '')) {
        let k = i - 1;
        while (k >= 0 && s[k] === ' ') k--;
        const prev = k >= 0 ? s[k]! : '';
        const tight = j === i + 1 && k < i - 1; // " -5": space before, none after
        if (!prev || /[(=±,;:+*/^<>≈]/.test(prev) || (tight && !/[\d)]/.test(prev))) {
          out += ' minus ';
          continue;
        }
      }
    }
    out += s[i];
  }
  return out;
}

/**
 * Canonical spelling of a formula, for equality only: "a² + b² = c²", "a^2+b^2=c^2" and "a2 + b2 = c2" → "a2+b2=c2";
 * "F = m · a" = "F=m*a" = "f=ma"; "2πr" = "2*pi*r"; "√(2)" = "sqrt(2)" = "Wurzel aus 2"; "U = R x I" = "U=R*I".
 * Exponents after a letter may be written without "^" ("x2" = "x²"), after a digit not ("2³" ≠ "23").
 */
export function mathKey(s: string): string {
  let k = mathText(stripUrls(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  k = k
    .replace(/\b(?:quadrat)?wurzel\s+(?:aus|von)\b|\b(?:quadrat)?wurzel\b|\bsqrt\b/g, ' √ ')
    .replace(/\bhoch\b/g, '^')
    .replace(/\bquadrat\b/g, '^2')
    .replace(/\bgeteilt durch\b|\bdurch\b/g, '/')
    .replace(/\bmal\b/g, '*')
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\b(?:ist )?gleich\b/g, '=')
    .replace(/\*\*/g, '^')
    .replace(/\+\s*\/?\s*-/g, '±')
    // "U = R x I", "7 x 3": a lone x between two operands multiplies.
    .replace(/([\w)])\s+x\s+(?=[\w(√])/g, '$1*')
    .replace(/(\d)x(?=\d)/g, '$1*')
    .replace(/([\w)])\s*:\s*(?=[\w(√])/g, '$1/')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s+/g, '')
    .replace(/[.?!]+$/, '');
  // Multiplication signs are optional ("m*a" = "ma") – except between two numbers ("2*3" ≠ "23").
  k = k.replace(/\*/g, (m, off: number, str: string) => (/\d/.test(str[off - 1] ?? '') && /\d/.test(str[off + 1] ?? '') ? m : ''));
  // Brackets around a single term are optional: "√(2)" = "√2", "cos(x)" = "cos x", "/(2a)" = "/2a".
  for (let prev = ''; prev !== k; ) {
    prev = k;
    k = k.replace(/\((-?[a-z0-9.']+)\)/g, '$1');
  }
  return k.replace(/([a-z)'])\^(\d+)/g, '$1$2');
}

/** Has operators that change a number's value ("√2", "2³", "1/2", "3*4", "pi") – then its digits alone say nothing. */
export function hasMathValue(s: string): boolean {
  return /[√π^²³⁰¹⁴-⁹½¼¾⅓-⅞]|\d\s*[*/:×·÷x]\s*\d|\b(?:sqrt|pi|wurzel|hoch|quadrat)\b/i.test(s);
}

/**
 * Value of a pure arithmetic expression in `mathKey` spelling ("1/2", "√2", "2pi", "3*10^8", "-7"), else null.
 * Variables, functions and anything unparsable give null – it never guesses.
 */
export function mathValue(key: string): number | null {
  let i = 0;
  const peek = () => key[i] ?? '';
  const num = (): number | null => {
    const m = /^\d+(?:\.\d+)?/.exec(key.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const atom = (): number | null => {
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') return null;
      i++;
      return v;
    }
    if (peek() === '√') {
      i++;
      const v = power();
      return v === null || v < 0 ? null : Math.sqrt(v);
    }
    if (key.startsWith('pi', i)) {
      i += 2;
      return Math.PI;
    }
    return num();
  };
  const power = (): number | null => {
    const base = atom();
    if (base === null) return null;
    if (peek() !== '^') return base;
    i++;
    const exp = unary();
    return exp === null ? null : Math.pow(base, exp);
  };
  const unary = (): number | null => {
    if (peek() === '-' || peek() === '+') {
      const neg = key[i++] === '-';
      const v = unary();
      return v === null ? null : neg ? -v : v;
    }
    return power();
  };
  const term = (): number | null => {
    let v = unary();
    while (v !== null) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const r = unary();
        if (r === null) return null;
        v = c === '*' ? v * r : v / r;
      } else if (c === '(' || c === '√' || key.startsWith('pi', i) || (/\d/.test(c) && /[)i]/.test(key[i - 1] ?? ''))) {
        const r = power(); // implicit multiplication: "2pi", "2√2", "3(4)"
        if (r === null) return null;
        v *= r;
      } else break;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const plus = key[i++] === '+';
      const r = term();
      if (r === null) return null;
      v = plus ? v + r : v - r;
    }
    return v;
  };
  if (!key) return null;
  const v = expr();
  return v !== null && i === key.length && Number.isFinite(v) ? v : null;
}

export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1, 1 = identical (after normalisation, order-insensitive). */
export function similarity(a: string, b: string): number {
  const x = tokens(a).sort().join(' ');
  const y = tokens(b).sort().join(' ');
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Spelling similarity 0..1 of the whole phrase without spaces ("Breakingbad" = "Breaking Bad"); order matters. */
export function spellingSimilarity(a: string, b: string): number {
  const x = normalize(a).replace(/\s/g, '');
  const y = normalize(b).replace(/\s/g, '');
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** Words that hedge or negate an answer ("Paris oder London", "nicht Paris", "1988 bzw. 1989"). */
const HEDGE_WORDS = new Set(['oder', 'or', 'bzw', 'beziehungsweise', 'entweder', 'either', 'nicht', 'kein', 'keine', 'keiner', 'not', 'no', 'nor', 'weder']);

/** Hedging/negating words of `answer` that are not part of `reference` itself ("Wer nicht wagt …" stays fine). */
export function hedgeWords(answer: string, reference: string): string[] {
  const ref = new Set(normalize(reference).split(' '));
  const hedges = normalize(answer).split(' ').filter((w) => HEDGE_WORDS.has(w) && !ref.has(w));
  // "Paris / London", "Paris | London" – separators of alternatives (normalize() drops them).
  // A slash between numbers or single letters divides ("1/2", "s/t") and hedges nothing.
  const divisions = /(?<![a-zà-ÿ])([a-z0-9)])\s*\/\s*(?=[a-z0-9(√π](?![a-zà-ÿ]))/gi;
  if (/\S\s*[/|;]\s*\S/.test(stripUrls(answer).replace(divisions, '$1÷')) && !/[/|;]/.test(stripUrls(reference))) hedges.push('/');
  return hedges;
}

/**
 * The vowels of a phrase with spelling variants folded (ä/ae → e, y → i, ei/ai/ey → ai, eu/äu → oi).
 * Kölner Phonetik ignores vowels; comparing them as well keeps "Hamburg"/"Homburg" and "Kenia"/"Guinea" apart.
 */
export function vowelSkeleton(s: string): string {
  return normalize(s)
    .replace(/[^a-z]/g, '')
    .replace(/ae/g, 'e')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/y/g, 'i')
    .replace(/ie/g, 'i')
    .replace(/ei|ai/g, 'A')
    .replace(/eu|oi/g, 'O')
    .replace(/[^aeiouAO]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Extracts numbers incl. German number words and signs ("vier" → 4, "neunzehnhundertsiebenundsiebzig" → 1977,
 * "42,195" → 42.195, "−7" / "minus 7" → -7). See `numberTokens` (number-words.ts) for the forms it reads.
 */
export function numbers(s: string): number[] {
  return numberTokens(foldForNumbers(s)).map((t) => t.value);
}

/** The number tokens of a text (`numberTokens` on `foldForNumbers`), with the words they were read from. */
export function numberParts(s: string): { words: string[]; numbers: NumberToken[] } {
  const folded = foldForNumbers(s);
  return { words: folded.split(' ').filter(Boolean), numbers: numberTokens(folded) };
}

const NON_ANSWERS = /^(keine ahnung|weiss (ich )?nicht|weiss nicht|k\.? ?a\.?|pass|passe|skip|\?+|idk|no idea|nichts)$/;

export function isNonAnswer(answer: string): boolean {
  const n = normalize(answer);
  return !n || NON_ANSWERS.test(n);
}

/**
 * Formula-like text ("a² + b² = c²", "v = s / t", "cos(x)", "x = (−b ± √(b² − 4ac)) / 2a"): its brackets
 * and slashes are maths, not explanations or alternatives.
 */
export function isFormula(s: string): boolean {
  return /[=√π^±∞²³¹⁰⁴-⁹⁺⁻₀-₉]/.test(s) || /\b[a-z]{1,4}'?\([^)]*\)/i.test(s) || /(?:^|[\s(])[a-z]\s*[*/×·÷:]\s*[a-z0-9](?:$|[\s)])/i.test(s);
}

/**
 * The short solution of a note "<short solution> - <explanation>" – "1. September 1939 - In Europa begann der Zweite
 * Weltkrieg am 1. September 1939 …" → "1. September 1939". The explanation starts after a dash with spaces (or a line
 * break), begins with a letter and has at least 5 words; otherwise the whole note is the solution ("Bryan Adams - Summer
 * Of 69", "1939 - 1945"). The same rule as the spoken reveal (voice/narration.ts `solutionCore`).
 */
export function referenceCore(note: string): string {
  const text = stripUrls(note).trim();
  const m = /^(.+?)(?:\s+[-–—]\s+|[ \t]*\n\s*)(?=\p{L})(.+)$/su.exec(text);
  if (m && /[\p{L}\d]/u.test(m[1]!) && m[2]!.trim().split(/\s+/).length >= 5) return m[1]!.trim();
  return text;
}

/** Months and seasons – parts of a date ("1. September 1939", "Sommer 1961"). */
export const DATE_WORDS: ReadonlySet<string> = new Set([
  'januar', 'jaenner', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember',
  'fruehling', 'fruehjahr', 'sommer', 'herbst', 'winter',
]);

/**
 * Splits a host note into acceptable answer variants. Notes often look like
 * "Tatooine https://…", "Volksrepublik China", "Breaking Bad / BB",
 * "Der Federball (Badminton) kann …" – we take the whole note, the part before
 * an explanation, and explicit alternatives. Formulas stay whole ("v = s / t" never yields "t").
 */
export function referenceVariants(note: string): string[] {
  const clean = stripUrls(note).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const variants = new Set<string>([clean]);
  // "Polen - Am 1. September 1939 überfiel …": the short solution before the explanation is an answer of its own.
  const core = referenceCore(note).replace(/\s+/g, ' ');
  if (core !== clean) {
    variants.add(core);
    const coreBare = isFormula(core) ? core : core.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (coreBare) variants.add(coreBare);
  }
  const formula = isFormula(clean);
  const withoutParens = formula ? clean : clean.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutParens) variants.add(withoutParens);
  if (!formula) {
    for (const m of clean.matchAll(/\(([^)]+)\)/g)) {
      const inner = m[1]!.trim();
      variants.add(inner);
      // "(englisch: Bolts)", "(auch: BB)" → "Bolts", "BB"
      const afterColon = inner.split(':').slice(1).join(':').trim();
      if (afterColon) variants.add(afterColon);
    }
  }
  const separators = formula ? /\s*(?:;|\boder\b|\bor\b|\|)\s*/i : /\s*(?:\/|;|\boder\b|\bor\b|\|)\s*/i;
  for (const part of withoutParens.split(separators)) if (part.trim()) variants.add(part.trim());
  // "X = 8" (solution of an equation): the value alone is the answer as well.
  for (const v of [...variants]) {
    const m = /^[a-z]\s*=\s*([-−]?\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)$/i.exec(v);
    if (m) variants.add(m[1]!.replace(/\s+/g, ''));
  }
  return [...variants].filter((v) => normalize(v).length > 0);
}

/**
 * Kölner Phonetik – German sound code: words that sound alike get the same code
 * ("Flaggen"/"Flecken" → 3546, "Meyer"/"Maier" → 67). Used to forgive speech-recognition
 * and spelling mix-ups when matching category names.
 */
export function colognePhonetic(word: string): string {
  const s = word
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 's')
    .replace(/[^a-z]/g, '');
  let codes = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const prev = s[i - 1] ?? '';
    const next = s[i + 1] ?? '';
    let code = '';
    if ('aeijouy'.includes(c)) code = '0';
    else if (c === 'h') code = '';
    else if (c === 'b') code = '1';
    else if (c === 'p') code = next === 'h' ? '3' : '1';
    else if (c === 'd' || c === 't') code = 'csz'.includes(next) && next ? '8' : '2';
    else if ('fvw'.includes(c)) code = '3';
    else if ('gkq'.includes(c)) code = '4';
    else if (c === 'c') {
      if (i === 0) code = 'ahkloqrux'.includes(next) && next ? '4' : '8';
      else code = 'sz'.includes(prev) && prev ? '8' : 'ahkoqux'.includes(next) && next ? '4' : '8';
    } else if (c === 'x') code = 'ckq'.includes(prev) && prev ? '8' : '48';
    else if (c === 'l') code = '5';
    else if (c === 'm' || c === 'n') code = '6';
    else if (c === 'r') code = '7';
    else if ('sz'.includes(c)) code = '8';
    codes += code;
  }
  let out = '';
  for (const ch of codes) if (ch !== out.at(-1)) out += ch;
  return out ? out[0] + out.slice(1).replace(/0/g, '') : '';
}

