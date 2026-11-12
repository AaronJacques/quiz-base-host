/** Text normalisation and similarity helpers – pure functions, fully unit-tested. */

const NUMBER_WORDS: Record<string, number> = {
  null: 0, eins: 1, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
  zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15, zwanzig: 20, dreissig: 30, hundert: 100,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'the', 'a', 'an',
  'ist', 'es', 'sind', 'war', 'is', 'it', 'auf', 'in', 'im', 'von', 'vom', 'of', 'und', 'and',
]);

export function stripUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, ' ').replace(/www\.\S+/gi, ' ');
}

export function normalize(s: string): string {
  return stripUrls(s)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)[.,](\d)/g, '$1.$2')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

/** Extracts numbers incl. German number words ("vier" → 4, "42,195" → 42.195). */
export function numbers(s: string): number[] {
  const n = normalize(s);
  const out: number[] = [];
  for (const m of n.matchAll(/\d+(?:\.\d+)?/g)) out.push(parseFloat(m[0]));
  for (const t of n.split(' ')) if (t in NUMBER_WORDS) out.push(NUMBER_WORDS[t]!);
  return out;
}

const NON_ANSWERS = /^(keine ahnung|weiss (ich )?nicht|weiss nicht|k\.? ?a\.?|pass|passe|skip|\?+|idk|no idea|nichts)$/;

export function isNonAnswer(answer: string): boolean {
  const n = normalize(answer);
  return !n || NON_ANSWERS.test(n);
}

/**
 * Splits a host note into acceptable answer variants. Notes often look like
 * "Tatooine https://…", "Volksrepublik China", "Breaking Bad / BB",
 * "Der Federball (Badminton) kann …" – we take the whole note, the part before
 * an explanation, and explicit alternatives.
 */
export function referenceVariants(note: string): string[] {
  const clean = stripUrls(note).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const variants = new Set<string>([clean]);
  const withoutParens = clean.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutParens) variants.add(withoutParens);
  for (const m of clean.matchAll(/\(([^)]+)\)/g)) {
    const inner = m[1]!.trim();
    variants.add(inner);
    // "(englisch: Bolts)", "(auch: BB)" → "Bolts", "BB"
    const afterColon = inner.split(':').slice(1).join(':').trim();
    if (afterColon) variants.add(afterColon);
  }
  for (const part of withoutParens.split(/\s*(?:\/|;|\boder\b|\bor\b|\|)\s*/i)) if (part.trim()) variants.add(part.trim());
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

