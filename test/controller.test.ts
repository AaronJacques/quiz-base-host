import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { FakeTafelquizPage } from './fake-page.ts';

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
