import type { EventBus, HostEvents } from '../core/events.ts';
import type { PlayerState } from '../core/types.ts';

/** The live rules object of the game – the bridge only sets its voice bonus (`bonusTimeSec`). */
type TimingRules = { bonusTimeSec: number };
import {
  ANSWER_HOW_LINE,
  askLine,
  BUZZER_OPEN_LINE,
  freeCardsLine,
  gameOverLine,
  questionLine,
  reminderLine,
  rulesLine,
  revealLine,
  scoresLine,
  turnLine,
  verdictLine,
} from '../voice/narration.ts';
import type { VoiceHost } from '../voice/voice-host.ts';

/**
 * Narrates one game into a voice channel. Listens to the same `host:*` events as
 * the chat rendering and keeps just enough state to speak naturally
 * (categories once per board, no reveal after a correct answer, scores every n questions).
 */
export class VoiceBridge {
  private offs: (() => void)[] = [];
  private turn: HostEvents['host:turn'] | null = null;
  private lastQuestion: HostEvents['host:question'] | null = null;
  private lastAsk: HostEvents['host:await-answer'] | null = null;
  private players: PlayerState[] = [];
  private announcedBoard = 0;
  private questions = 0;
  private solved = false;
  private _buzzerOpen = false;
  private questionOpen = false;

  constructor(readonly host: VoiceHost, private opts: { scoresEvery: number; extraTimeSec: number; board: () => string }) {}

  get buzzerOpen(): boolean {
    return this._buzzerOpen;
  }

  say(text: string, key?: string): Promise<void> {
    return this.host.say(text, { key });
  }

  /**
   * Spoken questions and verdicts take time before players hear "deine Antwort?" or
   * "Buzzer frei!" – give the game that time back while voice is active. The bonus is a field
   * of its own (set, never added), so rule changes keep it and a rejoin does not double it.
   */
  private timed: TimingRules | null = null;
  private rules: Parameters<typeof rulesLine>[0] | null = null;

  attach(bus: EventBus, rules?: TimingRules & Partial<Parameters<typeof rulesLine>[0]>): void {
    this.detach();
    this.rules = rules && rules.correctFactor !== undefined ? (rules as Parameters<typeof rulesLine>[0]) : null;
    if (rules) {
      rules.bonusTimeSec = Math.max(0, this.opts.extraTimeSec);
      this.timed = rules;
    }
    const on = <K extends keyof HostEvents>(e: K, h: (p: HostEvents[K]) => void) => this.offs.push(bus.on(e, h));

    on('host:scores', ({ players }) => (this.players = players));
    on('host:notice', (n) => {
      switch (n.kind) {
        case 'started':
          void this.say(`Los geht's mit ${this.opts.board()}! ${this.rules ? `${rulesLine(this.rules)} ` : ''}${ANSWER_HOW_LINE}`);
          break;
        case 'reminder':
          if (n.player) void this.say(reminderLine(n.player, this.turn?.open[0]), 'turn');
          break;
        case 'buzzer-open':
          this._buzzerOpen = true;
          void this.say(BUZZER_OPEN_LINE);
          break;
        case 'buzzed':
          this._buzzerOpen = false;
          break;
        case 'no-buzz':
          this._buzzerOpen = false;
          void this.say('Niemand? Schade.');
          break;
        case 'board-switch':
          void this.say(n.text);
          break;
        case 'operator-needed':
          void this.say('Da bin ich mir nicht sicher. Die Spielleitung entscheidet.');
          break;
      }
    });
    on('host:turn', (t) => {
      const fresh = this.turn?.player !== t.player || this.turn?.open.length !== t.open.length || this.turn?.board.active !== t.board.active;
      this.turn = t;
      this.questionOpen = false;
      if (!fresh) return;
      const first = this.announcedBoard !== t.board.active;
      this.announcedBoard = t.board.active;
      void this.say(turnLine(t, first), 'turn');
    });
    on('host:question', (q) => {
      this.lastQuestion = q;
      this.questionOpen = true;
      this.solved = false;
      this._buzzerOpen = false;
      this.questions++;
      void this.say(questionLine(q));
    });
    on('host:await-answer', (a) => {
      this.lastAsk = a;
      void this.say(a.viaBuzzer ? `${a.player} war am schnellsten. Deine Antwort?` : askLine(a), 'ask');
    });
    on('host:verdict', (v) => {
      if (v.correct) this.solved = true;
      void this.say(verdictLine(v, false)); // spoken answers were already repeated back for confirmation
    });
    on('host:reveal', ({ answer }) => {
      this._buzzerOpen = false;
      this.questionOpen = false;
      const parts = [this.solved ? '' : revealLine(answer)];
      if (this.opts.scoresEvery > 0 && this.questions % this.opts.scoresEvery === 0) parts.push(scoresLine(this.players));
      const text = parts.filter(Boolean).join(' ');
      if (text) void this.say(text);
    });
    on('host:game-over', ({ players }) => {
      this.host.clear();
      void this.say(gameOverLine(players));
    });
  }

  detach(): void {
    if (this.timed) this.timed.bonusTimeSec = 0;
    this.timed = null;
    this.offs.splice(0).forEach((off) => off());
    this.turn = null;
    this.lastQuestion = null;
    this.lastAsk = null;
    this.questionOpen = false;
    this.announcedBoard = 0;
    this.questions = 0;
    this._buzzerOpen = false;
  }

  /** "Quizmaster, wiederholen" – the question (and the pending ask), or whose turn it is. */
  repeat(): void {
    if (this.questionOpen && this.lastQuestion) {
      void this.say(`Noch mal: ${questionLine(this.lastQuestion)}${this.lastAsk ? ` ${askLine(this.lastAsk)}` : ''}`);
    } else if (this.turn) void this.say(turnLine(this.turn, true), 'turn');
    else void this.say('Gerade gibt es nichts zu wiederholen.');
  }

  freeCards(): void {
    void this.say(this.turn ? freeCardsLine(this.turn.open, this.turn.grid) : 'Gerade ist kein Brett offen.');
  }

  scores(): void {
    void this.say(this.players.length ? scoresLine(this.players) : 'Noch keine Punkte.');
  }
}
