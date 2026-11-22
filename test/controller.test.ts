import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { EventBus, type HostEvents } from '../src/core/events.ts';
import { setLogLevel, sleep } from '../src/core/logger.ts';
import { CascadeJudge } from '../src/judge/cascade-judge.ts';
import { FuzzyJudge } from '../src/judge/fuzzy-judge.ts';
import { createJudge, JudgeCache, type JudgeKit } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { FakeTafelquizPage, type FakeQuestion } from './fake-page.ts';

setLogLevel('error');

function setup(overrides: Record<string, unknown> = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbhost-'));
  const config = ConfigSchema.parse({
    game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 1, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, ...overrides },
    judge: { cacheFile: path.join(tmp, 'cache.json') },
    browser: { pollMs: 100 },
    llm: { provider: 'none' },
  });
  const bus = new EventBus();
  const page = new FakeTafelquizPage(
    ['Anna', 'Ben'],
    [
      [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
      [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine https://x.y' }],
    ],
  );
  const judge = createJudge(config, bus, null, new UsageMeter());
  const controller = new TafelquizController({ page, bus, judge, game: config.game, pollMs: 20 });
  const said: string[] = [];
  bus.on('host:say', ({ text }) => said.push(text));
  return { bus, page, controller, said };
}

describe('TafelquizController', () => {
  it('plays a full game: pick → answer → judge → points → next turn → end', async () => {
    const { bus, page, controller } = setup();

    bus.on('host:turn', ({ player, open }) => {
      setTimeout(() => bus.emit('player:pick', { player, col: open[0]!.col, row: open[0]!.row }), 5);
    });
    bus.on('host:await-answer', ({ player }) => {
      const answer = player === 'Anna' ? 'zehn' : 'auf tatooine';
      setTimeout(() => bus.emit('player:answer', { player, answer }), 5);
    });

    await controller.run(new AbortController().signal);

    expect(page.phase).toBe('results');
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(100);
    expect(page.players.find((p) => p.name === 'Ben')!.score).toBe(200);
    expect(page.log).toContain('animate Richtig');
  }, 10000);

  it('wrong answer → penalty → buzzer round → other player scores', async () => {
    const { bus, page, controller } = setup();
    let first = true;
    bus.on('host:turn', ({ player, open }) => {
      if (!first) {
        // end the test game after the first question
        void page.endGame();
        return;
      }
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    bus.on('host:await-answer', ({ player, viaBuzzer }) => {
      setTimeout(() => bus.emit('player:answer', { player, answer: viaBuzzer ? '10' : '5' }), 5);
    });
    bus.on('host:say', ({ text }) => {
      if (text.startsWith('🔔 Buzzer frei')) setTimeout(() => page.buzz('Ben'), 20);
    });

    await controller.run(new AbortController().signal);

    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(-50);
    expect(page.players.find((p) => p.name === 'Ben')!.score).toBe(100);
    expect(page.log).toContain('releaseBuzzer');
  }, 10000);

  it('operator can override a verdict', async () => {
    const { bus, page, controller } = setup({ buzzerOnWrong: false });
    let first = true;
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    bus.on('host:await-answer', () => setTimeout(() => bus.emit('operator:command', { command: 'r', args: [] }), 5));

    await controller.run(new AbortController().signal);
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(100);
  }, 10000);

  it('timeout counts as wrong', async () => {
    const { bus, page, controller } = setup({ buzzerOnWrong: false });
    let first = true;
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 1, row: 0 }), 5);
    });
    await controller.run(new AbortController().signal);
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(-100);
  }, 10000);
});

// Independent games with real timers: concurrent, so this file (the suite's longest) does not get slower.
describe.concurrent('TafelquizController: pause between reveal and closing the card', () => {
  /** Plays one question and returns the ms between `host:reveal` and the close click. */
  async function pauseAfterReveal(answer: string, opts: { game?: Record<string, unknown>; abortOnReveal?: boolean } = {}) {
    const { bus, page, controller } = setup({ buzzerOnWrong: false, revealPauseSec: 0.8, revealPauseSolvedSec: 0.1, ...opts.game });
    const ac = new AbortController();
    let first = true;
    let revealedAt = 0;
    let closedAt = 0;
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    bus.on('host:await-answer', ({ player }) => setTimeout(() => bus.emit('player:answer', { player, answer }), 5));
    bus.on('host:reveal', () => {
      revealedAt = Date.now();
      if (opts.abortOnReveal) setTimeout(() => ac.abort(), 50);
    });
    const close = page.closeQuestion;
    page.closeQuestion = () => {
      closedAt = Date.now();
      return close();
    };
    await controller.run(ac.signal);
    return { ms: closedAt - revealedAt, revealedAt, closedAt, page };
  }

  it('solved: short pause (revealPauseSolvedSec)', async () => {
    const { ms } = await pauseAfterReveal('zehn');
    expect(ms).toBeGreaterThanOrEqual(90);
    expect(ms).toBeLessThan(600);
  }, 10000);

  it('not solved: long pause (revealPauseSec)', async () => {
    const { ms } = await pauseAfterReveal('5');
    expect(ms).toBeGreaterThanOrEqual(780);
  }, 10000);

  it('stopping the game during the pause ends it at once and clicks nothing', async () => {
    const { revealedAt, closedAt, page } = await pauseAfterReveal('zehn', { game: { revealPauseSolvedSec: 20 }, abortOnReveal: true });
    expect(revealedAt).toBeGreaterThan(0);
    expect(closedAt).toBe(0);
    expect(page.log).not.toContain('close');
    expect(Date.now() - revealedAt).toBeLessThan(2000); // not the 20 s pause
  }, 10000);
});

describe('TafelquizController – stale turn marker', () => {
  it('announces the next player by rotation when quiz-base still shows the previous one', async () => {
    const { bus, page, controller } = setup({ buzzerOnWrong: false });
    page.staleTurnDisplay = true;
    const turns: string[] = [];
    bus.on('host:turn', ({ player, open }) => {
      turns.push(player);
      if (!open.length) return void page.endGame();
      setTimeout(() => bus.emit('player:pick', { player, col: open[0]!.col, row: open[0]!.row }), 5);
    });
    const answered: string[] = [];
    bus.on('host:await-answer', ({ player }) => {
      answered.push(player);
      setTimeout(() => bus.emit('player:answer', { player, answer: answered.length === 1 ? 'zehn' : 'tatooine' }), 5);
    });
    await controller.run(new AbortController().signal);
    expect(turns.slice(0, 2)).toEqual(['Anna', 'Ben']);
    expect(answered).toEqual(['Anna', 'Ben']); // the one who picked is the one who answers
  }, 20000);
});

describe('TafelquizController – stale turn marker after opening the card (F20)', () => {
  it('asks the player who picked, not the previous one quiz-base still shows', async () => {
    const { bus, page, controller } = setup({ buzzerOnWrong: false });
    page.staleTurnDisplay = true;
    page.staleAfterOpenMs = 3000; // "Am Zug" stays at Anna for a while after Ben opened his card
    const asked: string[] = [];
    bus.on('host:turn', ({ player, open }) => {
      if (!open.length) return void page.endGame();
      setTimeout(() => bus.emit('player:pick', { player, col: open[0]!.col, row: open[0]!.row }), 5);
    });
    bus.on('host:await-answer', ({ player }) => {
      asked.push(player);
      setTimeout(() => bus.emit('player:answer', { player, answer: asked.length === 1 ? 'zehn' : 'tatooine' }), 5);
    });
    await controller.run(new AbortController().signal);
    expect(asked).toEqual(['Anna', 'Ben']);
    expect(page.players.find((p) => p.name === 'Ben')!.score).toBe(200);
  }, 20000);
});

describe('TafelquizController – game ended mid-question (F6)', () => {
  it('gives no verdict, no points and clicks nothing after the end while waiting for the answer', async () => {
    const { bus, page, controller } = setup({ answerTimeoutSec: 5 });
    const ac = new AbortController();
    const events: string[] = [];
    bus.on('host:verdict', () => events.push('verdict'));
    bus.on('host:reveal', () => events.push('reveal'));
    bus.on('host:turn', ({ player }) => setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5));
    let clicksAtEnd = -1;
    bus.on('host:await-answer', () =>
      setTimeout(() => {
        ac.abort(); // what GameSession.endGame() does first
        clicksAtEnd = page.log.length;
        void page.endGame();
      }, 50),
    );
    await controller.run(ac.signal);
    expect(events).toEqual([]);
    expect(page.log.slice(clicksAtEnd)).toEqual(['endGame']);
    expect(page.players.every((p) => p.score === 0)).toBe(true);
  }, 10000);

  it('drops a verdict that arrives after the end (judge still thinking)', async () => {
    const { bus, page } = setup();
    const ac = new AbortController();
    const base = createJudge(ConfigSchema.parse({ llm: { provider: 'none' }, judge: { cacheFile: path.join(mkdtempSync(path.join(os.tmpdir(), 'qbhost-')), 'c.json') } }), bus, null, new UsageMeter());
    const slow: JudgeKit = { ...base, judge: { judge: async () => (await new Promise((r) => setTimeout(r, 300)), { verdict: 'correct', method: 'llm', confidence: 1 }) } };
    const game = ConfigSchema.parse({ game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 5 } }).game;
    const controller = new TafelquizController({ page, bus, judge: slow, game, pollMs: 20 });
    page.phase = 'board';
    const events: string[] = [];
    bus.on('host:verdict', () => events.push('verdict'));
    bus.on('host:turn', ({ player }) => setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5));
    bus.on('host:await-answer', ({ player }) => setTimeout(() => bus.emit('player:answer', { player, answer: 'zehn' }), 5));
    let clicksAtEnd = -1;
    bus.on('player:answer', () => setTimeout(() => ((clicksAtEnd = page.log.length), ac.abort()), 100));
    await controller.run(ac.signal);
    expect(events).toEqual([]);
    expect(page.log.slice(clicksAtEnd)).toEqual([]);
    expect(page.players.every((p) => p.score === 0)).toBe(true);
  }, 10000);
});

describe('TafelquizController – buzzer window (F11)', () => {
  it('opens the window once and ends it on time although someone who already answered keeps buzzing', async () => {
    const { bus, page, controller } = setup({ buzzWindowSec: 1 });
    let opens = 0;
    let noBuzz = 0;
    let spam: NodeJS.Timeout | undefined;
    let first = true;
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    bus.on('host:await-answer', ({ player }) => setTimeout(() => bus.emit('player:answer', { player, answer: '5' }), 5));
    bus.on('host:notice', (n) => {
      if (n.kind === 'buzzer-open') {
        opens++;
        spam = setInterval(() => page.buzz('Anna'), 30); // Anna already answered and hits space again and again
      }
      if (n.kind === 'no-buzz') {
        noBuzz++;
        clearInterval(spam);
      }
    });
    const t0 = Date.now();
    await controller.run(new AbortController().signal);
    clearInterval(spam);
    expect(opens).toBe(1);
    expect(noBuzz).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(-50);
  }, 10000);

  it('lets the game leader skip the buzzer round (F12)', async () => {
    const { bus, page, controller } = setup({ buzzWindowSec: 30 });
    let first = true;
    const reveals: (string | null)[] = [];
    bus.on('host:reveal', ({ answer }) => reveals.push(answer));
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    bus.on('host:await-answer', ({ player }) => setTimeout(() => bus.emit('player:answer', { player, answer: '5' }), 5));
    bus.on('host:notice', (n) => {
      if (n.kind === 'buzzer-open') setTimeout(() => bus.emit('operator:command', { command: 'skip', args: [] }), 20);
    });
    const t0 = Date.now();
    await controller.run(new AbortController().signal);
    expect(reveals).toEqual(['10']);
    expect(Date.now() - t0).toBeLessThan(5000); // not the 30 s window
  }, 10000);
});

/** A page with music and picture questions without notes, a fake vision solver and a real cache. */
function mediaSetup(questions: FakeQuestion[], cacheFile: string) {
  const bus = new EventBus();
  const page = new FakeTafelquizPage(['Anna', 'Ben'], questions.map((q) => [q]));
  page.phase = 'board';
  const cache = new JudgeCache(cacheFile);
  const solver = {
    calls: 0,
    async solve(_q: string, _images: unknown[], hints: string[]) {
      this.calls++;
      const title = hints.find((h) => h.startsWith('Audio-Titel: '));
      return { answer: title ? title.slice('Audio-Titel: '.length).split(' - ')[1]! : 'Mario', confidence: 0.9 };
    },
  };
  const judge: JudgeKit = { judge: new CascadeJudge([{ name: 'fuzzy', judge: new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: true }) }], cache), solver: solver as never, cache };
  const game = ConfigSchema.parse({ game: { buzzerOnWrong: false, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 2, autoplayAudio: false } }).game;
  const answers = questions.map((q) => (q.audio ? q.audio.split(' - ')[1]! : 'Mario'));
  bus.on('host:turn', (t) => (t.open.length ? setTimeout(() => bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row }), 5) : void page.endGame()));
  bus.on('host:await-answer', (a) => setTimeout(() => bus.emit('player:answer', { player: a.player, answer: answers[page.open!.col]! }), 5));
  const verdicts: boolean[] = [];
  const reveals: (string | null)[] = [];
  bus.on('host:verdict', (v) => verdicts.push(v.correct));
  bus.on('host:reveal', (r) => reveals.push(r.answer));
  const controller = new TafelquizController({ page, bus, judge, game, pollMs: 20 });
  return { bus, page, cache, solver, controller, verdicts, reveals };
}

describe('TafelquizController – solution cache (F3)', () => {
  const songs: FakeQuestion[] = [
    { category: 'Musik', points: 100, text: 'Welcher Song ist das?', note: null, audio: 'Queen - Bohemian Rhapsody' },
    { category: 'Musik', points: 100, text: 'Welcher Song ist das?', note: null, audio: 'ABBA - Waterloo' },
    { category: 'Bild', points: 100, text: 'Wer ist das?', note: null, images: ['data:'] },
  ];

  it('keys derived solutions by the audio track and never caches media without identity', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'qbhost-')), 'c.json');
    // An entry under the old key (question text only) must not be used any more.
    new JudgeCache(file).setSolution('welcher song ist das␟', { answer: 'Bohemian Rhapsody', confidence: 0.9 });

    const a = mediaSetup(songs, file);
    await a.controller.run(new AbortController().signal);
    expect(a.reveals).toEqual(['Bohemian Rhapsody', 'Waterloo', 'Mario']);
    expect(a.verdicts).toEqual([true, true, true]);
    expect(a.solver.calls).toBe(3);

    // Next game with the same board: both songs come from the cache, the data: picture is solved again.
    const b = mediaSetup(songs, file);
    await b.controller.run(new AbortController().signal);
    expect(b.reveals).toEqual(['Bohemian Rhapsody', 'Waterloo', 'Mario']);
    expect(b.solver.calls).toBe(1);
  }, 20000);

  it('builds keys from text, every image and the audio title – null without stable identity', () => {
    const none = { imageUrls: [], audio: { present: false, title: null } };
    expect(JudgeCache.solutionKey('Welcher Song?', { imageUrls: [], audio: { present: true, title: 'ABBA - Waterloo' } })).toContain('audio:ABBA - Waterloo');
    expect(JudgeCache.solutionKey('Wer?', { imageUrls: ['https://x/a.png', 'https://x/b.png'], audio: none.audio })).toContain('img:https://x/b.png');
    expect(JudgeCache.solutionKey('Wer?', { imageUrls: ['data:'], audio: none.audio })).toBeNull();
    expect(JudgeCache.solutionKey('Welcher Song?', { imageUrls: [], audio: { present: true, title: null } })).toBeNull();
    expect(JudgeCache.solutionKey('Wer?', none)).not.toBe('wer␟');
    // Verdicts without reference depend on the media too.
    expect(JudgeCache.verdictKey('Welcher Song?', null, 'Waterloo', { media: 'audio:A' })).not.toBe(JudgeCache.verdictKey('Welcher Song?', null, 'Waterloo', { media: 'audio:B' }));
    expect(JudgeCache.verdictKey('Wer?', null, 'Mario', { media: null })).toBeNull();
    expect(JudgeCache.verdictKey('Wer?', 'Mario', 'Mario', { media: null })).not.toBeNull();
  });
});

describe('TafelquizController – log secrecy (F16)', () => {
  it('keeps the LLM-derived solution out of the info log until the reveal', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      const m = mediaSetup([{ category: 'Musik', points: 100, text: 'Welcher Song ist das?', note: null, audio: 'Queen - Bohemian Rhapsody' }], path.join(mkdtempSync(path.join(os.tmpdir(), 'qbhost-')), 'c.json'));
      let atReveal = -1;
      m.bus.on('host:reveal', () => (atReveal = lines.length));
      await m.controller.run(new AbortController().signal);
      expect(atReveal).toBeGreaterThan(0);
      expect(lines.join('')).toContain('Lösung per LLM bestimmt');
      // Only the player's own answer may appear before the reveal (the judge logs what was answered).
      const beforeReveal = lines.slice(0, atReveal).join('').replace(/fuzzy: "Bohemian Rhapsody"[^\n]*/g, '');
      expect(beforeReveal).not.toContain('Bohemian Rhapsody');
    } finally {
      setLogLevel('error');
      spy.mockRestore();
    }
  }, 10000);
});

describe('TafelquizController – multiple choice (Schulwissen board)', () => {
  const options = [
    { letter: 'A', label: 'leicht', correct: false },
    { letter: 'B', label: 'schwer', correct: false },
    { letter: 'C', label: 'riesig', correct: false },
    { letter: 'D', label: 'klein', correct: true },
  ];
  const mc = (text: string): FakeQuestion => ({ category: '1. Klasse', points: 100, text, note: null, options });

  it('shows the options without the solution, judges letters without LLM and reveals letter + text', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbhost-'));
    const config = ConfigSchema.parse({
      game: { autoStart: true, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 2, buzzerOnWrong: false },
      judge: { cacheFile: path.join(tmp, 'cache.json') },
      llm: { provider: 'none' },
    });
    const bus = new EventBus();
    const page = new FakeTafelquizPage(['Anna', 'Ben'], [[mc('Gegenteil von groß?')], [mc('Gegenteil von groß (2)?')]]);
    page.phase = 'board';
    const judge = createJudge(config, bus, null, new UsageMeter());
    const controller = new TafelquizController({ page, bus, judge, game: config.game, pollMs: 20 });
    const shown: string[][] = [];
    const verdicts: { player: string; correct: boolean }[] = [];
    const reveals: (string | null)[] = [];
    bus.on('host:question', (q) => shown.push(q.options));
    bus.on('host:verdict', (v) => verdicts.push({ player: v.player, correct: v.correct }));
    bus.on('host:reveal', (r) => reveals.push(r.answer));
    bus.on('host:notice', (n) => n.kind === 'operator-needed' && bus.emit('operator:command', { command: 'f', args: [] }));
    bus.on('host:turn', (t) => (t.open.length ? setTimeout(() => bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row }), 5) : void page.endGame()));
    bus.on('host:await-answer', (a) => setTimeout(() => bus.emit('player:answer', { player: a.player, answer: a.player === 'Anna' ? 'D' : 'B' }), 5));

    await controller.run(new AbortController().signal);

    expect(shown).toEqual([['leicht', 'schwer', 'riesig', 'klein'], ['leicht', 'schwer', 'riesig', 'klein']]);
    expect(verdicts).toEqual([{ player: 'Anna', correct: true }, { player: 'Ben', correct: false }]);
    expect(reveals).toEqual(['D) klein', 'D) klein']);
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(100);
    expect(page.players.find((p) => p.name === 'Ben')!.score).toBe(-50);
  }, 10000);
});

// Reported 12.11.2026: last question of "Schulwissen 1. - 12. Klasse", played alone. The player typed "D", the bot
// said wrong (the LLM read "D Neutralisation richtig" and decided "D nennt keinen Begriff"), the reveal showed D.
describe('TafelquizController – letter answer on the last multiple-choice question (live report)', () => {
  const question: FakeQuestion = {
    category: '12. Klasse',
    points: 1200,
    text: 'Wie nennt man den Vorgang, bei dem eine Säure und eine Base miteinander reagieren und typischerweise Wasser entsteht?',
    note: null,
    options: [
      { letter: 'A', label: 'Addition', correct: false },
      { letter: 'B', label: 'Reduktion', correct: false },
      { letter: 'C', label: 'Division', correct: false },
      { letter: 'D', label: 'Neutralisation', correct: true },
    ],
  };

  async function play(answer: string, optionsDelayMs: number) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbhost-'));
    const bus = new EventBus();
    const page = new FakeTafelquizPage(['Aaron'], [[question]]);
    page.phase = 'board';
    page.autoResults = true; // quiz-base shows the results by itself after the last card
    page.optionsDelayMs = optionsDelayMs;
    // An LLM stage that would get it wrong, as it did live – it must not be asked.
    const llm = { calls: 0, async judge() { this.calls++; return { verdict: 'wrong' as const, method: 'llm' as const, confidence: 0.9, reason: 'D nennt keinen Begriff' }; } };
    const cache = new JudgeCache(path.join(tmp, 'c.json'));
    const judge: JudgeKit = {
      judge: new CascadeJudge([{ name: 'fuzzy', judge: new FuzzyJudge({ acceptThreshold: 0.86, rejectThreshold: 0.35, rejectDissimilar: false }) }, { name: 'llm', judge: llm, cache: true }], cache),
      solver: null,
      cache,
    };
    const game = ConfigSchema.parse({ game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 2 } }).game;
    const controller = new TafelquizController({ page, bus, judge, game, pollMs: 20 });
    const out = { verdicts: [] as { answer: string; correct: boolean; delta: number }[], reveals: [] as (string | null)[], over: null as null | { name: string; score: number }[], shown: [] as string[][] };
    bus.on('host:turn', (t) => t.open.length && setTimeout(() => bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row }), 5));
    bus.on('host:question', (q) => out.shown.push(q.options));
    bus.on('host:await-answer', (a) => setTimeout(() => bus.emit('player:answer', { player: a.player, answer }), 5));
    bus.on('host:verdict', (v) => out.verdicts.push({ answer: v.answer, correct: v.correct, delta: v.delta }));
    bus.on('host:reveal', (r) => out.reveals.push(r.answer));
    bus.on('host:game-over', ({ players }) => (out.over = players.map((p) => ({ name: p.name, score: p.score }))));
    await controller.run(new AbortController().signal);
    return { ...out, llmCalls: llm.calls, log: page.log };
  }

  it.each(['D', 'd', 'D)', 'Antwort D', 'Neutralisation'])('"%s" is right without the LLM, also at the very end', async (answer) => {
    const r = await play(answer, 0);
    expect(r.verdicts).toEqual([{ answer, correct: true, delta: 1200 }]);
    expect(r.llmCalls).toBe(0);
    expect(r.reveals).toEqual(['D) Neutralisation']);
    expect(r.over).toEqual([{ name: 'Aaron', score: 1200 }]);
    expect(r.log).not.toContain('endGame');
  }, 10000);

  it('waits for options that appear after the question text', async () => {
    const r = await play('D', 500);
    expect(r.shown).toEqual([['Addition', 'Reduktion', 'Division', 'Neutralisation']]);
    expect(r.verdicts).toEqual([{ answer: 'D', correct: true, delta: 1200 }]);
    expect(r.llmCalls).toBe(0);
  }, 10000);

  it('another letter is wrong, also without the LLM', async () => {
    const r = await play('B', 0);
    expect(r.verdicts).toEqual([{ answer: 'B', correct: false, delta: -600 }]);
    expect(r.llmCalls).toBe(0);
    expect(r.over).toEqual([{ name: 'Aaron', score: -600 }]);
  }, 10000);
});

describe('TafelquizController: pick reminders', () => {
  /** Runs a game on fake time; `step` is called every 5 s (seconds since start), `react` once with the bus. */
  async function reminders(
    game: Record<string, unknown>,
    untilSec: number,
    opts: { players?: string[]; react?: (bus: EventBus) => void; step?: (sec: number, rules: Record<string, unknown>) => void } = {},
  ) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbhost-'));
      const config = ConfigSchema.parse({
        game: { autoStart: true, minPlayers: 1, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 1, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, ...game },
        judge: { cacheFile: path.join(tmp, 'cache.json') },
        llm: { provider: 'none' },
      });
      const bus = new EventBus();
      const page = new FakeTafelquizPage(opts.players ?? ['Anna', 'Ben'], [
        [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
        [{ category: 'Film', points: 200, text: 'Wie viele Episoden hat die Skywalker-Saga?', note: '9' }],
      ]);
      const controller = new TafelquizController({ page, bus, judge: createJudge(config, bus, null, new UsageMeter()), game: config.game, pollMs: 20 });
      const start = Date.now();
      const at: number[] = [];
      bus.on('host:notice', (n) => n.kind === 'reminder' && at.push(Math.round((Date.now() - start) / 1000)));
      opts.react?.(bus);
      const ac = new AbortController();
      const run = controller.run(ac.signal);
      for (let t = 0; t < untilSec; t += 5) {
        opts.step?.(t, config.game as unknown as Record<string, unknown>);
        await vi.advanceTimersByTimeAsync(5000);
      }
      ac.abort();
      await vi.advanceTimersByTimeAsync(1000);
      await run;
      return at;
    } finally {
      vi.useRealTimers();
    }
  }

  it('reminds first after 90 s, then every 5 minutes', async () => {
    const at = await reminders({}, 700);
    expect(at).toHaveLength(3);
    expect(at[0]).toBeGreaterThanOrEqual(90);
    expect(at[0]).toBeLessThan(95);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(300);
    expect(at[1]! - at[0]!).toBeLessThan(305);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(300);
  }, 30000);

  it('"aus": no reminder at all, or only the first one', async () => {
    expect(await reminders({ pickReminderSec: 0 }, 700)).toEqual([]);
    const once = await reminders({ pickReminderRepeatSec: 0 }, 700);
    expect(once).toHaveLength(1);
  }, 30000);

  it('a new turn of the same player starts over at 90 s, not at the 5-minute pace', async () => {
    let picked = 0;
    const at = await reminders({}, 300, {
      players: ['Anna'],
      react: (bus) => {
        // After the first reminder Anna picks; she answers right and is on turn again.
        bus.on('host:notice', (n) => n.kind === 'reminder' && !picked++ && setTimeout(() => bus.emit('player:pick', { player: 'Anna', col: 0, row: 0 }), 1000));
        bus.on('host:await-answer', ({ player }) => setTimeout(() => bus.emit('player:answer', { player, answer: 'zehn' }), 100));
      },
    });
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(90);
    expect(at[1]! - at[0]!).toBeLessThan(110); // the second turn's first reminder, not 300 s
  }, 30000);

  it('a rule change during the turn counts within 30 s – also from "aus" and to "aus" (F8)', async () => {
    // "aus" at the start, 60 s from second 100 on: the reminder comes by 130 s (turn start + 60 s is past).
    const on = await reminders({ pickReminderSec: 0 }, 200, { step: (t, r) => t === 100 && (r.pickReminderSec = 60) });
    expect(on[0]).toBeGreaterThanOrEqual(100);
    expect(on[0]).toBeLessThanOrEqual(135);
    // 90 s at the start, "aus" from second 50 on: no reminder at all.
    expect(await reminders({}, 400, { step: (t, r) => t === 50 && (r.pickReminderSec = 0) })).toEqual([]);
  }, 30000);
});


describe('TafelquizController: no pick is lost during a turn (review F12)', () => {
  const picks = (bus: EventBus) => (bus as unknown as { emitter: { listenerCount(e: string): number } }).emitter.listenerCount('player:pick');

  /**
   * Plays one turn on fake time with a slow page (`state()` 300 ms, pollMs 500 like the default) and picks at
   * second `at` (twice, if `twice`). Returns how often a question was opened and the pick listeners left.
   */
  async function pickAt(at: number, opts: { twice?: boolean; game?: Record<string, unknown> } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbgap-'));
      const config = ConfigSchema.parse({
        game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 5, ...opts.game },
        judge: { cacheFile: path.join(tmp, 'c.json') },
        llm: { provider: 'none' },
      });
      const bus = new EventBus();
      const page = new FakeTafelquizPage(['Anna', 'Ben'], [
        [{ category: 'Sport', points: 100, text: 'Pins?', note: '10' }],
        [{ category: 'Film', points: 200, text: 'Planet?', note: 'Tatooine' }],
      ]);
      const state = page.state.bind(page);
      (page as unknown as { state: () => ReturnType<typeof state> }).state = async () => {
        await new Promise((r) => setTimeout(r, 300)); // like Playwright: reading the page takes a while
        return state();
      };
      const controller = new TafelquizController({ page, bus, judge: createJudge(config, bus, null, new UsageMeter()), game: config.game, pollMs: 500 });
      let turn: { player: string; open: { col: number; row: number }[] } | null = null;
      let turnAt = 0;
      let questions = 0;
      bus.on('host:turn', (t) => {
        if (!turn) (turn = t), (turnAt = Date.now());
      });
      bus.on('host:question', () => questions++);
      const ac = new AbortController();
      const run = controller.run(ac.signal);
      while (!turn) await vi.advanceTimersByTimeAsync(50);
      const listenersInTurn = picks(bus);
      await vi.advanceTimersByTimeAsync(at * 1000 - (Date.now() - turnAt));
      const t = turn as { player: string; open: { col: number; row: number }[] };
      bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row });
      if (opts.twice) bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row });
      await vi.advanceTimersByTimeAsync(3000);
      const opened = page.log.filter((l) => l.startsWith('open')).length;
      const afterTurn = picks(bus); // the question is open: nobody listens for picks
      ac.abort();
      await vi.advanceTimersByTimeAsync(3000);
      await run.catch(() => {});
      return { questions, opened, listenersInTurn, afterTurn, afterStop: picks(bus) };
    } finally {
      vi.useRealTimers();
    }
  }

  // Around the old 30 s re-check, the first reminder (90 s), the repeat (90 + 300 s) and the re-checks in between.
  for (const at of [0.01, 10, 29.95, 30, 30.05, 30.2, 30.6, 60.3, 89.95, 90, 90.05, 90.6, 120.2, 389.95, 390, 390.05, 390.6]) {
    it(`a pick at ${at} s is taken exactly once`, async () => {
      const r = await pickAt(at);
      expect(r.questions).toBe(1);
      expect(r.opened).toBe(1);
      expect(r.listenersInTurn).toBe(1);
      expect(r.afterTurn).toBe(0);
      expect(r.afterStop).toBe(0);
    }, 30000);
  }

  it('the same pick twice opens one card; with reminders off the turn still takes it', async () => {
    const twice = await pickAt(45, { twice: true });
    expect(twice.questions).toBe(1);
    expect(twice.opened).toBe(1);
    const off = await pickAt(400, { game: { pickReminderSec: 0 } });
    expect(off.questions).toBe(1);
  }, 30000);

  it('leaves no pick listener and no reminder behind when the game stops or ends during the turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      for (const how of ['stop', 'end'] as const) {
        const { bus, page, controller } = setup({ autoStart: true });
        const reminders: number[] = [];
        bus.on('host:notice', (n) => n.kind === 'reminder' && reminders.push(Date.now()));
        let turn = false;
        bus.on('host:turn', () => (turn = true));
        const ac = new AbortController();
        const run = controller.run(ac.signal);
        while (!turn) await vi.advanceTimersByTimeAsync(50);
        expect(picks(bus)).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        if (how === 'stop') ac.abort();
        else void page.endGame(); // quiz-base ended it (the page leaves the board)
        await vi.advanceTimersByTimeAsync(5000);
        expect(picks(bus)).toBe(0);
        ac.abort();
        await vi.advanceTimersByTimeAsync(1000);
        await run;
        await vi.advanceTimersByTimeAsync(600_000);
        expect(reminders, how).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});

describe('sleep with a signal', () => {
  it('ends early on abort and never rejects', async () => {
    const ac = new AbortController();
    const t = Date.now();
    const p = sleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(Date.now() - t).toBeLessThan(1000);
    await sleep(5000, ac.signal); // already aborted → at once
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('TafelquizController: verdict before the score animation (latency-logic 2)', () => {
  /** One question on a page that shows new scores after `scoreDelayMs` (quiz-base: ~1.3 s). */
  function scoreGame(opts: { game?: Record<string, unknown>; scoreDelayMs?: number; answers?: Record<string, string> } = {}) {
    const g = setup(opts.game);
    g.page.scoreDelayMs = opts.scoreDelayMs ?? 0;
    const answers = opts.answers ?? { Anna: '5', Ben: '10' };
    let first = true;
    g.bus.on('host:turn', ({ player }) => {
      if (!first) return void g.page.endGame();
      first = false;
      setTimeout(() => g.bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    const answeredAt: Record<string, number> = {};
    g.bus.on('host:await-answer', ({ player }) =>
      setTimeout(() => {
        answeredAt[player] = Date.now();
        g.bus.emit('player:answer', { player, answer: answers[player] ?? '?' });
      }, 5),
    );
    g.bus.on('host:say', ({ text }) => {
      if (text.startsWith('🔔 Buzzer frei')) setTimeout(() => g.page.buzz('Ben'), 20);
    });
    const score = (name: string) => g.page.players.find((p) => p.name === name)!.score;
    const verdicts: { player: string; delta: number; after: number; shown: number }[] = [];
    g.bus.on('host:verdict', (v) => verdicts.push({ player: v.player, delta: v.delta, after: Date.now() - answeredAt[v.player]!, shown: score(v.player) }));
    const scoresAt: { reveal: Record<string, number> | null; buzzerOpen: number | null; benAsked: number | null } = { reveal: null, buzzerOpen: null, benAsked: null };
    let lastScores: Record<string, number> = {};
    g.bus.on('host:scores', ({ players }) => (lastScores = Object.fromEntries(players.map((p) => [p.name, p.score]))));
    g.bus.on('host:reveal', () => (scoresAt.reveal = lastScores));
    g.bus.on('host:notice', (n) => n.kind === 'buzzer-open' && (scoresAt.buzzerOpen = score('Anna')));
    g.bus.on('host:await-answer', ({ player }) => player === 'Ben' && (scoresAt.benAsked = score('Anna')));
    return { ...g, verdicts, scoresAt, score };
  }

  it('announces the verdict right after the click; buzzer round and reveal see the new scores', async () => {
    const g = scoreGame({ scoreDelayMs: 300 });
    await g.controller.run(new AbortController().signal);
    expect(g.verdicts.map(({ player, delta }) => ({ player, delta }))).toEqual([
      { player: 'Anna', delta: -50 },
      { player: 'Ben', delta: 100 },
    ]);
    for (const v of g.verdicts) {
      expect(v.shown).toBe(0); // announced before quiz-base shows the new score …
      expect(v.after).toBeLessThan(250); // … without waiting for it
    }
    // Everything that reads scores afterwards sees the page's new scores.
    expect(g.scoresAt.buzzerOpen).toBe(-50);
    expect(g.scoresAt.benAsked).toBe(-50);
    expect(g.scoresAt.reveal).toEqual({ Anna: -50, Ben: 100 });
    // The page order stays: points first, then the animation.
    const log = g.page.log;
    expect(log.indexOf('award Anna -50')).toBeLessThan(log.indexOf('animate Falsch'));
  }, 10000);

  it('a failed award click announces nothing early: wait first, then the verdict as before, with a warning', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('warn');
    try {
      const g = scoreGame({ game: { buzzerOnWrong: false }, answers: { Anna: '10' } });
      g.page.awardFails = true;
      let animatedBeforeVerdict = false;
      g.bus.on('host:verdict', () => (animatedBeforeVerdict = g.page.log.includes('animate Richtig')));
      await g.controller.run(new AbortController().signal);
      expect(g.verdicts).toHaveLength(1);
      expect(g.verdicts[0]!.after).toBeGreaterThanOrEqual(2900); // the old 3 s score wait came first
      expect(g.verdicts[0]!.delta).toBe(100); // unchanged from today
      expect(animatedBeforeVerdict).toBe(true);
      expect(g.score('Anna')).toBe(0);
      const warn = lines.join('');
      expect(warn).toContain('Punkte für Anna (100) nicht vergeben');
      expect(warn).toContain('Punktestand von Anna: erwartet 100, quiz-base zeigt 0');
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
  }, 10000);

  it('the page applies other points: the verdict names the expected ones, later messages the real score, one warning', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('warn');
    try {
      const g = scoreGame({ game: { buzzerOnWrong: false }, answers: { Anna: '10' }, scoreDelayMs: 100 });
      g.page.awardApplies = 50;
      await g.controller.run(new AbortController().signal);
      expect(g.verdicts.map((v) => v.delta)).toEqual([100]);
      expect(g.verdicts[0]!.after).toBeLessThan(250);
      expect(g.scoresAt.reveal).toEqual({ Anna: 50, Ben: 0 });
      const warns = lines.filter((l) => l.includes('Punktestand von'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('erwartet 100, quiz-base zeigt 50');
      expect(warns[0]).not.toContain('"10"'); // no answer text in the warning
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
  }, 10000);

  it('stopping the game between the verdict and the new score: no hanging wait, one verdict, no more clicks', async () => {
    const g = scoreGame({ game: { buzzerOnWrong: false }, answers: { Anna: '10' }, scoreDelayMs: 10_000 });
    const ac = new AbortController();
    let clicksAtVerdict = -1;
    let stoppedAt = 0;
    g.bus.on('host:verdict', () => {
      clicksAtVerdict = g.page.log.length;
      stoppedAt = Date.now();
      ac.abort();
    });
    await g.controller.run(ac.signal);
    expect(Date.now() - stoppedAt).toBeLessThan(500);
    expect(g.verdicts).toHaveLength(1);
    expect(g.page.log.slice(clicksAtVerdict)).toEqual([]);
  }, 10000);

  it('the game ended in the browser between the verdict and the new score: the wait ends, one verdict, no animation', async () => {
    const g = scoreGame({ game: { buzzerOnWrong: false }, answers: { Anna: '10' }, scoreDelayMs: 10_000 });
    let endedAt = 0;
    g.bus.on('host:verdict', () => {
      endedAt = Date.now();
      void g.page.endGame();
    });
    const over: unknown[] = [];
    g.bus.on('host:game-over', (o) => over.push(o));
    await g.controller.run(new AbortController().signal);
    expect(Date.now() - endedAt).toBeLessThan(1000);
    expect(g.verdicts).toHaveLength(1);
    expect(over).toHaveLength(1);
    expect(g.page.log).not.toContain('animate Richtig');
  }, 10000);

  it('a second answer while the score is still animating is ignored: one verdict per player', async () => {
    const g = scoreGame({ scoreDelayMs: 300 });
    g.bus.on('host:verdict', (v) => setTimeout(() => g.bus.emit('player:answer', { player: v.player, answer: '10' }), 10));
    g.bus.on('host:await-answer', ({ player }) => setTimeout(() => g.bus.emit('player:answer', { player, answer: player === 'Anna' ? '5' : '10' }), 6));
    await g.controller.run(new AbortController().signal);
    expect(g.verdicts.map((v) => v.player)).toEqual(['Anna', 'Ben']);
    expect(g.scoresAt.reveal).toEqual({ Anna: -50, Ben: 100 });
  }, 10000);

  /** Like the session: a point correction goes straight to the page (the fake shows it after `scoreDelayMs` too). */
  const bookCorrections = (g: ReturnType<typeof scoreGame>) =>
    g.bus.on('operator:command', (c) => c.command === 'punkte' && void g.page.award(c.args[0]!, Number(c.args[1])));
  const warnings = async (fn: () => Promise<void>) => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('warn');
    try {
      await fn();
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
    return lines.join('');
  };

  for (const steps of [1, 6]) {
    it(`overruled to "richtig" while the score still shows (${steps === 1 ? 'at once' : 'counting up'}): the wait ends at the corrected score, no warning, "Richtig" on the page, no buzzer round`, async () => {
      const g = scoreGame({ scoreDelayMs: 300 });
      g.page.scoreSteps = steps;
      bookCorrections(g);
      // What the bot sends for "!quiz richtig" after "falsch (−50)": 100 − (−50).
      let verdictAt = 0;
      g.bus.on('host:verdict', (v) => {
        if (v.player !== 'Anna') return;
        verdictAt = Date.now();
        setTimeout(() => g.bus.emit('operator:command', { command: 'punkte', args: ['Anna', '150'] }), 100);
      });
      let revealAt = 0;
      g.bus.on('host:reveal', () => (revealAt = Date.now()));
      const notices: string[] = [];
      g.bus.on('host:notice', (n) => notices.push(n.kind));
      const warn = await warnings(() => g.controller.run(new AbortController().signal));
      expect(warn).not.toContain('Punktestand von');
      expect(revealAt - verdictAt).toBeLessThan(1500); // not the 3 s timeout
      expect(g.page.log).toContain('animate Richtig');
      expect(g.page.log).not.toContain('animate Falsch');
      expect(notices).not.toContain('buzzer-open');
      expect(g.page.log).not.toContain('releaseBuzzer');
      expect(g.scoresAt.reveal).toEqual({ Anna: 100, Ben: 0 });
    }, 10000);
  }

  it('overruled to "falsch" in the window: "Falsch" on the page, the real score at the reveal, no warning', async () => {
    const g = scoreGame({ scoreDelayMs: 300, answers: { Anna: '10' } });
    bookCorrections(g);
    g.bus.on('host:verdict', (v) => setTimeout(() => g.bus.emit('operator:command', { command: 'punkte', args: [v.player, '-150'] }), 50));
    const warn = await warnings(() => g.controller.run(new AbortController().signal));
    expect(warn).not.toContain('Punktestand von');
    expect(g.page.log).toContain('animate Falsch');
    expect(g.page.log).not.toContain('animate Richtig');
    expect(g.scoresAt.reveal).toEqual({ Anna: -50, Ben: 0 });
  }, 10000);

  it('a correction of another player in the window does not change the wait or the outcome', async () => {
    const g = scoreGame({ scoreDelayMs: 300, game: { buzzerOnWrong: false }, answers: { Anna: '10' } });
    bookCorrections(g);
    g.bus.on('host:verdict', () => setTimeout(() => g.bus.emit('operator:command', { command: 'punkte', args: ['Ben', '150'] }), 50));
    const warn = await warnings(() => g.controller.run(new AbortController().signal));
    expect(warn).not.toContain('Punktestand von');
    expect(g.page.log).toContain('animate Richtig');
    expect(g.scoresAt.reveal?.Anna).toBe(100);
    await sleep(500); // the fake shows Ben's correction 300 ms after it was booked
    expect(g.score('Ben')).toBe(150);
  }, 10000);

  it('counting-up scores: the verdict comes first, buzzer round and reveal see only the final scores', async () => {
    const g = scoreGame({ scoreDelayMs: 600 });
    g.page.scoreSteps = 6;
    const warn = await warnings(() => g.controller.run(new AbortController().signal));
    expect(g.verdicts.map((v) => v.shown)).toEqual([0, 0]);
    expect(g.verdicts.every((v) => v.after < 250)).toBe(true);
    expect(g.scoresAt.buzzerOpen).toBe(-50);
    expect(g.scoresAt.reveal).toEqual({ Anna: -50, Ben: 100 });
    expect(warn).not.toContain('Punktestand von');
  }, 10000);

  it('a failed award click and the game stopped during the wait: no verdict, no clicks, no hanging wait', async () => {
    const g = scoreGame({ answers: { Anna: '10' } });
    g.page.awardFails = true;
    const ac = new AbortController();
    let failedAt = -1;
    const award = g.page.award;
    g.page.award = (name: string, delta: number) => {
      const r = award(name, delta);
      failedAt = g.page.log.length;
      setTimeout(() => ac.abort(), 200);
      return r;
    };
    const t = Date.now();
    await warnings(() => g.controller.run(ac.signal));
    expect(Date.now() - t).toBeLessThan(2500); // not the 3 s wait
    expect(g.verdicts).toHaveLength(0);
    expect(g.page.log.slice(failedAt)).toEqual([]);
  }, 10000);

  it('a failed award click and the game ended in the browser during the wait: the verdict as before, no buzzer round on the results', async () => {
    const g = scoreGame(); // Anna answers wrong, buzzer round is on
    g.page.awardFails = true;
    const award = g.page.award;
    g.page.award = (name: string, delta: number) => {
      const r = award(name, delta);
      setTimeout(() => void g.page.endGame(), 200);
      return r;
    };
    const t = Date.now();
    await warnings(() => g.controller.run(new AbortController().signal));
    expect(Date.now() - t).toBeLessThan(2500);
    expect(g.verdicts.map((v) => ({ player: v.player, delta: v.delta }))).toEqual([{ player: 'Anna', delta: -50 }]);
    expect(g.page.log).not.toContain('releaseBuzzer');
    expect(g.page.log).not.toContain('animate Falsch');
  }, 10000);
});

describe('TafelquizController: the page watchdog does not delay the work (latency-logic 5)', () => {
  /** Fake time, pollMs 500 (watchdog pause 1 s like the default): how long from the event to the reaction. */
  async function reaction(at: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { bus, page } = setup({ buzzerOnWrong: false, answerTimeoutSec: 30 });
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbwd-'));
      const config = ConfigSchema.parse({ game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 30, buzzerOnWrong: false }, judge: { cacheFile: path.join(tmp, 'c.json') }, llm: { provider: 'none' } });
      const controller = new TafelquizController({ page, bus, judge: createJudge(config, bus, null, new UsageMeter()), game: config.game, pollMs: 500 });
      let turn: HostEvents['host:turn'] | null = null;
      let asked: string | null = null;
      bus.on('host:turn', (t) => (turn ??= t));
      bus.on('host:await-answer', (a) => (asked ??= a.player));
      let verdictAt = 0;
      bus.on('host:verdict', () => (verdictAt ||= Date.now()));
      const ac = new AbortController();
      const run = controller.run(ac.signal);
      while (!turn) await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(at);
      const t = turn as HostEvents['host:turn'];
      const pickAt = Date.now();
      bus.emit('player:pick', { player: t.player, col: t.open[0]!.col, row: t.open[0]!.row });
      let openedAt = 0;
      while (!page.log.some((l) => l.startsWith('open')) && Date.now() - pickAt < 3000) await vi.advanceTimersByTimeAsync(1);
      openedAt = Date.now();
      while (!asked) await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(at);
      const answerAt = Date.now();
      bus.emit('player:answer', { player: asked, answer: '10' });
      while (!verdictAt && Date.now() - answerAt < 3000) await vi.advanceTimersByTimeAsync(1);
      ac.abort();
      await vi.advanceTimersByTimeAsync(5000);
      await run.catch(() => {});
      return { pick: openedAt - pickAt, answer: verdictAt - answerAt, opened: page.log.filter((l) => l.startsWith('open')).length };
    } finally {
      vi.useRealTimers();
    }
  }

  for (const at of [0, 130, 470, 990]) {
    it(`pick → openCell and answer → verdict without the 1 s watchdog pause (event at +${at} ms)`, async () => {
      const r = await reaction(at);
      expect(r.pick).toBeLessThan(30);
      expect(r.answer).toBeLessThan(30);
      expect(r.opened).toBe(1);
    }, 20000);
  }
});

// Package C: the answer time grows once by `confirmGraceSec` when a spoken answer is asked back ("Paris?").
// Real timers, concurrent: answer time 1 s plus the usual 3 s slack = 4 s without grace.
describe.concurrent('TafelquizController: grace for the spoken "Ja" (confirmGraceSec)', () => {
  /** One question; `pending` / `answerAt` in ms after `host:await-answer`. Returns the verdict's answer and when it came. */
  async function graceRun(game: Record<string, unknown>, pending: { at: number; player?: string }[], answerAt: number) {
    const { bus, page, controller } = setup({ buzzerOnWrong: false, ...game });
    let first = true;
    let askedAt = 0;
    let verdict: { answer: string; ms: number } | null = null;
    bus.on('host:turn', ({ player }) => {
      if (!first) return void page.endGame();
      first = false;
      setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5);
    });
    const timers: NodeJS.Timeout[] = [];
    bus.on('host:await-answer', ({ player }) => {
      askedAt = Date.now();
      for (const p of pending) timers.push(setTimeout(() => bus.emit('player:answer-pending', { player: p.player ?? player, answer: 'zehn' }), p.at));
      timers.push(setTimeout(() => bus.emit('player:answer', { player, answer: 'zehn', spoken: true }), answerAt));
    });
    bus.on('host:verdict', (v) => (verdict ??= { answer: v.answer, ms: Date.now() - askedAt }));
    await controller.run(new AbortController().signal);
    timers.forEach(clearTimeout);
    return verdict!;
  }

  it('an answer asked back shortly before the end gets the grace: the answer 4 s after the answer time still counts', async () => {
    const v = await graceRun({ confirmGraceSec: 2 }, [{ at: 800 }], 5000);
    expect(v.answer).toBe('zehn');
  }, 15000);

  it('without an answer asked back there is no grace', async () => {
    const v = await graceRun({ confirmGraceSec: 2 }, [], 5000);
    expect(v.answer).toBe('(keine Antwort)');
    expect(v.ms).toBeLessThan(4800);
  }, 15000);

  it('confirmGraceSec 0: no grace, as before', async () => {
    const v = await graceRun({ confirmGraceSec: 0 }, [{ at: 800 }], 5000);
    expect(v.answer).toBe('(keine Antwort)');
    expect(v.ms).toBeLessThan(4800);
  }, 15000);

  it('a second answer asked back does not extend any further (at most once by confirmGraceSec)', async () => {
    const v = await graceRun({ confirmGraceSec: 2 }, [{ at: 800 }, { at: 3900 }, { at: 5500 }], 6800);
    expect(v.answer).toBe('(keine Antwort)');
    expect(v.ms).toBeGreaterThanOrEqual(5900);
    expect(v.ms).toBeLessThan(6700);
  }, 15000);

  it('someone else\'s pending answer gives the person asked no grace', async () => {
    const v = await graceRun({ confirmGraceSec: 2 }, [{ at: 800, player: 'Ben' }], 5000);
    expect(v.answer).toBe('(keine Antwort)');
  }, 15000);
});
