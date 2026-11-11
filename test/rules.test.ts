import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { scoreFor } from '../src/modes/tafelquiz/rules.ts';

const game = ConfigSchema.parse({}).game;

describe('scoreFor', () => {
  it('uses quiz-base classic rules by default', () => {
    expect(scoreFor(400, true, false, game)).toBe(400);
    expect(scoreFor(400, false, false, game)).toBe(-200);
    expect(scoreFor(300, false, true, game)).toBe(-150);
  });

  it('supports house rules', () => {
    expect(scoreFor(400, false, false, { ...game, wrongPenalty: 0 })).toBe(-0);
    expect(scoreFor(400, false, true, { ...game, penalizeBuzzers: false })).toBe(0);
    expect(scoreFor(400, false, false, { ...game, wrongPenalty: 1 })).toBe(-400);
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
