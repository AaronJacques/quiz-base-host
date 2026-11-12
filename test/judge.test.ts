import { describe, expect, it } from 'vitest';
import { FuzzyJudge } from '../src/judge/fuzzy-judge.ts';
import { isNonAnswer, normalize, numbers, referenceVariants, similarity } from '../src/judge/normalize.ts';

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
