import { LEVELS, type BoardLevel, type BoardSpec } from '../boardgen/spec.ts';

export interface CreateRequest {
  spec: BoardSpec;
  /** "nochmal": generate a fresh draft even if the same request exists. */
  force: boolean;
  /** "öffentlich" was asked for – quiz-base only saves private drafts, publishing is manual. */
  publicAsked: boolean;
}

const LEVEL_WORDS: Record<string, BoardLevel> = {
  kinder: 'kinder', kids: 'kinder', grundschule: 'kinder',
  schule: 'schule', schulquiz: 'schule', klasse: 'schule', unterstufe: 'schule',
  oberstufe: 'oberstufe', abi: 'oberstufe', abitur: 'oberstufe',
  kneipe: 'kneipe', kneipenquiz: 'kneipe', pub: 'kneipe', allgemein: 'kneipe', normal: 'kneipe',
  profi: 'profi', profis: 'profi', experte: 'profi', experten: 'profi', nerd: 'profi', nerds: 'profi', schwer: 'profi',
};

const LANG_WORDS: Record<string, string> = {
  deutsch: 'de', german: 'de', englisch: 'en', english: 'en', französisch: 'fr', franzoesisch: 'fr', french: 'fr',
  spanisch: 'es', spanish: 'es', italienisch: 'it', italian: 'it', niederländisch: 'nl', niederlaendisch: 'nl', dutch: 'nl',
};

const NUMBER_WORDS: Record<string, number> = { ein: 1, eins: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 };

const num = (t: string | undefined): number | null => {
  if (t === undefined) return null;
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
};

const QUOTES = /^["„“”'‚‘’]+|["„“”'‚‘’]+$/g;

/**
 * Parses `!quiz erstellen <Thema> [Optionen]`, e.g.
 * "Star Wars 5x4 profi 2 boards mc 25% sprache en; name: Krieg der Sterne; themen: Jedi, Schiffe".
 * Unknown words form the topic. Pure function – validation of the values is `specProblems`.
 */
export function parseCreateArgs(text: string, base: BoardSpec): CreateRequest {
  const spec: BoardSpec = { ...base, themes: [...base.themes] };
  let rest = ` ${text.trim()} `;
  let force = false;
  let publicAsked = false;

  // Free-text options: quoted or up to ";" / the next free-text option / end.
  const grab = (key: RegExp): string | null => {
    const quoted = new RegExp(`\\s${key.source}\\s*:?\\s*["„“'‚]([^"„“”'‚‘’]+)["“”'‘’]`, 'i').exec(rest);
    const plain = quoted ?? new RegExp(`\\s${key.source}\\s*:\\s*([^;]+?)(?=\\s*;|\\s+(?:name|themen?|themenbereiche)\\s*:|\\s*$)`, 'i').exec(rest);
    if (!plain) return null;
    rest = rest.replace(plain[0], ' ');
    return plain[1]!.trim();
  };
  const name = grab(/name/);
  if (name) spec.name = name.replace(QUOTES, '').trim();
  const themes = grab(/(?:themen|themenbereiche|thema)/);
  if (themes) spec.themes = themes.split(/\s*[,/]\s*|\s+und\s+/).map((t) => t.replace(QUOTES, '').trim()).filter(Boolean);

  const tokens = rest.replace(/;/g, ' ').split(/\s+/).filter(Boolean);
  const topic: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    const t = raw.toLowerCase().replace(/[.,!?]+$/, '');
    const next = tokens[i + 1]?.toLowerCase().replace(/[.,!?]+$/, '');
    const prevNum = num(t);
    let m: RegExpExecArray | null;
    if ((m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(t))) {
      spec.categories = Number(m[1]);
      spec.rows = Number(m[2]);
    } else if (prevNum !== null && (next === 'x' || next === '×') && num(tokens[i + 2]) !== null) {
      spec.categories = prevNum;
      spec.rows = num(tokens[i + 2])!;
      i += 2;
    } else if (prevNum !== null && next && /^(kategorien?|kat)$/.test(next)) {
      spec.categories = prevNum;
      i++;
    } else if (/^(kategorien?|kat)$/.test(t) && num(next) !== null) {
      spec.categories = num(next)!;
      i++;
    } else if (prevNum !== null && next && /^(stufen?|fragen|zeilen|reihen)$/.test(next)) {
      spec.rows = prevNum;
      i++;
    } else if (/^(stufen?|fragen|zeilen|reihen)$/.test(t) && num(next) !== null) {
      spec.rows = num(next)!;
      i++;
    } else if (/^(schritt|punkte|punkteschritt)$/.test(t) && num(next) !== null) {
      spec.step = num(next)!;
      i++;
    } else if (prevNum !== null && next && /^boards?$/.test(next)) {
      spec.boards = prevNum === 2 ? 2 : (prevNum as 1 | 2);
      i++;
    } else if (/^boards?$/.test(t) && num(next) !== null) {
      spec.boards = num(next)! as 1 | 2;
      i++;
    } else if (/^(mc|multiple-?choice)$/.test(t) || (t === 'multiple' && next === 'choice')) {
      if (t === 'multiple') i++;
      const v = tokens[i + 1]?.toLowerCase();
      const pct = v ? /^(\d+(?:[.,]\d+)?)\s*%?$/.exec(v) : null;
      if (pct) {
        const n = Number(pct[1]!.replace(',', '.'));
        spec.mcShare = v!.endsWith('%') || n > 1 ? n / 100 : n;
        i++;
      } else spec.mcShare = 0.25;
    } else if (t === 'sprache' && next) {
      spec.language = LANG_WORDS[next] ?? next;
      i++;
    } else if (t in LANG_WORDS) {
      spec.language = LANG_WORDS[t]!;
    } else if (t in LEVEL_WORDS) {
      spec.level = LEVEL_WORDS[t]!;
      // "Klasse 5-7" / "Klasse 6" belongs to the level, not the topic.
      if (t === 'klasse' && next && /^\d+([-–]\d+)?$/.test(next)) i++;
    } else if (t in LEVELS) {
      spec.level = t as BoardLevel;
    } else if (/^(öffentlich|oeffentlich|public|veröffentlichen|veroeffentlichen)$/.test(t)) {
      publicAsked = true;
    } else if (/^(privat|private)$/.test(t)) {
      // Always private anyway.
    } else if (t === 'nochmal' || (t === 'neu' && i === tokens.length - 1)) {
      force = true;
    } else {
      topic.push(raw);
    }
  }
  spec.topic = topic.join(' ').replace(QUOTES, '').trim();
  return { spec, force, publicAsked };
}
