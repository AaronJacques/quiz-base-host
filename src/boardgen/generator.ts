import type { z } from 'zod';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import type { LlmClient, UsageMeter } from '../llm/client.ts';
import { FIX_SYSTEM, fixPrompt, GENERATE_SYSTEM, generatePrompt, REVIEW_SYSTEM, reviewPrompt } from './prompts.ts';
import { BoardOutSchema, FixOutSchema, ReviewOutSchema, type BoardCategory, type BoardOut, type GeneratedBoard } from './schema.ts';
import { fingerprint, mcSlots, pointsList, questionId, specProblems, totalQuestions, type BoardSpec } from './spec.ts';
import { applyReplacements, cleanAnswer, cleanOptions, cleanText, cleanVariants, LIMITS, problemLines, validateBoard, type Validation } from './validate.ts';

const log = createLogger('boardgen');

export interface GeneratorDeps {
  llm: LlmClient;
  meter: UsageMeter;
  config: Config['boardgen'];
  /** Enforce `maxCostUsd` (API). Off for the subscription, whose reported cost is only notional. */
  enforceCostCap: boolean;
  /** Short German status lines ("Prüfrunde …") for the chat/terminal. */
  onProgress?: (text: string) => void;
}

/** SDK limit for non-streaming requests is ~21k max_tokens; thinking counts against it. */
const MAX_TOKENS_CAP = 21000;

class CostCapError extends Error {}

/**
 * Generates a complete Tafelquiz board: one generation call (retried with the exact list of
 * problems while the answer is structurally invalid), a review round that fact-checks and
 * replaces weak questions, and at most one targeted fix call for what is still wrong.
 * All counting, de-duplication, ordering and note formatting is done in code.
 */
export class BoardGenerator {
  constructor(private d: GeneratorDeps) {}

  async generate(spec: BoardSpec): Promise<GeneratedBoard> {
    const bad = specProblems(spec);
    if (bad.length) throw new Error(bad.join(' '));
    const cfg = this.d.config;
    const run = { cost: 0, calls: 0 };
    const ask = async <S extends z.ZodType>(system: string, prompt: string, schema: S, purpose: string): Promise<z.infer<S>> => {
      const res = await this.d.llm.completeJson({
        system,
        prompt,
        schema,
        purpose,
        model: cfg.model,
        maxTokens: Math.min(MAX_TOKENS_CAP, 4000 + 260 * totalQuestions(spec)),
        effort: cfg.effort,
        timeoutMs: cfg.timeoutMs,
      });
      run.calls++;
      run.cost += res.costUsd ?? 0;
      this.d.meter.record(purpose, res.costUsd);
      log.info(`${purpose}: ${(res.ms / 1000).toFixed(0)} s${res.costUsd != null ? `, $${res.costUsd.toFixed(4)}` : ''}`);
      if (this.d.enforceCostCap && run.cost > cfg.maxCostUsd) throw new CostCapError(`Kostengrenze erreicht ($${run.cost.toFixed(2)} > $${cfg.maxCostUsd.toFixed(2)}, boardgen.maxCostUsd).`);
      return res.data;
    };

    // 1) Generation, retried while the structure is wrong.
    let draft: BoardOut | null = null;
    let v: Validation = { hard: [], questions: new Map() };
    let feedback: string[] = [];
    let lastError = '';
    for (let attempt = 1; attempt <= cfg.maxAttempts && !draft; attempt++) {
      this.progress(attempt === 1 ? `✍️ Schreibe ${totalQuestions(spec)} Fragen …` : `🔁 Neuer Versuch (${attempt}/${cfg.maxAttempts}) …`);
      let out: BoardOut;
      try {
        out = await ask(GENERATE_SYSTEM, generatePrompt(spec, feedback), BoardOutSchema, 'boardgen');
      } catch (e) {
        if (e instanceof CostCapError) throw e;
        lastError = (e as Error).message;
        log.warn(`Erzeugung fehlgeschlagen: ${lastError.slice(0, 200)}`);
        feedback = ['- Die Antwort war kein gültiges JSON im geforderten Schema. Halte dich genau an das Schema.'];
        continue;
      }
      v = validateBoard(out, spec);
      if (v.hard.length) {
        feedback = problemLines(v);
        lastError = v.hard.join(' ');
        log.warn(`Board ungültig: ${lastError}`);
        continue;
      }
      draft = out;
    }
    if (!draft) throw new Error(`Kein gültiges Board nach ${cfg.maxAttempts} Versuchen: ${lastError}`);

    // 2) Review round: fact check + replacements in one call. Findings without a replacement stay open.
    const reviewed: { id: string; problem: string }[] = [];
    const reviewOpen = new Map<string, string[]>();
    if (cfg.review) {
      this.progress('🔎 Prüfrunde: Fakten und Eindeutigkeit …');
      try {
        const r = await ask(REVIEW_SYSTEM, reviewPrompt(draft, spec, problemLines(v)), ReviewOutSchema, 'boardgen-review');
        const replaced = new Set(applyReplacements(draft, r.replacements));
        for (const issue of r.issues) {
          reviewed.push({ id: issue.id, problem: issue.problem });
          if (!replaced.has(issue.id)) reviewOpen.set(issue.id, [...(reviewOpen.get(issue.id) ?? []), issue.problem]);
        }
        for (const id of replaced) if (!r.issues.some((i) => i.id === id)) reviewed.push({ id, problem: 'ersetzt' });
      } catch (e) {
        if (e instanceof CostCapError) throw e;
        log.warn(`Prüfrunde fehlgeschlagen: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    // 3) Deterministic check again; one targeted fix call for whatever is still wrong.
    const openProblems = () => {
      const m = new Map(reviewOpen);
      for (const [id, ps] of v.questions) m.set(id, [...(m.get(id) ?? []), ...ps]);
      return m;
    };
    v = validateBoard(draft, spec);
    let open = openProblems();
    if (open.size) {
      this.progress(`🛠️ Ersetze ${open.size} Frage${open.size === 1 ? '' : 'n'} …`);
      try {
        const lines = [...open].map(([id, ps]) => `- ${id}: ${ps.join(' ')}`);
        const f = await ask(FIX_SYSTEM, fixPrompt(draft, spec, lines), FixOutSchema, 'boardgen-fix');
        for (const id of applyReplacements(draft, f.replacements)) reviewOpen.delete(id);
      } catch (e) {
        if (e instanceof CostCapError) throw e;
        log.warn(`Reparatur fehlgeschlagen: ${(e as Error).message.slice(0, 200)}`);
      }
      v = validateBoard(draft, spec);
      open = openProblems();
    }
    if (v.hard.length) throw new Error(`Board ungültig: ${v.hard.join(' ')}`);

    const warnings = [...open].map(([id, ps]) => `${id}: ${ps.join(' ')}`);
    const board = buildBoard(draft, spec, { model: cfg.model, costUsd: run.cost, calls: run.calls, reviewed, warnings });
    log.info(`Board „${board.title}“: ${totalQuestions(spec)} Fragen, ${run.calls} Aufrufe, ${reviewed.length} in der Prüfrunde ersetzt/gemeldet, ${warnings.length} Warnungen`);
    return board;
  }

  private progress(text: string): void {
    try {
      this.d.onProgress?.(text);
    } catch {
      /* progress is cosmetic */
    }
  }
}

function clampDifficulty(d: unknown): number {
  const n = Math.round(Number(d));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

/** Deterministic PRNG so the same board always gets the same MC order (tests, re-creation). */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Turns a validated model answer into the board that goes into the editor. */
export function buildBoard(
  out: BoardOut,
  spec: BoardSpec,
  meta: Pick<GeneratedBoard, 'model' | 'costUsd' | 'calls' | 'reviewed' | 'warnings'>,
): GeneratedBoard {
  const fp = fingerprint(spec);
  const slots = mcSlots(spec);
  const points = pointsList(spec);
  const categories: BoardCategory[] = out.categories.map((c, ci) => {
    const qs = c.questions
      .map((q, ri) => ({ q, mc: slots.has(questionId(ci, ri)), d: clampDifficulty(q.difficulty), ri }))
      .sort((a, b) => a.d - b.d || a.ri - b.ri);
    return {
      name: cleanText(c.name),
      board: spec.boards === 2 && ci >= spec.categories ? 2 : 1,
      questions: qs.map(({ q, mc, d }, k) => {
        const id = questionId(ci, k);
        const answer = cleanAnswer(q.answer);
        const variants = cleanVariants(answer, q.variants);
        const wrong = mc ? cleanOptions(answer, q.wrongOptions) : [];
        const options = wrong.length === 3 ? shuffle([answer, ...wrong], seeded(fp + id)) : null;
        return {
          id,
          points: points[k]!,
          question: cleanText(q.question),
          answer,
          variants,
          options,
          correct: options ? options.indexOf(answer) : null,
          note: options ? null : [answer, ...variants].join(' / '),
          difficulty: d,
        };
      }),
    };
  });
  const supers = out.supercategories.map(cleanText).filter(Boolean);
  return {
    title: spec.name ?? (cleanText(out.title).slice(0, LIMITS.title) || `${spec.topic} Quiz`),
    description: cleanText(out.description).slice(0, LIMITS.description),
    supercategories: Array.from({ length: spec.boards }, (_, i) => (supers[i] ?? (i === 0 ? spec.topic : supers[0] ?? spec.topic)).slice(0, 40)),
    categories,
    spec,
    fingerprint: fp,
    model: meta.model,
    generatedAt: new Date().toISOString(),
    costUsd: meta.costUsd,
    calls: meta.calls,
    reviewed: meta.reviewed,
    warnings: meta.warnings,
  };
}
