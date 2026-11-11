/**
 * A game mode drives one quiz-base format from lobby to results. New formats
 * (Punktejagd, Eagle Eye, …) implement this interface with their own page
 * probe + controller and get registered in `src/modes/index.ts`.
 */
export interface GameMode {
  readonly name: string;
  run(signal: AbortSignal): Promise<void>;
}
