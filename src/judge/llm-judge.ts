import { z } from 'zod';
import type { ImageInput, LlmClient, UsageMeter } from '../llm/client.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';
import { DATE_WORDS, numberParts, numberReference, stripDialogueDash } from './normalize.ts';

const VerdictSchema = z.object({
  correct: z.boolean(),
  reason: z.string().describe('max. 12 Wörter, deutsch'),
});

const SolveSchema = z.object({
  answer: z.string().describe('nur die Lösung selbst, max. 8 Wörter, keine Erklärung'),
  confidence: z.number().min(0).max(1),
});

/** Bump when JUDGE_SYSTEM changes meaningfully – invalidates cached verdicts. */
export const JUDGE_RULES_VERSION = 6;

// Kept short and stable on purpose: it is the bulk of every judging request.
const JUDGE_SYSTEM = `Du bist ein fairer, lockerer Quizmaster bei einem Spieleabend unter Freunden.
Entscheide, ob die Spielerantwort als richtig gilt.
Regeln:
- Tippfehler, Umgangssprache, andere Sprache, Synonyme und Groß/Kleinschreibung sind egal.
- Der Kern zählt: Bei Personen reicht meist der bekannte Name (Nachname oder Rufname), außer die Frage verlangt ausdrücklich den vollen Namen.
- Zusätzliche Wörter sind ok, solange sie nichts Falsches behaupten.
- Fragt die Frage nach X "und/oder" Y, reicht eines davon.
- Zahlen und Jahre müssen im Wert exakt stimmen (Einheiten egal); ausgeschriebene Zahlen zählen wie Ziffern ("neunzehnhundertneunundsiebzig" = 1979, also falsch, wenn 1977 gesucht ist). Toleranz nur bei Schätzfragen ("ca.") oder üblichen Rundungen bekannter Werte (z.B. "42 km" für 42,195 km beim Marathon), wenn die Frage nicht ausdrücklich exakt fragt.
- Mehr Genauigkeit als gefragt ist nie nötig: Fragt die Frage nach einem Zeitpunkt oder Jahr ("Wann …?", "In welchem Jahr …?"), genügt das richtige Jahr, auch wenn die Lösung Tag und Monat nennt ("1939" für "1. September 1939"). Tag oder Monat sind nur nötig, wenn die Frage ausdrücklich nach dem Tag oder dem genauen Datum fragt.
- Mehrere widersprüchliche Antworten auf einmal ("A oder B") sind falsch.
- Die Lösung des Hosts kann zusätzliche Erklärungen oder Links enthalten – bewerte nur gegen den Kern.
- Formeln: Es zählt der mathematische Inhalt, nicht die Schreibweise (x^2 = x² = x2, 1/2 = 0,5, pi = π, * = · = ×, sqrt(2) = √2). Eine andere Formel oder ein anderer Wert ist falsch.
- Multiple Choice: Der Buchstabe der richtigen Option zählt wie ihr Text.
Antworte nur im geforderten JSON.`;

const SOLVE_SYSTEM = `Du hilfst einem Quiz-Host, die Lösung einer Quizfrage zu bestimmen, für die keine Lösung hinterlegt ist.
Du bekommst einen Screenshot der Host-Ansicht (Frage + Bild in der Mitte; Spielerliste und Bedienelemente ignorieren).
Schau dir das Bild genau an und gib die wahrscheinlichste Lösung an: nur den Begriff/Namen, ohne Erklärung.
Ist die Frage ohne weitere Infos nicht eindeutig lösbar, setze confidence unter 0.5.`;

/** At most this many values per side in the number hint. */
const HINT_VALUES = 4;
/** A solution with more words is prose: only its digits are values ("Erster Weltkrieg" keeps its 1, a sentence does not). */
const HINT_PROSE_WORDS = 6;

/**
 * "Zahlenwerte (automatisch gelesen): Antwort 1979 | Lösung 1977" – the parsed values, so the LLM need not split
 * "neunzehnhundertneunundsiebzig" itself. Only for the LLM (never public). null when neither side has a number.
 */
export function numberHint(answer: string, reference: string | null, spoken = false): string | null {
  // Lone articles ("Eine neue Hoffnung") and digits inside words ("H2O") are no values worth naming.
  const values = (s: string | null, prose = false) => {
    const seen = new Set<string>();
    const out: string[] = [];
    const { words, numbers: found } = s ? numberParts(s) : { words: [], numbers: [] };
    for (const t of found) {
      if (t.article || t.partial) continue;
      // Number words in longer prose ("Der erste Film kam 1977 …", "der Zweite Weltkrieg") are no solution values.
      if (prose && t.words) continue;
      // The day of a date ("1. September 1939") is no value the answer has to name – only the year.
      if (t.ordinal && t.value <= 31 && DATE_WORDS.has(words[t.to + 1]?.replace(/\.+$/, '') ?? '')) continue;
      // "12.000", "1.500", "12 000": thousands or not – every reading, never just one of them.
      const shown = t.readings?.length ? t.readings.map((r) => r.map(plainNumber).join(' und ')).join(' oder ') : plainNumber(t.value);
      if (!seen.has(shown) && out.length < HINT_VALUES) out.push(shown);
      seen.add(shown);
    }
    return out;
  };
  // "- 5" spoken: a dialogue dash – or a minus, if the solution is negative: then both readings.
  const plain = values(answer);
  const undashed = spoken ? values(stripDialogueDash(answer)) : plain;
  const negative = !!reference && numberParts(reference).numbers.some((t) => t.value < 0);
  const a = undashed.join() === plain.join() || !negative ? undashed : [`${undashed.join(', ') || '–'} oder ${plain.join(', ')}`];
  // The numbers that count: a short solution that is a number or date ("1939 - Der Krieg …" → 1939, not "der Zweite
  // Weltkrieg"), else the whole note. Without a number in it there is no line – never "Lösung –" (B-F16).
  const counted = reference ? numberReference(reference) : null;
  const r = values(counted, !!counted && numberParts(counted).words.filter(Boolean).length > HINT_PROSE_WORDS);
  if (!r.length) return null;
  const show = (v: string[]) => (v.length ? v.join(', ') : '–');
  return `Zahlenwerte (automatisch gelesen): Antwort ${show(a)} | Lösung ${show(r)}`;
}

/** German, without thousands separator ("1977", "1500000", "1,5") – a grouped "12.000" would be unclear itself. */
const plainNumber = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 6, useGrouping: false });

export class LlmJudge implements AnswerJudge {
  constructor(
    private llm: LlmClient,
    private meter: UsageMeter,
  ) {}

  async judge({ question, reference, answer, hints, spoken, options, prefetch }: JudgeInput): Promise<JudgeResult> {
    const lines = [`Frage: ${question}`, `Lösung laut Host: ${reference ?? '(keine hinterlegt – nutze dein Wissen)'}`];
    if (options?.length) lines.push(`Antwortmöglichkeiten: ${options.map((o) => `${o.letter}) ${o.label}${o.correct ? ' (richtig)' : ''}`).join(' | ')}`);
    if (hints?.length) lines.push(`Hinweise: ${hints.join(' | ')}`);
    if (spoken) lines.push('Die Antwort wurde GESPROCHEN und automatisch transkribiert: Werte nach dem Klang, nicht nach der Schreibweise. Klingt sie eindeutig wie die Lösung (z.B. „Preaking Bat“ für „Breaking Bad“, „Tschingis Kan“ für „Dschingis Khan“), ist sie richtig. Das gilt nicht für Zahlen: Bei Zahlen und Jahren zählt nur der Wert, ähnlicher Klang („neunundsiebzig“/„siebenundsiebzig“) reicht nicht.');
    const values = numberHint(answer, reference, spoken);
    if (values) lines.push(values);
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
