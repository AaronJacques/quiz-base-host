import type { GeneratedBoard } from '../../boardgen/schema.ts';
import { createLogger, sleep } from '../../core/logger.ts';
import type { ActionResult } from '../tafelquiz/page.ts';
import type { BoardEditorPort, EditorQuestion, EditorState } from './page.ts';

const log = createLogger('editor');

export interface WriteOptions {
  /** Pause after each click/input so React can re-render (0 in tests). */
  pauseMs?: number;
  /** Poll interval while waiting for a step. */
  pollMs?: number;
  onProgress?: (text: string) => void;
}

export interface WriteResult {
  url: string | null;
}

export class EditorError extends Error {}

/**
 * Types a generated board into quiz-base's Tafelquiz editor and saves it as own board.
 * Talks only to the BoardEditorPort, reads every step back and repeats what did not stick.
 * Never clicks "Lobby erstellen" – a game is started separately with `!quiz neu`.
 */
export async function writeBoard(port: BoardEditorPort, board: GeneratedBoard, opts: WriteOptions = {}): Promise<WriteResult> {
  const pause = opts.pauseMs ?? 150;
  const poll = opts.pollMs ?? 250;
  const step = async (r: Promise<ActionResult>, what: string) => {
    const res = await r;
    if (!res.ok) throw new EditorError(`${what}: ${res.error ?? 'fehlgeschlagen'}`);
    if (pause) await sleep(pause);
  };
  const waitFor = async (pred: (s: EditorState) => boolean, what: string, timeoutMs = 15000): Promise<EditorState> => {
    const end = Date.now() + timeoutMs;
    let s = await port.state();
    while (!pred(s)) {
      if (Date.now() > end) throw new EditorError(`${what} (Schritt ${s.step ?? '?'}${s.dialog ? `, Dialog: ${s.dialog}` : ''})`);
      await sleep(poll);
      s = await port.state();
    }
    return s;
  };

  const spec = board.spec;
  const cats = board.categories;

  // Step 1: empty editor, logged in.
  opts.onProgress?.('🌐 Öffne den Board-Editor auf quiz-base …');
  await port.start();
  await waitFor((s) => s.templates.includes('Benutzerdefiniert'), 'Board-Editor lädt nicht');
  const loggedIn = await port.loginState();
  if (loggedIn === false) throw new EditorError('Nicht bei quiz-base angemeldet. Einmal "npx qbhost login" auf dem Bot-Rechner ausführen.');
  await step(port.chooseTemplate('Benutzerdefiniert'), 'Template wählen');

  // Step 2: number of boards.
  await waitFor((s) => s.step === 2, 'Schritt 2 (Board-Anzahl) erscheint nicht');
  await step(port.clickButton(spec.boards === 2 ? '2 Boards' : '1 Board'), 'Board-Anzahl');
  await step(port.clickButton('Weiter →'), 'Weiter zu Schritt 3');

  // Step 3: categories (names, number of questions, board assignment, super categories).
  await waitFor((s) => s.step === 3, 'Schritt 3 (Kategorien) erscheint nicht');
  opts.onProgress?.(`🗂️ Lege ${cats.length} Kategorien an …`);
  for (let round = 0; ; round++) {
    let s = await port.state();
    for (let guard = 0; s.categories.length < cats.length && guard < 20; guard++) {
      await step(port.clickButton('+ Kategorie hinzufügen'), 'Kategorie hinzufügen');
      s = await port.state();
    }
    for (let guard = 0; s.categories.length > cats.length && guard < 20; guard++) {
      await step(port.deleteCategory(s.categories.length - 1), 'Kategorie löschen');
      s = await port.state();
    }
    for (const [i, c] of cats.entries()) {
      const have = s.categories[i];
      if (!have) continue;
      if (have.name !== c.name) await step(port.setCategoryName(i, c.name), `Kategoriename ${i + 1}`);
      for (let n = have.count ?? 0, guard = 0; n !== spec.rows && guard < 12; guard++) {
        await step(port.changeCount(i, n < spec.rows ? 1 : -1), `Fragenanzahl Kategorie ${i + 1}`);
        n = (await port.state()).categories[i]?.count ?? n;
      }
      if (spec.boards === 2 && have.board !== c.board) await step(port.toggleCategoryBoard(i), `Board-Zuordnung Kategorie ${i + 1}`);
    }
    for (const [i, name] of board.supercategories.entries()) {
      if (s.supers[i] !== undefined && s.supers[i] !== name) await step(port.setSuper(i, name), `Oberkategorie ${i + 1}`);
    }
    s = await port.state();
    const wrong = categoryMismatches(s, board);
    if (!wrong.length) break;
    if (round >= 2) throw new EditorError(`Kategorien stimmen nicht: ${wrong.join('; ')}`);
    log.debug(`Kategorien nachbessern: ${wrong.join('; ')}`);
  }
  await step(port.clickButton('Weiter →'), 'Weiter zu Schritt 4');
  await waitFor((s) => s.step === 4, 'Schritt 4 (Fragen) erscheint nicht');

  // Step 4: questions, category by category.
  for (const [ci, c] of cats.entries()) {
    opts.onProgress?.(`✏️ Kategorie ${ci + 1}/${cats.length}: ${c.name}`);
    await step(port.selectCategory(ci + 1), `Kategorie ${ci + 1} wählen`);
    await waitFor((s) => s.title === `Fragen für: ${c.name}` && s.questions.length === c.questions.length, `Fragen von „${c.name}“ erscheinen nicht`);
    for (const [qi, q] of c.questions.entries()) {
      // Fill and verify each question while it is expanded (collapsed rows hide the answer part).
      for (let attempt = 0; ; attempt++) {
        let have = (await port.state()).questions[qi];
        if (!have) throw new EditorError(`Frage ${qi + 1} in „${c.name}“ fehlt`);
        if (!have.expanded) {
          await step(port.expandQuestion(qi), `Frage ${qi + 1} aufklappen`);
          have = (await port.state()).questions[qi]!;
        }
        if (questionOk(have, q)) break;
        if (attempt >= 3) throw new EditorError(`Frage ${qi + 1} in „${c.name}“ lässt sich nicht eintragen`);
        if (attempt) log.debug(`„${c.name}“ Frage ${qi + 1}: nachbessern`);
        if (have.text !== q.question) await step(port.setQuestionText(qi, q.question), `Fragetext ${qi + 1}`);
        if (have.mc !== !!q.options) await step(port.setMc(qi, !!q.options), `Antwortmöglichkeiten ${qi + 1}`);
        if (q.options) {
          const now = (await port.state()).questions[qi]!;
          for (const [k, o] of q.options.entries()) if (now.options[k] !== o) await step(port.setOption(qi, k, o), `Antwort ${k + 1} von Frage ${qi + 1}`);
          if (now.correct !== q.correct) await step(port.setCorrect(qi, q.correct!), `Richtige Antwort ${qi + 1}`);
        } else if (have.note !== q.note) {
          await step(port.setNote(qi, q.note ?? ''), `Notiz ${qi + 1}`);
        }
        for (let p = have.points ?? q.points, guard = 0; p !== q.points && guard < 40; guard++) {
          await step(port.changePoints(qi, p < q.points ? 1 : -1), `Punkte ${qi + 1}`);
          p = (await port.state()).questions[qi]?.points ?? p;
        }
      }
    }
    // Text and points are visible on every row – a last cheap check for the whole category.
    const s = await port.state();
    const lost = c.questions.map((q, qi) => (s.questions[qi]?.text === q.question && s.questions[qi]?.points === q.points ? null : qi + 1)).filter((x) => x !== null);
    if (lost.length) throw new EditorError(`Fragen ${lost.join(', ')} in „${c.name}“ sind wieder verschwunden`);
  }

  // Save as own board.
  opts.onProgress?.('💾 Speichere das Board …');
  const saved = await port.save({ title: board.title, description: board.description });
  if (!saved.ok) throw new EditorError(`Speichern: ${saved.error ?? 'fehlgeschlagen'}`);
  return { url: saved.url ?? null };
}

function categoryMismatches(s: EditorState, board: GeneratedBoard): string[] {
  const out: string[] = [];
  if (s.categories.length !== board.categories.length) out.push(`${s.categories.length} statt ${board.categories.length} Kategorien`);
  board.categories.forEach((c, i) => {
    const have = s.categories[i];
    if (!have) return;
    if (have.name !== c.name) out.push(`Name ${i + 1}`);
    if (have.count !== board.spec.rows) out.push(`Anzahl ${i + 1}: ${have.count}`);
    if (board.spec.boards === 2 && have.board !== c.board) out.push(`Board ${i + 1}`);
  });
  board.supercategories.forEach((name, i) => {
    if (s.supers[i] !== undefined && s.supers[i] !== name) out.push(`Oberkategorie ${i + 1}`);
  });
  return out;
}

function questionOk(have: EditorQuestion, q: GeneratedBoard['categories'][number]['questions'][number]): boolean {
  if (have.text !== q.question || have.points !== q.points) return false;
  // Collapsed rows do not show the answer part – only an expanded, checked row counts as done.
  if (have.mc === null) return false;
  if (q.options) return have.mc === true && have.correct === q.correct && q.options.every((o, k) => have.options[k] === o);
  return have.mc === false && have.note === q.note;
}
