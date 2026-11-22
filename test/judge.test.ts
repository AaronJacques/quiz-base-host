import { describe, expect, it } from 'vitest';
import { JudgeCache } from '../src/judge/cache.ts';
import { FuzzyJudge, judgeChoice } from '../src/judge/fuzzy-judge.ts';
import { hedgeWords, isNonAnswer, mathKey, mathValue, normalize, numbers, referenceVariants, similarity } from '../src/judge/normalize.ts';

describe('normalize', () => {
  it('folds umlauts, case, punctuation and URLs', () => {
    expect(normalize('Tatooine https://jedipedia.fandom.com/wiki/X')).toBe('tatooine');
    expect(normalize('Grüße, MÜNCHEN!')).toBe('gruesse muenchen');
    expect(normalize('42,195 km')).toBe('42.195 km');
  });

  it('extracts numbers incl. German words', () => {
    expect(numbers('vier')).toContain(4);
    expect(numbers('Deutschland gewann 4 mal')).toContain(4);
    expect(numbers('42,195 km (26,22 meilen)')).toContain(42.195);
  });

  it('splits notes into variants', () => {
    expect(referenceVariants('Breaking Bad https://www.imdb.com/x')).toContain('Breaking Bad');
    const v = referenceVariants('Der Federball (Badminton) kann 490 km/h erreichen');
    expect(v).toContain('Badminton');
    expect(referenceVariants('Pete "Maverick" Mitchell / Maverick')).toContain('Maverick');
  });

  it('recognises non-answers', () => {
    expect(isNonAnswer('Keine Ahnung')).toBe(true);
    expect(isNonAnswer('  ')).toBe(true);
    expect(isNonAnswer('Paris')).toBe(false);
  });

  it('similarity tolerates typos and order', () => {
    expect(similarity('Volksrepublik China', 'volksrepublik chna')).toBeGreaterThan(0.9);
    expect(similarity('Harry James Potter', 'Potter Harry James')).toBe(1);
  });
});

describe('FuzzyJudge (cascade mode)', () => {
  const judge = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
  const q = 'Testfrage';

  it.each([
    ['Tatooine https://jedipedia.fandom.com/wiki/Anakin', 'tatooine'],
    ['Tatooine', 'auf Tatooine'],
    ['4', 'vier'],
    ['4', '4 Mal'],
    ['10', '10'],
    ['Volksrepublik China', 'Volksrepublik Chian'],
    ['Breaking Bad https://www.imdb.com/x', 'breaking bad'],
    ['Schrauben (englisch: Bolts)', 'Bolts'],
  ])('accepts %s ← %s without LLM', async (reference, answer) => {
    expect((await judge.judge({ question: q, reference, answer })).verdict).toBe('correct');
  });

  it.each([
    ['Bryan Adams - Summer Of 69', 'Summer of 69'],
    ['Pete "Maverick" Mitchell', 'Tom Cruise'],
    ['Der Federball (Badminton) kann über 490 km/h erreichen.', 'Federball'],
    ['Harry James Potter', 'Harry Potter'],
  ])('escalates %s ← %s', async (reference, answer) => {
    expect((await judge.judge({ question: q, reference, answer })).verdict).toBe('unsure');
  });

  it('rejects non-answers immediately', async () => {
    expect((await judge.judge({ question: q, reference: 'Paris', answer: 'weiß nicht' })).verdict).toBe('wrong');
  });

  it('is unsure without reference', async () => {
    expect((await judge.judge({ question: q, reference: null, answer: 'Mario' })).verdict).toBe('unsure');
  });
});

describe('FuzzyJudge (fuzzy-only mode)', () => {
  const judge = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: true });
  it('rejects clearly different answers and wrong numbers', async () => {
    expect((await judge.judge({ question: 'q', reference: 'Tatooine', answer: 'Coruscant' })).verdict).toBe('wrong');
    expect((await judge.judge({ question: 'q', reference: '4', answer: '5' })).verdict).toBe('wrong');
  });
});

describe('spoken answers', () => {
  it('accepts answers that sound like the solution', async () => {
    const { FuzzyJudge } = await import('../src/judge/fuzzy-judge.ts');
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'Wer?', reference: 'Dschingis Khan', answer: 'Tschingis Kahn', spoken: true })).verdict).toBe('correct');
    expect((await j.judge({ question: 'Wer?', reference: 'Dschingis Khan', answer: 'Tschingis Kahn' })).verdict).not.toBe('correct');
    expect((await j.judge({ question: 'Serie?', reference: 'Breaking Bad', answer: 'Preaking Bat', spoken: true })).verdict).toBe('correct');
  });

  // F2: sounding alike is not enough – digits, vowels and the rough spelling must match too.
  it.each([
    ['Kenia', 'Guinea'],
    ['Hamburg', 'Homburg'],
  ])('does not accept %s ← spoken %s by sound alone', async (reference, answer) => {
    for (const rejectDissimilar of [false, true]) {
      const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
      expect((await j.judge({ question: 'q', reference, answer, spoken: true })).verdict).toBe('unsure');
    }
  });

  // Same words, another number: no longer left to the LLM, the number rules (R2) say wrong.
  it.each([
    ['Apollo 11', 'Apollo 13'],
    ['Rocky 2', 'Rocky 4'],
  ])('does not accept %s ← spoken %s by sound alone: wrong number', async (reference, answer) => {
    for (const rejectDissimilar of [false, true]) {
      const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
      const r = await j.judge({ question: 'q', reference, answer, spoken: true });
      expect(r).toMatchObject({ verdict: 'wrong', method: 'fuzzy', reason: 'falsche Zahl' });
    }
  });

  it('keeps the live cases: "Preakidad" is never wrong, "Better Call Saul" stays wrong', async () => {
    for (const rejectDissimilar of [false, true]) {
      const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
      expect((await j.judge({ question: 'Serie?', reference: 'Breaking Bad', answer: 'Preakidad', spoken: true })).verdict).not.toBe('wrong');
      expect((await j.judge({ question: 'Serie?', reference: 'Breaking Bad', answer: 'Better Call Saul', spoken: true })).verdict).not.toBe('correct');
    }
    const strict = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: true });
    expect((await strict.judge({ question: 'Serie?', reference: 'Breaking Bad', answer: 'Better Call Saul', spoken: true })).verdict).toBe('wrong');
  });
});

// F1: an answer that hedges, negates or lists candidates is never accepted without the LLM.
describe('FuzzyJudge – hedged answers', () => {
  it.each([
    ['Paris', 'Paris oder London'],
    ['Paris', 'nicht Paris'],
    ['Paris', 'London Paris Rom'],
    ['Paris', 'Paris / London'],
    ['1989', '1988 oder 1989'],
    ['1989', '1987 1988 1989'],
    ['1989', '1988 bzw. 1989'],
    ['Breaking Bad', 'Breaking Bad oder Better Call Saul'],
    ['Apollo 11', 'Apollo 13'], // close spelling, other number
  ])('%s ← %s is not correct', async (reference, answer) => {
    for (const rejectDissimilar of [false, true]) {
      for (const spoken of [false, true]) {
        const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
        expect((await j.judge({ question: 'q', reference, answer, spoken })).verdict).not.toBe('correct');
      }
    }
  });

  it('still accepts fillers and words that belong to the solution', async () => {
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'q', reference: 'Tatooine', answer: 'ich glaube Tatooine' })).verdict).toBe('correct');
    expect((await j.judge({ question: 'q', reference: 'Tatooine (Wüstenplanet)', answer: 'Wüstenplanet Tatooine' })).verdict).toBe('correct');
    expect((await j.judge({ question: 'q', reference: 'Wer nicht wagt, der nicht gewinnt', answer: 'wer nicht wagt der nicht gewinnt' })).verdict).toBe('correct');
    expect((await j.judge({ question: 'q', reference: 'Vereinigte Staaten / USA', answer: 'USA' })).verdict).toBe('correct');
  });
});

// Formulas as quiz-base shows them (Unicode text, live board „Schulwissen 1. - 12. Klasse“) and as players type them.
describe('formulas', () => {
  it('normalize keeps formula symbols apart instead of dropping them', () => {
    expect(normalize('x²')).toBe(normalize('x^2'));
    expect(normalize('2πr')).toBe('2 pi r');
    expect(normalize('√2')).toBe('wurzel 2');
    expect(normalize('√2')).not.toBe(normalize('2'));
    expect(normalize('2πr')).not.toBe(normalize('2 r'));
    expect(normalize('H₂O')).toBe('h2o');
    expect(numbers('−7')).toEqual([-7]);
    expect(numbers('x = -7')).toEqual([-7]);
    expect(numbers('minus fünf')).toEqual([-5]);
    expect(numbers('10-3')).toEqual([10, 3]);
    expect(numbers('1914 - 1918')).toEqual([1914, 1918]);
  });

  it('mathKey: same formula, same key', () => {
    const same = (a: string, b: string) => expect(mathKey(a), `${a} = ${b}`).toBe(mathKey(b));
    same('a² + b² = c²', 'a^2+b^2=c^2');
    same('a² + b² = c²', 'a2 + b2 = c2');
    same('E = mc²', 'e=m*c^2');
    same('F = m · a', 'F=m*a');
    same('F = m · a', 'f = ma');
    same('2πr', '2*pi*r');
    same('2πr', '2 pi r');
    same('√2', 'sqrt(2)');
    same('√2', 'Wurzel aus 2');
    same('v = s / t', 'v=s:t');
    same('U = R x I', 'U=R*I');
    same('H₂O', 'H2O');
    same('x = (−b ± √(b² − 4ac)) / 2a', 'x=(-b+-sqrt(b^2-4ac))/(2a)');
    same('cos(x)', 'cos x');
    same('½', '1/2');
  });

  it('mathKey: different formulas stay different', () => {
    const differ = (a: string, b: string) => expect(mathKey(a), `${a} ≠ ${b}`).not.toBe(mathKey(b));
    differ('x²', '2x');
    differ('2³', '23');
    differ('10³', '103');
    differ('2*3', '23');
    differ('eˣ', 'ex');
    differ('v = s / t', 'v = t / s');
    differ('2πr', 'πr²');
    differ('a² + b² = c²', 'a + b = c');
    differ('−5', '5');
  });

  it('mathValue evaluates plain arithmetic only', () => {
    expect(mathValue(mathKey('1/2'))).toBe(0.5);
    expect(mathValue(mathKey('0,5'))).toBe(0.5);
    expect(mathValue(mathKey('√2'))).toBeCloseTo(Math.SQRT2, 12);
    expect(mathValue(mathKey('2π'))).toBeCloseTo(2 * Math.PI, 12);
    expect(mathValue(mathKey('3·10⁸'))).toBe(3e8);
    expect(mathValue(mathKey('10⁻³'))).toBeCloseTo(0.001, 15);
    expect(mathValue(mathKey('−7'))).toBe(-7);
    expect(mathValue(mathKey('x²'))).toBeNull();
    expect(mathValue(mathKey('1/0'))).toBeNull();
    expect(mathValue(mathKey('2x'))).toBeNull();
  });

  const judge = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
  const strict = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: true });

  it.each([
    ['Wie lautet der Satz des Pythagoras?', 'a² + b² = c²', 'a^2+b^2=c^2'],
    ['Wie lautet der Satz des Pythagoras?', 'a² + b² = c²', 'a² + b² = c²'],
    ['Wie lautet der Satz des Pythagoras?', 'a² + b² = c²', 'a2+b2=c2'],
    ['Einsteins Gleichung?', 'E = mc²', 'E=mc^2'],
    ['Einsteins Gleichung?', 'E = mc²', 'e = m*c2'],
    ['Wie lautet das Ohmsche Gesetz?', 'U = R x I', 'U = R*I'],
    ['Wie lautet das Ohmsche Gesetz?', 'U = R x I', 'U=R·I'],
    ['Chemische Formel für Wasser?', 'H₂O', 'H2O'],
    ['Formel?', 'v = s / t', 'v=s/t'],
    ['Wie groß ist der Umfang eines Kreises?', '2πr', '2*pi*r'],
    ['Wie groß ist der Umfang eines Kreises?', '2πr', '2 π r'],
    ['Wie viel ist die Hälfte von 1?', '0,5', '1/2'],
    ['Wie viel ist die Hälfte von 1?', '1/2', '0.5'],
    ['Wie viel ist die Hälfte von 1?', '½', '0,5'],
    ['Kreiszahl?', 'π', 'pi'],
    ['Wurzel?', '√2', 'sqrt(2)'],
    ['Löse: X + 7 = 15', 'X = 8', '8'],
    ['Löse: X + 7 = 15', 'X = 8', 'x=8'],
    ['Ableitung von sin(x)?', 'cos(x)', 'cos x'],
    ['Gefrierpunkt?', '−5', 'minus 5'],
    ['Wie viele Ecken hat ein Würfel?', '8', '2³'], // same value, and not just the question repeated
  ])('%s %s ← %s is correct without LLM', async (question, reference, answer) => {
    expect((await judge.judge({ question, reference, answer })).verdict).toBe('correct');
  });

  it.each([
    ['Formel?', 'x²', '2x'],
    ['Formel?', 'x²', 'x'],
    ['Wie groß ist der Umfang eines Kreises?', '2πr', '2r'],
    ['Wie groß ist der Umfang eines Kreises?', '2πr', 'πr²'],
    ['Formel?', 'v = s / t', 't'],
    ['Formel?', 'v = s / t', 'v = t / s'],
    ['Lösungsformel?', 'x = (−b ± √(b² − 4ac)) / 2a', '2a'],
    ['Ableitung von sin(x)?', 'cos(x)', 'x'],
    ['Wert?', '√2', '2'],
    ['Wert?', '2', '√2'],
    ['Wert?', '2', 'x²'],
    ['Wert?', '0,5', '1/4'],
    ['Wert?', '5', '−5'],
    ['Wert?', '−5', '5'],
    ['Pythagoras?', 'a² + b² = c²', 'a + b = c'],
    ['Wie viel ist 3² + 4²?', '25', '3^2+4^2'], // restates the question
    ['Was ist 144:12?', '12', '144/12'],
    ['Wie viel ist 2 hoch 3?', '8', '2³'],
  ])('%s %s ← %s is not correct without LLM', async (question, reference, answer) => {
    for (const j of [judge, strict]) expect((await j.judge({ question, reference, answer })).verdict).not.toBe('correct');
  });

  it('a slash between numbers divides, between words it lists alternatives (F1)', () => {
    expect(hedgeWords('1/2', '0,5')).toEqual([]);
    expect(hedgeWords('s/t', 'v')).toEqual([]);
    expect(hedgeWords('Paris/London', 'Paris')).toEqual(['/']);
    expect(hedgeWords('Paris / London', 'Paris')).toEqual(['/']);
  });

  it('verdict cache keys keep formulas apart (normalize() alone drops the operators)', () => {
    const key = (answer: string) => JudgeCache.verdictKey('Formel für v?', 'v = s / t', answer);
    expect(key('v = s * t')).not.toBe(key('v = s / t'));
    expect(key('c² = a² − b²')).not.toBe(key('c² = a² + b²'));
    // Plain words keep their old keys.
    expect(JudgeCache.verdictKey('Welches Spiel?', 'Half-Life 2', 'Half-Life 2')).toBe('v1␟welches spiel␟half life 2␟half life 2');
  });

  it('formula notes are not split at "/" or brackets', () => {
    expect(referenceVariants('v = s / t')).toEqual(['v = s / t']);
    expect(referenceVariants('cos(x)')).toEqual(['cos(x)']);
    expect(referenceVariants('X = 8')).toEqual(['X = 8', '8']);
    expect(referenceVariants('Licht / Sonnenlicht')).toEqual(['Licht / Sonnenlicht', 'Licht', 'Sonnenlicht']);
  });
});

// Multiple choice: quiz-base marks the correct option; players answer with the letter or the text.
describe('multiple choice', () => {
  const options = [
    { letter: 'A', label: 'Addition', correct: false },
    { letter: 'B', label: 'Reduktion', correct: false },
    { letter: 'C', label: 'Division', correct: false },
    { letter: 'D', label: 'Neutralisation', correct: true },
  ];
  const judge = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
  const ask = (answer: string, opts = options, spoken = false) =>
    judge.judge({ question: 'Säure + Base?', reference: opts.find((o) => o.correct)!.label, answer, options: opts, spoken });

  it.each(['D', 'd', 'D)', 'Antwort D', 'ich nehme D', 'Neutralisation', 'D Neutralisation', 'Neutralisation (D)'])('%s is correct', async (answer) => {
    expect((await ask(answer)).verdict).toBe('correct');
  });

  it.each(['A', 'b', 'Antwort C', 'Reduktion', 'B Reduktion'])('%s is wrong (another option)', async (answer) => {
    expect((await ask(answer)).verdict).toBe('wrong');
  });

  it('leaves other answers to the next stage', async () => {
    expect((await ask('E')).verdict).toBe('unsure');
    expect((await ask('D oder B')).verdict).not.toBe('correct');
    expect((await ask('Neutralisierung')).verdict).toBe('unsure');
  });

  it('spoken letters', async () => {
    expect((await ask('De.', options, true)).verdict).toBe('correct');
    expect((await ask('Be', options, true)).verdict).toBe('wrong');
  });

  it('formula options compare by formula', async () => {
    const f = [
      { letter: 'A', label: 'v = s / t', correct: true },
      { letter: 'B', label: 'v = st', correct: false },
      { letter: 'C', label: 'v = t / s', correct: false },
    ];
    expect((await ask('v=s/t', f)).verdict).toBe('correct');
    expect((await ask('v = t/s', f)).verdict).toBe('wrong');
    expect((await ask('v=s*t', f)).verdict).toBe('wrong');
    const ln = [
      { letter: 'A', label: 'x = 1', correct: false },
      { letter: 'B', label: 'x = 5', correct: true },
    ];
    expect((await ask('x=5', ln)).verdict).toBe('correct');
    expect((await ask('b', ln)).verdict).toBe('correct');
  });

  it('without a marked option nothing is decided here', async () => {
    const unmarked = options.map((o) => ({ ...o, correct: false }));
    expect(judgeChoice('D', unmarked, false)).toBeNull();
  });
});

// Numbers and years decide without the LLM (rules R0–R3, live case 2026-11-20: 1977 ← „neunzehnhundertneunundsiebzig“ was taken as right).
describe('FuzzyJudge – numbers and years', () => {
  const year = 'In welchem Jahr kam der erste Star-Wars-Film, Eine neue Hoffnung, in die US-Kinos?';
  type Expect = 'correct' | 'wrong' | 'unsure' | 'not wrong' | 'not correct';
  const cases: [reference: string, answer: string, question: string, expected: Expect, spoken?: boolean][] = [
    ['1977', 'neunzehnhundertneunundsiebzig', year, 'wrong', true],
    ['1977', 'neunzehnhundertsiebenundsiebzig', year, 'correct', true],
    ['1977', 'neunzehn siebenundsiebzig', year, 'correct', true],
    ['1977', 'neunzehnhundert-siebenundsiebzig', year, 'correct'],
    ['1977', 'Im Jahr 1977.', year, 'correct'],
    ['1977', '1979 glaube ich', year, 'wrong'],
    ['1977', 'siebenundsiebzig', year, 'correct'],
    ['1977', '1977 oder 1978', year, 'unsure'],
    ['2005', 'zweitausendundfünf', 'Wann kam das Spiel heraus?', 'correct'],
    ['2005', 'zweitausend fünf', 'Wann kam das Spiel heraus?', 'correct'],
    ['4', 'vier', 'Wie viele Titel gewann Deutschland?', 'correct'],
    ['4', 'der vierte', 'Wie viele Titel gewann Deutschland?', 'correct'],
    ['4', '4 Mal', 'Wie viele Titel gewann Deutschland?', 'correct'],
    ['4', 'Eine neue Hoffnung', 'Welche Episode ist der erste Film?', 'not wrong'],
    ['2187', '603', 'Welche Nummer hatte Leias Zelle?', 'wrong'],
    ['42,195 km', '42', 'Wie lang ist ein Marathon?', 'unsure'],
    ['42,195 km', 'zweiundvierzig komma eins neun fünf', 'Wie lang ist ein Marathon?', 'correct'],
    ['ca. 8000', '7500', 'Wie viele Gene ungefähr?', 'unsure'],
    ['1939–1945', '1945', 'Wann war der Zweite Weltkrieg?', 'unsure'],
    ['1,5 Millionen', '1.500.000', 'Wie viele Einwohner?', 'unsure'],
    ['1,5 Millionen', 'eineinhalb Millionen', 'Wie viele Einwohner?', 'correct'],
    ['Episode IV', 'vier', 'Welche Episode ist der erste Film?', 'unsure'],
    ['Episode IV (1977)', 'vier', 'Welche Episode ist der erste Film?', 'unsure'],
    ['1977 (USA), 1978 (Deutschland)', '1978', 'Wann kam der Film ins Kino?', 'unsure'],
    ['25. Mai 1977', '1979', 'In welchem Jahr kam der Film ins Kino?', 'wrong'],
    ['25. Mai 1977', '1977', 'In welchem Jahr kam der Film ins Kino?', 'correct'],
    ['25. Mai 1977', '1977', 'An welchem Tag kam der Film ins Kino?', 'not correct'],
    ['Rot 2', 'Rot Vier', 'Welches Rufzeichen hatte Wedge?', 'wrong', true],
    ['Apollo 11', 'Apollo elf', 'Welche Mission landete zuerst?', 'correct'],
    ['Apollo 11', 'Apollo 13', 'Welche Mission landete zuerst?', 'wrong'],
    ['Formel 1', 'Formel eins', 'Welche Rennserie?', 'correct'],
    ['1. Weltkrieg', 'Erster Weltkrieg', 'Welcher Krieg?', 'correct'],
    ['0', 'null', 'Wie viele Tore fielen?', 'correct'],
    ['Die drei Musketiere', 'Die 3 Musketiere', 'Welcher Roman?', 'correct'],
  ];
  /**
   * The table is for the cascade (rejectDissimilar false). With rejectDissimilar true (strategy "fuzzy") an answer the
   * number rules leave open may still be rejected as dissimilar, as before – there "unsure" only means "not correct"
   * and "not wrong" means "not wrong by a number rule".
   */
  it.each(cases)('%s ← %s (%s) → %s', async (reference, answer, question, expected, spoken) => {
    for (const rejectDissimilar of [false, true]) {
      for (const sp of spoken === undefined ? [false, true] : [spoken]) {
        const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
        const r = await j.judge({ question, reference, answer, spoken: sp });
        const label = `${reference} ← ${answer} (rejectDissimilar ${rejectDissimilar}, spoken ${sp}): ${r.verdict} ${r.reason ?? ''}`;
        // Strategy "fuzzy" still rejects a dissimilar answer – but never by the number rules.
        if (expected === 'not wrong' && rejectDissimilar) expect(r.reason, label).toMatch(/^unähnlich/);
        else if (expected === 'not wrong') expect(r.verdict, label).not.toBe('wrong');
        else if (expected === 'not correct' || (expected === 'unsure' && rejectDissimilar)) expect(r.verdict, label).not.toBe('correct');
        else expect(r.verdict, label).toBe(expected);
        if (expected === 'wrong' || expected === 'correct') expect(r.method, label).toBe('fuzzy');
      }
    }
  });

  it('gives the reasons the number rules stand for', async () => {
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    const reason = async (reference: string, answer: string, question = year) => (await j.judge({ question, reference, answer, spoken: true })).reason;
    expect(await reason('1977', 'neunzehnhundertneunundsiebzig')).toBe('falsche Zahl');
    expect(await reason('1977', 'siebenundsiebzig')).toBe('Kurzform des Jahres');
    expect(await reason('42,195 km', '42', 'Wie lang ist ein Marathon?')).toBe('gerundet');
    expect(await reason('25. Mai 1977', '1979')).toBe('falsches Jahr');
    expect(await reason('25. Mai 1977', '1977')).toBe('Jahr stimmt');
    expect(await reason('1989', '1987 1988 1989')).toBe('mehrere Zahlen');
    expect(await reason('1989', '1985 1986', 'Wann fiel die Mauer?')).toBe('falsche Zahlen');
  });

  it('the short form of a year counts only when the question asks for the year', async () => {
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'Wie viele Zuschauer (in Tausend)?', reference: '1977', answer: '77' })).verdict).toBe('wrong');
    expect((await j.judge({ question: 'Wann fiel die Mauer?', reference: '1989', answer: '89' })).verdict).toBe('correct');
  });

  it('a lone article is a number only if nothing else is said', async () => {
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'Wie viele Monde hat die Erde?', reference: '1', answer: 'einen' })).verdict).toBe('correct');
    expect((await j.judge({ question: 'Wie viele Monde hat die Erde?', reference: '2', answer: 'einen' })).verdict).toBe('wrong');
    expect((await j.judge({ question: 'Welche Episode?', reference: '4', answer: 'Eine neue Hoffnung' })).verdict).not.toBe('wrong');
  });

  it('a solution with several numbers alternatives: any of them is right, none of them wrong', async () => {
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'Wann?', reference: '1977 / 1978', answer: '1978' })).verdict).toBe('correct');
    expect((await j.judge({ question: 'Wann?', reference: '1977 / 1978', answer: '1979' })).verdict).toBe('wrong');
  });
});

// Review V1 of the number rules: a right answer is never wrong by these rules – in doubt the LLM decides.
describe('FuzzyJudge – numbers, review fixes', () => {
  const year = 'In welchem Jahr kam Star Wars ins Kino?';
  const verdicts = async (question: string, reference: string, answer: string, spoken?: boolean) => {
    const out: string[] = [];
    for (const rejectDissimilar of [false, true]) {
      for (const sp of spoken === undefined ? [false, true] : [spoken]) {
        const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
        const r = await j.judge({ question, reference, answer, spoken: sp });
        out.push(`${rejectDissimilar ? 'strict' : 'cascade'}${sp ? '/spoken' : ''}: ${r.verdict} ${r.reason ?? ''}`);
      }
    }
    return out;
  };
  /** Never wrong by a number rule (strategy "fuzzy" may still reject a dissimilar answer, as before). */
  const notWrongByNumber = async (question: string, reference: string, answer: string, spoken?: boolean) => {
    for (const line of await verdicts(question, reference, answer, spoken)) {
      expect(line, `${reference} ← ${answer}`).not.toMatch(/wrong (?:falsche|falsches)/);
      if (line.startsWith('cascade')) expect(line, `${reference} ← ${answer}`).not.toMatch(/wrong/);
    }
  };
  const all = async (question: string, reference: string, answer: string, expected: 'correct' | 'wrong', spoken?: boolean) => {
    for (const line of await verdicts(question, reference, answer, spoken)) expect(line, `${reference} ← ${answer}`).toMatch(new RegExp(`: ${expected} `));
  };

  it('the live case still holds: 1977 ← „neunzehnhundertneunundsiebzig“ wrong, „…siebenundsiebzig“ right', async () => {
    await all(year, '1977', 'neunzehnhundertneunundsiebzig', 'wrong', true);
    await all(year, '1977', 'neunzehnhundertsiebenundsiebzig', 'correct', true);
  });

  // B-F1: a second number of the note is no wrong answer.
  it.each([
    ['1977 (1978 in Deutschland)', '1978'],
    ['1977; in DE erst 1978', '1978'],
    ['Mai 1977 (Deutschland Februar 1978)', '1978'],
    ['Apollo 11 (1969)', 'Apollo 1969'],
  ])('B-F1: %s ← %s goes to the LLM, never wrong', async (reference, answer) => {
    await notWrongByNumber(year, reference, answer);
  });

  it('B-F1: a number the note does not name is still wrong', async () => {
    await all(year, '1977 (1978 in Deutschland)', '1979', 'wrong');
    await all(year, 'Mai 1977 (Deutschland Februar 1978)', '1979', 'wrong');
  });

  // B-F3: units have to agree when both sides name one.
  it.each([
    ['Wie lange?', '6 Tage', '6 Wochen'],
    ['Wie lange?', '90 Minuten', '90 Stunden'],
    ['Wie alt wurde sie?', '116 Jahre', '116 Tage'],
    ['Wie hoch?', '8848 m', '8848 km'],
  ])('B-F3: %s %s ← %s is not correct (other unit)', async (question, reference, answer) => {
    for (const line of await verdicts(question, reference, answer)) expect(line).not.toMatch(/correct/);
  });

  it.each([
    ['Wie lange dauert ein Fußballspiel?', '90 Minuten', '1,5 Stunden'],
    ['Wie lange dauert ein Fußballspiel?', '90 Minuten', 'Anderthalb Stunden'],
    ['Wie lang ist ein Marathon?', '42,195 km', '42195 Meter'],
  ])('B-F3: %s %s ← %s (conversion) is never wrong by a number rule', async (question, reference, answer) => {
    await notWrongByNumber(question, reference, answer);
  });

  it('B-F3: a unit on one side only still counts', async () => {
    await all('Wie lang ist ein Marathon?', '42,195 km', 'zweiundvierzig komma eins neun fünf', 'correct');
    await all('Wie lange?', '6 Tage', '6', 'correct');
    await all('Wie lange?', '6 Tage', '7', 'wrong');
    await all('Wie lange?', '6', '6 Tage', 'correct');
    await all('Wie lange?', '6 Tage', 'sechs Tage', 'correct');
  });

  // B-F4: one number said in several parts.
  it.each([
    ['Wie viele Einwohner?', '1,5 Millionen', 'eine Million fünfhunderttausend', true],
    ['Wann wurde die Mauer gebaut?', '1961', 'Neunzehn hunderteinundsechzig', true],
    ['Wie viele Zuschauer?', '12000', '12 000', undefined],
    ['Wie viele Einwohner?', '1500000', '1 500 000', undefined],
    [year, '1977', '19 77', undefined],
    [year, '1977', '19-77', undefined],
    [year, '1977', '1900 77', undefined],
    [year, '1977', 'neunzehnhundert 77', undefined],
    [year, '1977', '19 hundert 77', undefined],
    ['Wann?', '2014', '2 tausend 14', undefined],
  ])('B-F4: %s %s ← %s is never wrong by a number rule', async (question, reference, answer, spoken) => {
    await notWrongByNumber(question, reference, answer, spoken);
  });

  it('B-F4: merged forms are read as one number and decided', async () => {
    await all('Wie viele Einwohner?', '1,5 Millionen', 'eine Million fünfhunderttausend', 'correct', true);
    await all('Wann wurde die Mauer gebaut?', '1961', 'Neunzehn hunderteinundsechzig', 'correct', true);
    await all('Wann wurde die Mauer gebaut?', '1961', 'Neunzehn hundertzweiundsechzig', 'wrong', true);
    await all('Wann?', '2014', 'zwei tausendvierzehn', 'correct');
    // Several numbers that are no reading of the solution stay wrong.
    await all('Wann fiel die Mauer?', '1989', '1985 1986', 'wrong');
  });

  // B-F5: roundings to fewer decimal places go to the LLM, both ways.
  it.each([
    ['Wie lautet die Kreiszahl?', '3,14159', '3,14'],
    ['Wie lautet die Kreiszahl?', '3,14159', 'drei komma eins vier'],
    ['Wie lautet die Kreiszahl?', '3,14', '3,1416'],
    ['Wie lang ist ein Marathon?', '42,195 km', '42,2 km'],
    ['Wie lang ist ein Marathon?', '42,195 km', '42'],
  ])('B-F5: %s %s ← %s is unsure „gerundet“', async (question, reference, answer) => {
    for (const line of await verdicts(question, reference, answer)) expect(line).toMatch(/unsure gerundet/);
  });

  it('B-F5: a different value with fewer places is still wrong', async () => {
    await all('Wie lautet die Kreiszahl?', '3,14159', '3,2', 'wrong');
    await all('Wie lang ist ein Marathon?', '42,195 km', '43', 'wrong');
  });

  // B-F6: a word of the question next to the number says only the number.
  it.each([
    ['Wie viele Beine hat eine Spinne?', '8', 'Acht Beine'],
    ['Wie viele Ringe hat die olympische Flagge?', '5', 'fünf Ringe'],
    ['Wie viele Saiten hat eine Gitarre?', '6', 'sechs Saiten'],
    ['Wie viele Bundesländer hat Deutschland?', '16', 'Sechzehn Bundesländer'],
    ['Wie viele Bundesländer hat Deutschland?', '16', 'Ich sage sechzehn'],
  ])('B-F6: %s %s ← %s is right without LLM', async (question, reference, answer) => {
    await all(question, reference, answer, 'correct');
  });

  it('B-F6: a question word tells candidates apart unless the solution uses it', async () => {
    const q = 'Welcher Film kam zuerst: Rocky 4 oder Rambo 2?';
    for (const line of await verdicts(q, 'Rambo 2', 'Rocky 2')) expect(line).not.toMatch(/correct/);
    await all(q, 'Rambo 2', 'Rambo 4', 'wrong');
    await all('Wie viele Beine hat eine Spinne?', '8', 'sechs Beine', 'wrong');
  });

  // B-F7: the year in one word without "hundert".
  it('B-F7: „Neunzehnneunundsiebzig“ is 1979, „Neunzehnsiebenundsiebzig“ 1977', async () => {
    await all(year, '1977', 'Neunzehnneunundsiebzig', 'wrong', true);
    await all(year, '1977', 'Neunzehnsiebenundsiebzig', 'correct', true);
    await all('Wann wurde die Mauer gebaut?', '1961', 'Neunzehneinundsechzig', 'correct', true);
  });

  // B-F9: a dialogue dash from speech recognition is no minus.
  it('B-F9: spoken „- 1977“ is 1977; typed or without space it stays a minus', async () => {
    await all(year, '1977', '- 1977', 'correct', true);
    await all(year, '1977', '– 1977', 'correct', true);
    await all('Gefrierpunkt?', '-5', '-5', 'correct', true);
    const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
    expect((await j.judge({ question: 'Gefrierpunkt?', reference: '5', answer: '-5', spoken: true })).verdict).toBe('wrong');
  });
});

describe('FuzzyJudge – numbers, review fixes (open cases of the review closed)', () => {
  const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false });
  const v = async (question: string, reference: string, answer: string) => (await j.judge({ question, reference, answer, spoken: true })).verdict;

  it('digits after a word hundred/thousand: „2 tausend 14“, „neunzehnhundert 77“ (not „1900 77“)', async () => {
    expect(await v('Wann?', '2014', '2 tausend 14')).toBe('correct');
    expect(await v('In welchem Jahr?', '1977', 'neunzehnhundert 77')).toBe('correct');
    expect(await v('In welchem Jahr?', '1977', 'neunzehnhundert 79')).toBe('wrong');
    expect(await v('In welchem Jahr?', '1977', '1900 77')).toBe('unsure');
  });

  it('a month next to the year answers a question for the year – unless the solution names a month itself', async () => {
    expect(await v('In welchem Jahr kam der Film?', '1977', 'Mai 1977')).toBe('correct');
    expect(await v('In welchem Jahr kam der Film?', '1977', 'Mai 1979')).toBe('wrong');
    expect(await v('Wann kam der Film?', 'Mai 1977', 'Juni 1977')).not.toBe('correct');
    expect(await v('Wie viele Filme gab es?', '1977', 'Mai 1977')).not.toBe('correct'); // no question for the year
  });

  it('singular and plural of a question word: „ein Tor“ for „Wie viele Tore?“', async () => {
    expect(await v('Wie viele Tore fielen?', '1', 'ein Tor')).toBe('correct');
    expect(await v('Wie viele Tore fielen?', '2', 'ein Tor')).toBe('wrong');
  });
});

// Review V3 (delta): readings that are ambiguous go to the LLM – never a deterministic verdict on one of them.
describe('FuzzyJudge – numbers, review V3', () => {
  const both = (rejectDissimilar: boolean) => new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
  const lines = async (question: string, reference: string, answer: string, spoken = true) => {
    const out: string[] = [];
    for (const rd of [false, true]) {
      const r = await both(rd).judge({ question, reference, answer, spoken });
      out.push(`${rd ? 'strict' : 'cascade'}: ${r.verdict} ${r.reason ?? ''}`);
    }
    return out;
  };
  const neverDecidedByNumber = async (question: string, reference: string, answer: string, spoken = true) => {
    for (const l of await lines(question, reference, answer, spoken)) {
      expect(l, `${reference} ← ${answer}`).not.toMatch(/(?:wrong|correct) (?:falsche|falsches|Zahl stimmt|Jahr stimmt)/);
      if (l.startsWith('cascade')) expect(l, `${reference} ← ${answer}`).toMatch(/unsure/);
    }
  };

  // B-F10: "eine Million zwei" is 1 000 002 or the short form of 1,2 Millionen.
  it.each([
    ['1,2 Millionen', 'eine Million zwei'],
    ['1,5 Millionen', 'eine Million fünf'],
    ['3,7 Millionen', 'drei Millionen sieben'],
    ['1,5 Millionen', 'eine Million fünfhundert'],
    ['1000002', 'eine Million zwei'],
  ])('B-F10: %s ← „%s“ goes to the LLM', async (reference, answer) => {
    await neverDecidedByNumber('Wie viele Einwohner?', reference, answer);
  });

  it('B-F10: "eine Million fünfhunderttausend" stays one clear number', async () => {
    for (const l of await lines('Wie viele Einwohner?', '1,5 Millionen', 'eine Million fünfhunderttausend')) expect(l).toMatch(/correct/);
    for (const l of await lines('Wie viele Einwohner?', '1,2 Millionen', 'eine Million fünfhunderttausend')) expect(l).toMatch(/wrong/);
  });

  // B-F11: spoken "- 5" for a negative solution – dialogue dash or minus?
  it.each([
    ['-5', '- 5'],
    ['-5 Grad', '- 5 Grad'],
  ])('B-F11: %s ← spoken „%s“ is never wrong', async (reference, answer) => {
    for (const l of await lines('Wie kalt war es?', reference, answer)) expect(l).not.toMatch(/wrong/);
  });

  it('B-F11: both readings agree → decided; typed "- 5" is a minus as before', async () => {
    for (const l of await lines('Wie kalt war es?', '-5', '- 7')) expect(l).toMatch(/wrong/); // neither 7 nor -7
    for (const l of await lines('Wie kalt war es?', '-5', '- 5', false)) expect(l).toMatch(/correct/);
    for (const l of await lines('In welchem Jahr?', '1977', '- 1977')) expect(l).toMatch(/correct/); // B-F9 still holds
  });

  // B-F12: a number of the question said again next to the article.
  it('B-F12: „Finale 2014 ein Tor“ for 1 is never wrong', async () => {
    for (const l of await lines('Wie viele Tore fielen im Finale 2014?', '1', 'Finale 2014 ein Tor')) expect(l).not.toMatch(/wrong (?:falsche|falsches)/);
    for (const l of await lines('Wie viele Tore fielen im Finale 2014?', '1', 'Finale 2014 ein Tor')) if (l.startsWith('cascade')) expect(l).not.toMatch(/wrong/);
    for (const l of await lines('Wie viele Tore fielen im Finale?', '2', 'zwei Tore')) expect(l).toMatch(/correct/);
  });

  // B-F13: a bare number that the question names for two candidates.
  it('B-F13: „2“ for „Rocky 2 oder Rambo 2?“ is not right without the LLM; a clear answer still is', async () => {
    const q = 'Welcher Film kam zuerst: Rocky 2 oder Rambo 2?';
    for (const l of await lines(q, 'Rambo 2', '2')) expect(l).not.toMatch(/correct/);
    for (const l of await lines(q, 'Rambo 2', 'Rambo zwei')) expect(l).toMatch(/correct/);
    for (const l of await lines('Wie viele Beine hat eine Spinne?', '8', 'acht')) expect(l).toMatch(/correct/);
  });

  it('the live case still holds', async () => {
    for (const l of await lines('In welchem Jahr kam der erste Star-Wars-Film, Eine neue Hoffnung, in die US-Kinos?', '1977', 'neunzehnhundertneunundsiebzig')) {
      expect(l).toMatch(/wrong falsche Zahl/);
    }
  });
});
