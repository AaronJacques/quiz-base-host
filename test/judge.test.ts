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
  });
});
