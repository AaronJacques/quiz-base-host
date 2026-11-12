import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
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
    game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, answerTimeoutSec: 1, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, ...overrides },
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
    const game = ConfigSchema.parse({ game: { revealPauseSec: 0, answerTimeoutSec: 5 } }).game;
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
  const game = ConfigSchema.parse({ game: { buzzerOnWrong: false, revealPauseSec: 0, answerTimeoutSec: 2, autoplayAudio: false } }).game;
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
