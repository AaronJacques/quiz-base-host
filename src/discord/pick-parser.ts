import type { BoardCell } from '../core/types.ts';
import { normalize, similarity } from '../judge/normalize.ts';

export type PickResult =
  /** Message doesn't look like a pick at all (chatter) – ignore silently. */
  | { kind: 'none' }
  | { kind: 'ok'; cell: BoardCell }
  /** The card exists but was already played. */
  | { kind: 'taken'; cell: BoardCell }
  /** Several cards fit – e.g. only "200" without category. */
  | { kind: 'ambiguous'; options: BoardCell[]; hint: string }
  /** Looked like a pick, but nothing on the board matches. */
  | { kind: 'invalid'; hint: string };

const FILLER = new Set(['ich', 'nehme', 'nehm', 'nimm', 'bitte', 'fuer', 'mit', 'die', 'der', 'das', 'den', 'punkte', 'pkt', 'kategorie', 'spalte', 'frage', 'mal', 'gerne', 'gern', 'dann', 'auf', 'in', 'and', 'for', 'take']);

/**
 * Understands free-text card choices from chat and validates them against the
 * board: "Nintendo 200", "nin 200", "2 200" (2nd column), "Serien/Filme für 300",
 * "ich nehme Filme 300". Pure function – no Discord or browser involved.
 */
export function parsePick(text: string, grid: BoardCell[]): PickResult {
  const norm = normalize(text);
  if (!norm) return { kind: 'none' };
  const categories = [...new Map(grid.map((c) => [c.col, c.category])).entries()].sort((a, b) => a[0] - b[0]);
  const pointValues = new Set(grid.map((c) => c.points));

  const nums = [...norm.matchAll(/\b\d+\b/g)].map((m) => parseInt(m[0], 10));
  const points = nums.filter((n) => pointValues.has(n));
  const colNumbers = nums.filter((n) => !pointValues.has(n) && n >= 1 && n <= categories.length);

  // Category by name.
  const words = norm.split(' ').filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !FILLER.has(w));
  let best = 0;
  let bestCols: number[] = [];
  for (const [col, name] of categories) {
    const score = categoryScore(norm, words, name);
    if (score > best) {
      best = score;
      bestCols = [col];
    } else if (score === best && score > 0) bestCols.push(col);
  }
  let cols = best >= 0.7 ? bestCols : [];
  if (!cols.length && colNumbers.length === 1) cols = [colNumbers[0]! - 1];

  if (!points.length && !cols.length) {
    // A number that is no point value on this board in an otherwise empty message is still a pick attempt.
    if (nums.length && words.length === 0) return { kind: 'invalid', hint: `Punktwerte auf diesem Board: ${[...pointValues].sort((a, b) => a - b).join(', ')}.` };
    return { kind: 'none' };
  }

  if (cols.length > 1) {
    const names = cols.map((c) => categories.find(([col]) => col === c)?.[1]).join(' oder ');
    return { kind: 'ambiguous', options: grid.filter((c) => cols.includes(c.col)), hint: `Meinst du ${names}?` };
  }

  if (!points.length) {
    const col = cols[0]!;
    const open = grid.filter((c) => c.col === col && !c.answered);
    const name = categories.find(([c]) => c === col)?.[1] ?? '?';
    const wrongValue = nums.find((n) => !colNumbers.includes(n) || best >= 0.7);
    if (wrongValue !== undefined)
      return { kind: 'invalid', hint: `In **${name}** gibt es keine ${wrongValue}. ${open.length ? `Frei: ${open.map((c) => c.points).join(', ')}.` : 'Dort ist nichts mehr frei.'}` };
    if (!open.length) return { kind: 'invalid', hint: `In **${name}** ist nichts mehr frei.` };
    if (open.length === 1) return { kind: 'ok', cell: open[0]! };
    return { kind: 'ambiguous', options: open, hint: `Wie viele Punkte in **${name}**? Frei: ${open.map((c) => c.points).join(', ')}.` };
  }

  const pts = points[points.length - 1]!;
  if (!cols.length) {
    const matching = grid.filter((c) => c.points === pts);
    const open = matching.filter((c) => !c.answered);
    if (open.length === 1) return { kind: 'ok', cell: open[0]! };
    if (!open.length) return { kind: 'taken', cell: matching[0]! };
    return { kind: 'ambiguous', options: open, hint: `${pts} gibt es noch in: ${open.map((c) => c.category).join(', ')}. Welche Kategorie?` };
  }

  const col = cols[0]!;
  const inCol = grid.filter((c) => c.col === col && c.points === pts);
  const name = categories.find(([c]) => c === col)?.[1] ?? '?';
  if (!inCol.length) {
    const avail = grid.filter((c) => c.col === col && !c.answered).map((c) => c.points);
    return { kind: 'invalid', hint: `In **${name}** gibt es keine ${pts}. ${avail.length ? `Frei: ${avail.join(', ')}.` : 'Dort ist nichts mehr frei.'}` };
  }
  const open = inCol.find((c) => !c.answered);
  return open ? { kind: 'ok', cell: open } : { kind: 'taken', cell: inCol[0]! };
}

function categoryScore(normText: string, words: string[], category: string): number {
  const cat = normalize(category);
  if (!cat) return 0;
  if (` ${normText} `.includes(` ${cat} `)) return 1;
  const catWords = cat.split(' ').filter((w) => w.length >= 2);
  let best = 0;
  for (const w of words) {
    for (const cw of catWords) {
      if (w === cw) best = Math.max(best, 0.95);
      else if (w.length >= 3 && cw.startsWith(w)) best = Math.max(best, 0.85);
      else if (w.length >= 4 && similarity(w, cw) >= 0.72) best = Math.max(best, 0.75);
    }
  }
  return best;
}

/** Discord-friendly board overview: one line per category, played cards struck through. */
export function formatBoard(grid: BoardCell[]): string {
  const cols = [...new Set(grid.map((c) => c.col))].sort((a, b) => a - b);
  return cols
    .map((col) => {
      const cells = grid.filter((c) => c.col === col).sort((a, b) => a.row - b.row);
      const values = cells.map((c) => (c.answered ? `~~${c.points}~~` : `**${c.points}**`)).join(' · ');
      return `\`${col + 1}\` **${cells[0]?.category ?? '?'}** — ${values}`;
    })
    .join('\n');
}
