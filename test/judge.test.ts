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
    ['Apollo 11', 'Apollo 13'],
    ['Rocky 2', 'Rocky 4'],
    ['Kenia', 'Guinea'],
    ['Hamburg', 'Homburg'],
  ])('does not accept %s ← spoken %s by sound alone', async (reference, answer) => {
    for (const rejectDissimilar of [false, true]) {
      const j = new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar });
      expect((await j.judge({ question: 'q', reference, answer, spoken: true })).verdict).toBe('unsure');
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
