import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { rulesText } from '../src/discord/format.ts';
import { applyRule, findRule, formatRuleValue, parseFactor, pickRules, scoreFor } from '../src/modes/tafelquiz/rules.ts';

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

  it('pick reminders and the pick hint: defaults, seconds, "aus"', () => {
    const g = base();
    expect([g.pickReminderSec, g.pickReminderRepeatSec, g.pickHint]).toEqual([90, 300, true]);
    expect(formatRuleValue(g, findRule('erinnerung')!)).toBe('90 s');
    expect(applyRule(g, findRule('erinnerung')!, 'aus')).toBeNull();
    expect(g.pickReminderSec).toBe(0);
    expect(formatRuleValue(g, findRule('erinnerung')!)).toBe('aus');
    expect(applyRule(g, findRule('erinnerungstakt')!, '0')).toBeNull();
    expect(g.pickReminderRepeatSec).toBe(0);
    expect(applyRule(g, findRule('erinnerungstakt')!, '120')).toBeNull();
    expect(g.pickReminderRepeatSec).toBe(120);
    expect(applyRule(g, findRule('kartenhinweis')!, 'aus')).toBeNull();
    expect(g.pickHint).toBe(false);
    expect(applyRule(g, findRule('erinnerung')!, '2')).toMatch(/oder "aus"/);
    // Answer times cannot be switched off.
    expect(applyRule(g, findRule('zeit')!, 'aus')).toMatch(/Sekunden/);
  });

  it('pause after a correct answer: 0 to 30 s with one decimal, German format', () => {
    const g = base();
    expect([g.revealPauseSolvedSec, g.revealPauseSec]).toEqual([1.5, 4]);
    const spec = findRule('pause')!;
    expect(findRule('richtigpause')).toBe(spec);
    expect(spec.key).toBe('revealPauseSolvedSec');
    expect(formatRuleValue(g, spec)).toBe('1,5 s');
    for (const [input, value] of [['2,5', 2.5], ['1.5', 1.5], ['2', 2], ['0', 0], ['30', 30], ['0,25', 0.3], ['3 s', 3]] as const) {
      expect(applyRule(g, spec, input), input).toBeNull();
      expect(g.revealPauseSolvedSec, input).toBe(value);
    }
    expect(formatRuleValue(g, spec)).toBe('3 s');
    expect(applyRule(g, spec, '0,5')).toBeNull();
    expect(formatRuleValue(g, spec)).toBe('0,5 s');
    for (const bad of ['31', '30,1', '-1', 'aus', 'lang', '1,5,5']) {
      expect(applyRule(g, spec, bad), bad).toBe(`"${bad}": bitte Sekunden zwischen 0 und 30 (z.B. 1,5).`);
    }
    expect(g.revealPauseSolvedSec).toBe(0.5); // invalid input changes nothing
  });

  it('the older seconds rules keep 5–600, whole seconds and "aus" where they had it', () => {
    const g = base();
    for (const name of ['zeit', 'buzzerzeit', 'buzzerantwortzeit']) {
      const spec = findRule(name)!;
      expect([spec.min, spec.max, spec.decimal, spec.off], name).toEqual([undefined, undefined, undefined, undefined]);
      expect(applyRule(g, spec, '4'), name).toBe('"4": bitte Sekunden zwischen 5 und 600.');
      expect(applyRule(g, spec, '601'), name).toBe('"601": bitte Sekunden zwischen 5 und 600.');
      expect(applyRule(g, spec, '0'), name).toMatch(/zwischen 5 und 600\.$/);
      expect(applyRule(g, spec, '7,5'), name).toBeNull();
      expect(g[spec.key], name).toBe(7); // whole seconds, as before
      expect(formatRuleValue(g, spec), name).toBe('7 s');
    }
    for (const name of ['erinnerung', 'erinnerungstakt']) {
      const spec = findRule(name)!;
      expect(applyRule(g, spec, '4'), name).toBe('"4": bitte Sekunden zwischen 5 und 600 oder "aus".');
      expect(applyRule(g, spec, 'aus'), name).toBeNull();
      expect(formatRuleValue(g, spec), name).toBe('aus');
    }
  });
});

describe('voice rules: grace for "Ja" and the submission at the deadline (package C)', () => {
  it('defaults: 8 s grace, auto submission on; config limits 0–20 s', () => {
    const g = base();
    expect([g.confirmGraceSec, g.confirmAtDeadline]).toEqual([8, true]);
    expect(ConfigSchema.parse({}).voice.minConfirmSpeechMs).toBe(250);
    expect(() => ConfigSchema.parse({ game: { confirmGraceSec: 21 } })).toThrow();
    expect(ConfigSchema.parse({ game: { confirmGraceSec: 0 } }).game.confirmGraceSec).toBe(0);
  });

  it('regel nachfrist 5 / aus, regel autoabgabe aus', () => {
    const g = base();
    const grace = findRule('nachfrist')!;
    expect(findRule('jazeit')).toBe(grace);
    expect(grace.key).toBe('confirmGraceSec');
    expect(formatRuleValue(g, grace)).toBe('8 s');
    expect(applyRule(g, grace, '5')).toBeNull();
    expect(g.confirmGraceSec).toBe(5);
    expect(applyRule(g, grace, 'aus')).toBeNull();
    expect(g.confirmGraceSec).toBe(0);
    expect(formatRuleValue(g, grace)).toBe('aus');
    expect(applyRule(g, grace, '0')).toBeNull();
    expect(g.confirmGraceSec).toBe(0);
    for (const bad of ['21', '-1', 'lang']) expect(applyRule(g, grace, bad), bad).toBe(`"${bad}": bitte Sekunden zwischen 1 und 20 oder "aus".`);
    expect(applyRule(g, grace, '20')).toBeNull();
    expect(g.confirmGraceSec).toBe(20);

    const auto = findRule('autoabgabe')!;
    expect(auto.key).toBe('confirmAtDeadline');
    expect(formatRuleValue(g, auto)).toBe('an');
    expect(applyRule(g, auto, 'aus')).toBeNull();
    expect(g.confirmAtDeadline).toBe(false);
    expect(formatRuleValue(g, auto)).toBe('aus');
    expect(applyRule(g, auto, 'vielleicht')).toMatch(/"an" oder "aus"/);
  });

  it('`regeln` lists both, and both are persisted with the other adjustable rules', () => {
    const g = { ...base(), confirmGraceSec: 5, confirmAtDeadline: false };
    const text = rulesText(g, '!quiz');
    expect(text).toContain('• Nachfrist für das „Ja“ (Sprache): **5 s**  `nachfrist`');
    expect(text).toContain('• Unbestätigte Antwort bei Zeitende werten (Sprache): **aus**  `autoabgabe`');
    expect(pickRules(g)).toMatchObject({ confirmGraceSec: 5, confirmAtDeadline: false });
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
