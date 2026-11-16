export interface JudgeInput {
  question: string;
  /** Best known correct answer (host note, correct MC option, derived by vision …). Null = unknown. */
  reference: string | null;
  answer: string;
  /** Extra context the LLM may use (e.g. YouTube title of an audio question). */
  hints?: string[];
  /** Transcribed from speech: judge by sound, not by spelling ("Preaking Bad" = "Breaking Bad"). */
  spoken?: boolean;
  /**
   * Identity of the question's pictures/sound (`JudgeCache.mediaKey`) – part of the verdict cache key when
   * there is no reference. null = no stable identity → the verdict is not cached. Omitted = no media.
   */
  media?: string | null;
  /** Multiple-choice options as shown on quiz-base ("A" … "D"), the correct one flagged. */
  options?: ChoiceOption[];
  /**
   * Who answers which question (unique per question and player, e.g. `q17|Anna`). An early judgement
   * (`prejudge`) is only ever used for the same scope – never for another question, player or game.
   */
  scope?: string;
  /** Set by the cascade for an early judgement: the LLM stage books it as `prejudge` in the usage meter. */
  prefetch?: boolean;
}

export interface ChoiceOption {
  letter: string;
  label: string;
  correct: boolean;
}

export type Verdict = 'correct' | 'wrong' | 'unsure';

export interface JudgeResult {
  verdict: Verdict;
  /** How the decision was made – useful to see where tokens are spent. */
  method: 'fuzzy' | 'rule' | 'cache' | 'llm' | 'operator';
  confidence: number;
  reason?: string;
}

/** Strategy interface – fuzzy, LLM, operator and the cascade all implement it. */
export interface AnswerJudge {
  judge(input: JudgeInput): Promise<JudgeResult>;
  /**
   * Optional: judge a not yet confirmed answer in the background (no operator stage, nothing public). A later
   * `judge` with the same input and `scope` takes its result instead of asking again. Resolves when done, never rejects.
   */
  prejudge?(input: JudgeInput): Promise<void>;
}
