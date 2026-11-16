import type { BoardCell, PlayerState, QuestionState, TafelquizState } from '../src/core/types.ts';
import type { ActionResult, TafelquizPort } from '../src/site/tafelquiz/page.ts';

export interface FakeQuestion {
  category: string;
  points: number;
  text: string;
  note: string | null;
  /** Image URLs of the question (`data:` = inline image without identity). */
  images?: string[];
  /** YouTube title of the question's audio; null = audio without title. Omitted = no audio. */
  audio?: string | null;
  /** Multiple-choice options as quiz-base shows them (letter, text, correct one flagged). */
  options?: { letter: string; label: string; correct: boolean }[];
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
  /** Lobby players who have not clicked "Ich bin bereit!" yet (quiz-base cannot start then). */
  notReady = new Set<string>();

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
      players: this.players.map((p, i) => ({ ...p, isTurn: this.phase !== 'lobby' && i === (this.shownTurn ?? this.turn), hasBuzzed: p.name === this.buzzer.buzzedBy, ready: !this.notReady.has(p.name) })),
      ready: this.phase === 'lobby' ? { ready: this.players.length - this.notReady.size, total: this.players.length } : null,
      canStart: this.phase === 'lobby' && !this.notReady.size,
      boards: { count: 1, active: 1 },
      grid: this.phase === 'board' ? this.cells.map(({ q: _q, ...c }) => c) : [],
      question: this.open
        ? {
            points: this.open.points,
            text: this.open.q.text,
            note: this.open.q.note,
            options: Date.now() >= this.optionsShownAt ? (this.open.q.options ?? []) : [],
            imageUrls: this.open.q.images ?? [],
            imagesLoaded: (this.open.q.images ?? []).map(() => true),
            audio: this.open.q.audio !== undefined ? { present: true, title: this.open.q.audio, playing: false } : { present: false, title: null, playing: false },
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
  /** Test hook: the answer options appear this long after the question text (seen as a possible race). */
  optionsDelayMs = 0;
  private optionsShownAt = 0;
  openCell = (col: number, row: number) => {
    this.optionsShownAt = Date.now() + this.optionsDelayMs;
    // With staleAfterOpenMs, "Am Zug" keeps showing the previous player for a moment after the card opened.
    if (this.staleAfterOpenMs && this.shownTurn !== null) setTimeout(() => (this.shownTurn = null), this.staleAfterOpenMs);
    else this.shownTurn = null;
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
  /** Test hook: how long the stale "Am Zug" survives opening the next card (0 = it corrects itself at once). */
  staleAfterOpenMs = 0;
  private shownTurn: number | null = null;
  /** Test hook: like quiz-base (seen live 12.11.2026), show the results by itself once the last card is closed. */
  autoResults = false;
  closeQuestion = () => {
    if (this.open) this.open.answered = true;
    this.open = null;
    this.phase = this.autoResults && this.cells.every((c) => c.answered) ? 'results' : 'board';
    if (this.staleTurnDisplay) this.shownTurn = this.turn;
    this.turn = (this.turn + 1) % this.players.length;
    return this.ok('close');
  };
  /** Test hook: like quiz-base (live ~1.3 s), the new score shows this long after the award click. */
  scoreDelayMs = 0;
  /** Test hook: with `scoreDelayMs`, show the new score counting up in this many steps instead of at once. */
  scoreSteps = 1;
  /** Test hook: the award click fails (nothing is applied). */
  awardFails = false;
  /** Test hook: the page applies these points instead of the requested ones (e.g. a different quick button). */
  awardApplies: number | null = null;
  award = (name: string, delta: number) => {
    if (this.awardFails) {
      this.log.push(`award failed ${name} ${delta}`);
      return Promise.resolve({ ok: false, error: 'no points section' });
    }
    const p = this.players.find((x) => x.name === name)!;
    const applied = this.awardApplies ?? delta;
    if (this.scoreDelayMs > 0 && this.scoreSteps > 1) {
      // Count up/down in steps like an animated score; the chunks add up to `applied`.
      let done = 0;
      for (let i = 1; i <= this.scoreSteps; i++) {
        const upTo = Math.round((applied * i) / this.scoreSteps);
        const chunk = upTo - done;
        done = upTo;
        setTimeout(() => (p.score += chunk), (this.scoreDelayMs * i) / this.scoreSteps);
      }
    } else if (this.scoreDelayMs > 0) setTimeout(() => (p.score += applied), this.scoreDelayMs);
    else p.score += applied;
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
