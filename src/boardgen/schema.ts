import { z } from 'zod';
import type { BoardSpec } from './spec.ts';

// LLM output schemas. Deliberately loose (no length/count constraints): structured-output
// backends do not support all JSON-schema keywords, and exact counts are checked in
// validate.ts, which can tell the model precisely what to fix.

export const QuestionOutSchema = z.object({
  question: z.string(),
  answer: z.string().describe('kürzeste übliche Form der Lösung, 1–4 Wörter'),
  variants: z.array(z.string()).describe('weitere als richtig geltende Antworten, sonst leer'),
  wrongOptions: z.array(z.string()).describe('nur bei Multiple-Choice-Fragen: 3 falsche Optionen, sonst leer'),
  difficulty: z.number().describe('1 (sehr leicht) bis 5 (sehr schwer)'),
});

export const BoardOutSchema = z.object({
  title: z.string(),
  description: z.string(),
  supercategories: z.array(z.string()),
  categories: z.array(z.object({ name: z.string(), questions: z.array(QuestionOutSchema) })),
});

export const ReviewOutSchema = z.object({
  issues: z.array(z.object({ id: z.string(), problem: z.string().describe('kurz, deutsch') })),
  replacements: z.array(QuestionOutSchema.extend({ id: z.string() })),
});

export const FixOutSchema = z.object({
  replacements: z.array(QuestionOutSchema.extend({ id: z.string() })),
});

export type QuestionOut = z.infer<typeof QuestionOutSchema>;
export type BoardOut = z.infer<typeof BoardOutSchema>;
export type ReviewOut = z.infer<typeof ReviewOutSchema>;

/** A finished question as it goes into the editor (and the DM preview). */
export interface BoardQuestion {
  id: string;
  points: number;
  question: string;
  answer: string;
  variants: string[];
  /** Multiple choice: four options including the answer (shuffled); null = free answer with host note. */
  options: string[] | null;
  /** Index of the answer in `options`. */
  correct: number | null;
  /** Host note for free answers: "Antwort / Variante / …" (split by the judge's referenceVariants). */
  note: string | null;
  difficulty: number;
}

export interface BoardCategory {
  name: string;
  board: 1 | 2;
  questions: BoardQuestion[];
}

export interface GeneratedBoard {
  title: string;
  description: string;
  supercategories: string[];
  categories: BoardCategory[];
  spec: BoardSpec;
  fingerprint: string;
  model: string;
  generatedAt: string;
  costUsd: number;
  calls: number;
  /** Problems the review round found (all replaced unless listed in `warnings`). */
  reviewed: { id: string; problem: string }[];
  /** Problems that are still there after all attempts – shown to the creator before creating. */
  warnings: string[];
}
