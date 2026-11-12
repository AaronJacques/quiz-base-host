import { describe, expect, it } from 'vitest';
import { buildBoard, defaultSpec, mcSlots, type BoardOut, type BoardSpec, type GeneratedBoard } from '../src/boardgen/index.ts';
import { ConfigSchema } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { writeBoard } from '../src/site/editor/writer.ts';
import { FakeBoardEditorPage } from './fake-editor.ts';

setLogLevel('error');

const config = ConfigSchema.parse({});

function board(over: Partial<BoardSpec> = {}): GeneratedBoard {
  const s = defaultSpec(config, 'Musik', { categories: 2, rows: 3, ...over });
  const slots = mcSlots(s);
  const out: BoardOut = {
    title: 'Musik Quiz',
    description: 'Hits und Instrumente.',
    supercategories: s.boards === 2 ? ['Pop', 'Klassik'] : ['Musik'],
    categories: Array.from({ length: s.categories * s.boards }, (_, c) => ({
      name: `Kat ${c + 1}`,
      questions: Array.from({ length: s.rows }, (_, r) => ({
        question: `Frage ${c}-${r}?`,
        answer: `Antwort ${c}-${r}`,
        variants: [`Var ${c}-${r}`],
        wrongOptions: slots.has(`k${c + 1}f${r + 1}`) ? ['X', 'Y', 'Z'] : [],
        difficulty: r + 1,
      })),
    })),
  };
  return buildBoard(out, s, { model: 'sonnet', costUsd: 0, calls: 2, reviewed: [], warnings: [] });
}

const fast = { pauseMs: 0, pollMs: 1 };

describe('writeBoard (Board-Editor)', () => {
  it('trägt ein Board mit Notizen vollständig ein und speichert es, ohne eine Lobby zu öffnen', async () => {
    const page = new FakeBoardEditorPage();
    const b = board();
    const res = await writeBoard(page, b, fast);
    expect(res.url).toBe('https://www.quiz-base.de/board/fake-1');
    expect(page.lobbyClicked).toBe(false);
    const saved = page.saved!;
    expect(saved.meta).toEqual({ title: 'Musik Quiz', description: 'Hits und Instrumente.' });
    expect(saved.boards).toBe(1);
    expect(saved.supers).toEqual(['Musik']);
    expect(saved.categories.map((c) => [c.name, c.count])).toEqual([['Kat 1', 3], ['Kat 2', 3]]);
    const q = saved.categories[1]!.questions[2]!;
    expect(q).toMatchObject({ text: 'Frage 1-2?', points: 300, mc: false, note: 'Antwort 1-2 / Var 1-2' });
  });

  it('Multiple Choice: Optionen und richtige Antwort, Rest mit Notiz', async () => {
    const page = new FakeBoardEditorPage();
    const b = board({ mcShare: 0.5 });
    await writeBoard(page, b, fast);
    const all = page.saved!.categories.flatMap((c) => c.questions);
    const want = b.categories.flatMap((c) => c.questions);
    expect(all.filter((q) => q.mc)).toHaveLength(want.filter((q) => q.options).length);
    for (const [i, q] of want.entries()) {
      if (q.options) expect(all[i]).toMatchObject({ mc: true, options: q.options, correct: q.correct });
      else expect(all[i]).toMatchObject({ mc: false, note: q.note });
    }
  });

  it('zwei Boards: Kategorien werden Board 1/2 zugeordnet, zwei Oberkategorien', async () => {
    const page = new FakeBoardEditorPage();
    await writeBoard(page, board({ boards: 2 }), fast);
    expect(page.saved!.boards).toBe(2);
    expect(page.saved!.categories.map((c) => c.board)).toEqual([1, 1, 2, 2]);
    expect(page.saved!.supers).toEqual(['Pop', 'Klassik']);
  });

  it('Punkteschritt ≠ 100 über den 50er-Stepper', async () => {
    const page = new FakeBoardEditorPage();
    await writeBoard(page, board({ step: 250 }), fast);
    expect(page.saved!.categories[0]!.questions.map((q) => q.points)).toEqual([250, 500, 750]);
  });

  it('wiederholt Eingaben, die React verschluckt', async () => {
    const page = new FakeBoardEditorPage();
    page.dropEvery = 4;
    await writeBoard(page, board(), fast);
    expect(page.saved!.categories.flatMap((c) => c.questions).every((q) => q.text.startsWith('Frage'))).toBe(true);
    expect(page.saved!.categories.map((c) => c.name)).toEqual(['Kat 1', 'Kat 2']);
  });

  it('kommt mit einem Akkordeon zurecht (nur eine Frage offen)', async () => {
    const page = new FakeBoardEditorPage();
    page.accordion = true;
    await writeBoard(page, board(), fast);
    expect(page.saved!.categories[0]!.questions.map((q) => q.note)).toEqual(['Antwort 0-0 / Var 0-0', 'Antwort 0-1 / Var 0-1', 'Antwort 0-2 / Var 0-2']);
  });

  it('ohne Login: klare Meldung, nichts eingetragen', async () => {
    const page = new FakeBoardEditorPage();
    page.loggedIn = false;
    await expect(writeBoard(page, board(), fast)).rejects.toThrow(/qbhost login/);
    expect(page.saved).toBeNull();
    expect(page.log).toEqual([]);
  });
});
