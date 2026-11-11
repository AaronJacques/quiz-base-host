import type { EventBus } from '../core/events.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';

/** Last resort: ask the human operator in the console (`richtig` / `falsch`). */
export class OperatorJudge implements AnswerJudge {
  constructor(
    private bus: EventBus,
    private timeoutMs = 60000,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const detail = `Unsicher: „${input.answer}“ auf „${input.question}“ (Lösung: ${input.reference ?? '?'}) – bitte mit richtig/falsch entscheiden.`;
    this.bus.emit('host:say', { text: '❓ ' + detail });
    this.bus.emit('host:notice', { kind: 'operator-needed', text: `Bei „${input.answer}“ bin ich unsicher – die Spielleitung entscheidet.`, detail });
    const cmd = await this.bus.waitFor('operator:command', (c) => ['richtig', 'falsch', 'r', 'f'].includes(c.command), this.timeoutMs);
    if (!cmd) return { verdict: 'unsure', method: 'operator', confidence: 0, reason: 'keine Entscheidung' };
    const correct = cmd.command.startsWith('r');
    return { verdict: correct ? 'correct' : 'wrong', method: 'operator', confidence: 1 };
  }
}
