import { describe, expect, it } from 'vitest';
import { foldForNumbers, numberParts, numbers, parseNumberWord } from '../src/judge/normalize.ts';
import { numberTokens } from '../src/judge/number-words.ts';

describe('parseNumberWord: one whole token', () => {
  it.each([
    ['null', 0],
    ['eins', 1],
    ['ein', 1],
    ['zwei', 2],
    ['zwo', 2],
    ['elf', 11],
    ['zwoelf', 12],
    ['sechzehn', 16],
    ['siebzehn', 17],
    ['zwanzig', 20],
    ['einundzwanzig', 21],
    ['dreissig', 30],
    ['siebenundsiebzig', 77],
    ['neunundneunzig', 99],
    ['hundert', 100],
    ['einhundert', 100],
    ['hundertundeins', 101],
    ['hunderteins', 101],
    ['zweihundertdreiundvierzig', 243],
    ['neunhundertneunundneunzig', 999],
    ['tausend', 1000],
    ['eintausend', 1000],
    ['neunzehnhundertsiebenundsiebzig', 1977],
    ['neunzehnhundertneunundsiebzig', 1979],
    ['zweitausendfuenf', 2005],
    ['zweitausendundfuenf', 2005],
    ['zweitausendzwanzig', 2020],
    ['zweitausendzweiundzwanzig', 2022],
    ['neuntausendneunhundertneunundneunzig', 9999],
    ['zwoelftausend', 12000],
    ['hunderttausend', 100000],
    ['neunhundertneunundneunzigtausendneunhundertneunundneunzig', 999999],
    ['viermal', 4],
    ['one', 1],
    ['twelve', 12],
  ])('%s = %d', (word, value) => {
    expect(parseNumberWord(word)).toEqual({ value, ordinal: false, decimal: false });
  });

  it.each([
    ['erste', 1],
    ['ersten', 1],
    ['erster', 1],
    ['zweite', 2],
    ['zwote', 2],
    ['dritte', 3],
    ['vierte', 4],
    ['vierten', 4],
    ['siebte', 7],
    ['siebente', 7],
    ['achte', 8],
    ['achter', 8], // also the rowing boat – accepted on purpose (only counts where the other words agree)
    ['zehnte', 10],
    ['elfte', 11],
    ['zwoelfte', 12],
    ['dreizehnte', 13],
    ['neunzehnte', 19],
    ['zwanzigste', 20],
    ['einundzwanzigste', 21],
    ['hundertste', 100],
    ['hundertzweite', 102],
    ['hunderterste', 101],
    ['tausendste', 1000],
  ])('ordinal %s = %d', (word, value) => {
    expect(parseNumberWord(word)).toEqual({ value, ordinal: true, decimal: false });
  });

  it.each([
    ['eineinhalb', 1.5],
    ['anderthalb', 1.5],
    ['zweieinhalb', 2.5],
  ])('fraction %s = %d', (word, value) => {
    expect(parseNumberWord(word)).toEqual({ value, ordinal: false, decimal: true });
  });

  it.each(['dreite', 'einte', 'zwanzigte', 'zweiste', 'hundertnull', 'nullhundert', 'zweitausendtausend', 'einsundzwanzig', 'und', 'hundertund', ''])(
    '%s is no number word',
    (word) => expect(parseNumberWord(word)).toBeNull(),
  );
});

describe('numbers(): whole texts', () => {
  it.each([
    ['neunzehnhundertneunundsiebzig', [1979]],
    ['neunzehnhundertsiebenundsiebzig', [1977]],
    ['Neunzehnhundert-Siebenundsiebzig', [1977]],
    ['neunzehnhundert siebenundsiebzig', [1977]],
    ['neunzehnhundert und siebenundsiebzig', [1977]],
    ['neunzehn hundert sieben und siebzig', [1977]],
    ['neunzehn siebenundsiebzig', [1977]],
    ['zwanzig zwanzig', [2020]],
    ['sieben und siebzig', [77]],
    ['drei und vier', [3, 4]],
    ['zweitausend fünf', [2005]],
    ['zweitausend und fünf', [2005]],
    ['zweitausend neunhundert', [2900]],
    ['zweitausendzweiundzwanzig', [2022]],
    ['3 tausend', [3000]],
    ['Im Jahr 1977.', [1977]],
    ['1979 glaube ich', [1979]],
    ['19 77', [19, 77]], // digits are never joined to a year
    ['der vierte', [4]],
    ['4 Mal', [4]],
    ['zweiundvierzig komma eins neun fünf', [42.195]],
    ['eins komma fünf', [1.5]],
    ['zwei komma fünfzehn', [2.15]],
    ['null komma null fünf', [0.05]],
    ['1,5 Millionen', [1_500_000]],
    ['eineinhalb Millionen', [1_500_000]],
    ['eine Million', [1_000_000]],
    ['3 Mrd', [3e9]],
    ['1.500.000', [1_500_000]],
    ['tausend und eine Nacht', [1000, 1]],
    ['zwölftausend', [12000]],
    // old cases (test/judge.test.ts)
    ['vier', [4]],
    ['Deutschland gewann 4 mal', [4]],
    ['42,195 km (26,22 meilen)', [42.195, 26.22]],
    ['−7', [-7]],
    ['x = -7', [-7]],
    ['minus fünf', [-5]],
    ['minus neunzehnhundert', [-1900]],
    ['10-3', [10, 3]],
    ['1914 - 1918', [1914, 1918]],
    ['H2O', [2]],
  ])('%s → %j', (text, expected) => {
    expect(numbers(text)).toEqual(expected);
  });

  it.each([
    'Achtung',
    'Hundertwasser',
    'Elfmeter',
    'Dreieck',
    'Neunkirchen',
    'Siebengebirge',
    'Tausendfüßler',
    'Einhorn',
    'einfach',
    'Zweifel',
    'Elfen',
    'Zehntel',
    'Neuntel',
    'Dreier',
    'Vierer',
    'Zehner',
    'Hunderter',
    'Zwanziger',
    'Hälfte',
    'meisten',
    'Westen',
    'Ersteres',
    'Denkmal',
    'Achtel',
    'Sechser',
    'Elfer',
  ])('%s is no number', (text) => {
    expect(numbers(text)).toEqual([]);
  });
});

describe('numberTokens: flags', () => {
  const tok = (s: string) => numberTokens(foldForNumbers(s));

  it('marks ordinals, decimals, magnitudes and words', () => {
    expect(tok('4. Platz')[0]).toMatchObject({ value: 4, ordinal: true, words: false });
    expect(tok('Platz 4.')[0]).toMatchObject({ value: 4, ordinal: false }); // end of the sentence, no ordinal
    expect(tok('vierte')[0]).toMatchObject({ value: 4, ordinal: true, words: true });
    expect(tok('1,5')[0]).toMatchObject({ value: 1.5, decimal: true, ambiguous: false });
    expect(tok('eins komma fünf')[0]).toMatchObject({ value: 1.5, decimal: true, words: true });
    expect(tok('2 Millionen')[0]).toMatchObject({ value: 2e6, magnitude: true });
    expect(tok('1977')[0]).toMatchObject({ value: 1977, words: false, ordinal: false, decimal: false, magnitude: false });
  });

  it('"1.500" and "42.195" are ambiguous (thousands dot or decimal point), "1.500.000" and "1,5" are not', () => {
    expect(tok('1.500')[0]).toMatchObject({ value: 1.5, ambiguous: true });
    expect(tok('42.195')[0]).toMatchObject({ value: 42.195, ambiguous: true });
    expect(tok('1.500.000')[0]).toMatchObject({ value: 1_500_000, ambiguous: false });
    expect(tok('3.14')[0]).toMatchObject({ value: 3.14, ambiguous: false, decimal: true });
  });

  it('a lone article is marked, merged ones are not', () => {
    expect(tok('Eine neue Hoffnung')[0]).toMatchObject({ value: 1, article: true });
    expect(tok('einen')[0]).toMatchObject({ value: 1, article: true });
    expect(tok('eins')[0]).toMatchObject({ value: 1, article: false });
    expect(tok('eine Million')[0]).toMatchObject({ value: 1e6, article: false });
    expect(tok('ein und zwanzig')[0]).toMatchObject({ value: 21, article: false });
  });

  it('digits in a word are partial', () => {
    expect(tok('h2o')[0]).toMatchObject({ value: 2, partial: true });
    expect(tok('70er')[0]).toMatchObject({ value: 70, partial: true });
  });

  it('covers the tokens it was read from', () => {
    const { words, numbers: found } = numberParts('Im Jahr neunzehnhundert sieben und siebzig, glaube ich');
    expect(found).toHaveLength(1);
    expect(words.slice(found[0]!.from, found[0]!.to + 1)).toEqual(['neunzehnhundert', 'sieben', 'und', 'siebzig']);
    expect(tok('minus fünf')[0]).toMatchObject({ value: -5, from: 0, to: 1 });
  });

  it('foldForNumbers keeps "1,5" and "1.500" apart, normalize() does not', async () => {
    const { normalize } = await import('../src/judge/normalize.ts');
    expect(foldForNumbers('1,5 und 1.500')).toBe('1,5 und 1.500');
    expect(foldForNumbers('Paris, London')).toBe('paris london');
    expect(normalize('1,5')).toBe('1.5');
  });
});

describe('review fixes (B-F4, B-F7, B-F2)', () => {
  it.each([
    ['eine Million fünfhunderttausend', [1_500_000]],
    ['zwei Millionen dreihunderttausend fünfhundert', [2_300_500]],
    ['drei Millionen vier Millionen', [3_000_000, 4_000_000]],
    ['Neunzehn hunderteinundsechzig', [1961]],
    ['zwei tausendvierzehn', [2014]],
    ['Neunzehnneunundsiebzig', [1979]],
    ['Neunzehnsiebenundsiebzig', [1977]],
    ['zwanzigzwanzig', [2020]],
    ['zwanzigeins', []], // "…eins" < 10: no year form
    ['12 000', [12000]],
    ['1 500 000', [1_500_000]],
    ['19 77', [19, 77]],
    ['1977 1978', [1977, 1978]],
  ])('%s → %j', (text, expected) => {
    expect(numbers(text)).toEqual(expected);
  });

  it('digit groups with spaces and "1.500" are ambiguous and carry every reading', () => {
    const tok = (s: string) => numberTokens(foldForNumbers(s));
    expect(tok('12 000')[0]).toMatchObject({ value: 12000, ambiguous: true, readings: [[12000], [12, 0]], from: 0, to: 1 });
    expect(tok('1.500')[0]).toMatchObject({ value: 1.5, ambiguous: true, readings: [[1500], [1.5]] });
    expect(tok('1.500.000')[0]!.readings).toBeUndefined();
  });

  it.each(['Elfmeter', 'Zwanzigeins', 'Neunzehnte', 'Elfzig'])('%s is no year form', (w) => {
    const v = parseNumberWord(w.toLowerCase());
    expect(v === null || v.value <= 999, `${w} → ${v?.value}`).toBe(true);
  });
});
