import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { applyRule, findRule, formatRuleValue, parseFactor, scoreFor } from '../src/modes/tafelquiz/rules.ts';

const base = () => ConfigSchema.parse({}).game;

describe('scoreFor', () => {
  it('uses quiz-base classic rules by default', () => {
    const g = base();
    expect(scoreFor(400, true, false, g)).toBe(400);
    expect(scoreFor(400, false, false, g)).toBe(-200);
    expect(scoreFor(300, false, true, g)).toBe(-150);
    expect(scoreFor(300, true, true, g)).toBe(300);
  });

  it('supports house rules', () => {
    expect(scoreFor(400, false, false, { ...base(), wrongFactor: 0 })).toBe(-0);
    expect(scoreFor(400, false, true, { ...base(), buzzerWrongFactor: 0 })).toBe(-0);
    expect(scoreFor(400, false, false, { ...base(), wrongFactor: 1 })).toBe(-400);
    expect(scoreFor(100, true, true, { ...base(), buzzerCorrectFactor: 0.5 })).toBe(50);
    expect(scoreFor(100, false, false, { ...base(), wrongFactor: 0.25 })).toBe(-25);
  });
});

describe('rule parsing', () => {
  it.each([
    ['50%', 0.5], ['0,5', 0.5], ['1/2', 0.5], ['halb', 0.5], ['100', 1], ['2x', 2], ['nichts', 0], ['0', 0], ['25', 0.25],
  ])('parseFactor(%s) = %s', (input, expected) => expect(parseFactor(input)).toBe(expected));

  it('applies and formats rules by German names', () => {
    const g = base();
    expect(applyRule(g, findRule('minus')!, '0')).toBeNull();
    expect(g.wrongFactor).toBe(0);
    expect(formatRuleValue(g, findRule('falsch')!)).toBe('kein Abzug');
    expect(applyRule(g, findRule('buzzer')!, 'aus')).toBeNull();
    expect(g.buzzerOnWrong).toBe(false);
    expect(applyRule(g, findRule('zeit')!, '30')).toBeNull();
    expect(g.answerTimeoutSec).toBe(30);
    expect(applyRule(g, findRule('zeit')!, '2')).toMatch(/Sekunden/);
    expect(applyRule(g, findRule('plus')!, 'viel')).toMatch(/Faktor/);
  });
});

describe('config', () => {
  it('has working defaults without a file', () => {
    const c = ConfigSchema.parse({});
    expect(c.browser.driver).toBe('playwright');
    expect(c.llm.model).toBe('haiku');
    expect(c.judge.strategy).toBe('cascade');
  });
});
