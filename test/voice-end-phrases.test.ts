import { describe, expect, it } from 'vitest';
import { endAskReply, mentionsCard, stripWakeWord, voiceCommand } from '../src/voice/commands.ts';

const WAKE = ['quizmaster', 'quiz master', 'quizmeister', 'quizhost', 'quiz host'];
type Expect = 'direkt' | 'Rückfrage' | 'nichts';

/** What "Quizmaster, <text>" does: ends the game right away, asks back first, or neither. */
function outcome(text: string, categories: string[] = []): Expect {
  const said = `Quizmaster, ${text}`;
  const cmd = voiceCommand(stripWakeWord(said, WAKE)!, { question: /\?\s*$/.test(said), categories });
  return cmd?.name === 'ende' ? 'direkt' : cmd?.name === 'ende?' ? 'Rückfrage' : 'nichts';
}

/**
 * The 224 utterances of the review of 3098cb2 (F1), after the wake word. Only an exact command or one that
 * sounds exactly like it (no digits, no question) ends the game; anything close only asks back.
 */
const TABLE: Record<string, [string, Expect][]> = {
  "Kartenwahl (Kategorien)": [
    ["Spielfilme für 200", 'nichts'],
    ["Spielfilme 100", 'nichts'],
    ["Spiele 300", 'nichts'],
    ["Spielzeug für 400", 'nichts'],
    ["Spielshows 500", 'nichts'],
    ["Brettspiele für 100", 'nichts'],
    ["Videospiele 200", 'nichts'],
    ["Olympische Spiele 300", 'nichts'],
    ["Spielekonsolen für 100", 'nichts'],
    ["Bienen für 200", 'nichts'],
    ["Bienen 100", 'nichts'],
    ["Quizfragen 300", 'nichts'],
    ["Quiz für 100", 'nichts'],
    ["Wendepunkte 200", 'nichts'],
    ["Beethoven 300", 'nichts'],
    ["Bundesliga für 200", 'nichts'],
    ["Benelux 100", 'nichts'],
    ["Spielberg für 300", 'nichts'],
    ["Spielberg-Filme 200", 'nichts'],
    ["Spielbanken 100", 'nichts'],
    ["Spielplätze 400", 'nichts'],
    ["Kinderspiele 100", 'nichts'],
    ["Spieltheorie 300", 'nichts'],
    ["Bilder für 200", 'nichts'],
    ["Banden 300", 'nichts'],
    ["Bänder 100", 'nichts'],
    ["Geschichte 300", 'nichts'],
    ["Sport für hundert", 'nichts'],
    ["die erste für hundert", 'nichts'],
    ["die zweite Kategorie", 'nichts'],
    ["Kategorie eins", 'nichts'],
    ["Biologie für 500", 'nichts'],
    ["Erdkunde 200", 'nichts'],
    ["Quizshows 300", 'nichts'],
    ["Quiz Bienen", 'Rückfrage'],
    ["Spielbälle", 'nichts'],
    ["Spielende", 'nichts'],
    ["Spielregeln für 200", 'nichts'],
    ["Spielerwechsel", 'nichts'],
    ["Spielwende", 'nichts'],
  ],
  "Spiel + Verb (keine Endabsicht)": [
    ["Spiel beginnen", 'nichts'],
    ["Spiel starten", 'nichts'],
    ["Spiel weiter", 'nichts'],
    ["Spiel weitermachen", 'nichts'],
    ["Spiel bewerten", 'nichts'],
    ["Spiel speichern", 'nichts'],
    ["Spiel bestellen", 'nichts'],
    ["Spiel benennen", 'Rückfrage'],
    ["Spiel bieten", 'Rückfrage'],
    ["Spiel bedienen", 'nichts'],
    ["Spiel beraten", 'nichts'],
    ["Spiel bestimmen", 'nichts'],
    ["Spiel beachten", 'nichts'],
    ["Spiel bereden", 'Rückfrage'],
    ["Spiel besprechen", 'nichts'],
    ["Spiel wenden", 'Rückfrage'],
    ["Spiel binden", 'Rückfrage'],
    ["Spiel bilden", 'Rückfrage'],
    ["Spiel finden", 'Rückfrage'],
    ["Spiel senden", 'Rückfrage'],
    ["Spiel bitten", 'Rückfrage'],
    ["Spiel Linden", 'Rückfrage'],
    ["Spiel benden lassen", 'nichts'],
    ["Spiel beneiden", 'nichts'],
    ["Spiel betreten", 'nichts'],
    ["Spiel bekommen", 'nichts'],
    ["Spiel bedenken", 'nichts'],
    ["Spiel pausieren", 'nichts'],
    ["Spiel anhalten", 'nichts'],
    ["Spiel neu starten", 'nichts'],
    ["Spiel wechseln", 'nichts'],
    ["Spiel laden", 'nichts'],
    ["Spiel wiederholen", 'nichts'],
    ["Spiel erklären", 'nichts'],
    ["Spiel abgeben", 'nichts'],
    ["Spiel aufgeben", 'nichts'],
    ["Spiel abwarten", 'nichts'],
    ["Spiel abspielen", 'nichts'],
    ["Spiel absprechen", 'nichts'],
    ["Spiel abstimmen", 'nichts'],
    ["Spiel aufbrechen", 'nichts'],
    ["Spiel abgesprochen", 'Rückfrage'],
    ["Spiel abgestürzt", 'nichts'],
    ["Spiel aufgehängt", 'nichts'],
    ["Spielen wir weiter", 'nichts'],
    ["spielen", 'nichts'],
    ["Spiel", 'nichts'],
    ["Spielende?", 'nichts'],
    ["wann ist Spielende", 'nichts'],
    ["Spielstand", 'nichts'],
    ["Spielplan", 'nichts'],
    ["Spielregeln", 'nichts'],
    ["Spielbrett", 'nichts'],
    ["Spielfeld", 'nichts'],
    ["Spielbeginn", 'nichts'],
    ["Spielzeit", 'nichts'],
    ["Spielrunde", 'nichts'],
    ["Spieler", 'nichts'],
    ["Spieler wechseln", 'nichts'],
    ["Spieler Ben", 'nichts'],
    ["Spieler Bennet", 'nichts'],
    ["Spielleiter", 'nichts'],
    ["Spielleitung", 'nichts'],
    ["Spielleiter Ben", 'nichts'],
  ],
  "Quiz + Verb": [
    ["Quiz abgeben", 'nichts'],
    ["Quiz angeben", 'nichts'],
    ["Quiz aufgeben", 'nichts'],
    ["Quiz beginnen", 'nichts'],
    ["Quiz starten", 'nichts'],
    ["Quiz bewerten", 'nichts'],
    ["Quiz bieten", 'Rückfrage'],
    ["Quiz binden", 'Rückfrage'],
    ["Quiz finden", 'Rückfrage'],
    ["Quiz wenden", 'Rückfrage'],
    ["Quiz enden", 'Rückfrage'],
    ["Quiz bitte", 'nichts'],
    ["Quiz bestellen", 'nichts'],
    ["Quiz speichern", 'nichts'],
    ["Quiz Bienen", 'Rückfrage'],
    ["Quiz Biene", 'nichts'],
    ["Quiz bestimmen", 'nichts'],
    ["Quiz weiter", 'nichts'],
    ["Quiz anfangen", 'nichts'],
    ["Quiz abbrechen lassen", 'nichts'],
    ["Quiz ab", 'nichts'],
    ["Quiz absagen", 'Rückfrage'],
    ["Quiz absprechen", 'nichts'],
    ["Quiz abrechnen", 'Rückfrage'],
    ["Quiz abrechen", 'direkt'],
    ["Quiz Abend", 'nichts'],
    ["Quizabend", 'nichts'],
    ["Quizrunde", 'nichts'],
    ["Quiz wechseln", 'nichts'],
    ["Quiz Benden", 'direkt'],
  ],
  "Stand / Regeln / Befehle": [
    ["Punktestand", 'nichts'],
    ["Zwischenstand", 'nichts'],
    ["Stand", 'nichts'],
    ["wie steht es", 'nichts'],
    ["wer führt", 'nichts'],
    ["Regeln", 'nichts'],
    ["Regel Minus", 'nichts'],
    ["Regel Zeit 30", 'nichts'],
    ["Regel Buzzer aus", 'nichts'],
    ["Regel Erinnerung aus", 'nichts'],
    ["Regel Kartenhinweis aus", 'nichts'],
    ["wiederholen", 'nichts'],
    ["nochmal", 'nichts'],
    ["Hilfe", 'nichts'],
    ["was ist frei", 'nichts'],
    ["Brett", 'nichts'],
    ["los", 'nichts'],
    ["starte das Spiel", 'nichts'],
    ["das war richtig", 'nichts'],
    ["das war falsch", 'nichts'],
    ["weiter", 'nichts'],
    ["nächste Frage", 'nichts'],
    ["tschüss", 'nichts'],
    ["verlass den Channel", 'nichts'],
    ["neues Quiz Geschichte", 'nichts'],
    ["neues Spiel", 'nichts'],
    ["lass uns Geschichte spielen", 'nichts'],
    ["Bende", 'nichts'],
    ["beenden", 'Rückfrage'],
    ["Ende", 'Rückfrage'],
    ["Ende?", 'Rückfrage'],
    ["ende jetzt", 'nichts'],
    ["Spiel Ende", 'Rückfrage'],
    ["Spiel-Ende", 'Rückfrage'],
    ["Spielende jetzt", 'nichts'],
  ],
  "Antworten mit Schlüsselwort / Namen": [
    ["meine Antwort ist Benden", 'nichts'],
    ["meine Antwort ist Spielberg", 'nichts'],
    ["Antwort Bienen", 'nichts'],
    ["meine Antwort ist Beethoven", 'nichts'],
    ["ich bin Ben", 'nichts'],
    ["ich bin Anna", 'nichts'],
    ["ich heiße Bennet", 'nichts'],
    ["mein Name ist Bente", 'nichts'],
    ["Anna", 'nichts'],
    ["Ben", 'nichts'],
    ["Ben ist dran", 'nichts'],
    ["Bennet beenden", 'nichts'],
    ["wer ist dran", 'nichts'],
    ["bin ich dran", 'nichts'],
    ["ja", 'nichts'],
    ["nein", 'nichts'],
    ["Ja bitte", 'nichts'],
    ["bitte", 'nichts'],
    ["genau", 'nichts'],
    ["klar", 'nichts'],
  ],
  "Verhörer der Endbefehle (base-q5_1)": [
    ["Spielbeenden", 'direkt'],
    ["Spiel bänden", 'direkt'],
    ["Spielbänden", 'direkt'],
    ["Spiel benden", 'direkt'],
    ["Spiel Benton", 'nichts'],
    ["Spiel beenten", 'direkt'],
    ["Spiel beendet", 'Rückfrage'],
    ["Spiel beendet?", 'Rückfrage'],
    ["Spiel ist beendet", 'Rückfrage'],
    ["Spiel abgebrochen", 'Rückfrage'],
    ["Spiel abgebrochen?", 'Rückfrage'],
    ["Quiz abgebrochen?", 'Rückfrage'],
    ["Quiz beendet?", 'Rückfrage'],
    ["Spiel abbrechen", 'direkt'],
    ["Spielabbrechen", 'direkt'],
    ["Spiel abrechen", 'direkt'],
    ["Spiel Abrechnen", 'Rückfrage'],
    ["Quizabrechen", 'direkt'],
    ["Quiz beenden", 'direkt'],
    ["Quizbeenden", 'direkt'],
    ["beende das Spiel", 'direkt'],
    ["Wende das Spiel", 'Rückfrage'],
    ["Ende das Spiel", 'Rückfrage'],
    ["Bende das Spiel", 'direkt'],
    ["brich das Spiel ab", 'direkt'],
    ["brich das Quiz ab", 'direkt'],
    ["Spiel bienen", 'Rückfrage'],
    ["Spiel Bändern", 'Rückfrage'],
    ["Spiel enden", 'Rückfrage'],
    ["Spiel wenden bitte", 'Rückfrage'],
    ["Spiel beeinden", 'nichts'],
    ["Spiel bedeuten", 'nichts'],
    ["Spiel bewenden", 'Rückfrage'],
    ["Spiel Bettina", 'nichts'],
    ["Spiel Berlin", 'nichts'],
  ],
};

/** The 27 utterances that ended the game without asking in 3098cb2 (review F1, "ungewollt"). */
const UNWANTED = ["Quiz Bienen", "Quiz abgebrochen?", "Quiz abrechnen", "Quiz beendet?", "Quiz bieten", "Quiz binden", "Quiz finden", "Quiz wenden", "Quizfragen 300", "Spiel Bändern", "Spiel Linden", "Spiel abgebrochen?", "Spiel abgesprochen", "Spiel beendet?", "Spiel benennen", "Spiel bereden", "Spiel bewenden", "Spiel bienen", "Spiel bieten", "Spiel bilden", "Spiel binden", "Spiel bitten", "Spiel finden", "Spiel senden", "Spiel wenden", "Spielbanken 100"];

describe('voice: ending the game – review table (F1)', () => {
  for (const [group, rows] of Object.entries(TABLE)) {
    it(`${group}`, () => {
      const got = rows.map(([text]) => [text, outcome(text)]);
      expect(got).toEqual(rows);
    });
  }

  it('has all 224 utterances, and none of the unwanted ones ends the game right away', () => {
    expect(Object.values(TABLE).flat()).toHaveLength(224);
    for (const text of UNWANTED) expect(outcome(text), text).not.toBe('direkt');
  });

  it('the live game: "Quizabrechen", "Spielbänden", "Spielbeenden" end right away, "Abbrechen" asks back', () => {
    for (const text of ['Quizabrechen', 'Spielbänden', 'Spielbeenden']) expect(outcome(text), text).toBe('direkt');
    expect(outcome('Abbrechen')).toBe('Rückfrage');
  });

  it('a question, a participle or a near miss asks back; digits or a category of the board never end', () => {
    for (const text of ['Spiel beenden?', 'Spielbeenden?', 'Ende?', 'Spiel beendet', 'Spiel abgebrochen?', 'Spiel bieten', 'Spiel binden']) expect(outcome(text), text).toBe('Rückfrage');
    for (const text of ['Spielbanken 100', 'Quizfragen 300', 'Spiel beenden 2', 'Geschichte 300']) expect(outcome(text), text).toBe('nichts');
    // Board with a category "Spielbanken": the bare word is a card, not "Spiel abbrechen".
    expect(outcome('Spielbanken', ['Spielbanken', 'Sport'])).toBe('nichts');
    expect(outcome('Spielbanken')).toBe('Rückfrage');
    // A category named like the end words does not block the command itself.
    expect(outcome('Spiel beenden', ['Spiele', 'Quiz'])).toBe('direkt');
  });
});

describe('voice: the reply to "Soll ich das Spiel beenden?" (F2, F11)', () => {
  it('counts only a clear yes or no, never a question or an ambiguous word', () => {
    for (const s of ['Ja', 'Ja.', 'ja bitte', 'Ja, genau!', 'jawohl', 'Ja, ja']) expect(endAskReply(s), s).toBe('yes');
    for (const s of ['Nein', 'nein, weiter', 'Nee', 'weiter', 'Weiterspielen']) expect(endAskReply(s), s).toBe('no');
    for (const s of ['Bitte?', 'Bitte', 'Klar?', 'Klar', 'Genau?', 'Genau', 'Ja?', 'Wie bitte?', 'Ne?', 'beenden?', 'Jo', 'ja, Geschichte 300', 'ja warte mal', 'Meine Antwort ist ja', ''])
      expect(endAskReply(s), s).toBeNull();
    // After the wake word the "?" is gone – the caller passes it on.
    expect(endAskReply('ja', true)).toBeNull();
  });
});

describe('voice: card attempts vs. side talk (F10)', () => {
  const cell = (category: string, points: number) => ({ col: 0, row: 0, category, points, answered: false });
  const grid = [cell('Flaggen', 100), cell('Geschichte', 200), cell('Serien und Filme', 300)];
  it('a year in conversation is no card attempt, a column by number is', () => {
    for (const s of ['Das war doch 1990, oder?', 'ich hab 12 Katzen']) expect(mentionsCard(s, grid), s).toBe(false);
    for (const s of ['die zweite', 'Nummer drei', 'Kategorie eins', 'Hund für 250', 'zweihundertfünfzig']) expect(mentionsCard(s, grid), s).toBe(true);
  });
});

/**
 * Round 2 of the review (160 utterances, F13): sound neighbours, imperative neighbours, card picks on a board
 * with the categories below, questions and statements. Statements and the indicative ("bricht das Spiel ab",
 * "Spiel ist vorbei") ask back; only commands (and their exact sound doubles) end right away.
 */
const BOARD = ['Geschichte', 'Spielbanken', 'Bienen & Insekten', 'Musik', 'Beethoven'];
const TABLE2: Record<string, [string, Expect][]> = {
  "Klangnachbarn Spiel/Quiz + Verb (andere Bedeutung)": [
    ["Spiel benoten", 'nichts'],
    ["Spiel betonen", 'nichts'],
    ["Spiel bedanken", 'nichts'],
    ["Spiel Bändchen", 'nichts'],
    ["Spiel bändigen", 'nichts'],
    ["Spiel pendeln", 'Rückfrage'],
    ["Spiel penden", 'direkt'],
    ["Spiel Penne", 'nichts'],
    ["Spiel bemerken", 'nichts'],
    ["Spiel Panther", 'nichts'],
    ["Spiel Banditen", 'nichts'],
    ["Spiel Bandit", 'nichts'],
    ["Spielbanden", 'nichts'],
    ["Spielbande", 'nichts'],
    ["Spiel Pinten", 'Rückfrage'],
    ["Spiel Bündel", 'nichts'],
    ["Spiel bunten", 'nichts'],
    ["Spiel bemängeln", 'nichts'],
    ["Spiel beantworten", 'nichts'],
    ["Spiel verbinden", 'nichts'],
    ["Spiel empfinden", 'nichts'],
    ["Spiel entbinden", 'nichts'],
    ["Spiel Benz", 'nichts'],
    ["Spiel Benno", 'nichts'],
    ["Spiel Bente", 'Rückfrage'],
    ["Spiel Bänken", 'Rückfrage'],
    ["Spiel binnen", 'Rückfrage'],
    ["Spiel bannen", 'nichts'],
    ["Spiel bespannen", 'nichts'],
    ["Spiel behindern", 'nichts'],
    ["Spielpaten", 'nichts'],
    ["Spiel paten", 'nichts'],
    ["Spiel beten", 'Rückfrage'],
    ["Spiel betten", 'Rückfrage'],
    ["Spiel baden", 'nichts'],
    ["Spiel bieten lassen", 'nichts'],
    ["Spiel beendete", 'Rückfrage'],
    ["Spiel beendend", 'Rückfrage'],
    ["Spiel Bändern", 'Rückfrage'],
    ["Spielwände", 'nichts'],
    ["Spiel Wänden", 'Rückfrage'],
    ["Spiel Pfänden", 'Rückfrage'],
    ["Spiel pfänden", 'Rückfrage'],
    ["Spiel bänden?", 'Rückfrage'],
    ["Spiel benden?", 'Rückfrage'],
    ["Spiel beenden?", 'Rückfrage'],
    ["Spiel abbrechen?", 'Rückfrage'],
    ["Spielbeenden?", 'Rückfrage'],
    ["Quiz abbringen", 'nichts'],
    ["Quiz abringen", 'nichts'],
    ["Quiz abbiegen", 'nichts'],
    ["Quiz abwischen", 'nichts'],
    ["Quiz abdecken", 'Rückfrage'],
    ["Quiz Abendessen", 'nichts'],
    ["Quiz abschreiben", 'nichts'],
    ["Quiz abräumen", 'nichts'],
    ["Quiz abspeichern", 'nichts'],
    ["Quiz Abrechnung", 'nichts'],
    ["Quiz Abbruch", 'nichts'],
    ["Quiz abbrennen", 'Rückfrage'],
    ["Quiz Benton", 'nichts'],
    ["Quiz Benjamin", 'nichts'],
    ["Quiz Bienchen", 'Rückfrage'],
    ["Quiz Bühne", 'nichts'],
    ["Quiz Wende", 'nichts'],
    ["Quiz bändigen", 'nichts'],
    ["Quiz Benten", 'direkt'],
    ["Quiz penden", 'direkt'],
    ["Quiz Bänden", 'direkt'],
    ["Quiz beendet worden", 'nichts'],
    ["Kuss beenden", 'nichts'],
    ["Chris beenden", 'nichts'],
    ["Kriss beenden", 'nichts'],
    ["Quiz-Pendant", 'nichts'],
    ["Spiel ab brechen", 'direkt'],
    ["Spiel abrächen", 'direkt'],
    ["Spiel Aprechen", 'direkt'],
    ["Spiel abstechen", 'nichts'],
    ["Spiel abtrennen", 'nichts'],
    ["Spiel Absprache", 'nichts'],
    ["Spiel abbrennen", 'Rückfrage'],
    ["Spiel abprallen", 'Rückfrage'],
  ],
  "Imperativ-Nachbarn (beende / brich)": [
    ["Bente das Spiel", 'direkt'],
    ["Bente, das Spiel", 'direkt'],
    ["wende das Quiz", 'Rückfrage'],
    ["sende das Spiel", 'Rückfrage'],
    ["meine das Spiel", 'nichts'],
    ["beende das Lied", 'nichts'],
    ["beende den Satz", 'nichts'],
    ["beende die Frage", 'nichts'],
    ["beende die Runde", 'nichts'],
    ["Brich das Eis", 'nichts'],
    ["brich das Spiel nicht ab", 'nichts'],
    ["sprich das Spiel an", 'nichts'],
    ["prüf das Spiel ab", 'nichts'],
    ["bring das Spiel ab", 'Rückfrage'],
    ["brich das Spiel an", 'Rückfrage'],
    ["bricht das Spiel ab", 'Rückfrage'],
    ["bricht das Spiel ab?", 'Rückfrage'],
    ["bricht das Quiz ab", 'Rückfrage'],
    ["beendet das Spiel", 'Rückfrage'],
    ["beendet das Spiel?", 'Rückfrage'],
    ["beendet das Quiz", 'Rückfrage'],
    ["beende das Spiel nicht", 'nichts'],
    ["Pente das Spiel", 'direkt'],
    ["Bende das Quiz", 'direkt'],
    ["bente das Quiz", 'direkt'],
    ["Benedas Spiel", 'Rückfrage'],
    ["Brigitte das Spiel", 'nichts'],
    ["Brich das Spielab", 'direkt'],
  ],
  "Kartenwahl-Verhörer ohne Ziffer (Board: Geschichte, Spielbanken, Bienen & Insekten, Musik, Beethoven)": [
    ["Spielbanken hundert", 'nichts'],
    ["Spielbanken", 'nichts'],
    ["Spiel Banken", 'Rückfrage'],
    ["Spielbangen", 'Rückfrage'],
    ["Spiel banken hundert", 'nichts'],
    ["Bienen hundert", 'nichts'],
    ["Bienen und Insekten", 'nichts'],
    ["Quiz Bienen", 'nichts'],
    ["Beethoven zweihundert", 'nichts'],
    ["Geschichte hundert", 'nichts'],
    ["Musik dreihundert", 'nichts'],
    ["die letzte", 'nichts'],
    ["die erste", 'nichts'],
    ["Spielbanken die erste", 'nichts'],
    ["Spiel Bienen", 'nichts'],
    ["Spiel Biene", 'nichts'],
    ["Spiel Beethoven", 'nichts'],
    ["Quiz Beethoven", 'nichts'],
    ["Spielbank", 'nichts'],
    ["Spielbanken bitte", 'nichts'],
  ],
  "Fragen, Aussagen, Pausen-Schnitte": [
    ["Spiel ist vorbei", 'Rückfrage'],
    ["Spiel ist vorbei?", 'Rückfrage'],
    ["das Spiel ist zu Ende", 'Rückfrage'],
    ["Quiz ist zu Ende?", 'Rückfrage'],
    ["Ende?", 'Rückfrage'],
    ["Ende!", 'Rückfrage'],
    ["Ende gut alles gut", 'nichts'],
    ["Ende der Runde", 'nichts'],
    ["beenden?", 'Rückfrage'],
    ["beenden", 'Rückfrage'],
    ["wir hören auf", 'direkt'],
    ["wir hören auf?", 'Rückfrage'],
    ["lass uns aufhören", 'direkt'],
    ["Schluss für heute", 'direkt'],
    ["Spiel stoppen", 'direkt'],
    ["Quiz stoppen", 'direkt'],
    ["stopp das Spiel", 'direkt'],
    ["kannst du das Spiel beenden?", 'Rückfrage'],
    ["kannst du das Spiel beenden", 'Rückfrage'],
    ["das Spiel beenden", 'direkt'],
    ["dieses Spiel beenden", 'direkt'],
    ["das Spiel", 'nichts'],
    ["Spiel beenden wir gleich", 'nichts'],
    ["das Quiz abbrechen?", 'Rückfrage'],
    ["Spiel beendet.", 'Rückfrage'],
    ["Spiel abgebrochen.", 'Rückfrage'],
    ["Quiz beendet", 'Rückfrage'],
    ["Spiel beenden bitte", 'direkt'],
    ["bitte Spiel beenden", 'direkt'],
    ["mal das Spiel beenden", 'Rückfrage'],
  ],
};

describe('voice: ending the game – review table round 2 (F13)', () => {
  for (const [group, rows] of Object.entries(TABLE2)) {
    it(`${group}`, () => {
      const cats = group.startsWith('Kartenwahl') ? BOARD : [];
      expect(rows.map(([text]) => [text, outcome(text, cats)])).toEqual(rows);
    });
  }

  it('has all 160 utterances; statements and the indicative never end the game right away', () => {
    expect(Object.values(TABLE2).flat()).toHaveLength(160);
    for (const text of ['bricht das Spiel ab', 'bricht das Quiz ab', 'beendet das Spiel', 'Spiel ist vorbei', 'das Spiel ist zu Ende', 'Quiz ist aus', 'das Spiel endet'])
      expect(outcome(text), text).toBe('Rückfrage');
    // The commands themselves still end right away.
    for (const text of ['brich das Spiel ab', 'beende das Spiel', 'wir hören auf', 'Spiel beenden']) expect(outcome(text), text).toBe('direkt');
  });

  it('what still ends right away is a command (or its exact sound double) – nothing else', () => {
    const direct = [...Object.values(TABLE), ...Object.values(TABLE2)].flat().filter(([, e]) => e === 'direkt').map(([t]) => t);
    expect([...new Set(direct)].sort((a, b) => a.localeCompare(b, 'de'))).toEqual(
      [
        'beende das Spiel', 'Bende das Quiz', 'Bende das Spiel', 'bente das Quiz', 'Bente das Spiel', 'Bente, das Spiel', 'bitte Spiel beenden',
        'brich das Quiz ab', 'brich das Spiel ab', 'Brich das Spielab', 'das Spiel beenden', 'dieses Spiel beenden', 'lass uns aufhören', 'Pente das Spiel', 'Quiz abrechen', 'Quiz Bänden', 'Quiz beenden', 'Quiz Benden', 'Quiz Benten', 'Quiz penden',
        'Quiz stoppen', 'Quizabrechen', 'Quizbeenden', 'Schluss für heute', 'Spiel ab brechen', 'Spiel abbrechen', 'Spiel abrächen', 'Spiel abrechen', 'Spiel Aprechen',
        'Spiel bänden', 'Spiel beenden bitte', 'Spiel beenten', 'Spiel benden', 'Spiel penden', 'Spiel stoppen', 'Spielabbrechen',
        'Spielbänden', 'Spielbeenden', 'stopp das Spiel', 'wir hören auf',
      ].sort((a, b) => a.localeCompare(b, 'de')),
    );
  });
});

describe('voice: column words in conversation (F14)', () => {
  const cell = (category: string, points: number) => ({ col: 0, row: 0, category, points, answered: false });
  const grid = [cell('Flaggen', 100), cell('Geschichte', 200)];
  it('a bare "Kategorie" or an ordinal without a column reference is side talk', () => {
    for (const s of ['Ich achte drauf', 'Das ist das erste Mal', 'zum ersten Mal hier', 'Die Kategorie ist schwer', 'die Kategorie ist neu'])
      expect(mentionsCard(s, grid), s).toBe(false);
    for (const s of ['die zweite', 'den dritten', 'zweite', 'Kategorie eins', 'Nummer drei', 'Spalte 2']) expect(mentionsCard(s, grid), s).toBe(true);
  });

  it('an ordinal before a column word is a card attempt again (F15)', () => {
    for (const s of ['zweite Kategorie', 'erste Spalte', 'erste Reihe', 'die dritte Kategorie']) expect(mentionsCard(s, grid), s).toBe(true);
    for (const s of ['Ich achte drauf', 'das erste Mal', 'Die Kategorie ist schwer']) expect(mentionsCard(s, grid), s).toBe(false);
  });
});

describe('voice: bare words and polite questions ask back (review delta 2)', () => {
  it('"Ende", "beenden", "kannst du …", "sollen wir …", "mal …" ask back; the clear commands still end', () => {
    for (const text of ['Ende', 'beenden', 'Spiel Ende', 'kannst du das Spiel beenden', 'könntest du das Spiel beenden', 'kannst du Spiel beenden', 'sollen wir aufhören', 'sollen wir das Spiel beenden', 'mal das Spiel beenden'])
      expect(outcome(text), text).toBe('Rückfrage');
    for (const text of ['Spiel beenden', 'Quiz abbrechen', 'Spiel stoppen', 'beende das Spiel', 'stopp das Spiel', 'brich das Spiel ab', 'wir hören auf', 'Schluss für heute', 'lass uns aufhören', 'Spiel beenden bitte', 'bitte Spiel beenden', 'Spielbeenden'])
      expect(outcome(text), text).toBe('direkt');
  });
});

/**
 * Review delta 3 (F18): the wider polite prefix is only for ending the game. Every other command behaves
 * exactly as on main 89de88e – these results were recorded with the voiceCommand of 89de88e.
 */
const AS_ON_MAIN: [string, { name: string; args: string[] } | null][] = [
  ["sollen wir weiter?", null],
  ["kannst du mal skippen", null],
  ["wollen wir die Regeln ändern", null],
  ["weiter", {"name":"skip","args":[]}],
  ["kannst du weiter", {"name":"skip","args":[]}],
  ["mal weiter", {"name":"skip","args":[]}],
  ["bitte weiter", {"name":"skip","args":[]}],
  ["Stand", {"name":"stand","args":[]}],
  ["kannst du den Stand sagen", {"name":"stand","args":[]}],
  ["sollen wir den Stand sagen", {"name":"stand","args":[]}],
  ["wie steht es", {"name":"stand","args":[]}],
  ["wiederholen", {"name":"wiederholen","args":[]}],
  ["kannst du das wiederholen", {"name":"wiederholen","args":[]}],
  ["könntest du nochmal", {"name":"wiederholen","args":[]}],
  ["was ist frei", {"name":"brett","args":[]}],
  ["kannst du mal sagen was frei ist", null],
  ["Hilfe", {"name":"hilfe","args":[]}],
  ["kannst du mir helfen", null],
  ["das war richtig", {"name":"richtig","args":[]}],
  ["sollen wir das richtig geben", null],
  ["das war falsch", {"name":"falsch","args":[]}],
  ["willst du falsch sagen", null],
  ["los", {"name":"los","args":[]}],
  ["kannst du starten", {"name":"los","args":[]}],
  ["sollen wir los", null],
  ["würdest du starten", null],
  ["neues Quiz Geschichte", {"name":"neu","args":["geschichte"]}],
  ["wollen wir ein neues Quiz", null],
  ["ich bin Anna", {"name":"ich","args":["anna"]}],
  ["mal ich bin Anna", {"name":"ich","args":["anna"]}],
  ["tschüss", {"name":"voice","args":["aus"]}],
  ["würdest du den Channel verlassen", {"name":"voice","args":["aus"]}],
  ["Regeln", {"name":"regeln","args":[]}],
  ["wollen wir Regeln", null],
  ["nächste Frage", {"name":"skip","args":[]}],
  ["sollten wir die nächste Frage", null],
  ["lass uns Geschichte spielen", {"name":"neu","args":["geschichte"]}],
  ["kannst du lass uns Geschichte spielen", {"name":"neu","args":["geschichte"]}],
  ["überspringen", {"name":"skip","args":[]}],
  ["willst du überspringen", null],
];

describe('voice: polite questions change only ending the game (F18, F19)', () => {
  it('all other commands behave exactly as on main 89de88e', () => {
    expect(AS_ON_MAIN.length).toBeGreaterThanOrEqual(20);
    for (const [text, cmd] of AS_ON_MAIN) expect(voiceCommand(text, { question: /\?\s*$/.test(text) }), text).toEqual(cmd);
    // Reviewer's case: "Quizmaster, sollen wir weiter?" of the leader must not skip the question.
    for (const text of ['sollen wir weiter?', 'kannst du mal skippen', 'wollen wir die Regeln ändern']) expect(voiceCommand(text), text).toBeNull();
  });

  it('"kannst du mal …" and "sollen wir …" before ending the game ask back (F19)', () => {
    for (const text of ['kannst du mal das Spiel beenden', 'könntest du mal das Spiel beenden', 'sollen wir das Spiel beenden', 'sollen wir aufhören', 'würdest du das Spiel beenden'])
      expect(outcome(text), text).toBe('Rückfrage');
  });
});
