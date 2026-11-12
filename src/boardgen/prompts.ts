import type { BoardOut } from './schema.ts';
import { LEVELS, mcSlots, pointsList, questionId, totalCategories, totalQuestions, type BoardSpec } from './spec.ts';

const LANGUAGES: Record<string, string> = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch' };

export const languageName = (code: string) => LANGUAGES[code] ?? code;

// Stable on purpose (no dates, no request data): it is the bulk of every generation request.
const QUESTION_RULES = `Regeln für jede Frage:
- Genau eine richtige Antwort, die man eindeutig bewerten kann. Keine Meinungs-, Schätz- oder Listenfragen („Nenne drei …“), keine Fangfragen, keine Fragen mit mehreren gleich guten Antworten.
- Nur gesicherte Fakten, die sich nicht bald ändern: keine „aktuellen“ Rekorde, Amtsinhaber, Ranglisten, Preise oder Mitgliederzahlen. Bist du dir nicht sicher, nimm eine andere Frage.
- Die Frage steht für sich (höchstens 200 Zeichen), ist ohne Bild lösbar und verrät die Lösung nicht, auch nicht teilweise.
- answer: die kürzeste übliche Form der Lösung, 1–4 Wörter, höchstens 40 Zeichen. Keine Erklärung, keine Klammern, kein „/“ und kein „oder“. Zahlen als Ziffern. Personen mit dem bekannten Namen (z.B. „Albert Einstein“).
- variants: weitere Antworten, die als richtig gelten sollen: andere Schreibweisen, Synonyme, Abkürzungen, deutscher und englischer Name, mit oder ohne Vorname, Zahl als Wort. Nie eine falsche oder nur halb richtige Antwort. Leere Liste, wenn es keine gibt.
- difficulty: 1 (sehr leicht) bis 5 (sehr schwer), gemessen an der Zielgruppe. In jeder Kategorie steigt die Schwierigkeit mit den Punkten: Die erste Frage ist die leichteste, die letzte die schwerste.
- wrongOptions: nur bei den ausdrücklich genannten Multiple-Choice-Fragen genau 3 falsche, aber plausible Optionen von derselben Art wie die Lösung. Bei allen anderen Fragen eine leere Liste.`;

export const GENERATE_SYSTEM = `Du bist eine erfahrene Quizautorin für Tafelquiz-Runden (wie Jeopardy: Kategorien mit Punktestufen). Ein Host liest die Fragen vor, die Mitspieler antworten frei. Eine Bewertungs-Engine vergleicht die Antworten mit deiner Lösung und den Varianten, deshalb müssen Lösungen kurz und eindeutig sein.

${QUESTION_RULES}

Regeln für das Board:
- Kategorienamen kurz (höchstens 20 Zeichen), verschieden, passend zum Thema, gern mit Witz.
- Keine Lösung kommt zweimal vor, keine Frage verrät eine andere, keine zwei Fragen fragen dasselbe.
- Vielfalt: verschiedene Seiten des Themas und verschiedene Fragetypen (wer, was, wo, wann, wie viele).
- title: kurzer Board-Name (höchstens 50 Zeichen). description: ein Satz (höchstens 150 Zeichen) ohne Lösungen.
- supercategories: eine kurze Oberkategorie pro Board.
Antworte nur im geforderten JSON.`;

export const REVIEW_SYSTEM = `Du bist ein strenger Faktenprüfer und Lektor für Quizfragen. Du prüfst ein fertiges Tafelquiz-Board, bevor es gespielt wird.
Prüfe jede Frage auf diese Probleme:
1. falsch: Die Lösung ist sachlich falsch oder nicht sicher belegt.
2. mehrdeutig: Mehrere Antworten wären vertretbar, oder die Frage ist unklar.
3. veraltet: Die Antwort kann sich bald ändern oder hat sich schon geändert.
4. verraten: Die Frage enthält die Lösung oder macht sie trivial.
5. Lösung zu lang oder nicht kurz bewertbar.
6. Varianten fehlen (z.B. eine gängige Schreibweise) oder eine Variante ist falsch.
7. Die Schwierigkeit passt nicht zur Punktzahl oder Zielgruppe (höhere Punkte = schwerer).
8. Dublette oder starke Überschneidung mit einer anderen Frage.
9. Multiple Choice: Eine falsche Option ist auch richtig, oder die Lösung ist offensichtlich.
Melde nur echte Probleme, keine Geschmacksfragen. Für jede gemeldete Frage lieferst du in replacements einen Ersatz mit derselben id: dieselbe Frage korrigiert (z.B. mit vollständigen Varianten) oder eine neue Frage zur selben Kategorie und Stufe, deren Lösung im Board noch nicht vorkommt. Ist eine Frage eine Multiple-Choice-Frage, bleibt sie es (3 wrongOptions), sonst ist wrongOptions leer.

Für Ersatzfragen gelten dieselben Regeln wie für die Autorin:
${QUESTION_RULES}
Antworte nur im geforderten JSON.`;

export const FIX_SYSTEM = `Du ersetzt einzelne fehlerhafte Fragen eines Tafelquiz-Boards. Jede Ersatzfrage gehört zur selben Kategorie und Punktestufe, behält die id und wiederholt keine Lösung, die im Board schon vorkommt.

${QUESTION_RULES}
Antworte nur im geforderten JSON.`;

function audienceLines(spec: BoardSpec): string[] {
  return [`Thema: ${spec.topic}`, `Zielgruppe: ${LEVELS[spec.level].prompt}`, `Sprache der Kategorien, Fragen und Lösungen: ${languageName(spec.language)}`];
}

export function generatePrompt(spec: BoardSpec, feedback: string[] = []): string {
  const cats = totalCategories(spec);
  const points = pointsList(spec).join(', ');
  const lines = audienceLines(spec);
  if (spec.themes.length) lines.push(`Themenbereiche (je einer pro Kategorie, in dieser Reihenfolge; übrige Kategorien frei wählen): ${spec.themes.join(', ')}`);
  lines.push(`Aufbau: genau ${cats} Kategorien mit je genau ${spec.rows} Fragen für ${points} Punkte (von leicht nach schwer), insgesamt ${totalQuestions(spec)} Fragen.`);
  if (spec.boards === 2) lines.push(`Es gibt 2 Boards: Kategorie 1–${spec.categories} gehören zu Board 1, Kategorie ${spec.categories + 1}–${cats} zu Board 2. supercategories hat 2 Einträge.`);
  else lines.push('Es gibt 1 Board. supercategories hat 1 Eintrag.');
  const slots = [...mcSlots(spec)];
  lines.push(slots.length ? `Multiple Choice (wrongOptions mit genau 3 Einträgen) genau bei diesen Fragen (k = Kategorie, f = Frage, 1-basiert): ${slots.join(', ')}. Alle anderen Fragen: wrongOptions leer.` : 'Keine Multiple-Choice-Fragen: wrongOptions ist überall leer.');
  if (spec.name) lines.push(`title: genau „${spec.name}“.`);
  if (feedback.length) lines.push('', 'Deine letzte Antwort war ungültig. Behebe genau diese Punkte und liefere das ganze Board neu:', ...feedback);
  return lines.join('\n');
}

/** The board as compact JSON with ids, points and MC flags – input of the review and fix rounds. */
export function boardListing(out: BoardOut, spec: BoardSpec): string {
  const points = pointsList(spec);
  const slots = mcSlots(spec);
  const cats = out.categories.map((c, ci) => ({
    category: c.name,
    board: spec.boards === 2 ? (ci < spec.categories ? 1 : 2) : 1,
    questions: c.questions.map((q, ri) => {
      const id = questionId(ci, ri);
      return {
        id,
        points: points[ri],
        question: q.question,
        answer: q.answer,
        variants: q.variants,
        ...(slots.has(id) ? { wrongOptions: q.wrongOptions } : {}),
      };
    }),
  }));
  return JSON.stringify(cats, null, 1);
}

export function reviewPrompt(out: BoardOut, spec: BoardSpec, known: string[]): string {
  const lines = audienceLines(spec);
  lines.push('', 'Board:', boardListing(out, spec));
  if (known.length) lines.push('', 'Die automatische Prüfung hat schon diese Probleme gefunden; ersetze diese Fragen auf jeden Fall:', ...known);
  return lines.join('\n');
}

export function fixPrompt(out: BoardOut, spec: BoardSpec, problems: string[]): string {
  const lines = audienceLines(spec);
  lines.push('', 'Board:', boardListing(out, spec), '', 'Ersetze genau diese Fragen (id: Problem):', ...problems);
  return lines.join('\n');
}
