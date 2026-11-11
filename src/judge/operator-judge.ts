import type { EventBus } from '../core/events.ts';
import type { AnswerJudge, JudgeInput, JudgeResult } from './judge.ts';

/** Last resort: ask the human operator in the console (`richtig` / `falsch`). */
export class OperatorJudge implements AnswerJudge {
  constructor(
    private bus: EventBus,
    private timeoutMs = 60000,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeResult> {
    this.bus.emit('host:say', {
      text: `❓ Unsicher: "${input.answer}" auf "${input.question}" (Lösung: ${input.reference ?? '?'}) → tippe "richtig" oder "falsch"`,
    });
    const cmd = await this.bus.waitFor('operator:command', (c) => ['richtig', 'falsch', 'r', 'f'].includes(c.command), this.timeoutMs);
    if (!cmd) return { verdict: 'unsure', method: 'operator', confidence: 0, reason: 'keine Entscheidung' };
    const correct = cmd.command.startsWith('r');
    return { verdict: correct ? 'correct' : 'wrong', method: 'operator', confidence: 1 };
  }
}
