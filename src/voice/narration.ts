import type { HostEvents } from '../core/events.ts';
import type { BoardCell, PlayerState } from '../core/types.ts';

/**
 * What the host *says* (as opposed to what it posts in chat). Pure functions,
 * short sentences, no markdown – everything here goes straight into TTS.
 */

const LETTERS = 'ABCDEFGH';

/** The TTS voice says "Buzzer" the German way ("Butzer") – so the spoken call avoids the word. */
export const BUZZER_OPEN_LINE = 'Jetzt die anderen! Wer es weiß, ruft: Hier!';

/** Said once at the start – spoken answers need the keyword and are confirmed. */
export const ANSWER_HOW_LINE = 'Antwortet immer mit: Meine Antwort ist, und dann eure Antwort. Ich wiederhole sie kurz, ihr bestätigt mit Ja.';

export function categoriesLine(categories: string[]): string {
  if (!categories.length) return '';
  return `Die Kategorien sind: ${joinList(categories)}.`;
}

export function turnLine(t: HostEvents['host:turn'], first: boolean): string {
  const lead = first ? `${categoriesLine(t.categories)} ` : '';
  const left = t.open.length;
  const fewLeft = left > 0 && left <= 3 ? ` Noch frei: ${freeList(t.open)}.` : '';
  return `${lead}${t.player}, du bist dran. Welche Karte?${fewLeft}`;
}

export function reminderLine(player: string, example?: BoardCell): string {
  return `${player}, du bist noch dran. Sag zum Beispiel: ${example ? `${example.category} für ${example.points}` : 'Kategorie und Punkte'}.`;
}

export function freeCardsLine(open: BoardCell[], grid: BoardCell[] = []): string {
  if (!open.length) return 'Auf diesem Board ist nichts mehr frei.';
  return `Noch frei: ${freeList(open, grid.map((c) => c.points))}.`;
}

function freeList(open: BoardCell[], all: number[] = []): string {
  const steps = [...new Set([...all, ...open.map((c) => c.points)])].sort((a, b) => a - b);
  const byCat = new Map<string, number[]>();
  for (const c of open) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c.points]);
  return [...byCat].map(([cat, pts]) => `${cat} ${pointRuns(pts.sort((a, b) => a - b), steps)}`).join('; ');
}

/** [100,200,300,500] → "100 bis 300 und 500" – runs of ≥3 neighbouring board values are spoken as a range. */
function pointRuns(pts: number[], steps: number[]): string {
  const idx = (p: number) => steps.indexOf(p);
  const runs: number[][] = [];
  for (const p of pts) {
    const last = runs.at(-1);
    if (last && idx(p) === idx(last.at(-1)!) + 1) last.push(p);
    else runs.push([p]);
  }
  const parts = runs.flatMap((r) => (r.length >= 3 ? [`${r[0]} bis ${r.at(-1)}`] : r.map(String)));
  return joinList(parts);
}

export function questionLine(q: HostEvents['host:question']): string {
  const head = q.category ? `${q.category} für ${q.points}.` : `Für ${q.points} Punkte.`;
  const media = q.hasAudio ? ' Hört gut zu, die Musik läuft auf quiz-base.' : q.hasImage ? ' Schaut dazu aufs Bild.' : '';
  const text = q.text?.trim() ? ` ${q.text.trim()}` : '';
  const options = q.options.length ? ` Die Möglichkeiten: ${q.options.map((o, i) => `${LETTERS[i] ?? i + 1}: ${o}`).join('. ')}.` : '';
  return `${head}${text}${options}${media}`;
}

export function askLine(a: HostEvents['host:await-answer']): string {
  return a.viaBuzzer ? `${a.player}, bitte!` : `${a.player}, deine Antwort?`;
}

export function verdictLine(v: HostEvents['host:verdict'], echo: boolean): string {
  const pts = v.delta ? ` ${v.delta > 0 ? 'Plus' : 'Minus'} ${Math.abs(v.delta)}.` : '';
  if (v.answer === '(keine Antwort)') return `Die Zeit ist um, ${v.player}.${pts}`;
  if (v.answer.startsWith('(')) return `${v.correct ? 'Gewertet als richtig' : 'Gewertet als falsch'}.${pts}`;
  const heard = echo ? `${quote(v.answer)}. ` : '';
  return v.correct ? `${heard}Richtig!${pts}` : `${heard}Leider falsch.${pts}`;
}

export function revealLine(answer: string | null): string {
  if (!answer) return '';
  // Notes often carry extras – "42,195 km (26,22 Meilen)", "Vereinigte Staaten / USA".
  const spoken = answer.replace(/\([^)]*\)/g, ' ').replace(/\s+\/\s+/g, ' oder ').replace(/\s+/g, ' ').trim();
  return `Die richtige Antwort war: ${spoken || answer}.`;
}

/** "Richtig: voller Wert. Falsch: minus die Hälfte. Buzzer: …" – said once at the start. */
export function rulesLine(r: { correctFactor: number; wrongFactor: number; buzzerOnWrong: boolean; buzzerCorrectFactor: number; buzzerWrongFactor: number }): string {
  const share = (f: number) => (f === 1 ? 'den vollen Wert' : f === 0.5 ? 'die Hälfte' : f === 0 ? 'nichts' : `${Math.round(f * 100)} Prozent`);
  const wrong = r.wrongFactor === 0 ? 'Falsch kostet nichts.' : `Falsch kostet ${share(r.wrongFactor)}.`;
  const buzz = r.buzzerOnWrong
    ? ` Nach einer falschen Antwort dürfen die anderen ran: einfach Hier rufen${r.buzzerWrongFactor === 0 ? ', ein Fehler kostet dann nichts' : ''}.`
    : '';
  return `Die Regeln: Richtig gibt ${share(r.correctFactor)}. ${wrong}${buzz}`;
}

export function scoresLine(players: PlayerState[]): string {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (!sorted.length) return '';
  return `Zwischenstand: ${sorted.map((p) => `${p.name} ${p.score}`).join(', ')}.`;
}

export function gameOverLine(players: PlayerState[]): string {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const [first, second] = sorted;
  if (!first) return 'Das Spiel ist vorbei.';
  if (second && second.score === first.score) return `Das Spiel ist vorbei! Unentschieden zwischen ${sorted.filter((p) => p.score === first.score).map((p) => p.name).join(' und ')} mit ${first.score} Punkten.`;
  const rest = sorted.slice(1).map((p) => `${p.name} ${p.score}`).join(', ');
  const lead = first.score > 0 ? `Gewonnen hat ${first.name} mit ${first.score} Punkten.` : `Vorne liegt ${first.name} mit ${first.score === 0 ? 'null' : first.score} Punkten.`;
  return `Das Spiel ist vorbei! ${lead}${rest ? ` Dahinter: ${rest}.` : ''} Danke fürs Mitspielen!`;
}

export const VOICE_HELP =
  'Sag einfach die Karte, zum Beispiel: Sport für 200. Antworten immer mit: Meine Antwort ist, und dann die Antwort. Ich frage einmal nach, bestätige mit Ja. Wenn die anderen dürfen, ruf Hier. ' +
  'Mit Quizmaster davor gehen auch Befehle: Quizmaster Stand, Quizmaster was ist frei, Quizmaster wiederholen, ' +
  'Quizmaster neues Quiz und der Name, Quizmaster ich bin und dein Name.';

function quote(s: string): string {
  return `„${s.replace(/[„“"]/g, '')}“`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items.at(-1)}`;
}
