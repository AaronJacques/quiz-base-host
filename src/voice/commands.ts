import { colognePhonetic, levenshtein, normalize, vowelSkeleton } from '../judge/normalize.ts';
import type { BoardCell } from '../core/types.ts';

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
const END_RE = /^(?:(?:das |dieses )?(?:spiel|quiz) (?:beenden|abbrechen|stoppen)|(?:beende|stoppe?|stopp) (?:das|dieses) (?:spiel|quiz)|brich (?:das|dieses) (?:spiel|quiz) ab|wir beenden (?:das|dieses) (?:spiel|quiz)|schluss für heute|lass uns aufhören|wir hören auf)$/;
/** A bare word ("Ende", "beenden", "Spiel-Ende") may be cut off or mean something else: it asks back. */
const END_SHORT_RE = /^(?:beenden|ende|(?:das |dieses )?(?:spiel|quiz) ende)$/;
/**
 * A question or polite request ("kannst du das Spiel beenden", "sollen wir aufhören", "mal das Spiel beenden") –
 * Whisper often drops the "?". It asks back instead of ending right away.
 */
const END_POLITE_RE = /^(?:kannst du mal|könntest du mal|kannst du|könntest du|sollen wir|sollten wir|wollen wir|willst du|würdest du|mal)\s+/;
/**
 * Statements about the game, no commands ("Spiel ist vorbei", "bricht das Spiel ab", "das Spiel endet") – often
 * a question with the "?" lost. They ask back (`ende?`), never end the game by themselves.
 */
const END_STATE_RE = /^(?:(?:das |dieses )?(?:spiel|quiz) (?:ist|wird) (?:zu ende|vorbei|aus|beendet|abgebrochen)|(?:das |dieses )?(?:spiel|quiz) endet|(?:bricht|beendet|stoppt) (?:das|dieses) (?:spiel|quiz)(?: ab)?)$/;
/**
 * Short words that may mean "end the game" – or "stop talking", "cancel that". They never end the game
 * by themselves; the bot asks back (`ende?`).
 */
const MAYBE_END_RE = /^(?:stop|stopp|halt|abbrechen|abbruch|aufhören|hör auf|schluss)(?: jetzt| sofort)?$/;

/**
 * The whole phrases that end the game, as the fast Whisper model may write them: run together
 * ("Spielbeenden"), misheard ("Spielbänden", "Quizabrechen"). Compared by sound (Kölner Phonetik) *and*
 * vowels, as one word – so a longer sentence never matches. Only the same sound ends the game right away;
 * one code off ("Spiel bieten", "Quiz finden") and the participles ("Spiel abgebrochen?" – the question
 * people ask when the bot seems stuck) only lead to the stop question. "stoppen" is left out on purpose:
 * it sounds too much like "starten".
 */
const END_OBJECTS = ['spiel', 'quiz'];
/**
 * The vowel sounds one by one – unlike `vowelSkeleton`, a repeated sound across consonants stays:
 * "Spielbinden" → "i i e" ≠ "Spielbeenden" → "i e e" (the skeleton folds both to "ie").
 */
function vowelRuns(s: string): string {
  const fold: Record<string, string> = { ae: 'e', ee: 'e', ie: 'i', ai: 'ai', ei: 'ai', ey: 'ai', eu: 'oi', aeu: 'oi', oe: 'o', oo: 'o', ue: 'u', y: 'i' };
  return (normalize(s).replace(/[^a-z]/g, '').match(/[aeiouy]+/g) ?? []).map((r) => fold[r] ?? r).join(' ');
}
const sounds = (words: string[]) => words.map((w) => ({ code: colognePhonetic(w), vowels: vowelSkeleton(w), runs: vowelRuns(w) }));
const END_DIRECT = sounds(END_OBJECTS.flatMap((o) => [`${o}beenden`, `${o}abbrechen`, `beendedas${o}`, `brichdas${o}ab`]));
const END_PARTICIPLE = sounds(END_OBJECTS.flatMap((o) => [`${o}beendet`, `${o}abgebrochen`]));

/**
 * A whole "end the game" phrase that `END_RE` misses because Whisper ran it together or misheard it:
 * 'end' = sounds exactly like one, 'ask' = close (ask back first), null = no. Never with digits.
 */
export function endPhrase(text: string): 'end' | 'ask' | null {
  const s = speechNorm(text).replace(/^(?:das|dieses) /, '');
  if (!s || /\d/.test(s) || s.split(' ').length > 4) return null;
  const code = colognePhonetic(collapse(s));
  const vowels = vowelSkeleton(s);
  const near = (list: typeof END_DIRECT, d: number) => list.some((e) => e.vowels === vowels && (e.code === code || (d > 0 && e.code.length >= 6 && levenshtein(e.code, code) <= d)));
  const runs = vowelRuns(s);
  // The indicative sounds like the imperative ("bricht"/"brich", "beendet"/"beende"): a statement, no command.
  if (END_DIRECT.some((e) => e.code === code && e.vowels === vowels && e.runs === runs)) return /^\S+t /.test(s) ? 'ask' : 'end';
  return near(END_DIRECT, 1) || near(END_PARTICIPLE, 1) ? 'ask' : null;
}

/** Words of the end commands themselves – a category named "Spiele" or "Quiz" does not block "Spiel beenden". */
const END_WORDS = new Set(['spiel', 'quiz', 'ende', 'beenden', 'abbrechen', 'stopp', 'stop', 'schluss']);

/** The utterance names a category of the board ("Spielbanken", "Geschichte") – then it is a card, never "end". */
function namesCategory(s: string, categories: string[]): boolean {
  const cats = new Set(categories.flatMap((c) => normalize(c).split(' ')).filter((w) => w.length >= 4 && !END_WORDS.has(w)));
  return normalize(s).split(' ').some((w) => cats.has(w));
}

/**
 * The reply to "Soll ich das Spiel beenden?" – only a clear reply that is nothing else: "Ja", "Ja bitte",
 * "Ja genau", "Jawohl", "Nein", "Weiter". Never a question ("Bitte?", "Klar?", "Ja?") or a word that may mean
 * something else, and never a "Ja" at the start of a longer sentence ("ja, Geschichte 300", "ja warte mal").
 * `question`: the utterance as heard ended with "?" (lost by normalising after the wake word).
 */
export function endAskReply(text: string, question = /\?\s*$/.test(text)): 'yes' | 'no' | null {
  if (question) return null;
  const s = speechNorm(text);
  if (/^(?:ja|ja ja|jawohl|ja genau|ja bitte|ja klar|ja beenden|ja beende es|ja beende das spiel|ja aufhören)$/.test(s)) return 'yes';
  if (/^(?:nein|nee|nö|nein danke|nein weiter|weiter|weiterspielen|nicht beenden|doch nicht|nein doch nicht)$/.test(s)) return 'no';
  return null;
}

/** "die zweite", "Nummer drei", "Kategorie eins" – a column by number. */
/**
 * A column by number: "die zweite", "den dritten" (an ordinal after an article, not "das erste Mal"), an ordinal
 * alone, before a column word ("zweite Kategorie", "erste Spalte"), or "Nummer/Kategorie/Spalte" with a number after it. Not "Ich achte drauf", "Die Kategorie ist schwer".
 */
function columnByNumber(words: string[]): boolean {
  const ordinal = (w?: string) => !!w && w in ORDINALS && /te[nrs]?$/.test(w);
  const number = (w?: string) => !!w && (w in ORDINALS || /^\d{1,2}$/.test(w));
  if (words.length === 1 && ordinal(words[0])) return true;
  return words.some((w, i) =>
    (ordinal(w) && ['die', 'den', 'das', 'der', 'dem'].includes(words[i - 1] ?? '') && words[i + 1] !== 'mal') ||
    (ordinal(w) && ['kategorie', 'spalte', 'reihe', 'nummer'].includes(words[i + 1] ?? '')) || // "zweite Kategorie", "erste Spalte"
    (['nummer', 'kategorie', 'spalte'].includes(w) && number(words[i + 1])),
  );
}

/**
 * Sounds like a card choice that did not quite work: a short utterance with a point-like number
 * ("Hund für 250" – a value of the board or a multiple of 50, not a year), a column by number ("die zweite")
 * or a word close to a category ("Geschicht", "Flak" for "Flaggen"). Everything else is side talk – no
 * "Welche Karte?". (A board point value or a clear category is parsed as a pick already.)
 */
export function mentionsCard(text: string, grid: BoardCell[]): boolean {
  const words = speechNorm(spokenToDigits(text)).split(' ').filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const points = new Set(grid.map((c) => c.points));
  const pointLike = (n: number) => points.has(n) || (n >= 50 && n <= 2000 && n % 50 === 0);
  if (words.some((w) => /^\d{2,4}$/.test(w) && pointLike(Number(w)))) return true;
  if (columnByNumber(words)) return true;
  const catWords = [...new Set(grid.flatMap((c) => normalize(c.category).split(' ')))].filter((w) => w.length >= 4);
  // Same beginning, or the word sounds like the start of the category ("Flak" → "Flaggen").
  const near = (w: string, c: string) => {
    const code = colognePhonetic(w);
    return c.startsWith(w.slice(0, 5)) || w.startsWith(c.slice(0, 5)) || (code.length >= 3 && colognePhonetic(c).startsWith(code));
  };
  return words.map(normalize).some((w) => w.length >= 4 && catWords.some((c) => near(w, c)));
}

/** Maps a spoken instruction (after the wake word) to a bot command + args. */
/**
 * `question`: the utterance ended with "?" – then ending the game takes the stop question first.
 * `categories`: of the open board – an utterance with one of them (or with digits) is never "end".
 */
export function voiceCommand(rest: string, opts: { question?: boolean; categories?: string[] } = {}): { name: string; args: string[] } | null {
  const norm = speechNorm(rest);
  // Fillers in front of every command – unchanged; the wider polite prefix below is only for ending the game.
  const s = norm.replace(/^(bitte|mal|kannst du|könntest du)\s+/, '').replace(/\s+bitte$/, '');
  if (!s) return { name: 'hilfe', args: [] };
  let m: RegExpMatchArray | null;
  // Ending the game: a question or request ("sollen wir das Spiel beenden", "kannst du mal …") only asks back.
  const polite = norm.match(END_POLITE_RE);
  const e = polite ? norm.slice(polite[0].length).replace(/^(?:mal|bitte)\s+/, '').replace(/\s+bitte$/, '') : s;
  if (e && !/\d/.test(e) && !namesCategory(e, opts.categories ?? [])) {
    const end = END_RE.test(e) ? 'end' : END_STATE_RE.test(e) || END_SHORT_RE.test(e) ? 'ask' : endPhrase(e);
    if (end) return { name: end === 'end' && !opts.question && !polite ? 'ende' : 'ende?', args: [] };
    if (MAYBE_END_RE.test(e)) return { name: 'ende?', args: [] };
  }
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
 * belong here too: "Genau, meine Antwort ist zehn" is a new answer, not the "Ja" to the old one. So do
 * corrections ("Ich korrigiere, meine Antwort ist …", "Nein, mein Antwort ist …"; "ähm nein" and "nee warte"
 * are covered word by word) and the default wake words ("Quizmaster, meine Antwort ist …" from the person
 * answering). Custom wake words from `voice.wakeWords` are not stripped here – accepted, they are rare.
 */
const ANSWER_LEAD = String.raw`(?:(?:(?:hey\s+|hallo\s+)?quiz\s*(?:master|meister|host)|ich korrigiere(?:\s+mich)?|korrektur|quatsch|äh+m*|ähm|hm+|okay|ok|also|gut|na gut|ja|jap|jep|jo|genau|richtig|korrekt|stimmt|exakt|klar|passt|nein|ne|nee|nö|doch|warte|moment|sorry|dann|so|und|ach|oh|oder|halt)[\s,.!…:–-]*)*`;
/**
 * The possessive before "Antwort" as speech recognition writes it: "mein Antwort", "meiner Antwort", "Maine Antwort".
 * Never "eine" – "Eine Antwort ist schwer" is no answer.
 */
const ANSWER_POSS = String.raw`(?:meine|meiner|meinen|meinem|mein|maine|unsere|unser)`;
/**
 * The verb after "Antwort". "es" ("Meine Antwort es Paris", a misheard "ist") only with something after it –
 * at the very end it is swallowed, so "Meine Antwort es" waits for the answer instead of taking "es".
 * Never "war": "Meine Antwort war falsch" is thinking aloud.
 */
const ANSWER_VERB = String.raw`(?:ist|is|isst|lautet|wäre|heißt|sei|es(?=[\s,.:;!…–-]+[\p{L}\p{N}]|[\s,.:;!?…–-]*$))`;
/** "Meine Antwort ist", "Antwort:", "Die Antwort lautet", "Meine finale Antwort ist", "Ich antworte mit" … */
const ANSWER_KEY = String.raw`(?:(?:${ANSWER_POSS}|die)\s+)?(?:(?:end)?gültige\s+|finale\s+|letzte\s+)?antwort(?:\s+${ANSWER_VERB}|(?!\s+(?:war|waren)(?![\p{L}\p{N}])))|ich antworte(?:\s+mit)?`;
const ANSWER_RE = new RegExp(String.raw`^\s*${ANSWER_LEAD}(?:${ANSWER_KEY})(?=[\s,.:;!?…–-]|$)[\s,.:;!…–-]*(.*)$`, 'isu');

/**
 * Later keywords in the same utterance – stricter (possessive or article *and* verb), so "die Antwort auf
 * alles" stays part of an answer.
 */
const ANSWER_KEY_AGAIN = String.raw`${ANSWER_POSS}\s+(?:(?:end)?gültige\s+|finale\s+|letzte\s+)?antwort\s+(?:ist|is|isst|lautet|wäre|heißt|sei|es(?=[\s,.:;!…–-]+[\p{L}\p{N}]))|die\s+(?:(?:end)?gültige\s+|finale\s+|richtige\s+)?antwort\s+(?:ist|lautet|wäre)|ich antworte mit`;
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

/** Fillers and the wake word in front of the reply to "Paris?" ("Äh, ja", "Quizmaster, ja"). */
const CONFIRM_LEAD = /^(?:(?:äh+m*|ähm|hm+|also|(?:hey |hallo )?quiz ?(?:master|meister|host))(?: |$))+/u;
const NO_FIRST = new Set(['nein', 'ne', 'nee', 'nö', 'nä', 'falsch', 'stopp', 'stop', 'halt', 'korrektur', 'anders', 'nicht', 'no', 'nope']);
const NO_ANYWHERE = new Set(['nicht', 'nein', 'nee', 'nö', 'falsch']);
/** "Warte", "Moment": the answer stays open – no "Ja", no "Nein", and no asking back. */
const WAIT_FIRST = new Set(['warte', 'wart', 'moment', 'sekunde', 'augenblick']);
const YES_FIRST = new Set(
  ('ja jaa jaaa jaha jap japp jep jepp jo joa jup jupp jawohl jawoll genau richtig korrekt stimmt passt bestätigt bestätige ' +
    'yes yeah yep yup klar sicher logo exakt absolut definitiv natürlich eingeloggt einloggen').split(' '),
);
const YES_PHRASES = ['so ist es', 'das ist es', 'das ist sie', 'das stimmt', 'das passt', 'auf jeden fall'];
/** Words that may follow the "Ja" without making it something else ("Ja, das ist meine Antwort", "Ja, genau, bitte"). */
const YES_REST = new Set(
  ('ja genau bitte klar richtig korrekt stimmt so ist es das sie meine antwort die final endgültig absolut sicher danke gerne ' +
    'doch logo exakt jawohl passt auf jeden fall natürlich bestätigt').split(' '),
);

/** The reply to "Paris?" as words, without fillers and wake word in front; [] if nothing is left. */
function confirmWords(text: string): string[] {
  return speechNorm(text).replace(CONFIRM_LEAD, '').split(' ').filter(Boolean);
}

/**
 * The reply to "Paris?" – yes, no, or something else (null). `pending` is the answer waiting for "Ja":
 * its words may come along ("Ja, Paris"). A "Ja" only counts with nothing else after it ("Ja, warte",
 * "Ja, aber …", "Ja oder Rom" are null). A new answer with the keyword is null – it is handled as an answer.
 * "Okay", "Mhm", "Doch" alone are no "Ja".
 */
export function confirmReply(text: string, pending = ''): 'yes' | 'no' | null {
  const all = speechNorm(text);
  if (!all || all.split(' ').length > 6) return null;
  if (extractAnswer(text) !== null) return null; // "Genau, meine Antwort ist …" brings a new answer
  const words = confirmWords(text);
  if (!words.length) return null;
  const own = new Set(speechNorm(pending).split(' ').filter(Boolean));
  if (NO_FIRST.has(words[0]!) || words.some((w) => NO_ANYWHERE.has(w) && !own.has(w))) return 'no';
  if (WAIT_FIRST.has(words[0]!)) return null;
  const s = words.join(' ');
  const phrase = YES_PHRASES.find((p) => s === p || s.startsWith(`${p} `));
  const rest = phrase ? words.slice(phrase.split(' ').length) : YES_FIRST.has(words[0]!) ? words.slice(1) : null;
  if (rest && rest.every((w) => YES_REST.has(w) || own.has(w))) return 'yes';
  return null;
}

/** "Warte", "Moment", "Sekunde" in reply to "Paris?": the person wants time – the bot does not ask "Ja oder nein?". */
export function confirmWaits(text: string): boolean {
  const first = confirmWords(text)[0];
  return !!first && WAIT_FIRST.has(first);
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
