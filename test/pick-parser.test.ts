import { describe, expect, it } from 'vitest';
import type { BoardCell } from '../src/core/types.ts';
import { formatBoard, parsePick } from '../src/discord/pick-parser.ts';

const cats = ['Nintendo', 'Playstation', 'Serien/Filme', 'PC'];
const grid: BoardCell[] = cats.flatMap((category, col) =>
  [100, 200, 300, 400].map((points, row) => ({ category, col, row, points, answered: false })),
);
grid.find((c) => c.category === 'Nintendo' && c.points === 200)!.answered = true;
grid.find((c) => c.category === 'PC' && c.points === 400)!.answered = true;

const ok = (text: string) => {
  const r = parsePick(text, grid);
  if (r.kind !== 'ok') throw new Error(`${text} → ${JSON.stringify(r)}`);
  return `${r.cell.category} ${r.cell.points}`;
};

describe('parsePick', () => {
  it.each([
    ['Nintendo 300', 'Nintendo 300'],
    ['nin 300', 'Nintendo 300'],
    ['nintedno 100', 'Nintendo 100'],
    ['300 nintendo', 'Nintendo 300'],
    ['ich nehme Filme für 300', 'Serien/Filme 300'],
    ['serien 100', 'Serien/Filme 100'],
    ['Serien/Filme 400', 'Serien/Filme 400'],
    ['2 200', 'Playstation 200'],
    ['play 400', 'Playstation 400'],
  ])('%s → %s', (text, expected) => expect(ok(text)).toBe(expected));

  it('detects already played cards', () => {
    const r = parsePick('Nintendo 200', grid);
    expect(r.kind).toBe('taken');
  });

  it('rejects point values the category does not have', () => {
    const r = parsePick('Nintendo 500', grid);
    expect(r.kind).toBe('invalid');
  });

  it('asks back when only points are given', () => {
    const r = parsePick('200', grid);
    expect(r.kind).toBe('ambiguous');
  });

  it('picks the single remaining value of a category', () => {
    const g = grid.map((c) => ({ ...c, answered: c.category === 'PC' && c.points !== 100 ? true : c.answered }));
    const r = parsePick('PC', g);
    expect(r.kind === 'ok' && r.cell.points).toBe(100);
  });

  it('ignores chatter', () => {
    expect(parsePick('haha nice', grid).kind).toBe('none');
    expect(parsePick('moment', grid).kind).toBe('none');
  });

  it('formats the board with played cards struck through', () => {
    expect(formatBoard(grid)).toContain('~~200~~');
    expect(formatBoard(grid).split('\n')).toHaveLength(4);
  });
});

describe('parsePick – speech mix-ups', () => {
  it('matches categories that sound alike (Kölner Phonetik)', async () => {
    const { colognePhonetic } = await import('../src/judge/normalize.ts');
    expect(colognePhonetic('Flaggen')).toBe(colognePhonetic('Flecken'));
    expect(colognePhonetic('Meyer')).toBe(colognePhonetic('Maier'));
    const grid = ['Flaggen', 'Sport', 'Geschichte'].flatMap((category, col) => [100, 200].map((points, row) => ({ col, row, category, points, answered: false })));
    const r = parsePick('Flecken für 200', grid);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.cell.category).toBe('Flaggen');
  });
});
