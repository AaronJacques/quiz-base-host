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

/**
 * Ending the game is the one command that cannot be undone – only whole, unambiguous phrases count
 * ("Spiel beenden", "Spiel abbrechen"), never a word inside a sentence ("kannst du aufhören zu reden", "Schlussrunde").
 */
const END_RE = /^(?:(?:das |dieses )?(?:spiel|quiz) (?:beenden|abbrechen|stoppen|ende)|(?:beende|stoppe?|stopp) (?:das|dieses) (?:spiel|quiz)|brich (?:das|dieses) (?:spiel|quiz) ab|wir beenden (?:das|dieses) (?:spiel|quiz)|(?:spiel|quiz) ist (?:zu ende|vorbei)|beenden|ende|schluss für heute|lass uns aufhören|wir hören auf)$/;
/**
 * Short words that may mean "end the game" – or "stop talking", "cancel that". They never end the game
 * by themselves; the bot asks back (`ende?`).
 */
const MAYBE_END_RE = /^(?:stop|stopp|halt|abbrechen|abbruch|aufhören|hör auf|schluss)(?: jetzt| sofort)?$/;

/** Maps a spoken instruction (after the wake word) to a bot command + args. */
export function voiceCommand(rest: string): { name: string; args: string[] } | null {
  const s = speechNorm(rest).replace(/^(bitte|mal|kannst du|könntest du)\s+/, '').replace(/\s+bitte$/, '');
  if (!s) return { name: 'hilfe', args: [] };
  let m: RegExpMatchArray | null;
  if (END_RE.test(s)) return { name: 'ende', args: [] };
  if (MAYBE_END_RE.test(s)) return { name: 'ende?', args: [] };
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
 * "Buzzer!", "Ich!", "Hier!", "Ich weiß es" – short claims during the buzzer window, as the whole
 * utterance. A bare "ja" does not count (side talk), nor a question ("Ich?") or a sentence that only
 * mentions the buzzer ("kein Buzzer für mich").
 */
export function isBuzz(text: string): boolean {
  if (/\?\s*$/.test(text.trim())) return false;
  const s = speechNorm(text);
  if (!s || s.split(' ').length > 4) return false;
  return /^(?:(?:ich|hier) )?(?:buzzer|buzz|ich|ich ich|hier|hier hier|ich weiß|ich weiß es|ich weiß das|ich will|ich hab s|ich habs|ich hab es)(?: (?:buzzer|hier))?$/.test(s);
}

/**
 * Fillers that may come before the answer keyword ("Okay, äh, meine Antwort ist …"). Confirmation words
 * belong here too: "Genau, meine Antwort ist zehn" is a new answer, not the "Ja" to the old one.
 */
const ANSWER_LEAD = String.raw`(?:(?:äh+m*|ähm|hm+|okay|ok|also|gut|na gut|ja|jap|jep|jo|genau|richtig|korrekt|stimmt|exakt|klar|passt|nein|ne|nee|nö|doch|warte|moment|sorry|dann|so|und)[\s,.!…:–-]*)*`;
/** "Meine Antwort ist", "Antwort:", "Die Antwort lautet", "Meine finale Antwort ist", "Ich antworte mit" … */
const ANSWER_KEY = String.raw`(?:(?:meine|unsere|die)\s+)?(?:(?:end)?gültige\s+|finale\s+|letzte\s+)?antwort(?:\s+(?:ist|is|lautet|wäre|heißt|sei))?|ich antworte(?:\s+mit)?`;
const ANSWER_RE = new RegExp(String.raw`^\s*${ANSWER_LEAD}(?:${ANSWER_KEY})(?=[\s,.:;!?…–-]|$)[\s,.:;!…–-]*(.*)$`, 'isu');

/**
 * Later keywords in the same utterance – stricter (possessive or article *and* verb), so "die Antwort auf
 * alles" stays part of an answer.
 */
const ANSWER_KEY_AGAIN = String.raw`(?:meine|unsere)\s+(?:(?:end)?gültige\s+|finale\s+|letzte\s+)?antwort\s+(?:ist|is|lautet|wäre|heißt|sei)|die\s+(?:(?:end)?gültige\s+|finale\s+|richtige\s+)?antwort\s+(?:ist|lautet|wäre)|ich antworte mit`;
const ANSWER_AGAIN_RE = new RegExp(String.raw`(?:^|[\s,.;:!?…–-])(?:${ANSWER_KEY_AGAIN})(?=[\s,.:;!?…–-]|$)[\s,.:;!…–-]*`, 'giu');
/**
 * A correction inside the answer: "Nabu, ach nein, Tatooine", "Nabu – nein, Tatooine", "ich meine Tatooine".
 * A bare "nein" only counts after a pause (comma, dash …), so the answer "Nein" stays an answer.
 */
const CORRECTION_RE = new RegExp(
  String.raw`(?:^|[\s,.;:!?…–-])(?:(?:ach|oh|äh|ähm|oder|nee|halt|nein)\s+nein|ich mein(?:e|te)?|besser gesagt|korrektur|quatsch)(?=[\s,.:;!?…–-]|$)` +
    String.raw`|[,.;:!?…–-]\s*(?:nein|nee|nö|ne)(?=[\s,.:;!?…–-]|$)`,
  'giu',
);
/** Stalling right after a correction: "nein, warte, Tatooine". */
const AFTER_CORRECTION = /^[\s,.:;!…–-]*(?:(?:warte|moment|äh+m*|ähm|also|doch|sorry)[\s,.:;!…–-]+)*/iu;

/**
 * Spoken answers need the keyword, so thinking aloud and discussing never counts:
 * "Okay, meine Antwort ist Paris." → "Paris". null without keyword; '' if nothing follows.
 * Within one utterance the last keyword and the last correction count: "Meine Antwort ist Nabu, ach nein,
 * Tatooine" and "Meine Antwort ist Nabu … meine Antwort ist Tatooine" are both "Tatooine".
 * The answer keeps its original spelling – it is repeated back word for word.
 */
export function extractAnswer(text: string): string | null {
  const m = text.match(ANSWER_RE);
  if (!m) return null;
  let answer = m[1]!;
  const last = [...answer.matchAll(ANSWER_AGAIN_RE)].at(-1);
  if (last) {
    const rest = answer.slice(last.index! + last[0].length);
    if (/[\p{L}\p{N}]/u.test(rest)) answer = rest;
    else answer = answer.slice(0, last.index!); // "… Tatooine, meine Antwort ist." – the keyword came last
  }
  const corr = [...answer.matchAll(CORRECTION_RE)].at(-1);
  if (corr) {
    const rest = answer.slice(corr.index! + corr[0].length).replace(AFTER_CORRECTION, '');
    if (/[\p{L}\p{N}]/u.test(rest)) answer = rest;
  }
  return answer.replace(/[.!?…,;:\s–-]+$/u, '').trim();
}

/**
 * Someone "said" a sentence of the bot: its own voice came back through their microphone (speakers, no
 * headphones). Most words are the bot's, and they cover a good part of its sentence – a player who
 * repeats the example card ("Flaggen für 100") is not an echo.
 */
export function isEcho(heard: string, said: string): boolean {
  const h = speechNorm(heard).split(' ').filter(Boolean);
  const s = new Set(speechNorm(said).split(' ').filter(Boolean));
  if (!h.length || !s.size) return false;
  const hits = h.filter((w) => s.has(w)).length;
  return hits / h.length >= 0.8 && hits / s.size >= 0.5;
}

/** The reply to "Paris?" – yes, no, or something else (null). */
export function confirmReply(text: string): 'yes' | 'no' | null {
  const s = speechNorm(text);
  if (!s || s.split(' ').length > 6) return null;
  if (extractAnswer(text) !== null) return null; // "Genau, meine Antwort ist …" brings a new answer
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
