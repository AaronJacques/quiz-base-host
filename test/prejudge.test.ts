import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ConfigSchema } from '../src/config.ts';
import { EventBus, type HostEvents } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { CascadeJudge, type CascadeStage } from '../src/judge/cascade-judge.ts';
import { createJudge, LlmJudge, type JudgeInput, type JudgeKit, type JudgeResult } from '../src/judge/index.ts';
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
  calls: { prompt: string; done: boolean; resolve: (correct: boolean, reason?: string) => void; reject: (e: Error) => void }[] = [];
  completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> {
    return new Promise((res, rej) => {
      const call = {
        prompt: req.prompt,
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
      game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, answerTimeoutSec: 30, buzzWindowSec: 1, buzzAnswerTimeoutSec: 30, buzzerOnWrong: !!opts.buzzer },
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
