/**
 * Domain types shared across layers. These describe what the host *sees* on
 * quiz-base.de, independent of how it was read (DOM probe) or who reads it.
 */

export interface PlayerState {
  name: string;
  score: number;
  /** "Am Zug" marker in the player list. */
  isTurn: boolean;
  /** Player currently holds the buzzer ("Buzzer" marker). */
  hasBuzzed: boolean;
  /** Lobby only: clicked "Ich bin bereit!". */
  ready?: boolean;
}

export interface BoardCell {
  category: string;
  /** 0-based column index on the active board. */
  col: number;
  /** 0-based row index within the column. */
  row: number;
  points: number;
  answered: boolean;
}

export interface QuestionState {
  points: number;
  text: string;
  /** Host-only note ("Richtige Antwort (Notiz)"), null when the board has none. */
  note: string | null;
  /** Multiple-choice options ("A" … "D" + text) with the correct one flagged, if the board uses them. */
  options: { letter: string; label: string; correct: boolean }[];
  imageUrls: string[];
  /** Per image: finished loading (`null` = still loading, `false` = broken). */
  imagesLoaded: (boolean | null)[];
  audio: { present: boolean; title: string | null; playing: boolean };
  buzzer: { status: 'locked' | 'open' | 'buzzed' | 'unknown'; buzzedBy: string | null };
  /** Player the "Punkte vergeben" buttons currently target. */
  pointTarget: string | null;
}

export type Phase = 'lobby' | 'sound-gate' | 'board' | 'question' | 'results' | 'unknown';

export interface TafelquizState {
  phase: Phase;
  url: string;
  lobbyCode: string | null;
  players: PlayerState[];
  /** Lobby only: number of players marked ready / total. */
  ready: { ready: number; total: number } | null;
  canStart: boolean;
  boards: { count: number; active: number };
  grid: BoardCell[];
  question: QuestionState | null;
  dialog: string | null;
}

export interface Pick {
  col: number;
  row: number;
}
