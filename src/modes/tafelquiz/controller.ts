import type { Config } from '../../config.ts';
import type { EventBus, HostEvents } from '../../core/events.ts';
import { createLogger, sleep } from '../../core/logger.ts';
import type { BoardCell, QuestionState, TafelquizState } from '../../core/types.ts';
import { JudgeCache, type JudgeKit, type JudgeResult } from '../../judge/index.ts';
import { stripUrls } from '../../judge/normalize.ts';
import type { ImageInput } from '../../llm/client.ts';
import type { TafelquizPort } from '../../site/tafelquiz/page.ts';
import type { GameMode } from '../mode.ts';
import { scoreFor } from './rules.ts';

/** Lets a wait move its deadline later: call `to(at)` with the new deadline (epoch ms); returns the unsubscribe. */
type Extend = (to: (at: number) => void) => () => void;
/** `confirmAtDeadline` off: the wait ends this long after the bot let an unconfirmed answer lapse. */
const LAPSE_MARGIN_MS = 300;

/** While waiting for a pick, the reminder rules are read again this often – a change (also from "aus") counts within it. */
const REMINDER_RECHECK_MS = 30_000;
/** "No time limit" for the pick listener of a turn (the longest timer Node allows); the turn's end removes it. */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

const log = createLogger('tafelquiz');

/** Numbers every question this process hosts – the scope of early judgements never repeats, not even in a new game. */
let questionSeq = 0;

type AnswerOutcome = { kind: 'answer'; answer: string; spoken?: boolean } | { kind: 'override'; correct: boolean } | { kind: 'skip' } | { kind: 'timeout' };

export interface TafelquizDeps {
  page: TafelquizPort;
  bus: EventBus;
  judge: JudgeKit;
  game: Config['game'];
  pollMs: number;
}

/**
 * Deterministic host for the Tafelquiz format. It never calls an LLM itself –
 * only `judge` may (and only when fuzzy matching is not confident).
 *
 * Loop: read page state → act for the current phase → repeat.
 * Each phase handler is idempotent so the host can be (re)started at any point
 * of a running game.
 */
export class TafelquizController implements GameMode {
  readonly name = 'Tafelquiz';
  private lastPick: (BoardCell & { player: string }) | null = null;
  private finishedBoards = new Set<number>();
  /** After we closed a question with "Nächster Spieler": who quiz-base must show next, and who it showed before. */
  private rotation: { from: string; to: string; waited?: boolean } | null = null;
  private playerSig = '';
  private lobbySig = '';
  private codeAnnounced = false;
  private startRequested = false;
  private signal!: AbortSignal;
  /** Reminders sent in the current turn (player, board, open cards): the first comes late, later ones rarely. */
  private reminded = { turn: '', count: 0, since: 0 };
  /** The open question's id (scope of early judgements) and its gate: at most one early judgement at a time. */
  private questionId = '';
  private early: { running: boolean; next: (() => void) | null } = { running: false, next: null };

  constructor(private d: TafelquizDeps) {
    d.bus.on('operator:command', (c) => {
      if (c.command === 'start') this.startRequested = true;
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    while (!signal.aborted) {
      let s: TafelquizState;
      try {
        s = await this.d.page.state();
      } catch (e) {
        log.warn(`Seite nicht lesbar: ${(e as Error).message}`);
        await sleep(1500);
        continue;
      }
      this.publishPlayers(s);
      switch (s.phase) {
        case 'lobby':
          await this.onLobby(s);
          break;
        case 'sound-gate':
          await this.d.page.passSoundGate();
          break;
        case 'board':
          await this.onBoard(s);
          break;
        case 'question':
          await this.onQuestion(s);
          break;
        case 'results':
          this.d.bus.emit('host:game-over', { players: s.players });
          this.say('🏁 Spiel vorbei! ' + ranking(s));
          return;
        default:
          await sleep(this.d.pollMs);
      }
    }
  }

  // ───────────────────────────── Lobby ─────────────────────────────
  private async onLobby(s: TafelquizState): Promise<void> {
    const lobbySig = JSON.stringify([s.lobbyCode, s.players.map((p) => [p.name, p.ready]), s.canStart]);
    if (lobbySig !== this.lobbySig) {
      this.lobbySig = lobbySig;
      this.d.bus.emit('host:lobby', {
        code: s.lobbyCode,
        players: s.players.map((p) => ({ name: p.name, ready: !!p.ready })),
        canStart: s.canStart,
      });
    }
    if (!s.lobbyCode) await this.d.page.revealCode();
    else if (!this.codeAnnounced) {
      this.codeAnnounced = true;
      this.status('lobby', `Lobby offen – Code ${s.lobbyCode}`);
    }
    // minPlayers only holds back the automatic start – a start the game leader asked for ("!quiz los") always goes.
    const enough = s.players.length >= this.d.game.minPlayers;
    if (s.canStart && ((this.d.game.autoStart && enough) || this.startRequested)) {
      this.status('lobby', 'Alle bereit – Spiel startet!');
      this.notice('started', 'Alle bereit – das Spiel startet!');
      await this.d.page.startGame();
      await sleep(1500);
      return;
    }
    await sleep(this.d.pollMs * 2);
  }

  // ───────────────────────────── Board ─────────────────────────────
  private async onBoard(s: TafelquizState): Promise<void> {
    const open = s.grid.filter((c) => !c.answered);
    if (!open.length) {
      this.finishedBoards.add(s.boards.active);
      const next = Array.from({ length: s.boards.count }, (_, i) => i + 1).find((b) => !this.finishedBoards.has(b));
      if (next) {
        this.say(`Board ${s.boards.active} ist durch – weiter mit Board ${next}!`);
        this.notice('board-switch', `Board ${s.boards.active} ist durch – weiter mit Board ${next}!`);
        await this.d.page.selectBoard(next);
        await sleep(1200);
        return;
      }
      if (this.d.game.autoEnd) {
        this.say('Alle Fragen gespielt – Auswertung!');
        await this.d.page.endGame();
        await sleep(2000);
      } else await sleep(2000);
      return;
    }

    let current = s.players.find((p) => p.isTurn) ?? s.players[0];
    if (!current) return void (await sleep(this.d.pollMs));
    // quiz-base sometimes keeps showing "Am Zug" at the previous player although "Nächster Spieler"
    // already passed the turn on (it corrects itself when the next card opens). Wait a bit, then trust the order.
    const rot = this.rotation;
    let staleName: string | null = null;
    if (rot && current.name === rot.from) {
      let shown: string | undefined = current.name;
      if (!rot.waited) {
        rot.waited = true;
        const fresh = await this.d.page.waitFor((x) => x.phase !== 'board' || x.players.find((p) => p.isTurn)?.name !== rot.from, 6000, 300);
        if (fresh && fresh.phase !== 'board') return;
        shown = fresh?.players.find((p) => p.isTurn)?.name ?? shown;
      }
      if (shown === rot.from) {
        const next = s.players.find((p) => p.name === rot.to);
        if (next) {
          log.warn(`quiz-base zeigt „Am Zug“ noch bei ${rot.from} – laut Reihenfolge ist ${rot.to} dran`);
          staleName = rot.from;
          current = next;
        }
      } else return; // the page caught up – next loop reads the right player
    } else this.rotation = null; // page shows someone else → quiz-base is in charge again
    const turnName = current.name;
    const turnKey = `${current.name}|${s.boards.active}|${open.length}`;
    if (this.reminded.turn !== turnKey) this.reminded = { turn: turnKey, count: 0, since: Date.now() };
    // One listener for the whole turn, set up before the turn is announced: there is no moment in which a
    // pick goes unheard. Reminders run beside it on a timer and never interrupt it.
    const turn = new AbortController();
    const picked = this.d.bus.waitFor(
      'player:pick',
      (p) => (p.player === current.name || p.player === '@operator') && open.some((c) => c.col === p.col && c.row === p.row),
      NO_TIMEOUT_MS,
      turn.signal,
    );
    const categories = [...new Set(s.grid.map((c) => c.category))];
    this.d.bus.emit('host:turn', { player: current.name, open, grid: s.grid, categories, board: s.boards });
    this.status('board', `${current.name} ist am Zug – wähle Kategorie und Punkte.`);

    let timer: NodeJS.Timeout | undefined;
    const remindLater = () => {
      // Read the rule every time: a change during the turn counts from the turn start (or the last reminder).
      const waitSec = this.reminded.count === 0 ? this.d.game.pickReminderSec : this.d.game.pickReminderRepeatSec;
      const due = waitSec > 0 ? this.reminded.since + waitSec * 1000 : Infinity;
      timer = setTimeout(() => {
        if (turn.signal.aborted) return;
        if (Date.now() >= due) {
          this.reminded = { ...this.reminded, count: this.reminded.count + 1, since: Date.now() };
          this.say(`⏰ ${current.name}, du bist dran – such dir eine Frage aus!`);
          this.notice('reminder', 'Du bist dran – such dir eine Frage aus!', current.name);
        }
        remindLater();
      }, Math.max(0, Math.min(REMINDER_RECHECK_MS, due - Date.now())));
    };
    remindLater();
    let pick: HostEvents['player:pick'] | null | 'page-changed';
    try {
      pick = await this.whilePage(
        (x) => {
          const shown = x.players.find((p) => p.isTurn)?.name;
          return x.phase === 'board' && (shown === turnName || (!!staleName && shown === staleName));
        },
        (signal) => Promise.race([picked, new Promise<null>((r) => signal.addEventListener('abort', () => r(null), { once: true }))]),
      );
    } finally {
      turn.abort(); // removes the listener (turn over, page changed, game stopped)
      clearTimeout(timer);
    }
    if (!pick || pick === 'page-changed' || this.signal.aborted) return; // host acted in the browser / game stopped
    const cell = open.find((c) => c.col === pick.col && c.row === pick.row)!;
    this.rotation = null;
    this.lastPick = { ...cell, player: current.name };
    this.say(`${current.name} nimmt ${cell.category} für ${cell.points}.`);
    await this.d.page.openCell(cell.col, cell.row);
    await this.d.page.waitFor((x) => x.phase === 'question', 5000, 100);
  }

  // ───────────────────────────── Question ─────────────────────────────
  private async onQuestion(s: TafelquizState): Promise<void> {
    let q = s.question!;
    this.questionId = `q${++questionSeq}`;
    this.early = { running: false, next: null };
    // The answer options may appear a moment after the question text. Without them a letter answer ("D")
    // cannot be judged and the correct option is no reference – give the page a moment.
    if (!q.note && !q.options.length) {
      const settled = await this.d.page.waitFor((x) => x.phase !== 'question' || !!x.question?.note || !!x.question?.options.length, 1200, 200);
      if (settled?.question) q = settled.question;
    }
    // Who picked is known for sure (turn / rotation) – quiz-base may still show the previous player for a moment.
    // Only a card opened by hand in the browser falls back to the page's "Am Zug".
    const answerer = this.lastPick?.player ?? s.players.find((p) => p.isTurn)?.name ?? s.players[0]?.name ?? '?';
    const category = this.lastPick?.category ?? '';
    const hints = q.audio.title ? [`Audio-Titel: ${q.audio.title}`] : [];
    const media = JudgeCache.mediaKey(q);

    this.d.bus.emit('host:question', {
      player: answerer,
      category,
      points: q.points,
      text: q.text,
      hasImage: q.imageUrls.length > 0,
      hasAudio: q.audio.present,
      options: q.options.map((o) => o.label),
    });
    if (q.audio.present && this.d.game.autoplayAudio) await this.d.page.playAudio();

    // Resolve the reference answer in parallel while the player thinks.
    const referencePromise = this.resolveReference(q, hints);

    // 1) The player who picked the question answers.
    const tried = new Set<string>();
    let solved = await this.askAndJudge(answerer, q, referencePromise, hints, media, false);
    // Game ended mid-question: no verdict, no points, no more clicks – the session closes the page.
    if (this.signal.aborted) return;
    tried.add(answerer);

    // 2) Optional buzzer round for everybody else.
    if (!solved && this.d.game.buzzerOnWrong) solved = await this.buzzerRound(q, referencePromise, hints, media, tried, s.players.length);
    if (this.signal.aborted) return;

    // 3) Reveal + close.
    const after = await this.d.page.state();
    if (after.phase === 'results') return; // ended in the browser – the main loop reports the results
    this.publishPlayers(after); // scores right after awarding, for the reveal message
    const reference = await referencePromise;
    if (this.signal.aborted) return;
    const choice = q.options.find((o) => o.correct && o.label === reference);
    const shown = choice ? `${choice.letter}) ${choice.label}` : reference ? stripUrls(reference).replace(/\s+/g, ' ').trim() : null;
    this.d.bus.emit('host:reveal', { answer: shown });
    if (shown) this.say(`💡 Lösung: ${shown}`);
    await this.d.page.stopTimer();
    await this.d.page.stopAudio();
    // A solved question needs less reading time than an unsolved one (the answer was just said).
    const pauseSec = solved ? this.d.game.revealPauseSolvedSec : this.d.game.revealPauseSec;
    await sleep(pauseSec * 1000, this.signal); // resolves early on abort
    if (this.signal.aborted) return;
    const before = await this.d.page.state();
    const prevTurn = before.players.find((p) => p.isTurn)?.name;
    if (before.phase === 'question') {
      await this.d.page.closeQuestion();
      const order = before.players.map((p) => p.name);
      if (prevTurn && order.length >= 2) this.rotation = { from: prevTurn, to: order[(order.indexOf(prevTurn) + 1) % order.length]! };
    }
    // quiz-base rotates "Am Zug" a moment after the board reappears – wait for it,
    // otherwise the next pick would be attributed to the previous player.
    await this.d.page.waitFor(
      (x) => x.phase !== 'question' && (x.players.length < 2 || x.phase !== 'board' || x.players.find((p) => p.isTurn)?.name !== prevTurn),
      4000,
      200,
    );
    this.lastPick = null;
  }

  private async askAndJudge(
    player: string,
    q: QuestionState,
    referencePromise: Promise<string | null>,
    hints: string[],
    media: string | null,
    viaBuzzer: boolean,
  ): Promise<boolean> {
    const timeoutSec = viaBuzzer ? this.d.game.buzzAnswerTimeoutSec + Math.round(this.bonusSec / 2) : this.d.game.answerTimeoutSec + this.bonusSec;
    const askedAt = Date.now();
    this.d.bus.emit('host:await-answer', { player, timeoutSec, viaBuzzer });
    this.status('question', `${player}, deine Antwort? (${timeoutSec}s)`);
    await this.d.page.startTimer(timeoutSec);

    // A spoken answer waiting for "Ja" is judged already (no operator stage, nothing public) – "Ja" then takes the result.
    const scope = `${this.questionId}|${player}`;
    const prejudging = this.judgeEarly(scope, q, referencePromise, hints, media);
    // Speech: an answer asked back ("Paris?") in the last `confirmGraceSec` of the answer time gets up to that much more
    // for its "Ja" – never more. An earlier one has its time for "Ja" within the answer time (the bot's `armPending`
    // does the same sum), so it gets nothing. The clock on quiz-base is already at 0 then.
    // - `confirmAtDeadline` on: the bot submits it by D0 + grace; the wait ends 3 s after that at the latest.
    // - off: the bot lets it lapse at min(D0 + grace, asked back + grace) – the wait ends right after that, with the
    //   usual timeout ("Die Zeit ist um"), instead of seconds of silence in which a late "Ja" would go nowhere.
    const baseMs = timeoutSec * 1000 + 3000;
    const graceMs = this.d.game.confirmGraceSec * 1000;
    const answerEnd = askedAt + timeoutSec * 1000; // D0, as the bot counts it
    const waitFrom = Date.now(); // the wait below starts now (`whilePage` calls it at once)
    let extendTo: ((at: number) => void) | null = null;
    // One listener for both: early judging and the grace (only the controller listens to this event).
    const offPending = this.d.bus.on('player:answer-pending', (p) => {
      if (p.player !== player) return;
      prejudging.pending(p.answer);
      const now = Date.now();
      if (graceMs <= 0 || now < answerEnd - graceMs) return;
      extendTo?.(this.d.game.confirmAtDeadline ? waitFrom + baseMs + graceMs : Math.min(answerEnd, now) + graceMs + LAPSE_MARGIN_MS);
    });
    let outcome: AnswerOutcome;
    try {
      outcome = await this.collectAnswer(player, baseMs, (to) => {
        extendTo = to;
        return () => void (extendTo = null);
      });
    } finally {
      offPending();
      prejudging.stop(); // before judging: no early judgement may start after this
    }
    if (this.signal.aborted) return false; // game ended: no verdict, no points, no clicks
    // Operator skipped or the question was closed in the browser – no points (the reveal stops the timer).
    if (outcome.kind === 'skip') return true;
    await this.d.page.stopTimer();

    let result: JudgeResult;
    let answerText = '';
    switch (outcome.kind) {
      case 'override':
        result = { verdict: outcome.correct ? 'correct' : 'wrong', method: 'operator', confidence: 1 };
        answerText = '(Host-Entscheidung)';
        break;
      case 'timeout':
        result = { verdict: 'wrong', method: 'rule', confidence: 1, reason: 'Zeit abgelaufen' };
        answerText = '(keine Antwort)';
        break;
      case 'answer': {
        answerText = outcome.answer;
        const reference = await referencePromise;
        result = await this.d.judge.judge.judge({ question: q.text, reference, answer: outcome.answer, hints, spoken: outcome.spoken, media, options: q.options, scope });
      }
    }
    if (this.signal.aborted) return false; // ended while the judge was thinking

    const correct = result.verdict === 'correct';
    const delta = scoreFor(q.points, correct, viaBuzzer, this.d.game);
    if (result.verdict === 'unsure') log.warn('Keine sichere Entscheidung – werte als falsch ohne Abzug');
    const appliedDelta = result.verdict === 'unsure' ? 0 : delta;
    const verdict = () => {
      this.d.bus.emit('host:verdict', { player, answer: answerText, correct, delta: appliedDelta, reason: result.reason });
      this.say(`${correct ? '✅' : '❌'} ${player}: "${answerText}" ist ${correct ? 'richtig' : 'falsch'}${appliedDelta ? ` (${appliedDelta > 0 ? '+' : ''}${appliedDelta})` : ''}.`);
    };
    if (appliedDelta === 0) {
      await this.d.page.animate(correct ? 'Richtig' : 'Falsch');
      verdict();
      return correct;
    }
    const before = (await this.d.page.state()).players.find((p) => p.name === player)?.score;
    const awarded = await this.d.page.award(player, appliedDelta);
    // The click went through: announce at once – quiz-base takes ~1.3 s to show the new score. A failed click keeps the
    // order as before (wait first, then announce), so nothing is announced earlier than the page could show it.
    const early = awarded.ok;
    if (early) verdict();
    else log.warn(`Punkte für ${player} (${appliedDelta}) nicht vergeben: ${awarded.error ?? 'unbekannter Fehler'}`);
    // quiz-base shows new scores with a delay – wait so that everything reading the scores next (buzzer round, reveal,
    // standings, next turn) sees the page's real score. A game ended meanwhile (stopped, or in the browser) ends the wait.
    // The early verdict lets the game leader overrule it while we wait ("!quiz richtig/falsch", a correction): the
    // session books those points on the page right away. Count them in, so the wait ends at the corrected score.
    let fix = 0;
    const offFix = this.d.bus.on('operator:command', (c) => {
      if (c.command !== 'punkte' || c.args.length < 2 || c.args.slice(0, -1).join(' ') !== player) return;
      const n = Number(c.args[c.args.length - 1]);
      if (Number.isFinite(n)) fix += n;
    });
    try {
      if (before !== undefined) {
        const shown = await this.d.page.waitFor(
          (x) => this.signal.aborted || x.phase === 'results' || x.players.find((p) => p.name === player)?.score === before + appliedDelta + fix,
          3000,
          150,
        );
        if (this.signal.aborted) return false; // game ended: no more clicks (and no late verdict)
        if (shown?.phase === 'results') {
          if (!early) verdict(); // as before: the verdict still counts (the results show its points)
          return true; // question over: no buzzer round on the results screen – the main loop reports the results
        }
        if (!shown) {
          const now = await this.d.page.state().catch(() => null);
          log.warn(`Punktestand von ${player}: erwartet ${before + appliedDelta + fix}, quiz-base zeigt ${now?.players.find((p) => p.name === player)?.score ?? '?'}`);
        }
      }
    } finally {
      offFix();
    }
    // Overruled in the window (the points now are what the other outcome gives): the page shows that outcome, and a
    // verdict turned into "richtig" opens no buzzer round. "richtig" → "falsch" opens none either, like a later correction.
    const flipped = fix !== 0 && appliedDelta + fix === scoreFor(q.points, !correct, viaBuzzer, this.d.game);
    const shownCorrect = flipped ? !correct : correct;
    await this.d.page.animate(shownCorrect ? 'Richtig' : 'Falsch');
    if (!early) verdict();
    return correct || shownCorrect;
  }

  private async buzzerRound(
    q: QuestionState,
    referencePromise: Promise<string | null>,
    hints: string[],
    media: string | null,
    tried: Set<string>,
    playerCount: number,
  ): Promise<boolean> {
    const windowSec = this.d.game.buzzWindowSec + this.bonusSec;
    /** End of the current buzzer window (0 = not open yet). Buzzes of people who already answered do not extend it. */
    let deadline = 0;
    while (tried.size < playerCount && !this.signal.aborted) {
      let s = await this.d.page.state();
      if (deadline && Date.now() >= deadline) {
        if (s.question?.buzzer.status === 'buzzed') await this.d.page.resetBuzzer();
        return this.noBuzz();
      }
      if (s.question?.buzzer.status === 'buzzed') await this.d.page.resetBuzzer();
      s = await this.d.page.state();
      if (s.question?.buzzer.status !== 'open') await this.d.page.releaseBuzzer();
      if (!deadline) {
        deadline = Date.now() + windowSec * 1000;
        this.say(`🔔 Buzzer frei! (${windowSec}s)`);
        this.notice('buzzer-open', `Buzzer frei! Wer es weiß, drückt auf quiz-base den Buzzer (${windowSec} s).`);
        this.status('question', 'Buzzer frei');
      }

      const first = await this.firstBuzz(tried, Math.max(0, deadline - Date.now()));
      if (first.src === 'abort') return false;
      if (first.src === 'skip') return true; // the game leader skipped the question → reveal
      const who = first.who;
      if (who && (await this.d.page.state()).question?.buzzer.status === 'open') await this.d.page.resetBuzzer(); // lock the page buzzer for the others
      if (!who) return this.noBuzz();
      if (tried.has(who)) {
        log.info(`${who} hat schon geantwortet – Buzz ignoriert`);
        continue; // same window: re-open the page buzzer silently, no new announcement
      }
      tried.add(who);
      this.say(`🔔 ${who} hat gebuzzert!`);
      this.notice('buzzed', 'hat gebuzzert!', who);
      if (await this.askAndJudge(who, q, referencePromise, hints, media, true)) return true;
      deadline = 0; // wrong → a fresh window for the rest
    }
    return false;
  }

  private noBuzz(): false {
    this.say('Niemand hat gebuzzert.');
    this.notice('no-buzz', 'Niemand hat gebuzzert.');
    return false;
  }

  /**
   * Whoever is first within `ms`: the quiz-base buzzer, a buzz claimed by voice (player:buzz),
   * or the game leader skipping the question. `who` is null when the window ran out.
   */
  private firstBuzz(tried: Set<string>, ms: number): Promise<{ src: 'bus' | 'page' | 'skip' | 'abort'; who: string | null }> {
    return new Promise((resolve) => {
      const ac = new AbortController();
      const done = (r: { src: 'bus' | 'page' | 'skip' | 'abort'; who: string | null }) => {
        if (ac.signal.aborted) return;
        ac.abort();
        this.signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => done({ src: 'abort', who: null });
      if (this.signal.aborted) return onAbort();
      this.signal.addEventListener('abort', onAbort);
      void this.d.bus.waitFor('player:buzz', (b) => !tried.has(b.player), ms, ac.signal).then((b) => b && done({ src: 'bus', who: b.player }));
      void this.d.bus.waitFor('operator:command', (c) => c.command === 'skip', ms, ac.signal).then((c) => c && done({ src: 'skip', who: null }));
      void this.d.page
        .waitFor((x) => ac.signal.aborted || x.phase !== 'question' || (x.question?.buzzer.status === 'buzzed' && !!x.question.buzzer.buzzedBy), ms, 250)
        .then((x) => done({ src: 'page', who: x?.question?.buzzer.buzzedBy ?? null }))
        .catch(() => done({ src: 'page', who: null }));
    });
  }

  /**
   * Run `wait` while watching the page. If `stillValid` stops holding (e.g. a
   * human clicked something in the browser), the wait is cancelled and
   * 'page-changed' is returned.
   */
  private async whilePage<T>(stillValid: (s: TafelquizState) => boolean, wait: (signal: AbortSignal) => Promise<T>): Promise<T | 'page-changed'> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    this.signal.addEventListener('abort', onAbort);
    let changed = false;
    const watcher = (async () => {
      while (!ac.signal.aborted) {
        // The pause ends as soon as the work is done (or the page changed) – `await watcher` below then only
        // waits for a state() that is already running, not for the rest of the pause.
        await sleep(this.d.pollMs * 2, ac.signal);
        if (ac.signal.aborted) return;
        const s = await this.d.page.state().catch(() => null);
        if (s && !stillValid(s)) {
          changed = true;
          ac.abort();
        }
      }
    })();
    try {
      const result = await wait(ac.signal);
      return changed ? 'page-changed' : result;
    } finally {
      ac.abort();
      this.signal.removeEventListener('abort', onAbort);
      await watcher;
    }
  }

  /**
   * While `player` is asked back about a spoken answer ("Paris?"), judge it in the background: fuzzy → cache → LLM,
   * never the operator, nothing on the bus. At most one at a time per question; an answer that comes while one runs
   * waits, and only the newest one is judged after it. Nothing for typed answers (no `player:answer-pending`) or
   * answers without a letter or digit. `pending(answer)` takes each `player:answer-pending` of `player` (the caller
   * listens); after `stop()` nothing starts any more – a running judgement may still fill the cache.
   */
  private judgeEarly(scope: string, q: QuestionState, referencePromise: Promise<string | null>, hints: string[], media: string | null): { pending(answer: string): void; stop(): void } {
    const judge = this.d.judge.judge;
    if (!judge.prejudge) return { pending() {}, stop() {} };
    const gate = this.early;
    let stopped = false;
    const start = (answer: string) => {
      if (stopped || this.signal.aborted) return;
      gate.running = true;
      void (async () => {
        const reference = await referencePromise;
        if (stopped || this.signal.aborted) return;
        await judge.prejudge!({ question: q.text, reference, answer, hints, spoken: true, media, options: q.options, scope });
      })()
        .catch(() => {})
        .finally(() => {
          gate.running = false;
          const next = gate.next;
          gate.next = null;
          next?.();
        });
    };
    return {
      pending: (answer) => {
        if (stopped || !/[\p{L}\p{N}]/u.test(answer)) return;
        if (gate.running) gate.next = () => start(answer);
        else start(answer);
      },
      stop: () => {
        stopped = true;
      },
    };
  }

  /**
   * Wait for the answer of `player`, or an operator decision; aborts if the question gets closed in the browser.
   * `extend` may move the deadline (epoch ms) later, never earlier; it returns its unsubscribe.
   */
  private async collectAnswer(player: string, timeoutMs: number, extend?: Extend): Promise<AnswerOutcome> {
    const res = await this.whilePage((x) => x.phase === 'question', (signal) => this.collectAnswerRaw(player, timeoutMs, signal, extend));
    return res === 'page-changed' ? { kind: 'skip' } : res;
  }

  private async collectAnswerRaw(player: string, timeoutMs: number, outer: AbortSignal, extend?: Extend): Promise<AnswerOutcome> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    outer.addEventListener('abort', onAbort);
    let deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let offExtend = () => {};
    const timeoutP = new Promise<null>((resolve) => {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
      };
      arm();
      offExtend = extend?.((at) => {
        if (at <= deadline || ac.signal.aborted) return;
        deadline = at;
        arm();
      }) ?? offExtend;
      ac.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    // The deadline is the timer above; the waits only end on their event or the abort.
    const answerP = this.d.bus
      .waitFor('player:answer', (a) => a.player === player || a.player === '@operator', NO_TIMEOUT_MS, ac.signal)
      .then((a): AnswerOutcome | null => (a ? { kind: 'answer', answer: a.answer, spoken: a.spoken } : null));
    const opP = this.d.bus
      .waitFor('operator:command', (c) => ['richtig', 'falsch', 'r', 'f', 'skip'].includes(c.command), NO_TIMEOUT_MS, ac.signal)
      .then((c: HostEvents['operator:command'] | null): AnswerOutcome | null =>
        !c ? null : c.command === 'skip' ? { kind: 'skip' } : { kind: 'override', correct: c.command.startsWith('r') },
      );
    try {
      const first = await Promise.race([answerP, opP, timeoutP]);
      return first ?? { kind: 'timeout' };
    } finally {
      clearTimeout(timer);
      offExtend();
      ac.abort();
      outer.removeEventListener('abort', onAbort);
    }
  }

  /** Host note → correct MC option → cached/vision-solved answer → null. */
  private async resolveReference(q: QuestionState, hints: string[]): Promise<string | null> {
    if (q.note) return q.note;
    const correct = q.options.find((o) => o.correct);
    if (correct) return correct.label;
    const solver = this.d.judge.solver;
    if (!solver) return q.audio.title;

    // null = some picture/sound has no stable identity (data: image, untitled audio) → solve, but never cache.
    const key = JudgeCache.solutionKey(q.text, q);
    const cached = key ? this.d.judge.cache.getSolution(key) : undefined;
    if (cached && cached.confidence >= 0.6) return cached.answer;
    try {
      const images: ImageInput[] = [];
      if (q.imageUrls.length) {
        // Give the image a moment to load, then look at it like a human host would.
        const ready = await this.d.page.waitFor((x) => !!x.question && x.question.imagesLoaded.every((l) => l !== null), 4000, 300);
        const loaded = ready?.question?.imagesLoaded.some((l) => l) ?? false;
        // A screenshot works for every image source (SVG, data URI, hot-link protected URLs).
        if (loaded) images.push({ kind: 'file', path: await this.d.page.screenshot() });
        // File names are often telling ("SMP_Artwork_Waluigi.png") – also helps when the image is broken.
        for (const u of q.imageUrls) if (u && u !== 'data:') hints.push(`Bild-URL: ${decodeURIComponent(u).slice(0, 200)}`);
        if (!loaded) log.warn('Fragebild lädt nicht (auch für Spieler unsichtbar) – nutze nur Hinweise');
      }
      if (!images.length && !hints.length) return null;
      log.info('Keine Notiz – bestimme Lösung per LLM …');
      const sol = await solver.solve(q.text, images, hints);
      // The solution itself only on debug: the info log is visible to the host before the reveal.
      log.info(`Lösung per LLM bestimmt (${Math.round(sol.confidence * 100)}%)`);
      log.debug(`Lösung (LLM): ${sol.answer}`);
      if (sol.confidence < 0.6) return null; // too unsure to grade against – the judge falls back to its own knowledge + hints
      if (key) this.d.judge.cache.setSolution(key, sol);
      return sol.answer;
    } catch (e) {
      log.warn(`Lösung konnte nicht bestimmt werden: ${(e as Error).message}`);
      return q.audio.title;
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────
  /** Extra answer/buzzer seconds while a voice host narrates (`game.bonusTimeSec`). */
  private get bonusSec(): number {
    return Math.max(0, this.d.game.bonusTimeSec ?? 0);
  }

  private publishPlayers(s: TafelquizState): void {
    const sig = s.players.map((p) => `${p.name}:${p.score}:${p.isTurn}`).join('|');
    if (sig !== this.playerSig) {
      this.playerSig = sig;
      this.d.bus.emit('host:scores', { players: s.players });
    }
  }

  private status(phase: string, message: string): void {
    this.d.bus.emit('host:status', { phase, message });
  }

  private notice(kind: HostEvents['host:notice']['kind'], text: string, player?: string): void {
    this.d.bus.emit('host:notice', { kind, text, player });
  }

  private say(text: string): void {
    this.d.bus.emit('host:say', { text });
  }
}

function ranking(s: TafelquizState): string {
  return [...s.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => `${i + 1}. ${p.name} (${p.score})`)
    .join(', ');
}
