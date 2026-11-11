import type { Config } from '../../config.ts';

/**
 * Score change for an answer. Pure function so house rules are trivial to
 * change and test. Default matches quiz-base's classic rules:
 * correct = +value, wrong = −value/2.
 */
export function scoreFor(points: number, correct: boolean, viaBuzzer: boolean, game: Config['game']): number {
  if (correct) return points;
  if (viaBuzzer && !game.penalizeBuzzers) return 0;
  return -Math.round(points * game.wrongPenalty);
}
