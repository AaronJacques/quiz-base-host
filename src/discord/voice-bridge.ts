import type { EventBus, HostEvents } from '../core/events.ts';
import type { PlayerState } from '../core/types.ts';

type TimingRules = { answerTimeoutSec: number; buzzWindowSec: number; buzzAnswerTimeoutSec: number };
import {
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
  private voiceAnswer = false;
  private _buzzerOpen = false;
  private questionOpen = false;

  constructor(readonly host: VoiceHost, private opts: { scoresEvery: number; extraTimeSec: number; board: () => string }) {}

  get buzzerOpen(): boolean {
    return this._buzzerOpen;
  }

  /** The next verdict echoes the recognised answer ("„Luigi Mario“ – richtig"). */
  markVoiceAnswer(): void {
    this.voiceAnswer = true;
  }

  say(text: string, key?: string): Promise<void> {
    return this.host.say(text, { key });
  }

  /**
   * Spoken questions and verdicts take time before players hear "deine Antwort?" or
   * "Buzzer frei!" – give the game that time back while voice is active.
   */
  private timing: { rules: TimingRules; base: TimingRules } | null = null;
  private rules: Parameters<typeof rulesLine>[0] | null = null;

  attach(bus: EventBus, rules?: TimingRules & Partial<Parameters<typeof rulesLine>[0]>): void {
    this.detach();
    this.rules = rules && rules.correctFactor !== undefined ? (rules as Parameters<typeof rulesLine>[0]) : null;
    if (rules && this.opts.extraTimeSec > 0) {
      const base = { answerTimeoutSec: rules.answerTimeoutSec, buzzWindowSec: rules.buzzWindowSec, buzzAnswerTimeoutSec: rules.buzzAnswerTimeoutSec };
      rules.answerTimeoutSec += this.opts.extraTimeSec;
      rules.buzzWindowSec += this.opts.extraTimeSec;
      rules.buzzAnswerTimeoutSec += Math.round(this.opts.extraTimeSec / 2);
      this.timing = { rules, base };
    }
    const on = <K extends keyof HostEvents>(e: K, h: (p: HostEvents[K]) => void) => this.offs.push(bus.on(e, h));

    on('host:scores', ({ players }) => (this.players = players));
    on('host:notice', (n) => {
      switch (n.kind) {
        case 'started':
          void this.say(`Los geht's mit ${this.opts.board()}! ${this.rules ? rulesLine(this.rules) : ''}`);
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
      this.voiceAnswer = false;
      void this.say(a.viaBuzzer ? `${a.player} war am schnellsten. Deine Antwort?` : askLine(a), 'ask');
    });
    on('host:verdict', (v) => {
      if (v.correct) this.solved = true;
      void this.say(verdictLine(v, this.voiceAnswer));
      this.voiceAnswer = false;
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
    if (this.timing) Object.assign(this.timing.rules, this.timing.base);
    this.timing = null;
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
