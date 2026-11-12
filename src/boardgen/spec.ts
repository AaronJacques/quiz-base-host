import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import { normalize } from '../judge/normalize.ts';

export type BoardLevel = Config['boardgen']['defaults']['level'];

export const LEVELS: Record<BoardLevel, { label: string; prompt: string }> = {
  kinder: {
    label: 'Kinder (8–10 Jahre)',
    prompt: 'Kinder von 8 bis 10 Jahren: sehr bekannte Dinge aus Alltag, Natur, Tieren, Kinderbüchern und -filmen; einfache, kurze Sätze; auch die höchste Stufe ist für ein aufgewecktes Kind lösbar.',
  },
  schule: {
    label: 'Schule (Klasse 5–7)',
    prompt: 'Schulquiz für Klasse 5 bis 7 (10–13 Jahre): Stoff aus dem Unterricht und dem Alltag, klare Sprache; die niedrigste Stufe weiß fast jedes Kind, die höchste nur, wer gut aufgepasst hat.',
  },
  oberstufe: {
    label: 'Oberstufe',
    prompt: 'Oberstufe (16–19 Jahre): Schulwissen bis zum Abitur und Allgemeinbildung; die höchste Stufe verlangt echtes Fachwissen.',
  },
  kneipe: {
    label: 'Kneipenquiz',
    prompt: 'Kneipenquiz für Erwachsene: Allgemeinwissen und Popkultur; die niedrigste Stufe weiß fast jeder, die höchste nur echte Kenner.',
  },
  profi: {
    label: 'Profis',
    prompt: 'Erfahrene Quizspieler und Fans des Themas: anspruchsvolle, aber faire und eindeutige Fakten; schon die niedrigste Stufe ist für Laien nicht trivial.',
  },
};

/** Everything a board request can specify. `categories` counts per board. */
export interface BoardSpec {
  topic: string;
  /** Optional subject areas, one per category; the model fills the rest. */
  themes: string[];
  categories: number;
  rows: number;
  step: number;
  boards: 1 | 2;
  level: BoardLevel;
  language: string;
  mcShare: number;
  /** Board name; null = the model proposes one. */
  name: string | null;
}

/** quiz-base allows 1–10 questions per category; more than 60 questions makes one LLM answer too long. */
export const MAX_QUESTIONS = 60;

export function defaultSpec(config: Config, topic: string, over: Partial<BoardSpec> = {}): BoardSpec {
  const d = config.boardgen.defaults;
  return {
    topic: topic.trim(),
    themes: [],
    categories: d.categories,
    rows: d.rows,
    step: d.step,
    boards: d.boards as 1 | 2,
    level: d.level,
    language: d.language,
    mcShare: d.mcShare,
    name: null,
    ...over,
  };
}

export const totalQuestions = (s: BoardSpec) => s.categories * s.boards * s.rows;
export const totalCategories = (s: BoardSpec) => s.categories * s.boards;

/** Problems with a spec, in German (empty = fine). */
export function specProblems(s: BoardSpec): string[] {
  const out: string[] = [];
  if (s.topic.length < 2) out.push('Thema fehlt.');
  if (s.topic.length > 200) out.push('Thema ist zu lang (max. 200 Zeichen).');
  if (!Number.isInteger(s.categories) || s.categories < 2 || s.categories > 8) out.push('Kategorien pro Board: 2–8.');
  if (!Number.isInteger(s.rows) || s.rows < 1 || s.rows > 10) out.push('Punktestufen: 1–10 (mehr erlaubt quiz-base nicht).');
  if (!Number.isInteger(s.step) || s.step < 50 || s.step % 50 !== 0 || s.step > 1000) out.push('Punkteschritt: 50–1000 in 50er-Schritten.');
  if (s.boards !== 1 && s.boards !== 2) out.push('Boards: 1 oder 2.');
  if (!(s.level in LEVELS)) out.push(`Niveau: ${Object.keys(LEVELS).join(', ')}.`);
  if (!/^[a-z]{2}$/.test(s.language)) out.push('Sprache als Code, z.B. de oder en.');
  if (!(s.mcShare >= 0 && s.mcShare <= 1)) out.push('Multiple-Choice-Anteil: 0–100 %.');
  if (s.themes.length > totalCategories(s)) out.push(`Mehr Themenbereiche (${s.themes.length}) als Kategorien (${totalCategories(s)}).`);
  if (s.name && s.name.length > 60) out.push('Board-Name ist zu lang (max. 60 Zeichen).');
  if (totalQuestions(s) > MAX_QUESTIONS) out.push(`Zu viele Fragen (${totalQuestions(s)}); höchstens ${MAX_QUESTIONS} pro Board-Anfrage.`);
  return out;
}

/** Same request → same fingerprint (case, spacing, umlauts and theme order do not matter). */
export function fingerprint(s: BoardSpec): string {
  const key = {
    topic: normalize(s.topic),
    themes: s.themes.map(normalize).sort(),
    categories: s.categories,
    rows: s.rows,
    step: s.step,
    boards: s.boards,
    level: s.level,
    language: s.language,
    mc: Math.round(s.mcShare * 100),
    name: s.name ? normalize(s.name) : null,
  };
  return createHash('sha1').update(JSON.stringify(key)).digest('hex').slice(0, 16);
}

/** Which questions (category index, row index) are multiple choice – spread evenly, deterministic. */
export function mcSlots(s: BoardSpec): Set<string> {
  const total = totalQuestions(s);
  const n = Math.round(total * s.mcShare);
  const slots = new Set<string>();
  if (n <= 0) return slots;
  const cats = totalCategories(s);
  // Walk the board diagonally so MC questions land in different categories and rows.
  const order: [number, number][] = [];
  for (let k = 0; k < total; k++) {
    const c = k % cats;
    const r = (Math.floor(k / cats) + c) % s.rows;
    order.push([c, r]);
  }
  const stride = total / n;
  for (let i = 0; i < n; i++) {
    const [c, r] = order[Math.floor(i * stride)]!;
    slots.add(questionId(c, r));
  }
  return slots;
}

/** Stable id of a question in prompts and reviews: k<category>f<row>, 1-based. */
export const questionId = (c: number, r: number) => `k${c + 1}f${r + 1}`;

export function pointsList(s: BoardSpec): number[] {
  return Array.from({ length: s.rows }, (_, r) => (r + 1) * s.step);
}
