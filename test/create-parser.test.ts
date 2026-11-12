import { describe, expect, it } from 'vitest';
import { defaultSpec } from '../src/boardgen/spec.ts';
import { ConfigSchema } from '../src/config.ts';
import { parseCreateArgs } from '../src/discord/create-parser.ts';

const base = defaultSpec(ConfigSchema.parse({}), '');
const parse = (t: string) => parseCreateArgs(t, base);

describe('parseCreateArgs', () => {
  it('nur Thema → Standardwerte', () => {
    const { spec, force, publicAsked } = parse('Star Wars');
    expect(spec).toMatchObject({ topic: 'Star Wars', categories: 4, rows: 4, step: 100, boards: 1, level: 'kneipe', language: 'de', mcShare: 0, name: null });
    expect(force).toBe(false);
    expect(publicAsked).toBe(false);
  });

  it('Aufbau, Niveau, Boards, MC, Sprache', () => {
    const { spec } = parse('Star Wars 5x3 profi 2 boards mc 25% sprache en');
    expect(spec).toMatchObject({ topic: 'Star Wars', categories: 5, rows: 3, level: 'profi', boards: 2, mcShare: 0.25, language: 'en' });
  });

  it('„öffentlich“/„privat“ gehören nicht zum Thema; öffentlich wird nur gemerkt (quiz-base speichert Entwürfe)', () => {
    const pub = parse('Star Wars öffentlich');
    expect(pub.spec.topic).toBe('Star Wars');
    expect(pub.publicAsked).toBe(true);
    expect(parse('Star Wars privat')).toMatchObject({ spec: { topic: 'Star Wars' }, publicAsked: false });
  });

  it('ausgeschriebene Varianten', () => {
    expect(parse('Tiere 6 kategorien 5 stufen kinder englisch').spec).toMatchObject({ topic: 'Tiere', categories: 6, rows: 5, level: 'kinder', language: 'en' });
    expect(parse('Tiere kategorien drei fragen zwei').spec).toMatchObject({ categories: 3, rows: 2 });
    expect(parse('Tiere 3 x 2 schritt 200').spec).toMatchObject({ categories: 3, rows: 2, step: 200 });
    expect(parse('Erdkunde schule klasse 5-7').spec).toMatchObject({ topic: 'Erdkunde', level: 'schule' });
    expect(parse('Musik mc').spec.mcShare).toBe(0.25);
    expect(parse('Musik mc 0.5').spec.mcShare).toBe(0.5);
    expect(parse('Musik multiple choice 40%').spec.mcShare).toBe(0.4);
  });

  it('Name und Themenbereiche als Freitext', () => {
    const { spec } = parse('Star Wars 4x4; name: Krieg der Sterne; themen: Jedi, Raumschiffe, Planeten');
    expect(spec.topic).toBe('Star Wars');
    expect(spec.name).toBe('Krieg der Sterne');
    expect(spec.themes).toEqual(['Jedi', 'Raumschiffe', 'Planeten']);
    expect(parse('Filme name „Kino-Abend“ profi').spec).toMatchObject({ topic: 'Filme', name: 'Kino-Abend', level: 'profi' });
    expect(parse('Filme themen: Horror und Komödie').spec.themes).toEqual(['Horror', 'Komödie']);
  });

  it('nochmal erzwingt einen neuen Entwurf', () => {
    expect(parse('Star Wars nochmal').force).toBe(true);
    expect(parse('Star Wars neu').force).toBe(true);
    expect(parse('Neue Deutsche Welle').spec.topic).toBe('Neue Deutsche Welle');
  });
});
