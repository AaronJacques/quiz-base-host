import type { BoardCell, PlayerState, QuestionState, TafelquizState } from '../src/core/types.ts';
import type { ActionResult, TafelquizPort } from '../src/site/tafelquiz/page.ts';

export interface FakeQuestion {
  category: string;
  points: number;
  text: string;
  note: string | null;
}

/**
 * In-memory simulation of the quiz-base host page with the same observable
 * behaviour we verified live: turn rotates on close, point buttons target the
 * buzzing player, answered cells stay on the board.
 */
export class FakeTafelquizPage implements TafelquizPort {
  phase: TafelquizState['phase'] = 'lobby';
  players: PlayerState[];
  cells: (BoardCell & { q: FakeQuestion })[] = [];
  open: (BoardCell & { q: FakeQuestion }) | null = null;
  buzzer: QuestionState['buzzer'] = { status: 'locked', buzzedBy: null };
  turn = 0;
  log: string[] = [];

  constructor(names: string[], board: FakeQuestion[][]) {
    this.players = names.map((name, i) => ({ name, score: 0, isTurn: i === 0, hasBuzzed: false }));
    board.forEach((col, c) =>
      col.forEach((q, r) => this.cells.push({ category: q.category, col: c, row: r, points: q.points, answered: false, q })),
    );
  }

  private ok(what: string): Promise<ActionResult> {
    this.log.push(what);
    return Promise.resolve({ ok: true });
  }

  async state(): Promise<TafelquizState> {
    return {
      phase: this.phase,
      url: 'fake://host',
      lobbyCode: 'TEST01',
      players: this.players.map((p, i) => ({ ...p, isTurn: this.phase !== 'lobby' && i === (this.shownTurn ?? this.turn), hasBuzzed: p.name === this.buzzer.buzzedBy, ready: true })),
      ready: this.phase === 'lobby' ? { ready: this.players.length, total: this.players.length } : null,
      canStart: this.phase === 'lobby',
      boards: { count: 1, active: 1 },
      grid: this.phase === 'board' ? this.cells.map(({ q: _q, ...c }) => c) : [],
      question: this.open
        ? {
            points: this.open.points,
            text: this.open.q.text,
            note: this.open.q.note,
            options: [],
            imageUrls: [],
            imagesLoaded: [],
            audio: { present: false, title: null, playing: false },
            buzzer: { ...this.buzzer },
            pointTarget: this.buzzer.buzzedBy ?? this.players[this.turn]!.name,
          }
        : null,
      dialog: null,
    };
  }

  /** Test hook: a player hits the buzzer. */
  buzz(name: string): void {
    if (this.buzzer.status === 'open') this.buzzer = { status: 'buzzed', buzzedBy: name };
  }

  imageData = async () => null;
  screenshot = async () => '/dev/null';
  revealCode = () => this.ok('revealCode');
  startGame = () => {
    this.phase = 'board';
    return this.ok('startGame');
  };
  passSoundGate = () => this.ok('passSoundGate');
  selectBoard = (n: number) => this.ok(`selectBoard ${n}`);
  openCell = (col: number, row: number) => {
    this.shownTurn = null;
    this.open = this.cells.find((c) => c.col === col && c.row === row) ?? null;
    this.phase = 'question';
    this.buzzer = { status: 'locked', buzzedBy: null };
    return this.ok(`open ${col}/${row}`);
  };
  animate = (k: string) => this.ok(`animate ${k}`);
  releaseBuzzer = () => {
    this.buzzer = { status: 'open', buzzedBy: null };
    return this.ok('releaseBuzzer');
  };
  resetBuzzer = () => {
    this.buzzer = { status: 'locked', buzzedBy: null };
    return this.ok('resetBuzzer');
  };
  startTimer = (s: number) => this.ok(`timer ${s}`);
  stopTimer = () => this.ok('stopTimer');
  playAudio = () => this.ok('playAudio');
  stopAudio = () => this.ok('stopAudio');
  /** Test hook: like quiz-base sometimes, keep showing "Am Zug" at the previous player until the next card opens. */
  staleTurnDisplay = false;
  private shownTurn: number | null = null;
  closeQuestion = () => {
    if (this.open) this.open.answered = true;
    this.open = null;
    this.phase = 'board';
    if (this.staleTurnDisplay) this.shownTurn = this.turn;
    this.turn = (this.turn + 1) % this.players.length;
    return this.ok('close');
  };
  award = (name: string, delta: number) => {
    this.players.find((p) => p.name === name)!.score += delta;
    return this.ok(`award ${name} ${delta}`);
  };
  endGame = () => {
    this.phase = 'results';
    return this.ok('endGame');
  };
  async waitFor(pred: (s: TafelquizState) => boolean, timeoutMs: number, pollMs = 10): Promise<TafelquizState | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await this.state();
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }
}
