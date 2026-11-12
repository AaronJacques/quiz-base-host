import { levenshtein } from '../judge/normalize.ts';

/** Lowercase, no punctuation – the way spoken text is compared. */
export function speechNorm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-–—_]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const collapse = (s: string) => s.replace(/\s+/g, '');

/**
 * "Hey Quizmaster, Stand!" → "stand". Returns null if the text does not start with a
 * wake word. Tolerates how Whisper splits or misspells it ("Quiz Master", "Quizmeister").
 */
export function stripWakeWord(text: string, wakeWords: string[]): string | null {
  const words = speechNorm(text).replace(/^(hey|hallo|okay|ok|he|ey)\s+/, '').split(' ').filter(Boolean);
  for (const wake of wakeWords.map((w) => collapse(speechNorm(w)))) {
    for (let n = 1; n <= Math.min(3, words.length); n++) {
      const head = collapse(words.slice(0, n).join(' '));
      if (head === wake || (wake.length >= 8 && Math.abs(head.length - wake.length) <= 2 && levenshtein(head, wake) <= 2)) {
        return words.slice(n).join(' ');
      }
    }
  }
  return null;
}

/** Maps a spoken instruction (after the wake word) to a bot command + args. */
export function voiceCommand(rest: string): { name: string; args: string[] } | null {
  const s = speechNorm(rest).replace(/^(bitte|mal|kannst du|könntest du)\s+/, '').replace(/\s+bitte$/, '');
  if (!s) return { name: 'hilfe', args: [] };
  let m: RegExpMatchArray | null;
  if (/(spiel beenden|beende das spiel|^beenden$|^ende$|aufhören|schluss)/.test(s)) return { name: 'ende', args: [] };
  if ((m = s.match(/^(?:ein |eine )?(?:neues?|neue|neuen) (?:quiz|spiel|lobby|runde|board)(?: (?:mit|zu|zum thema|über))?(?: (.*))?$/))) return { name: 'neu', args: m[1] ? m[1].split(' ') : [] };
  if ((m = s.match(/^(?:lass uns (.+) spielen|wir spielen (.+))$/))) return { name: 'neu', args: (m[1] ?? m[2])!.split(' ') };
  if ((m = s.match(/^(?:ich bin|mein name ist|ich heiße) (.+)$/))) return { name: 'ich', args: m[1]!.split(' ') };
  if (/^(los|start|starten|starte|leg los|fang an|anfangen|starte das spiel|spiel starten)$/.test(s)) return { name: 'los', args: [] };
  if (/(punktestand|zwischenstand|\bstand\b|^punkte$|wie steht es|wer führt|wer liegt vorn|wie viele punkte)/.test(s)) return { name: 'stand', args: [] };
  if (/(was ist (noch )?frei|welche karten|was gibt es noch|brett|übersicht|was ist noch übrig|kategorien)/.test(s)) return { name: 'brett', args: [] };
  if (/(wiederhol|nochmal|noch mal|noch einmal|wie bitte)/.test(s)) return { name: 'wiederholen', args: [] };
  if (/^(das (war|ist) )?(richtig|korrekt|zählt)( gewesen)?$/.test(s)) return { name: 'richtig', args: [] };
  if (/^(das (war|ist) )?(falsch|nicht richtig)( gewesen)?$/.test(s)) return { name: 'falsch', args: [] };
  if (/^(weiter|überspringen|skip|nächste frage|frage überspringen)$/.test(s)) return { name: 'skip', args: [] };
  if (/(hilfe|was kann ich sagen|befehle)/.test(s)) return { name: 'hilfe', args: [] };
  if (/^(regeln|welche regeln)/.test(s)) return { name: 'regeln', args: [] };
  if (/(verlass|geh raus|tschüss|auf wiedersehen|leave|verschwinde)/.test(s)) return { name: 'voice', args: ['aus'] };
  return null;
}

/**
 * "Buzzer!", "Ich!", "Hier!", "Ich weiß es" – short claims during the buzzer window.
 * A bare "ja" does not count: it is said all the time in side talk.
 */
export function isBuzz(text: string): boolean {
  const s = speechNorm(text);
  if (!s || s.split(' ').length > 4) return false;
  return /^(buzzer|buzz|bass|ich|ich ich|hier|ich weiß|ich weiß es|ich weiß das|ich will|ich hab s|ich habs|ich hab es)( buzzer)?$/.test(s) || /\bbuzzer\b/.test(s);
}

/** Fillers that may come before the answer keyword ("Okay, äh, meine Antwort ist …"). */
const ANSWER_LEAD = String.raw`(?:(?:äh+m*|ähm|hm+|okay|ok|also|gut|na gut|ja|nein|ne|nee|nö|doch|warte|moment|sorry|dann|so|und)[\s,.!…:–-]*)*`;
/** "Meine Antwort ist", "Antwort:", "Die Antwort lautet", "Meine finale Antwort ist", "Ich antworte mit" … */
const ANSWER_KEY = String.raw`(?:(?:meine|unsere|die)\s+)?(?:(?:end)?gültige\s+|finale\s+|letzte\s+)?antwort(?:\s+(?:ist|is|lautet|wäre|heißt|sei))?|ich antworte(?:\s+mit)?`;
const ANSWER_RE = new RegExp(String.raw`^\s*${ANSWER_LEAD}(?:${ANSWER_KEY})(?=[\s,.:;!?…–-]|$)[\s,.:;!…–-]*(.*)$`, 'isu');

/**
 * Spoken answers need the keyword, so thinking aloud and discussing never counts:
 * "Okay, meine Antwort ist Paris." → "Paris". null without keyword; '' if nothing follows.
 * The answer keeps its original spelling – it is repeated back word for word.
 */
export function extractAnswer(text: string): string | null {
  const m = text.match(ANSWER_RE);
  if (!m) return null;
  return m[1]!.replace(/[.!?…,;:\s]+$/u, '').trim();
}

/** The reply to "Paris?" – yes, no, or something else (null). */
export function confirmReply(text: string): 'yes' | 'no' | null {
  const s = speechNorm(text);
  if (!s || s.split(' ').length > 6) return null;
  const end = String.raw`(?=\s|$)`;
  if (new RegExp(`^(nein|ne|nee|nö|nä|falsch|stopp|stop|halt|warte|moment|doch nicht|nicht|korrektur|anders)${end}`, 'u').test(s)) return 'no';
  if (/(^|\s)(nicht|nein)(\s|$)/.test(s)) return 'no';
  if (new RegExp(`^(ja|jap|jep|jo|joa|jawohl|genau|richtig|korrekt|stimmt|passt|bestätigt|bestätige|yes|yep|klar|sicher|logo|exakt|eingeloggt|einloggen|so ist es|das ist es|das ist sie)${end}`, 'u').test(s)) return 'yes';
  return null;
}

const ORDINALS: Record<string, number> = {
  eins: 1, ein: 1, eine: 1, einen: 1, erste: 1, ersten: 1, erstes: 1, erster: 1,
  zwei: 2, zwo: 2, zweite: 2, zweiten: 2, zweites: 2,
  drei: 3, dritte: 3, dritten: 3, drittes: 3,
  vier: 4, vierte: 4, vierten: 4, viertes: 4,
  fünf: 5, fünfte: 5, fünften: 5, fünftes: 5,
  sechs: 6, sechste: 6, sechsten: 6,
  sieben: 7, siebte: 7, siebten: 7,
  acht: 8, achte: 8, achten: 8,
  neun: 9, neunte: 9, neunten: 9,
  zehn: 10, zehnte: 10, zehnten: 10,
  elf: 11, zwölf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15,
};
const FILLER = new Set(['nummer', 'nr', 'die', 'das', 'der', 'den', 'board', 'quiz', 'bitte', 'ich', 'nehme', 'will', 'möchte', 'gerne', 'gern', 'also', 'äh', 'ähm', 'dann', 'mal', 'option', 'lieber']);

/** "Nummer zwei", "das zweite", "2" → 2; null when the text is more than a number. */
export function spokenNumber(text: string): number | null {
  const words = speechNorm(text).split(' ').filter((w) => w && !FILLER.has(w));
  if (words.length !== 1) return null;
  const w = words[0]!;
  if (/^\d{1,2}$/.test(w)) return Number(w);
  return ORDINALS[w] ?? null;
}

const UNITS: Record<string, number> = { ein: 1, eins: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9 };
const TENS: Record<string, number> = { zehn: 10, zwanzig: 20, dreißig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };

/**
 * "zweihundert" → "200", "tausend" → "1000", "fünfhundertfünfzig" → "550" (point values as words).
 * Also undoes Whisper hearing "für" as English "four": "Sport4300" / "Sport 4 300" → "Sport für 300".
 */
export function spokenToDigits(text: string): string {
  return text.replace(/(\p{L})\s?4\s?([1-9]\d{2,3})\b/gu, '$1 für $2').replace(/\b(?:(ein|eins|zwei|zwo|drei|vier|fünf|sechs|sieben|acht|neun)?hundert(?:und)?(zehn|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)?|(ein)?tausend)\b/gi, (m, unit, tens, thousand) => {
    if (/tausend/i.test(m)) return thousand !== undefined || /^tausend$/i.test(m) ? '1000' : m;
    const h = (unit ? UNITS[unit.toLowerCase()]! : 1) * 100;
    return String(h + (tens ? TENS[tens.toLowerCase()]! : 0));
  });
}
