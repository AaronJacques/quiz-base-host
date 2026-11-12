import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BoardGenerator,
  BoardStore,
  defaultSpec,
  estimateCost,
  fingerprint,
  fullPreview,
  mcSlots,
  publicPreview,
  specProblems,
  type BoardOut,
  type BoardSpec,
} from '../src/boardgen/index.ts';
import { QuizBaseBoardStudio } from '../src/board-studio.ts';
import { cleanAnswer, validateBoard } from '../src/boardgen/validate.ts';
import { ConfigSchema, type Config } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { referenceVariants } from '../src/judge/normalize.ts';
import { UsageMeter, type JsonRequest, type JsonResponse, type LlmClient } from '../src/llm/client.ts';

setLogLevel('error');

type Reply = unknown | ((req: JsonRequest<z.ZodType>) => unknown);

/** Scripted LLM: one reply per call (data or a function of the request); parses like the real clients. */
class FakeLlm implements LlmClient {
  name = 'fake';
  requests: JsonRequest<z.ZodType>[] = [];
  constructor(
    private replies: Reply[],
    private cost = 0.01,
  ) {}
  async completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> {
    this.requests.push(req as unknown as JsonRequest<z.ZodType>);
    const r = this.replies.shift();
    if (r === undefined) throw new Error('FakeLlm: keine Antwort mehr');
    const raw = typeof r === 'function' ? (r as (q: JsonRequest<z.ZodType>) => unknown)(req as unknown as JsonRequest<z.ZodType>) : r;
    if (raw instanceof Error) throw raw;
    return { data: req.schema.parse(raw), costUsd: this.cost, ms: 5 };
  }
  purposes() {
    return this.requests.map((r) => r.purpose);
  }
}

const config: Config = ConfigSchema.parse({});

function spec(over: Partial<BoardSpec> = {}): BoardSpec {
  return defaultSpec(config, 'Weltraum', { categories: 2, rows: 2, ...over });
}

const WORDS = ['Planet', 'Komet', 'Rakete', 'Galaxie', 'Mond', 'Sonne', 'Asteroid', 'Nebel', 'Satellit', 'Krater', 'Umlaufbahn', 'Teleskop'];
const VERBS = ['entdeckte', 'umkreist', 'erforschte', 'benannte', 'fotografierte', 'vermaß', 'besuchte', 'beobachtete', 'startete', 'baute'];

/** Distinct question text per cell (similarity between any two stays far below the duplicate threshold). */
const text = (c: number, r: number) => `Wer ${VERBS[r % VERBS.length]} im Jahr ${1900 + c * 37 + r * 11} den ${WORDS[(c * 3 + r) % WORDS.length]} ${String.fromCharCode(75 + c)}${r}?`;

/** A valid model answer for `s`: unique questions/answers, difficulty rising with the row. */
function boardOut(s: BoardSpec, edit?: (b: BoardOut) => void): BoardOut {
  const slots = mcSlots(s);
  const cats = s.categories * s.boards;
  const b: BoardOut = {
    title: 'Weltraum Quiz',
    description: 'Planeten, Sterne und Raumfahrt.',
    supercategories: s.boards === 2 ? ['Sonnensystem', 'Raumfahrt'] : ['Weltraum'],
    categories: Array.from({ length: cats }, (_, c) => ({
      name: `Kategorie ${String.fromCharCode(65 + c)}`,
      questions: Array.from({ length: s.rows }, (_, r) => ({
        question: text(c, r),
        answer: `Loesung${c}x${r}`,
        variants: [`Variante${c}x${r}`],
        wrongOptions: slots.has(`k${c + 1}f${r + 1}`) ? [`Falsch${c}${r}a`, `Falsch${c}${r}b`, `Falsch${c}${r}c`] : [],
        difficulty: r + 1,
      })),
    })),
  };
  edit?.(b);
  return b;
}

const noIssues = { issues: [], replacements: [] };

function generator(llm: LlmClient, over: Partial<Config['boardgen']> = {}, enforceCostCap = false) {
  const meter = new UsageMeter();
  const progress: string[] = [];
  const gen = new BoardGenerator({ llm, meter, config: { ...config.boardgen, ...over }, enforceCostCap, onProgress: (t) => progress.push(t) });
  return { gen, meter, progress };
}

describe('BoardGenerator', () => {
  it('erzeugt ein gültiges Board mit Prüfrunde, Punkten und Notizen im Judge-Format', async () => {
    const s = spec();
    const llm = new FakeLlm([boardOut(s), noIssues]);
    const { gen, meter } = generator(llm);
    const board = await gen.generate(s);
    expect(llm.purposes()).toEqual(['boardgen', 'boardgen-review']);
    expect(llm.requests[0]!.model).toBe('sonnet');
    expect(board.categories).toHaveLength(2);
    expect(board.categories[0]!.questions.map((q) => q.points)).toEqual([100, 200]);
    const q = board.categories[0]!.questions[0]!;
    expect(q.note).toBe('Loesung0x0 / Variante0x0');
    expect(referenceVariants(q.note!)).toEqual(expect.arrayContaining(['Loesung0x0', 'Variante0x0']));
    expect(board.warnings).toEqual([]);
    expect(board.calls).toBe(2);
    expect(board.costUsd).toBeCloseTo(0.02);
    expect(meter.calls).toBe(2);
    expect(meter.byPurpose).toEqual({ boardgen: 1, 'boardgen-review': 1 });
  });

  it('sortiert Fragen einer Kategorie nach Schwierigkeit', async () => {
    const s = spec();
    const out = boardOut(s, (b) => {
      b.categories[0]!.questions[0]!.difficulty = 5;
      b.categories[0]!.questions[1]!.difficulty = 1;
    });
    const board = await generator(new FakeLlm([out, noIssues])).gen.generate(s);
    expect(board.categories[0]!.questions.map((q) => q.answer)).toEqual(['Loesung0x1', 'Loesung0x0']);
    expect(board.categories[0]!.questions.map((q) => q.points)).toEqual([100, 200]);
  });

  it('wiederholt bei Schema-Fehlern mit Hinweis im Prompt', async () => {
    const s = spec();
    const llm = new FakeLlm([{ title: 'kaputt' }, boardOut(s), noIssues]);
    const board = await generator(llm).gen.generate(s);
    expect(llm.purposes()).toEqual(['boardgen', 'boardgen', 'boardgen-review']);
    expect(llm.requests[1]!.prompt).toContain('kein gültiges JSON');
    expect(board.title).toBe('Weltraum Quiz');
  });

  it('wiederholt bei falscher Struktur mit der genauen Fehlerliste', async () => {
    const s = spec();
    const short = boardOut(s, (b) => b.categories.pop());
    const llm = new FakeLlm([short, boardOut(s), noIssues]);
    await generator(llm).gen.generate(s);
    expect(llm.requests[1]!.prompt).toContain('genau 2 Kategorien');
  });

  it('gibt nach maxAttempts auf', async () => {
    const s = spec();
    const short = () => boardOut(s, (b) => b.categories.pop());
    const llm = new FakeLlm([short, short, short]);
    await expect(generator(llm).gen.generate(s)).rejects.toThrow(/Kein gültiges Board nach 3 Versuchen/);
  });

  it('gibt der Prüfrunde gefundene Probleme mit und übernimmt Ersatzfragen', async () => {
    const s = spec();
    // k1f2 verrät die Lösung, k2f1 wiederholt eine Lösung
    const out = boardOut(s, (b) => {
      b.categories[0]!.questions[1]!.question = 'Ist die Lösung Loesung0x1 oder nicht?';
      b.categories[1]!.questions[0]!.answer = 'Loesung0x0';
    });
    const review = (req: JsonRequest<z.ZodType>) => {
      expect(req.prompt).toContain('k1f2: Die Frage enthält die Lösung.');
      expect(req.prompt).toContain('k2f1: Lösung „Loesung0x0“ gibt es schon bei k1f1.');
      return {
        issues: [{ id: 'k1f2', problem: 'verraten' }, { id: 'k2f1', problem: 'Dublette' }],
        replacements: [
          { id: 'k1f2', question: 'Wie heißt der rote Planet?', answer: 'Mars', variants: [], wrongOptions: [], difficulty: 2 },
          { id: 'k2f1', question: 'Wie heißt der größte Planet?', answer: 'Jupiter', variants: [], wrongOptions: [], difficulty: 1 },
        ],
      };
    };
    const llm = new FakeLlm([out, review]);
    const board = await generator(llm).gen.generate(s);
    expect(llm.purposes()).toEqual(['boardgen', 'boardgen-review']);
    expect(board.categories[0]!.questions[1]!.answer).toBe('Mars');
    expect(board.categories[1]!.questions[0]!.answer).toBe('Jupiter');
    expect(board.reviewed.map((r) => r.id)).toEqual(['k1f2', 'k2f1']);
    expect(board.warnings).toEqual([]);
  });

  it('repariert Funde der Prüfrunde ohne Ersatz gezielt', async () => {
    const s = spec();
    const fix = (req: JsonRequest<z.ZodType>) => {
      expect(req.prompt).toContain('k2f2: Lösung ist veraltet');
      return { replacements: [{ id: 'k2f2', question: 'Wie viele Monde hat der Mars?', answer: '2', variants: ['zwei'], wrongOptions: [], difficulty: 3 }] };
    };
    const llm = new FakeLlm([boardOut(s), { issues: [{ id: 'k2f2', problem: 'Lösung ist veraltet' }], replacements: [] }, fix]);
    const board = await generator(llm).gen.generate(s);
    expect(llm.purposes()).toEqual(['boardgen', 'boardgen-review', 'boardgen-fix']);
    expect(board.categories[1]!.questions[1]!.note).toBe('2 / zwei');
    expect(board.warnings).toEqual([]);
  });

  it('meldet, was nach der Reparatur noch offen ist, als Warnung', async () => {
    const s = spec();
    const llm = new FakeLlm([boardOut(s), { issues: [{ id: 'k1f1', problem: 'mehrdeutig' }], replacements: [] }, { replacements: [] }]);
    const board = await generator(llm).gen.generate(s);
    expect(board.warnings).toEqual(['k1f1: mehrdeutig']);
  });

  it('ohne Prüfrunde nur ein Aufruf, wenn alles gültig ist', async () => {
    const s = spec();
    const llm = new FakeLlm([boardOut(s)]);
    await generator(llm, { review: false }).gen.generate(s);
    expect(llm.purposes()).toEqual(['boardgen']);
  });

  it('Multiple Choice: gleichmäßig verteilt, vier gemischte Optionen, genau eine richtig, keine Notiz', async () => {
    const s = spec({ mcShare: 0.5 });
    expect(mcSlots(s).size).toBe(2);
    const board = await generator(new FakeLlm([boardOut(s), noIssues])).gen.generate(s);
    const mc = board.categories.flatMap((c) => c.questions).filter((q) => q.options);
    expect(mc).toHaveLength(2);
    for (const q of mc) {
      expect(q.options).toHaveLength(4);
      expect(q.options![q.correct!]).toBe(q.answer);
      expect(q.note).toBeNull();
    }
    // deterministic: same request → same order
    const again = await generator(new FakeLlm([boardOut(s), noIssues])).gen.generate(s);
    expect(again.categories.flatMap((c) => c.questions).map((q) => q.options)).toEqual(board.categories.flatMap((c) => c.questions).map((q) => q.options));
  });

  it('Multiple Choice ohne 3 falsche Optionen ist ein Problem', () => {
    const s = spec({ mcShare: 1 });
    const v = validateBoard(boardOut(s, (b) => (b.categories[0]!.questions[0]!.wrongOptions = ['nur eine'])), s);
    expect(v.questions.get('k1f1')).toEqual(['Multiple Choice braucht 3 verschiedene falsche Optionen.']);
  });

  it('zwei Boards: Kategorien werden aufgeteilt, zwei Oberkategorien', async () => {
    const s = spec({ boards: 2 });
    const board = await generator(new FakeLlm([boardOut(s), noIssues])).gen.generate(s);
    expect(board.categories.map((c) => c.board)).toEqual([1, 1, 2, 2]);
    expect(board.supercategories).toEqual(['Sonnensystem', 'Raumfahrt']);
  });

  it('bricht ab, wenn die Kostengrenze überschritten wird (API)', async () => {
    const s = spec();
    const llm = new FakeLlm([boardOut(s), noIssues], 0.6);
    await expect(generator(llm, { maxCostUsd: 1 }, true).gen.generate(s)).rejects.toThrow(/Kostengrenze/);
  });

  it('ein vorgegebener Name schlägt den Vorschlag des Modells', async () => {
    const s = spec({ name: '[TEST] qbhost Probe' });
    const llm = new FakeLlm([boardOut(s), noIssues]);
    const board = await generator(llm).gen.generate(s);
    expect(board.title).toBe('[TEST] qbhost Probe');
    expect(llm.requests[0]!.prompt).toContain('title: genau „[TEST] qbhost Probe“');
  });
});

describe('BoardSpec', () => {
  it('Fingerprint ignoriert Schreibweise und Reihenfolge der Themen', () => {
    const a = spec({ topic: 'Star Wars', themes: ['Jedi', 'Schiffe'] });
    const b = spec({ topic: '  star   wars ', themes: ['schiffe', 'JEDI'] });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(spec({ topic: 'Star Wars', themes: ['Jedi', 'Schiffe'], rows: 5 })));
  });

  it('prüft Grenzen', () => {
    expect(specProblems(spec())).toEqual([]);
    expect(specProblems(spec({ rows: 11 }))).toEqual([expect.stringContaining('1–10')]);
    expect(specProblems(spec({ categories: 8, rows: 10, boards: 2 }))).toEqual([expect.stringContaining('Zu viele Fragen')]);
    expect(specProblems(spec({ step: 75 }))).toEqual([expect.stringContaining('50er')]);
  });

  it('Kostenschätzung: Abo kostet nichts extra, API in Dollar', () => {
    const viaCli = estimateCost(spec({ categories: 4, rows: 4 }), config);
    expect(viaCli.viaSubscription).toBe(true);
    expect(viaCli.calls).toBe(2);
    expect(viaCli.usd).toBeGreaterThan(0.03);
    expect(viaCli.usd).toBeLessThan(0.25);
    const api = estimateCost(spec(), { ...config, boardgen: { ...config.boardgen, provider: 'anthropic' } });
    expect(api.viaSubscription).toBe(false);
  });

  it('Lösungen werden für die Host-Notiz entschärft', () => {
    expect(cleanAnswer('AC/DC')).toBe('AC-DC');
    expect(cleanAnswer('Paris (Frankreich).')).toBe('Paris');
    expect(cleanAnswer('A; B')).toBe('A, B');
  });
});

describe('Vorschau und Register', () => {
  async function sample() {
    const s = spec();
    return generator(new FakeLlm([boardOut(s), noIssues])).gen.generate(s);
  }

  it('öffentliche Vorschau ohne Fragen und Lösungen, volle Vorschau mit Lösungen', async () => {
    const board = await sample();
    const pub = publicPreview(board);
    expect(pub).toContain('Weltraum Quiz');
    expect(pub).toContain('Kategorie A');
    expect(pub).not.toMatch(/Loesung|Variante|Wer /);
    const full = fullPreview(board).join('\n');
    expect(full).toContain('Loesung0x0');
    expect(full).toContain(text(0, 0));
  });

  it('volle Vorschau passt in Discord-Nachrichten', async () => {
    const s = spec({ categories: 6, rows: 10 });
    const board = await generator(new FakeLlm([boardOut(s), noIssues])).gen.generate(s);
    const parts = fullPreview(board);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1900);
  });

  it('Register: Entwurf, angelegt, Suche nach Name und Fingerprint', async () => {
    const store = new BoardStore(mkdtempSync(path.join(os.tmpdir(), 'qb-boards-')));
    const board = await sample();
    const rec = store.saveDraft(board);
    expect(store.byFingerprint(board.fingerprint)?.status).toBe('draft');
    expect(store.findCreated('Weltraum Quiz')).toEqual([]);
    store.markCreated(rec.id, 'https://www.quiz-base.de/profil/boards/edit/x');
    expect(store.byFingerprint(board.fingerprint)?.url).toBe('https://www.quiz-base.de/profil/boards/edit/x');
    expect(store.findCreated('weltraum quiz').map((r) => r.id)).toEqual([rec.id]);
    expect(store.load(rec.id).title).toBe('Weltraum Quiz');
    // Deleted on quiz-base → local draft again (questions kept, can be created again without LLM).
    store.markDeleted(rec.id);
    expect(store.get(rec.id)).toMatchObject({ status: 'draft', url: null });
    expect(store.findCreated('weltraum quiz')).toEqual([]);
    expect(store.load(rec.id).title).toBe('Weltraum Quiz');
    store.remove(rec.id);
    expect(store.list()).toEqual([]);
  });

  it('ein schon angelegtes Board wird nicht ein zweites Mal gespeichert', async () => {
    const config = ConfigSchema.parse({ boardgen: { dir: mkdtempSync(path.join(os.tmpdir(), 'qb-boards-')) } });
    const studio = new QuizBaseBoardStudio(config);
    const rec = studio.store.saveDraft(await sample());
    studio.store.markCreated(rec.id, null);
    await expect(studio.create(rec.id)).rejects.toThrow(/schon auf quiz-base angelegt/);
  });
});
