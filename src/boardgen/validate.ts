import { normalize, similarity } from '../judge/normalize.ts';
import type { BoardOut, QuestionOut } from './schema.ts';
import { mcSlots, questionId, totalCategories, type BoardSpec } from './spec.ts';

export const LIMITS = {
  categoryName: 24,
  question: 220,
  answer: 40,
  answerWords: 5,
  option: 60,
  title: 60,
  description: 200,
};

export interface Validation {
  /** Structural problems – the whole answer is unusable and must be regenerated. */
  hard: string[];
  /** Problems of single questions (by id) – fixable by replacing those questions. */
  questions: Map<string, string[]>;
}

/**
 * Makes an answer/variant safe for the host note: the judge splits notes at "/", ";", "|", "oder"
 * and turns "(…)" into extra variants, so none of those may appear inside one answer.
 */
export function cleanAnswer(s: string): string {
  return s
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/[/|]/g, '-')
    .replace(/;/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();
}

export function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const ID = /^k(\d+)f(\d+)$/;

export function parseId(id: string): [number, number] | null {
  const m = ID.exec(id.trim());
  return m ? [Number(m[1]) - 1, Number(m[2]) - 1] : null;
}

/** Distinct, cleaned variants without the answer itself. */
export function cleanVariants(answer: string, variants: string[]): string[] {
  const seen = new Set([normalize(answer)]);
  const out: string[] = [];
  for (const v of variants) {
    const c = cleanAnswer(v);
    const n = normalize(c);
    if (!n || seen.has(n) || c.length > LIMITS.answer * 2) continue;
    if (/\s(oder|or|bzw)\s/i.test(` ${c} `)) continue;
    seen.add(n);
    out.push(c);
  }
  return out;
}

/** Up to three wrong options that differ from the answer and from each other. */
export function cleanOptions(answer: string, wrong: string[]): string[] {
  const seen = new Set([normalize(answer)]);
  const out: string[] = [];
  for (const o of wrong) {
    const c = cleanText(o);
    const n = normalize(c);
    if (!n || seen.has(n) || c.length > LIMITS.option) continue;
    seen.add(n);
    out.push(c);
    if (out.length === 3) break;
  }
  return out;
}

function leaks(question: string, answer: string): boolean {
  const a = normalize(answer);
  if (a.length < 3) return false;
  return ` ${normalize(question)} `.includes(` ${a} `);
}

/** Checks a model answer against the request. Pure – used by the generator and the tests. */
export function validateBoard(out: BoardOut, spec: BoardSpec): Validation {
  const hard: string[] = [];
  const questions = new Map<string, string[]>();
  const add = (id: string, problem: string) => questions.set(id, [...(questions.get(id) ?? []), problem]);

  const wantCats = totalCategories(spec);
  if (out.categories.length !== wantCats) hard.push(`Es müssen genau ${wantCats} Kategorien sein (geliefert: ${out.categories.length}).`);
  const names = new Set<string>();
  out.categories.forEach((c, i) => {
    const name = cleanText(c.name);
    if (!name) hard.push(`Kategorie ${i + 1} hat keinen Namen.`);
    else if (name.length > LIMITS.categoryName) hard.push(`Kategoriename „${name}“ ist zu lang (max. ${LIMITS.categoryName} Zeichen).`);
    else if (names.has(normalize(name))) hard.push(`Kategoriename „${name}“ kommt doppelt vor.`);
    names.add(normalize(name));
    if (c.questions.length !== spec.rows) hard.push(`Kategorie ${i + 1} („${name}“) braucht genau ${spec.rows} Fragen (geliefert: ${c.questions.length}).`);
  });
  if (hard.length) return { hard, questions };

  const slots = mcSlots(spec);
  const answers: { id: string; norm: string }[] = [];
  const texts: { id: string; text: string }[] = [];
  out.categories.forEach((c, ci) =>
    c.questions.forEach((q, ri) => {
      const id = questionId(ci, ri);
      const text = cleanText(q.question);
      const answer = cleanAnswer(q.answer);
      if (!text) add(id, 'Fragetext fehlt.');
      else if (text.length > LIMITS.question) add(id, `Frage ist zu lang (max. ${LIMITS.question} Zeichen).`);
      if (!answer) add(id, 'Lösung fehlt.');
      else {
        if (answer.length > LIMITS.answer || answer.split(' ').length > LIMITS.answerWords) add(id, `Lösung ist zu lang (max. ${LIMITS.answerWords} Wörter / ${LIMITS.answer} Zeichen).`);
        if (/\s(oder|or|bzw|beziehungsweise)\s/i.test(` ${answer} `)) add(id, 'Lösung ist nicht eindeutig (enthält „oder“).');
        if (text && leaks(text, answer)) add(id, 'Die Frage enthält die Lösung.');
        const n = normalize(answer);
        const dup = answers.find((a) => a.norm === n);
        if (dup) add(id, `Lösung „${answer}“ gibt es schon bei ${dup.id}.`);
        answers.push({ id, norm: n });
      }
      const twin = texts.find((t) => similarity(t.text, text) >= 0.85);
      if (text && twin) add(id, `Fast dieselbe Frage wie ${twin.id}.`);
      texts.push({ id, text });
      if (slots.has(id) && answer && cleanOptions(answer, q.wrongOptions).length < 3) add(id, 'Multiple Choice braucht 3 verschiedene falsche Optionen.');
    }),
  );
  return { hard, questions };
}

/** Problems as prompt lines ("- k2f3: …"). */
export function problemLines(v: Validation): string[] {
  return [...v.hard.map((h) => `- ${h}`), ...[...v.questions].map(([id, ps]) => `- ${id}: ${ps.join(' ')}`)];
}

/** Puts replacement questions into the board by id. Returns the ids that were replaced. */
export function applyReplacements(out: BoardOut, replacements: (QuestionOut & { id: string })[]): string[] {
  const done: string[] = [];
  for (const r of replacements) {
    const pos = parseId(r.id);
    if (!pos) continue;
    const [c, q] = pos;
    const cat = out.categories[c];
    if (!cat || !cat.questions[q]) continue;
    const { id: _id, ...question } = r;
    cat.questions[q] = question;
    done.push(r.id);
  }
  return done;
}
