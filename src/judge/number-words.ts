/**
 * German (and a few English) number words → values. Pure functions, no imports.
 *
 * Input tokens are already folded: lower case, ä→ae, ö→oe, ü→ue, ß→ss. A token is only ever read as a whole –
 * never as a prefix ("Hundertwasser", "Achtung", "Einhorn" are no numbers).
 */

export interface NumberToken {
  value: number;
  /** "vierte", "4." */
  ordinal: boolean;
  /** "1,5", "komma", "einhalb" */
  decimal: boolean;
  /** "Millionen", "Mrd" */
  magnitude: boolean;
  /** "1.500" / "42.195": German thousands or English decimal – unclear; "12 000": one number or two? */
  ambiguous: boolean;
  /** For an ambiguous token: every way to read it ("1.500" → [[1500], [1.5]], "12 000" → [[12000], [12, 0]]). */
  readings?: number[][];
  /** written as words (not digits) */
  words: boolean;
  /** A lone article ("ein", "eine", "einen" …) read as 1 – counts as a number only if nothing else is said. */
  article: boolean;
  /** Digits inside a word ("h2o", "70er", "25.05.1977") – the token is a word as well. */
  partial: boolean;
  /** index of the first and last token it covers */
  from: number;
  to: number;
}

const UNITS: Record<string, number> = {
  ein: 1, eins: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
};
/** Units that may stand before "und" + tens ("einundzwanzig", not "einsundzwanzig"). */
const UNIT_BEFORE_UND: Record<string, number> = {
  ein: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
};
const TEENS: Record<string, number> = {
  zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
};
const TENS: Record<string, number> = {
  zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
};
const ENGLISH: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const ARTICLES = new Set(['ein', 'eine', 'einen', 'einem', 'einer', 'eines']);
const MAGNITUDES: Record<string, number> = {
  million: 1e6, millionen: 1e6, mio: 1e6, milliarde: 1e9, milliarden: 1e9, mrd: 1e9, billion: 1e12, billionen: 1e12,
};
/** First half of a year said in two parts ("neunzehn|siebenundsiebzig"): 11–20. */
const YEAR_HEADS: [string, number][] = [...Object.entries(TEENS).filter(([, v]) => v >= 11), ['zwanzig', 20]];
const ORDINAL_ENDINGS = ['e', 'er', 'en', 'es', 'em'];
/** Irregular ordinal stems: "erste", "dritte", "siebte"/"siebente", "achte". */
const ORDINAL_STEMS: [string, number][] = [['erst', 1], ['dritt', 3], ['siebent', 7], ['siebt', 7], ['acht', 8]];

/** 0–99 as one word ("null" only alone), else null. */
function below100(s: string, allowNull = false): number | null {
  if (!s) return null;
  if (s === 'null') return allowNull ? 0 : null;
  if (s in UNITS) return UNITS[s]!;
  if (s in TEENS) return TEENS[s]!;
  if (s in TENS) return TENS[s]!;
  const i = s.indexOf('und');
  if (i > 0) {
    const u = UNIT_BEFORE_UND[s.slice(0, i)];
    const t = TENS[s.slice(i + 3)];
    if (u !== undefined && t !== undefined) return u + t;
  }
  return null;
}

/** "[m]hundert[und][r]" with m, r < 100 – also "neunzehnhundertsiebenundsiebzig" = 1977. */
function hundreds(s: string): number | null {
  const plain = below100(s);
  if (plain !== null) return plain;
  const i = s.indexOf('hundert');
  if (i < 0) return null;
  const head = s.slice(0, i);
  const m = head ? below100(head) : 1;
  if (m === null || m === 0) return null;
  let tail = s.slice(i + 7);
  if (tail.startsWith('und') && tail.length > 3) tail = tail.slice(3);
  const r = tail ? below100(tail) : 0;
  return r === null ? null : m * 100 + r;
}

/** A cardinal number word up to 999 999 ("zweitausendundfuenf", "neunzehnhundertsiebenundsiebzig"), else null. */
function cardinal(s: string): number | null {
  if (s === 'null') return 0;
  const i = s.indexOf('tausend');
  if (i < 0) return hundreds(s);
  const head = s.slice(0, i);
  const m = head ? hundreds(head) : 1;
  if (m === null || m === 0 || m >= 1000) return null;
  let tail = s.slice(i + 7);
  if (tail.startsWith('und') && tail.length > 3) tail = tail.slice(3);
  const r = tail ? hundreds(tail) : 0;
  return r === null || r >= 1000 ? null : m * 1000 + r;
}

function ordinal(s: string): number | null {
  for (const end of ORDINAL_ENDINGS) {
    if (!s.endsWith(end)) continue;
    const body = s.slice(0, -end.length);
    // Irregular: "erste", "hundertdritte", "siebte", "achte".
    for (const [stem, v] of ORDINAL_STEMS) {
      if (!body.endsWith(stem)) continue;
      const head = body.slice(0, -stem.length);
      if (!head) return v;
      const h = cardinal(head);
      if (h !== null && h > 0 && h % 100 === 0) return h + v;
    }
    // "zweite" … "neunzehnte": stem + te (2–19, without the irregular ones).
    if (body.endsWith('t')) {
      const v = cardinal(body.slice(0, -1));
      const last = v === null ? -1 : v % 100;
      if (v !== null && last >= 2 && last <= 19 && ![3, 7, 8].includes(last)) return v;
    }
    // "zwanzigste", "einundzwanzigste", "hundertste", "tausendste": stem + ste (from 20).
    if (body.endsWith('st')) {
      const v = cardinal(body.slice(0, -2));
      if (v !== null && v >= 20 && (v % 100 === 0 || v % 100 >= 20)) return v;
    }
  }
  return null;
}

/** One token (already lower-case, ä→ae, ö→oe, ü→ue, ß→ss) as a whole German number word, else null. Never a prefix match. */
export function parseNumberWord(token: string): { value: number; ordinal: boolean; decimal: boolean } | null {
  const t = token.replace(/\.+$/, '');
  if (!t || !/^[a-z]+$/.test(t)) return null;
  if (t in ENGLISH) return { value: ENGLISH[t]!, ordinal: false, decimal: false };
  if (ARTICLES.has(t)) return { value: 1, ordinal: false, decimal: false };
  const c = cardinal(t);
  if (c !== null) return { value: c, ordinal: false, decimal: false };
  // Year in one word without "hundert": "neunzehnneunundsiebzig" = 1979, "zwanzigzwanzig" = 2020 (like rule 5).
  for (const [head, x] of YEAR_HEADS) {
    if (!t.startsWith(head) || t.length === head.length) continue;
    const y = below100(t.slice(head.length));
    if (y !== null && y >= 10) return { value: x * 100 + y, ordinal: false, decimal: false };
  }
  // "viermal", "zweimal" = "4 Mal" (the word "mal" alone is a unit).
  if (t.endsWith('mal') && t.length > 3) {
    const v = cardinal(t.slice(0, -3));
    if (v !== null && v > 0) return { value: v, ordinal: false, decimal: false };
  }
  if (t === 'anderthalb') return { value: 1.5, ordinal: false, decimal: true };
  if (t.endsWith('einhalb') && t.length > 7) {
    const v = cardinal(t.slice(0, -7));
    if (v !== null && v > 0) return { value: v + 0.5, ordinal: false, decimal: true };
  }
  const o = ordinal(t);
  return o === null ? null : { value: o, ordinal: true, decimal: false };
}

/** Number words, digits and the words that glue them ("und", "komma", "minus", "Millionen") – one entry per token. */
type Atom =
  | { kind: 'num'; value: number; ordinal: boolean; decimal: boolean; ambiguous: boolean; words: boolean; article: boolean; text: string; readings?: number[][] }
  | { kind: 'partial'; values: number[] }
  | { kind: 'word'; text: string };

function atom(raw: string, next: string | undefined): Atom {
  const word = raw.replace(/^\.+|\.+$/g, '');
  const num = (value: number, f: Partial<Extract<Atom, { kind: 'num' }>> = {}): Atom => ({
    kind: 'num', value, ordinal: false, decimal: false, ambiguous: false, words: false, article: false, text: word, ...f,
  });
  if (/^\d+$/.test(word)) {
    // "4. Platz": a number with a full stop before a word is an ordinal; at the end of a sentence ("1977.") it is not.
    const ord = /^\d+\.$/.test(raw) && !!next && /^[a-z]/.test(next);
    return num(parseInt(word, 10), { ordinal: ord });
  }
  if (/^\d+,\d+$/.test(word)) return num(parseFloat(word.replace(',', '.')), { decimal: true });
  if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(word)) return num(parseInt(word.replace(/\./g, ''), 10));
  if (/^\d{1,3}\.\d{3}$/.test(word)) {
    const thousands = parseInt(word.replace('.', ''), 10);
    return num(parseFloat(word), { decimal: true, ambiguous: true, readings: [[thousands], [parseFloat(word)]] });
  }
  if (/^\d+\.\d+$/.test(word)) return num(parseFloat(word), { decimal: true });
  if (/\d/.test(word)) return { kind: 'partial', values: [...word.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => parseFloat(m[0].replace(',', '.'))) };
  const w = parseNumberWord(word);
  if (w) return num(w.value, { ordinal: w.ordinal, decimal: w.decimal, words: true, article: ARTICLES.has(word) });
  return { kind: 'word', text: word };
}

type NumAtom = Extract<Atom, { kind: 'num' }>;
const isNum = (a: Atom | undefined): a is NumAtom => a?.kind === 'num';
const isWordNum = (a: Atom | undefined): a is NumAtom => isNum(a) && a.words;
const textOf = (a: Atom | undefined) => (a && a.kind !== 'partial' ? a.text : '');

/** A whole number (no ordinal, no fraction) that may be merged with its neighbours. */
const plain = (a: NumAtom) => !a.ordinal && !a.decimal && Number.isInteger(a.value);

/** Ends on the word "hundert" / "tausend" ("neunzehnhundert", "zweitausend") – a smaller number may follow. */
function endUnit(text: string, value: number): 100 | 1000 | null {
  if (text.endsWith('tausend') && value % 1000 === 0) return 1000;
  if (text.endsWith('hundert') && value % 100 === 0) return 100;
  return null;
}

/**
 * The word number at `k`, with rule 1 applied: "sieben und siebzig" = 77 (otherwise "und" separates: "drei und vier").
 * null if `k` is no word number.
 */
function wordNumberAt(atoms: Atom[], k: number): { value: number; ordinal: boolean; article: boolean; end: number; text: string } | null {
  const a = atoms[k];
  if (!isWordNum(a)) return null;
  const tens = atoms[k + 2];
  if (plain(a) && a.value >= 1 && a.value <= 9 && textOf(atoms[k + 1]) === 'und' && isWordNum(tens) && plain(tens) && tens.text in TENS) {
    return { value: a.value + tens.value, ordinal: false, article: false, end: k + 2, text: tens.text };
  }
  return { value: a.value, ordinal: a.ordinal, article: a.article, end: k, text: a.text };
}

/**
 * All numbers of a text: digits and number words, multi-token forms merged ("neunzehnhundert siebenundsiebzig",
 * "neunzehn siebenundsiebzig", "sieben und siebzig", "zweitausend fünf", "eins komma fünf", "1,5 Millionen"). A "minus"
 * before a number makes it negative. `text` should be folded like `normalize()` but keep "1,5" and "1.500" apart.
 */
export function numberTokens(text: string): NumberToken[] {
  const raw = text.split(/\s+/).filter(Boolean);
  const atoms = raw.map((t, i) => atom(t, raw[i + 1]));
  const out: NumberToken[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]!;
    if (a.kind === 'partial') {
      for (const value of a.values)
        out.push({ value, ordinal: false, decimal: !Number.isInteger(value), magnitude: false, ambiguous: false, words: false, article: false, partial: true, from: i, to: i });
      continue;
    }
    // "12 000", "1 500 000": digit groups with spaces (DIN 5008) – or several numbers. Unclear, so ambiguous.
    if (a.kind === 'num' && !a.words && /^\d{1,3}$/.test(raw[i]!) && /^\d{3}$/.test(raw[i + 1] ?? '')) {
      let j = i + 1;
      while (/^\d{3}$/.test(raw[j + 1] ?? '')) j++;
      const parts = raw.slice(i, j + 1);
      const value = parseInt(parts.join(''), 10);
      out.push({ value, ordinal: false, decimal: false, magnitude: false, ambiguous: true, words: false, article: false, partial: false, from: i, to: j, readings: [[value], parts.map((p) => parseInt(p, 10))] });
      i = j;
      continue;
    }
    const from = i;
    const negative = a.kind === 'word' && a.text === 'minus' && isNum(atoms[i + 1]);
    if (negative) i++;
    const first = atoms[i];
    if (!isNum(first)) continue;

    let { value, ordinal, decimal, ambiguous, words, article } = first;
    let readings = first.readings;
    let magnitude = false;
    /** After "Millionen": a smaller number may still be added (rule 7b). */
    let magFactor = 0;
    let last = first.text;
    const lead = wordNumberAt(atoms, i);
    if (lead && lead.end > i) {
      ({ value, ordinal } = lead);
      article = false;
      last = lead.text;
      i = lead.end;
    }
    const single = lead?.end === from + (negative ? 1 : 0) && !lead.article;
    let merged = false;
    const take = (end: number, t: string) => {
      i = end;
      last = t;
      merged = true;
      article = false;
    };

    for (;;) {
      if (ordinal) break;
      const n1 = atoms[i + 1];
      const whole = !decimal && Number.isInteger(value);
      // 4. "neunzehn hundert", "3 tausend": a number times a lone "hundert" / "tausend" – also when the rest is
      // written on to it: "neunzehn hunderteinundsechzig" = 1961, "zwei tausendvierzehn" = 2014.
      const n1Text = textOf(n1);
      const factor = n1Text.startsWith('hundert') ? 100 : n1Text.startsWith('tausend') ? 1000 : 0;
      const rest = factor && isWordNum(n1) && plain(n1) && n1.value >= factor && n1.value < 2 * factor ? n1.value - factor : null;
      if (whole && rest !== null && value >= 1 && value < (factor === 100 ? 100 : 1000)) {
        value = value * factor + rest;
        words = true;
        take(i + 1, n1Text);
        continue;
      }
      // 2./3. "neunzehnhundert [und] siebenundsiebzig", "zweitausend [und] fünf", "zweitausend neunhundert" – also
      // digits after the word ("neunzehnhundert 77", "2 tausend 14"), but never after digits alone ("1900 77").
      const unit = whole && words ? endUnit(last, value) : null;
      if (unit) {
        const k = textOf(n1) === 'und' ? i + 2 : i + 1;
        const addAtom = atoms[k];
        const add = wordNumberAt(atoms, k) ?? (isNum(addAtom) && plain(addAtom) && /^\d+$/.test(raw[k]!) ? { value: addAtom.value, ordinal: false, article: false, end: k, text: addAtom.text } : null);
        if (add && !add.article && !(isNum(addAtom) && addAtom.decimal) && add.value >= 1 && add.value < unit) {
          value += add.value;
          ordinal = add.ordinal;
          take(add.end, add.text);
          continue;
        }
      }
      // 5. Year: "neunzehn siebenundsiebzig" = 1977, "zwanzig zwanzig" = 2020 – words only, one right after the other.
      if (!merged && single && whole && value >= 11 && value <= 20) {
        const y = wordNumberAt(atoms, i + 1);
        if (y && !y.ordinal && !y.article && y.value >= 10 && y.value <= 99 && plain(atoms[i + 1] as NumAtom)) {
          value = value * 100 + y.value;
          take(y.end, y.text);
          continue;
        }
      }
      // 6. "zweiundvierzig komma eins neun fünf" = 42.195, "eins komma fünf" = 1.5, "komma fünfzehn" = .15.
      if (whole && textOf(n1) === 'komma') {
        let digits = '';
        let j = i + 2;
        for (let d = atoms[j]; isWordNum(d) && plain(d) && !d.article && d.value <= 9; d = atoms[++j]) digits += String(d.value);
        const two = atoms[i + 2];
        if (!digits && isWordNum(two) && plain(two) && two.value >= 10 && two.value <= 99) {
          digits = String(two.value);
          j = i + 3;
        }
        if (digits) {
          value = parseFloat(`${value}.${digits}`);
          decimal = true;
          words = true;
          take(j - 1, textOf(atoms[j - 1]));
          continue;
        }
      }
      // 7. "1,5 Millionen", "eine Milliarde", "3 Mrd".
      const mag = n1?.kind === 'word' ? MAGNITUDES[n1.text] : undefined;
      if (mag && !magnitude) {
        value *= mag;
        magnitude = true;
        magFactor = mag;
        ambiguous = false;
        readings = undefined;
        take(i + 1, textOf(n1));
        continue;
      }
      // 7b. A smaller number after it is added: "eine Million fünfhunderttausend" = 1 500 000 (not "drei Millionen vier Millionen").
      if (magFactor && Number.isInteger(value)) {
        const add = wordNumberAt(atoms, i + 1);
        const after = atoms[(add?.end ?? i) + 1];
        if (add && !add.article && !add.ordinal && plain(atoms[i + 1] as NumAtom) && add.value >= 1 && add.value < magFactor && !(after?.kind === 'word' && after.text in MAGNITUDES)) {
          value += add.value;
          magFactor = add.value;
          take(add.end, add.text);
          continue;
        }
      }
      break;
    }
    const sign = negative ? -1 : 1;
    out.push({
      value: sign * value, ordinal, decimal, magnitude, ambiguous, words, article, partial: false, from, to: i,
      ...(ambiguous && readings ? { readings: readings.map((r) => r.map((x) => sign * x)) } : {}),
    });
  }
  return out;
}
