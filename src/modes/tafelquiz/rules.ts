import type { Config } from '../../config.ts';

export type GameRules = Config['game'];

/**
 * Score change for an answer. Pure function so house rules are trivial to
 * change and test. Defaults match quiz-base's classic rules:
 * correct = +value, wrong = −value/2 (also for buzzer answers).
 */
export function scoreFor(points: number, correct: boolean, viaBuzzer: boolean, rules: GameRules): number {
  const factor = correct
    ? viaBuzzer ? rules.buzzerCorrectFactor : rules.correctFactor
    : viaBuzzer ? rules.buzzerWrongFactor : rules.wrongFactor;
  const delta = Math.round(points * factor);
  return correct ? delta : -delta;
}

type RuleKind = 'factor' | 'bool' | 'seconds';

export interface RuleSpec {
  key: keyof GameRules;
  names: string[];
  kind: RuleKind;
  label: string;
  /** `seconds` only: 0 / "aus" switches it off. */
  off?: boolean;
}

/** Rules that players may change at runtime (e.g. via Discord). */
export const RULES: RuleSpec[] = [
  { key: 'correctFactor', names: ['richtig', 'plus'], kind: 'factor', label: 'Punkte für richtige Antwort' },
  { key: 'wrongFactor', names: ['falsch', 'minus'], kind: 'factor', label: 'Abzug für falsche Antwort' },
  { key: 'buzzerCorrectFactor', names: ['buzzerrichtig', 'buzzerplus'], kind: 'factor', label: 'Punkte für richtige Buzzer-Antwort' },
  { key: 'buzzerWrongFactor', names: ['buzzerfalsch', 'buzzerminus'], kind: 'factor', label: 'Abzug für falsche Buzzer-Antwort' },
  { key: 'buzzerOnWrong', names: ['buzzer'], kind: 'bool', label: 'Buzzer nach falscher Antwort freigeben' },
  { key: 'answerTimeoutSec', names: ['antwortzeit', 'zeit'], kind: 'seconds', label: 'Antwortzeit' },
  { key: 'buzzWindowSec', names: ['buzzerzeit'], kind: 'seconds', label: 'Zeit zum Buzzern' },
  { key: 'buzzAnswerTimeoutSec', names: ['buzzerantwortzeit'], kind: 'seconds', label: 'Antwortzeit nach Buzzer' },
  { key: 'pickReminderSec', names: ['erinnerung'], kind: 'seconds', off: true, label: 'Erste Erinnerung bei der Kartenwahl' },
  { key: 'pickReminderRepeatSec', names: ['erinnerungstakt', 'nacherinnerung'], kind: 'seconds', off: true, label: 'Weitere Erinnerungen (nur im Chat)' },
  { key: 'pickHint', names: ['kartenhinweis', 'hinweis'], kind: 'bool', label: 'Hinweis „Welche Karte?“ (Sprache)' },
];

export function findRule(name: string): RuleSpec | undefined {
  const n = name.toLowerCase().replace(/[^a-zäöü]/g, '');
  return RULES.find((r) => r.names.includes(n) || r.key.toLowerCase() === n);
}

const WORD_FACTORS: Record<string, number> = { voll: 1, ganz: 1, halb: 0.5, haelfte: 0.5, hälfte: 0.5, nichts: 0, keine: 0, kein: 0, aus: 0, doppelt: 2 };

/** "50%", "0.5", "0,5", "1/2", "halb", "2x", "100" (Prozent ab > 5) → factor. */
export function parseFactor(input: string): number | null {
  const s = input.trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
  if (s in WORD_FACTORS) return WORD_FACTORS[s]!;
  let m = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (m) return parseFloat(m[1]!) / 100;
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)x$/);
  if (m) return parseFloat(m[1]!);
  m = s.match(/^\d+(?:\.\d+)?$/);
  if (m) {
    const v = parseFloat(s);
    return v > 5 ? v / 100 : v; // "50" means 50 %, "0.5" / "2" are factors
  }
  return null;
}

export function parseBool(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if (['an', 'ein', 'ja', 'on', 'true', '1'].includes(s)) return true;
  if (['aus', 'nein', 'off', 'false', '0'].includes(s)) return false;
  return null;
}

/** Validate and apply a rule change. Returns an error message or null. */
export function applyRule(rules: GameRules, spec: RuleSpec, raw: string): string | null {
  if (spec.kind === 'factor') {
    const f = parseFactor(raw);
    if (f === null || f < 0 || f > 5) return `"${raw}" ist kein gültiger Faktor (z.B. 100%, 50%, 0, 2x).`;
    (rules as any)[spec.key] = Math.round(f * 1000) / 1000;
  } else if (spec.kind === 'bool') {
    const b = parseBool(raw);
    if (b === null) return `"${raw}": bitte "an" oder "aus".`;
    (rules as any)[spec.key] = b;
  } else {
    if (spec.off && (parseBool(raw) === false || /^0+$/.test(raw.trim()))) {
      (rules as any)[spec.key] = 0;
      return null;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 5 || n > 600) return `"${raw}": bitte Sekunden zwischen 5 und 600${spec.off ? ' oder "aus"' : ''}.`;
    (rules as any)[spec.key] = n;
  }
  return null;
}

export function formatRuleValue(rules: GameRules, spec: RuleSpec): string {
  const v = rules[spec.key];
  if (spec.kind === 'factor') {
    const pct = Math.round((v as number) * 100);
    return spec.key.toLowerCase().includes('wrong') ? (pct ? `−${pct} %` : 'kein Abzug') : `+${pct} %`;
  }
  if (spec.kind === 'bool') return v ? 'an' : 'aus';
  if (spec.off && !v) return 'aus';
  return `${v} s`;
}

/** Snapshot of the adjustable rules (for persisting). */
export function pickRules(rules: GameRules): Partial<GameRules> {
  return Object.fromEntries(RULES.map((r) => [r.key, rules[r.key]])) as Partial<GameRules>;
}
