export interface JudgeInput {
  question: string;
  /** Best known correct answer (host note, correct MC option, derived by vision …). Null = unknown. */
  reference: string | null;
  answer: string;
  /** Extra context the LLM may use (e.g. YouTube title of an audio question). */
  hints?: string[];
  /** Transcribed from speech: judge by sound, not by spelling ("Preaking Bad" = "Breaking Bad"). */
  spoken?: boolean;
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
}
