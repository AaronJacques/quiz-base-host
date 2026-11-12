import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel } from '../src/channels/terminal.ts';
import { WebCompanion } from '../src/channels/web/server.ts';
import { ConfigSchema } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { CascadeJudge } from '../src/judge/cascade-judge.ts';
import { JudgeCache } from '../src/judge/cache.ts';
import { OperatorJudge } from '../src/judge/operator-judge.ts';
import { GameSession } from '../src/session.ts';

setLogLevel('error');

// F4: nothing that may contain the solution reaches a public channel before host:reveal.
describe('secrecy towards public channels', () => {
  it('OperatorJudge asks the leader privately – the solution is only in host:notice.detail', async () => {
    const bus = new EventBus();
    const said: string[] = [];
    const details: (string | undefined)[] = [];
    bus.on('host:say', ({ text }) => said.push(text));
    bus.on('host:notice', (n) => details.push(n.detail));
    const verdict = new OperatorJudge(bus, 50).judge({ question: 'Geburtsplanet von Anakin?', reference: 'Tatooine', answer: 'Tatuin' });
    expect((await verdict).verdict).toBe('unsure');
    expect(said.join('\n')).toContain('Tatuin');
    expect(said.join('\n')).not.toContain('Tatooine');
    expect(details.join('\n')).toContain('Tatooine');
  });

  it('the web companion never streams the judge reason, nor keeps it in the snapshot', async () => {
    const bus = new EventBus();
    const web = new WebCompanion({ port: 0, host: '127.0.0.1' });
    const pushed: string[] = [];
    (web as unknown as { push: (e: string, d: unknown) => void }).push = (e, d) => pushed.push(`${e} ${JSON.stringify(d)}`);
    await web.start(bus);
    try {
      void new OperatorJudge(bus, 30).judge({ question: 'Geburtsplanet?', reference: 'Tatooine', answer: 'Tatuin' });
      bus.emit('host:verdict', { player: 'Anna', answer: 'Naboo', correct: false, delta: -50, reason: 'Die Lösung ist Tatooine, nicht Naboo' });
      const snap = JSON.stringify((web as unknown as { snap: unknown }).snap);
      expect(pushed.join('\n')).not.toContain('Tatooine');
      expect(snap).not.toContain('Tatooine');
      expect(pushed.join('\n')).toContain('Naboo'); // the verdict itself is shown
    } finally {
      await web.stop();
    }
  });

  it('the operator console (private) shows the question to the leader with the solution', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (out.push(String(chunk)), true));
    try {
      const bus = new EventBus();
      await new TerminalChannel().start(bus);
      await new OperatorJudge(bus, 20).judge({ question: 'Geburtsplanet?', reference: 'Tatooine', answer: 'Tatuin' });
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).toContain('Lösung: Tatooine');
  });
});

// F16: LLM reasons (often with the solution) stay out of the info log.
describe('judge log', () => {
  it('logs LLM reasons only on debug', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      const llm = { judge: async () => ({ verdict: 'wrong' as const, method: 'llm' as const, confidence: 0.9, reason: 'Richtig wäre Tatooine' }) };
      await new CascadeJudge([{ name: 'llm', judge: llm }], null).judge({ question: 'q', reference: 'Tatooine', answer: 'Naboo' });
    } finally {
      setLogLevel('error');
      spy.mockRestore();
    }
    expect(lines.join('')).toContain('"Naboo" → wrong');
    expect(lines.join('')).not.toContain('Tatooine');
  });

  it('does not cache verdicts of questions whose media has no identity', async () => {
    const cache = new JudgeCache(path.join(mkdtempSync(path.join(os.tmpdir(), 'qbhost-')), 'c.json'));
    let calls = 0;
    const llm = { judge: async () => (calls++, { verdict: 'correct' as const, method: 'llm' as const, confidence: 0.9 }) };
    const judge = new CascadeJudge([{ name: 'llm', judge: llm, cache: true }], cache);
    for (let i = 0; i < 2; i++) await judge.judge({ question: 'Wer ist das?', reference: null, answer: 'Mario', media: null });
    expect(calls).toBe(2);
  });
});

// F9: a failing bus subscriber is logged – it never crashes the process or stops the emitter.
describe('EventBus error isolation', () => {
  it('catches thrown errors and rejected promises of handlers', async () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.on('host:say', () => {
      throw new Error('sync boom');
    });
    bus.on('host:say', async () => {
      throw new Error('async boom');
    });
    bus.on('host:say', ({ text }) => void got.push(text));
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (logged.push(String(chunk)), true));
    try {
      expect(() => bus.emit('host:say', { text: 'hallo' })).not.toThrow();
      await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would fail the test run
    } finally {
      spy.mockRestore();
    }
    expect(got).toEqual(['hallo']);
    expect(logged.join('')).toContain('sync boom');
    expect(logged.join('')).toContain('async boom');
  });

  it('a point correction with a broken browser does not take the process down', async () => {
    const s = new GameSession(ConfigSchema.parse({ browser: { headless: true } }), []);
    s.bus.emit('operator:command', { command: 'punkte', args: ['Anna', '100'] }); // browser never opened → award fails
    await new Promise((r) => setTimeout(r, 50));
    await s.close();
  });
});
