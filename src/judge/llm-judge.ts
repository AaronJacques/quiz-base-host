import { z } from 'zod';
import type { ImageInput, LlmClient, UsageMeter } from '../llm/client.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';

const VerdictSchema = z.object({
  correct: z.boolean(),
  reason: z.string().describe('max. 12 Wörter, deutsch'),
});

const SolveSchema = z.object({
  answer: z.string().describe('nur die Lösung selbst, max. 8 Wörter, keine Erklärung'),
  confidence: z.number().min(0).max(1),
});

/** Bump when JUDGE_SYSTEM changes meaningfully – invalidates cached verdicts. */
export const JUDGE_RULES_VERSION = 3;

// Kept short and stable on purpose: it is the bulk of every judging request.
const JUDGE_SYSTEM = `Du bist ein fairer, lockerer Quizmaster bei einem Spieleabend unter Freunden.
Entscheide, ob die Spielerantwort als richtig gilt.
Regeln:
- Tippfehler, Umgangssprache, andere Sprache, Synonyme und Groß/Kleinschreibung sind egal.
- Der Kern zählt: Bei Personen reicht meist der bekannte Name (Nachname oder Rufname), außer die Frage verlangt ausdrücklich den vollen Namen.
- Zusätzliche Wörter sind ok, solange sie nichts Falsches behaupten.
- Fragt die Frage nach X "und/oder" Y, reicht eines davon.
- Zahlen/Jahre müssen stimmen (Einheiten egal). Nur bei Schätzfragen ("ca.") ist etwas Toleranz ok. Übliche Rundungen bekannter Werte (z.B. "42 km" für 42,195 km beim Marathon) gelten, wenn die Frage nicht ausdrücklich exakt fragt.
- Mehrere widersprüchliche Antworten auf einmal ("A oder B") sind falsch.
- Die Lösung des Hosts kann zusätzliche Erklärungen oder Links enthalten – bewerte nur gegen den Kern.
- Formeln: Es zählt der mathematische Inhalt, nicht die Schreibweise (x^2 = x² = x2, 1/2 = 0,5, pi = π, * = · = ×, sqrt(2) = √2). Eine andere Formel oder ein anderer Wert ist falsch.
- Multiple Choice: Der Buchstabe der richtigen Option zählt wie ihr Text.
Antworte nur im geforderten JSON.`;

const SOLVE_SYSTEM = `Du hilfst einem Quiz-Host, die Lösung einer Quizfrage zu bestimmen, für die keine Lösung hinterlegt ist.
Du bekommst einen Screenshot der Host-Ansicht (Frage + Bild in der Mitte; Spielerliste und Bedienelemente ignorieren).
Schau dir das Bild genau an und gib die wahrscheinlichste Lösung an: nur den Begriff/Namen, ohne Erklärung.
Ist die Frage ohne weitere Infos nicht eindeutig lösbar, setze confidence unter 0.5.`;

export class LlmJudge implements AnswerJudge {
  constructor(
    private llm: LlmClient,
    private meter: UsageMeter,
  ) {}

  async judge({ question, reference, answer, hints, spoken, options, prefetch }: JudgeInput): Promise<JudgeResult> {
    const lines = [`Frage: ${question}`, `Lösung laut Host: ${reference ?? '(keine hinterlegt – nutze dein Wissen)'}`];
    if (options?.length) lines.push(`Antwortmöglichkeiten: ${options.map((o) => `${o.letter}) ${o.label}${o.correct ? ' (richtig)' : ''}`).join(' | ')}`);
    if (hints?.length) lines.push(`Hinweise: ${hints.join(' | ')}`);
    if (spoken) lines.push('Die Antwort wurde GESPROCHEN und automatisch transkribiert: Werte nach dem Klang, nicht nach der Schreibweise. Klingt sie eindeutig wie die Lösung (z.B. „Preaking Bat“ für „Breaking Bad“, „Tschingis Kan“ für „Dschingis Khan“), ist sie richtig.');
    lines.push(`Antwort des Spielers: ${answer}`);
    const res = await this.llm.completeJson({ system: JUDGE_SYSTEM, prompt: lines.join('\n'), schema: VerdictSchema, purpose: 'judge' });
    this.meter.record(prefetch ? 'prejudge' : 'judge', res.costUsd);
    return { verdict: res.data.correct ? 'correct' : 'wrong', method: 'llm', confidence: 0.9, reason: res.data.reason };
  }

  /** Derive a reference answer for questions without a host note (typically image questions). */
  async solve(question: string, images: ImageInput[], hints: string[] = []): Promise<{ answer: string; confidence: number }> {
    const prompt = [`Frage: ${question}`, ...(hints.length ? [`Hinweise: ${hints.join(' | ')}`] : [])].join('\n');
    const res = await this.llm.completeJson({ system: SOLVE_SYSTEM, prompt, schema: SolveSchema, images, purpose: 'solve' });
    this.meter.record('solve', res.costUsd);
    return res.data;
  }
}
