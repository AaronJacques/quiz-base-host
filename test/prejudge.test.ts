import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ConfigSchema } from '../src/config.ts';
import { EventBus, type HostEvents } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { CascadeJudge, type CascadeStage } from '../src/judge/cascade-judge.ts';
import { createJudge, JudgeCache, LlmJudge, type JudgeInput, type JudgeKit, type JudgeResult } from '../src/judge/index.ts';
import { JUDGE_RULES_VERSION } from '../src/judge/llm-judge.ts';
import { UsageMeter, type JsonRequest, type JsonResponse, type LlmClient } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel('error');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await tick(5);
  }
  throw new Error('timeout');
}

/** LLM whose answers the test releases one by one (`release`), or that fails (`fail`). */
class GateLlm implements LlmClient {
  readonly name = 'gate';
  calls: { prompt: string; system: string; done: boolean; resolve: (correct: boolean, reason?: string) => void; reject: (e: Error) => void }[] = [];
  completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> {
    return new Promise((res, rej) => {
      const call = {
        prompt: req.prompt,
        system: req.system ?? '',
        done: false,
        resolve: (correct: boolean, reason = 'GEHEIMER-GRUND') => ((call.done = true), res({ data: { correct, reason } as z.infer<S>, costUsd: 0.0001, ms: 1 })),
        reject: (e: Error) => ((call.done = true), rej(e)),
      };
      this.calls.push(call);
    });
  }
  answers(): string[] {
    return this.calls.map((c) => c.prompt.match(/Antwort des Spielers: (.*)/)?.[1] ?? '?');
  }
}

describe('CascadeJudge.prejudge', () => {
  /** fuzzy-like stage (always unsure), a counting "LLM" stage, a counting operator stage. */
  function cascade(llm: (i: JudgeInput) => Promise<JudgeResult>) {
    const calls = { llm: 0, operator: 0 };
    const stages: CascadeStage[] = [
      { name: 'fuzzy', judge: { judge: async () => ({ verdict: 'unsure', method: 'fuzzy', confidence: 0 }) } },
      { name: 'llm', cache: true, judge: { judge: (i) => (calls.llm++, llm(i)) } },
      { name: 'operator', interactive: true, judge: { judge: async () => (calls.operator++, { verdict: 'correct', method: 'operator', confidence: 1 }) } },
    ];
    return { judge: new CascadeJudge(stages, null), calls };
  }
  const input = (answer: string, scope = 'q1|Anna'): JudgeInput => ({ question: 'Pins?', reference: '10', answer, spoken: true, scope });

  it('"Ja" takes the early result: one LLM call, also when "Ja" comes before it is done', async () => {
    let release!: () => void;
    const { judge, calls } = cascade(() => new Promise((r) => (release = () => r({ verdict: 'wrong', method: 'llm', confidence: 0.9 }))));
    const pre = judge.prejudge(input('Kegel'));
    await tick();
    expect(calls.llm).toBe(1);
    const final = judge.judge(input('Kegel')); // "Ja" before the LLM answered: waits for the same call
    await tick(20);
    release();
    await pre;
    expect((await final).verdict).toBe('wrong');
    expect(calls).toEqual({ llm: 1, operator: 0 });
  });

  it('unsure early → "Ja" goes straight on to the operator: still one LLM call', async () => {
    const { judge, calls } = cascade(async () => ({ verdict: 'unsure', method: 'llm', confidence: 0 }));
    await judge.prejudge(input('Kegel'));
    expect(calls).toEqual({ llm: 1, operator: 0 }); // never the operator before "Ja"
    expect((await judge.judge(input('Kegel'))).method).toBe('operator');
    expect(calls).toEqual({ llm: 1, operator: 1 });
  });

  it('a failed early call is tried again at "Ja", as today', async () => {
    let n = 0;
    const { judge, calls } = cascade(async () => {
      if (n++ === 0) throw new Error('timeout');
      return { verdict: 'correct', method: 'llm', confidence: 0.9 };
    });
    await judge.prejudge(input('Kegel'));
    expect((await judge.judge(input('Kegel'))).verdict).toBe('correct');
    expect(calls).toEqual({ llm: 2, operator: 0 });
  });

  it('never counts for another answer, player, question or a judgement without scope', async () => {
    const { judge, calls } = cascade(async () => ({ verdict: 'correct', method: 'llm', confidence: 0.9 }));
    await judge.prejudge(input('Kegel'));
    await judge.judge(input('Pins'));
    await judge.judge(input('Kegel', 'q1|Ben'));
    await judge.judge(input('Kegel', 'q2|Anna'));
    await judge.judge({ ...input('Kegel'), scope: undefined });
    expect(calls.llm).toBe(5);
    await judge.judge(input('Kegel')); // the right scope still finds it
    expect(calls.llm).toBe(5);
  });

  it('A1: at most two early LLM calls per question and player; a third replaced answer is judged at "Ja"', async () => {
    const { judge, calls } = cascade(async () => ({ verdict: 'wrong', method: 'llm', confidence: 0.9 }));
    for (const a of ['Lyon', 'Marseille', 'Nizza']) await judge.prejudge(input(a));
    expect(calls.llm).toBe(2); // Lyon, Marseille – Nizza waits for "Ja"
    await judge.judge(input('Nizza'));
    expect(calls.llm).toBe(3); // the one call at "Ja", as before the feature
    // Another player of the same question has a budget of their own.
    await judge.prejudge(input('Lyon', 'q1|Ben'));
    expect(calls.llm).toBe(4);
  });

  it('is used once: a second judge of the same input asks again', async () => {
    const { judge, calls } = cascade(async () => ({ verdict: 'correct', method: 'llm', confidence: 0.9 }));
    await judge.prejudge(input('Kegel'));
    await judge.judge(input('Kegel'));
    await judge.judge(input('Kegel'));
    expect(calls.llm).toBe(2);
  });

  it('logs nothing about the answer on info before "Ja", the usual line after it', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      const { judge } = cascade(async () => ({ verdict: 'wrong', method: 'llm', confidence: 0.9, reason: 'GEHEIMER-GRUND' }));
      await judge.prejudge(input('Kegel'));
      expect(lines.join('')).toBe('');
      await judge.judge(input('Kegel'));
      expect(lines.join('')).toContain('llm: "Kegel" → wrong');
      expect(lines.join('')).not.toContain('GEHEIMER-GRUND');
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
  });

  it('books early LLM calls as "prejudge" in the usage meter', async () => {
    const meter = new UsageMeter();
    const llm = new GateLlm();
    const lj = new LlmJudge(llm, meter);
    const p = lj.judge({ question: 'Q', reference: 'R', answer: 'A', prefetch: true });
    llm.calls[0]!.resolve(true);
    await p;
    const q = lj.judge({ question: 'Q', reference: 'R', answer: 'A' });
    llm.calls[1]!.resolve(true);
    await q;
    expect(meter.byPurpose).toEqual({ prejudge: 1, judge: 1 });
  });
});

describe('TafelquizController: judging starts while "Paris?" waits for "Ja"', () => {
  const QUESTIONS = [
    [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
    [{ category: 'Film', points: 200, text: 'Wie viele Episoden hat die Skywalker-Saga?', note: '9' }],
  ];

  function setup(opts: { kit?: JudgeKit; buzzer?: boolean } = {}) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbpre-'));
    const config = ConfigSchema.parse({
      game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 30, buzzWindowSec: 1, buzzAnswerTimeoutSec: 30, buzzerOnWrong: !!opts.buzzer },
      judge: { cacheFile: path.join(tmp, 'cache.json') },
      llm: { provider: 'none' },
    });
    const bus = new EventBus();
    const page = new FakeTafelquizPage(['Anna', 'Ben'], QUESTIONS);
    const llm = new GateLlm();
    const meter = new UsageMeter();
    const judge = opts.kit ?? createJudge(config, bus, llm, meter);
    const controller = new TafelquizController({ page, bus, judge, game: config.game, pollMs: 20 });
    // Protocol of everything on the bus.
    const events: { ev: string; payload: unknown }[] = [];
    const emit = bus.emit.bind(bus);
    (bus as { emit: typeof bus.emit }).emit = (ev, payload) => {
      events.push({ ev, payload });
      emit(ev, payload);
    };
    let asked: string | null = null;
    bus.on('host:await-answer', (a) => (asked = a.player));
    let turns = 0;
    bus.on('host:turn', ({ player, open }) => {
      if (turns++ > 0) return void page.endGame();
      setTimeout(() => bus.emit('player:pick', { player, col: open[0]!.col, row: open[0]!.row }), 5);
    });
    const verdicts: HostEvents['host:verdict'][] = [];
    bus.on('host:verdict', (v) => verdicts.push(v));
    const ac = new AbortController();
    const start = () => controller.run(ac.signal);
    const waitAsked = async (who = 'Anna') => {
      await until(() => asked === who);
      asked = null;
    };
    const pending = (answer: string, player = 'Anna') => bus.emit('player:answer-pending', { player, answer });
    const answer = (answer: string, player = 'Anna', spoken = true) => bus.emit('player:answer', { player, answer, spoken });
    return { bus, page, llm, meter, controller, events, verdicts, ac, start, waitAsked, pending, answer, judge, config };
  }

  it('starts at the ask-back and "Ja" uses the same result: one LLM call, booked as prejudge', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('Kegel');
    await until(() => t.llm.calls.length === 1);
    t.llm.calls[0]!.resolve(false);
    await tick(10);
    expect(t.verdicts).toHaveLength(0); // nothing before "Ja"
    t.answer('Kegel');
    await until(() => t.verdicts.length === 1);
    expect(t.verdicts[0]!.correct).toBe(false);
    expect(t.llm.calls).toHaveLength(1);
    expect(t.meter.byPurpose).toEqual({ prejudge: 1 });
    await run;
  });

  it('"Ja" before the early call is done waits for it', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('Kegel');
    await until(() => t.llm.calls.length === 1);
    t.answer('Kegel');
    await tick(50);
    expect(t.verdicts).toHaveLength(0);
    t.llm.calls[0]!.resolve(true);
    await until(() => t.verdicts.length === 1);
    expect(t.verdicts[0]!.correct).toBe(true);
    expect(t.llm.calls).toHaveLength(1);
    await run;
  });

  it('a replaced answer is not used; at most one early call at a time, the newest answer next', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('Kegel');
    await until(() => t.llm.calls.length === 1);
    t.pending('Bowlingkugel'); // "Nein" + new answer while the first one runs
    t.pending('Pins');
    await tick(30);
    expect(t.llm.calls).toHaveLength(1); // never two at once
    t.llm.calls[0]!.resolve(true); // "Kegel" would be right – but it is not the answer any more
    await until(() => t.llm.calls.length === 2);
    expect(t.llm.answers()).toEqual(['Kegel', 'Pins']); // the newest, "Bowlingkugel" is skipped
    t.llm.calls[1]!.resolve(false);
    t.answer('Pins');
    await until(() => t.verdicts.length === 1);
    expect(t.verdicts[0]).toMatchObject({ answer: 'Pins', correct: false });
    expect(t.llm.calls).toHaveLength(2);
    await run;
  });

  it('A1: replaced three times → two early calls, and one at "Ja" for the last answer', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    for (const [i, a] of ['Kegel', 'Kugel', 'Bahn'].entries()) {
      t.pending(a);
      if (i < 2) {
        await until(() => t.llm.calls.length === i + 1);
        t.llm.calls[i]!.resolve(false);
      }
      await tick(20);
    }
    expect(t.llm.answers()).toEqual(['Kegel', 'Kugel']);
    t.answer('Bahn');
    await until(() => t.llm.calls.length === 3);
    t.llm.calls[2]!.resolve(false);
    await until(() => t.verdicts.length === 1);
    expect(t.llm.answers()).toEqual(['Kegel', 'Kugel', 'Bahn']);
    expect(t.meter.byPurpose).toEqual({ prejudge: 2, judge: 1 });
    await run;
  });

  it('A1: back to an answer judged early within the budget: "Ja" needs no call at all', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('Kegel');
    await until(() => t.llm.calls.length === 1);
    t.llm.calls[0]!.resolve(false);
    await tick(20);
    t.pending('Kugel');
    await until(() => t.llm.calls.length === 2);
    t.llm.calls[1]!.resolve(false);
    await tick(20);
    t.pending('Kegel'); // the cache knows it now
    await tick(20);
    t.answer('Kegel');
    await until(() => t.verdicts.length === 1);
    expect(t.llm.calls).toHaveLength(2);
    await run;
  });

  it('a failed early call: "Ja" asks the LLM again, like today', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('Kegel');
    await until(() => t.llm.calls.length === 1);
    t.llm.calls[0]!.reject(new Error('timeout'));
    await tick(10);
    t.answer('Kegel');
    await until(() => t.llm.calls.length === 2);
    t.llm.calls[1]!.resolve(true);
    await until(() => t.verdicts.length === 1);
    expect(t.verdicts[0]!.correct).toBe(true);
    await run;
  });

  it('no early call for typed answers, for answers without letters or digits, or when fuzzy decides', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('…?');
    t.pending('zehn'); // fuzzy: right, no LLM
    await tick(30);
    expect(t.llm.calls).toHaveLength(0);
    t.answer('Kegel', 'Anna', false); // typed: judged only now
    await until(() => t.llm.calls.length === 1);
    t.llm.calls[0]!.resolve(false);
    await until(() => t.verdicts.length === 1);
    expect(t.meter.byPurpose).toEqual({ judge: 1 });
    await run;
  });

  it('the game ends or the question is skipped while the early call runs: no verdict, nothing on the bus from it', async () => {
    for (const how of ['end', 'skip'] as const) {
      const t = setup();
      const run = t.start();
      await t.waitAsked();
      t.pending('Kegel');
      await until(() => t.llm.calls.length === 1);
      const mark = t.events.length;
      if (how === 'end') t.ac.abort();
      else t.bus.emit('operator:command', { command: 'skip', args: [] });
      await tick(30);
      t.llm.calls[0]!.resolve(true);
      await run;
      expect(t.verdicts).toHaveLength(0);
      const after = t.events.slice(mark).map((e) => e.ev);
      expect(after).not.toContain('host:verdict');
      expect(JSON.stringify(t.events)).not.toContain('GEHEIMER-GRUND');
    }
  });

  it('another player (buzzer) answering the same: never waits for or takes the early judgement of the first', async () => {
    const t = setup({ buzzer: true });
    t.bus.on('host:say', ({ text }) => text.startsWith('🔔 Buzzer frei') && setTimeout(() => t.page.buzz('Ben'), 10));
    const run = t.start();
    await t.waitAsked('Anna');
    t.pending('Kegel'); // Anna's early call never comes back
    await until(() => t.llm.calls.length === 1);
    t.answer('Pins'); // Anna confirms another answer instead
    await until(() => t.llm.calls.length === 2);
    t.llm.calls[1]!.resolve(false);
    await t.waitAsked('Ben');
    t.answer('Kegel', 'Ben'); // the same text as Anna's pending one – Ben's own call
    await until(() => t.llm.calls.length === 3);
    t.llm.calls[2]!.resolve(true);
    await until(() => t.verdicts.length === 2);
    expect(t.verdicts.map((v) => [v.player, v.correct])).toEqual([
      ['Anna', false],
      ['Ben', true],
    ]);
    await run;
  });

  it('a new game with the same judge and the same question never takes the old game\'s early judgement', async () => {
    const first = setup();
    const run1 = first.start();
    await first.waitAsked();
    first.pending('Kegel'); // never answered
    await until(() => first.llm.calls.length === 1);
    first.ac.abort();
    await run1;
    const second = setup({ kit: first.judge });
    const run2 = second.start();
    await second.waitAsked();
    second.answer('Kegel');
    await until(() => first.llm.calls.length === 2); // asked again (the shared fake LLM of the first game's kit)
    first.llm.calls[1]!.resolve(false);
    await until(() => second.verdicts.length === 1);
    await run2;
  });

  it('a wrong number word is wrong without the LLM, already at the ask-back ("neun" for 10)', async () => {
    const t = setup();
    const run = t.start();
    await t.waitAsked();
    t.pending('neun');
    await tick(30);
    t.answer('neun');
    await until(() => t.verdicts.length === 1);
    expect(t.verdicts[0]!.correct).toBe(false);
    expect(t.llm.calls).toHaveLength(0);
    expect(t.meter.byPurpose).toEqual({});
    await run;
  });

  it('only the controller listens to player:answer-pending', async () => {
    const t = setup();
    const count = () => (t.bus as unknown as { emitter: { listenerCount(e: string): number } }).emitter.listenerCount('player:answer-pending');
    const run = t.start();
    await t.waitAsked();
    expect(count()).toBe(1);
    t.answer('zehn');
    await until(() => t.verdicts.length === 1);
    expect(count()).toBe(0);
    await run;
  });
});

// Numbers decide without the LLM; the LLM gets the parsed values for the cases left to it (rules R0–R3, cache v5).
describe('judging numbers in the cascade', () => {
  const year = 'In welchem Jahr kam der erste Star-Wars-Film, Eine neue Hoffnung, in die US-Kinos?';
  function kit(cacheContent?: object) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbnum-'));
    const cacheFile = path.join(tmp, 'cache.json');
    if (cacheContent) writeFileSync(cacheFile, JSON.stringify(cacheContent));
    const config = ConfigSchema.parse({ judge: { cacheFile }, llm: { provider: 'none' } });
    const llm = new GateLlm();
    const meter = new UsageMeter();
    return { kit: createJudge(config, new EventBus(), llm, meter), llm, meter, cacheFile };
  }

  it('1977 ← "neunzehnhundertneunundsiebzig" (live case 2026-11-20) is wrong by fuzzy – the LLM is never asked, not even early', async () => {
    const { kit: k, llm, meter } = kit();
    const input: JudgeInput = { question: year, reference: '1977', answer: 'neunzehnhundertneunundsiebzig', spoken: true, scope: 'q1|Marvin' };
    await k.judge.prejudge!(input);
    const r = await k.judge.judge(input);
    expect(r).toMatchObject({ verdict: 'wrong', method: 'fuzzy', reason: 'falsche Zahl' });
    expect((await k.judge.judge({ ...input, answer: 'neunzehnhundertsiebenundsiebzig' })).verdict).toBe('correct');
    expect(llm.calls).toHaveLength(0);
    expect(meter.byPurpose).toEqual({});
  });

  it('"42" for 42,195 km goes to the LLM with the parsed values', async () => {
    const { kit: k, llm } = kit();
    const p = k.judge.judge({ question: 'Wie lang ist ein Marathon?', reference: '42,195 km', answer: '42' });
    await until(() => llm.calls.length === 1);
    expect(llm.calls[0]!.prompt).toContain('Zahlenwerte (automatisch gelesen): Antwort 42 | Lösung 42,195');
    llm.calls[0]!.resolve(true);
    expect((await p).verdict).toBe('correct');
  });

  it('the number hint names no lone articles and writes numbers without grouping (a grouped "12.000" would be unclear)', async () => {
    const { numberHint } = await import('../src/judge/llm-judge.ts');
    expect(numberHint('neunzehnhundertneunundsiebzig', '1977')).toBe('Zahlenwerte (automatisch gelesen): Antwort 1979 | Lösung 1977');
    expect(numberHint('Eine neue Hoffnung', 'Episode IV')).toBeNull();
    expect(numberHint('anderthalb Millionen', '1.500.000')).toBe('Zahlenwerte (automatisch gelesen): Antwort 1500000 | Lösung 1500000');
    expect(numberHint('Paris', 'Paris')).toBeNull();
  });

  // Review B-F2: "12.000" is left to the LLM because it is unclear – the hint must not hand it one (wrong) reading.
  it.each([
    ['zwölftausend', '12.000', 'Antwort 12000 | Lösung 12000 oder 12'],
    ['1500', '1.500', 'Antwort 1500 | Lösung 1500 oder 1,5'],
    ['fünfundzwanzigtausend', '25.000', 'Antwort 25000 | Lösung 25000 oder 25'],
    ['12000', '12 000', 'Antwort 12000 | Lösung 12000 oder 12 und 0'],
  ])('B-F2: hint for %s ← %s names both readings', async (answer, reference, expected) => {
    const { numberHint } = await import('../src/judge/llm-judge.ts');
    const hint = numberHint(answer, reference)!;
    expect(hint).toBe(`Zahlenwerte (automatisch gelesen): ${expected}`);
    expect(hint).not.toMatch(/Lösung (?:12|1,5|25)$/);
  });

  it('B-F2: the LLM prompt for 12.000 ← zwölftausend never says "Lösung 12" alone', async () => {
    const { kit: k, llm } = kit();
    const p = k.judge.judge({ question: 'Wie viele Zuschauer?', reference: '12.000', answer: 'zwölftausend' });
    await until(() => llm.calls.length === 1);
    expect(llm.calls[0]!.prompt).toContain('Lösung 12000 oder 12');
    expect(llm.calls[0]!.prompt).not.toMatch(/Lösung 12$/m);
    llm.calls[0]!.resolve(true);
    await p;
  });

  // L-F1: the hint made day and explanation numbers look required („Lösung 1, 1939, 2“).
  it('L-F1: the hint names the year of a date, not the day, and no numbers of the explanation', async () => {
    const { numberHint } = await import('../src/judge/llm-judge.ts');
    const note = '1. September 1939 - In Europa begann der Zweite Weltkrieg am 1. September 1939 mit dem von Adolf Hitler befohlenen Überfall auf Polen.';
    expect(numberHint('1939', note, true)).toBe('Zahlenwerte (automatisch gelesen): Antwort 1939 | Lösung 1939');
    expect(numberHint('1. September 1939', '1939')).toBe('Zahlenwerte (automatisch gelesen): Antwort 1939 | Lösung 1939');
    expect(numberHint('der 4. Platz', '4')).toBe('Zahlenwerte (automatisch gelesen): Antwort 4 | Lösung 4'); // an ordinal that is no day stays
  });

  it('L-F1: the prompt says the year is enough for "Wann"/"In welchem Jahr" – rules version 5', async () => {
    expect(JUDGE_RULES_VERSION).toBe(5);
    const { kit: k, llm } = kit();
    // A note fuzzy leaves open (two years) – the LLM gets the rule with it.
    const p = k.judge.judge({ question: 'Wann begann der Krieg?', reference: '1939 in Europa, 1937 in Asien', answer: '1939' });
    await until(() => llm.calls.length === 1);
    expect(llm.calls[0]!.prompt).toContain('Lösung 1939, 1937');
    expect(llm.calls[0]!.system).toContain('Mehr Genauigkeit als gefragt ist nie nötig');
    expect(llm.calls[0]!.system).toContain('genügt das richtige Jahr');
    llm.calls[0]!.resolve(true);
    await p;
  });

  it('B-F10/B-F11: the hint names both readings of "eine Million zwei" and of spoken "- 5" for a negative solution', async () => {
    const { numberHint } = await import('../src/judge/llm-judge.ts');
    expect(numberHint('eine Million zwei', '1,2 Millionen', true)).toBe('Zahlenwerte (automatisch gelesen): Antwort 1000002 oder 1200000 | Lösung 1200000');
    expect(numberHint('- 5', '-5', true)).toBe('Zahlenwerte (automatisch gelesen): Antwort 5 oder -5 | Lösung -5');
  });

  it('B-F9: a dialogue dash before a spoken answer is no minus, also in the hint', async () => {
    const { numberHint } = await import('../src/judge/llm-judge.ts');
    expect(numberHint('- 1977', '1977', true)).toBe('Zahlenwerte (automatisch gelesen): Antwort 1977 | Lösung 1977');
    expect(numberHint('-5', '5', true)).toBe('Zahlenwerte (automatisch gelesen): Antwort -5 | Lösung 5');
  });

  it('verdict keys carry rule version 5; createJudge removes older verdicts once and keeps the solutions', async () => {
    expect(JUDGE_RULES_VERSION).toBe(5);
    const old = {
      verdicts: {
        'v3s␟in welchem jahr␟1977␟neunzehnhundertneunundsiebzig': { verdict: 'correct', method: 'llm', confidence: 0.9 },
        'v3␟frage␟paris␟paris': { verdict: 'correct', method: 'llm', confidence: 0.9 },
        // live 2026-11-22 (rules v4): "1939" for the WW2 note judged wrong by the LLM – removed with v5
        'v4s␟wann begann der 2. weltkrieg␟1. september 1939␟1939': { verdict: 'wrong', method: 'llm', confidence: 0.9 },
        'v5␟frage␟paris␟pariss': { verdict: 'correct', method: 'llm', confidence: 0.9 },
        'v5s␟frage␟paris␟parie': { verdict: 'correct', method: 'llm', confidence: 0.9 },
      },
      solutions: { 's2␟bildfrage␟img:https://x/y.png': { answer: 'Paris', confidence: 0.9 } },
    };
    const { kit: k, llm, cacheFile } = kit(old);
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(Object.keys(saved.verdicts)).toEqual(['v5␟frage␟paris␟pariss', 'v5s␟frage␟paris␟parie']);
    expect(saved.solutions).toEqual(old.solutions);
    // A new verdict is stored under v5.
    const p = k.judge.judge({ question: 'Hauptstadt?', reference: 'Paris', answer: 'Lutetia' });
    await until(() => llm.calls.length === 1);
    llm.calls[0]!.resolve(true);
    await p;
    const keys = Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')).verdicts);
    expect(keys.filter((key) => key.includes('lutetia'))).toEqual(['v5␟hauptstadt␟paris␟lutetia']);
  });

  it('B-F8: prune keeps the verdicts of the game master (operator) – they do not depend on the judging rules', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbprune-'));
    const cache = new JudgeCache(path.join(tmp, 'cache.json'));
    cache.setVerdict('v3␟q␟paris␟lutetia', { verdict: 'correct', method: 'operator', confidence: 1 });
    cache.setVerdict('v3␟q␟paris␟rom', { verdict: 'wrong', method: 'llm', confidence: 0.9 });
    expect(cache.prune(4)).toBe(1);
    expect(cache.getVerdict('v3␟q␟paris␟lutetia')?.method).toBe('operator');
    expect(cache.getVerdict('v3␟q␟paris␟rom')).toBeUndefined();
  });

  it('B-F8: the log line says "andere Regelversion" (prune also removes higher versions)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      kit({ verdicts: { 'v6␟q␟a␟b': { verdict: 'correct', method: 'llm', confidence: 0.9 } }, solutions: {} });
      expect(lines.join('')).toContain(`Bewertungs-Cache: 1 alte Urteile (andere Regelversion als ${JUDGE_RULES_VERSION}) entfernt`);
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
  });

  it('JudgeCache.prune: removes other versions only, writes only if something was removed', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbprune-'));
    const file = path.join(tmp, 'cache.json');
    const cache = new JudgeCache(file);
    expect(cache.prune(4)).toBe(0);
    expect(() => readFileSync(file)).toThrow(); // nothing removed → nothing written
    cache.setVerdict('v3s␟q␟1977␟neunzehnhundertneunundsiebzig', { verdict: 'correct', method: 'llm', confidence: 0.9 });
    cache.setVerdict('v4s␟q␟1977␟neunzehnhundertneunundsiebzig', { verdict: 'wrong', method: 'llm', confidence: 0.9 });
    cache.setVerdict('v40␟q␟a␟b', { verdict: 'wrong', method: 'llm', confidence: 0.9 }); // "v40" is not "v4"
    cache.setSolution('s2␟q␟img:x', { answer: 'A', confidence: 1 });
    expect(cache.prune(4)).toBe(2);
    expect(cache.getVerdict('v4s␟q␟1977␟neunzehnhundertneunundsiebzig')?.verdict).toBe('wrong');
    expect(cache.getVerdict('v3s␟q␟1977␟neunzehnhundertneunundsiebzig')).toBeUndefined();
    expect(new JudgeCache(file).getSolution('s2␟q␟img:x')).toEqual({ answer: 'A', confidence: 1 });
  });
});
