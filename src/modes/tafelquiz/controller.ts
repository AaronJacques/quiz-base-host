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

const log = createLogger('tafelquiz');

type AnswerOutcome = { kind: 'answer'; answer: string } | { kind: 'override'; correct: boolean } | { kind: 'skip' } | { kind: 'timeout' };

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
  private playerSig = '';
  private codeAnnounced = false;
  private startRequested = false;
  private signal!: AbortSignal;

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
    if (!s.lobbyCode) await this.d.page.revealCode();
    else if (!this.codeAnnounced) {
      this.codeAnnounced = true;
      this.status('lobby', `Lobby offen – Code ${s.lobbyCode}`);
    }
    const enough = s.players.length >= this.d.game.minPlayers;
    if (s.canStart && enough && (this.d.game.autoStart || this.startRequested)) {
      this.status('lobby', 'Alle bereit – Spiel startet!');
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

    const current = s.players.find((p) => p.isTurn) ?? s.players[0];
    if (!current) return void (await sleep(this.d.pollMs));
    const categories = [...new Set(s.grid.map((c) => c.category))];
    this.d.bus.emit('host:turn', { player: current.name, open, categories });
    this.status('board', `${current.name} ist am Zug – wähle Kategorie und Punkte.`);

    const pick = await this.whilePage(
      (x) => x.phase === 'board' && x.players.find((p) => p.isTurn)?.name === current.name,
      (signal) =>
        this.d.bus.waitFor(
          'player:pick',
          (p) => (p.player === current.name || p.player === '@operator') && open.some((c) => c.col === p.col && c.row === p.row),
          this.d.game.pickReminderSec * 1000,
          signal,
        ),
    );
    if (pick === 'page-changed') return; // host acted in the browser (opened a question, ended the game, …)
    if (!pick) {
      this.say(`⏰ ${current.name}, du bist dran – such dir eine Frage aus!`);
      return;
    }
    const cell = open.find((c) => c.col === pick.col && c.row === pick.row)!;
    this.lastPick = { ...cell, player: current.name };
    this.say(`${current.name} nimmt ${cell.category} für ${cell.points}.`);
    await this.d.page.openCell(cell.col, cell.row);
    await this.d.page.waitFor((x) => x.phase === 'question', 5000, 250);
  }

  // ───────────────────────────── Question ─────────────────────────────
  private async onQuestion(s: TafelquizState): Promise<void> {
    const q = s.question!;
    const answerer = s.players.find((p) => p.isTurn)?.name ?? this.lastPick?.player ?? s.players[0]?.name ?? '?';
    const category = this.lastPick?.category ?? '';
    const hints = q.audio.title ? [`Audio-Titel: ${q.audio.title}`] : [];

    this.d.bus.emit('host:question', {
      player: answerer,
      category,
      points: q.points,
      text: q.text,
      hasImage: q.imageUrls.length > 0,
      hasAudio: q.audio.present,
    });
    if (q.audio.present && this.d.game.autoplayAudio) await this.d.page.playAudio();

    // Resolve the reference answer in parallel while the player thinks.
    const referencePromise = this.resolveReference(q, hints);

    // 1) The player who picked the question answers.
    const tried = new Set<string>();
    let solved = await this.askAndJudge(answerer, q, referencePromise, hints, false);
    tried.add(answerer);

    // 2) Optional buzzer round for everybody else.
    if (!solved && this.d.game.buzzerOnWrong) solved = await this.buzzerRound(q, referencePromise, hints, tried, s.players.length);

    // 3) Reveal + close.
    const reference = await referencePromise;
    const shown = reference ? stripUrls(reference).replace(/\s+/g, ' ').trim() : null;
    this.d.bus.emit('host:reveal', { answer: shown });
    if (shown) this.say(`💡 Lösung: ${shown}`);
    await this.d.page.stopTimer();
    await this.d.page.stopAudio();
    await sleep(this.d.game.revealPauseSec * 1000);
    const before = await this.d.page.state();
    const prevTurn = before.players.find((p) => p.isTurn)?.name;
    if (before.phase === 'question') await this.d.page.closeQuestion();
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
    viaBuzzer: boolean,
  ): Promise<boolean> {
    const timeoutSec = viaBuzzer ? this.d.game.buzzAnswerTimeoutSec : this.d.game.answerTimeoutSec;
    this.d.bus.emit('host:await-answer', { player, timeoutSec, viaBuzzer });
    this.status('question', `${player}, deine Antwort? (${timeoutSec}s)`);
    await this.d.page.startTimer(timeoutSec);

    const outcome = await this.collectAnswer(player, timeoutSec * 1000 + 3000);
    await this.d.page.stopTimer();

    let result: JudgeResult;
    let answerText = '';
    switch (outcome.kind) {
      case 'skip':
        return true; // operator skipped or question closed in the browser – no points
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
        result = await this.d.judge.judge.judge({ question: q.text, reference, answer: outcome.answer, hints });
      }
    }

    const correct = result.verdict === 'correct';
    const delta = scoreFor(q.points, correct, viaBuzzer, this.d.game);
    if (result.verdict === 'unsure') log.warn('Keine sichere Entscheidung – werte als falsch ohne Abzug');
    const appliedDelta = result.verdict === 'unsure' ? 0 : delta;
    if (appliedDelta !== 0) await this.d.page.award(player, appliedDelta);
    await this.d.page.animate(correct ? 'Richtig' : 'Falsch');
    this.d.bus.emit('host:verdict', { player, answer: answerText, correct, delta: appliedDelta, reason: result.reason });
    this.say(`${correct ? '✅' : '❌'} ${player}: "${answerText}" ist ${correct ? 'richtig' : 'falsch'}${appliedDelta ? ` (${appliedDelta > 0 ? '+' : ''}${appliedDelta})` : ''}.`);
    return correct;
  }

  private async buzzerRound(
    q: QuestionState,
    referencePromise: Promise<string | null>,
    hints: string[],
    tried: Set<string>,
    playerCount: number,
  ): Promise<boolean> {
    while (tried.size < playerCount && !this.signal.aborted) {
      let s = await this.d.page.state();
      if (s.question?.buzzer.status === 'buzzed') await this.d.page.resetBuzzer();
      s = await this.d.page.state();
      if (s.question?.buzzer.status !== 'open') await this.d.page.releaseBuzzer();
      this.say(`🔔 Buzzer frei! (${this.d.game.buzzWindowSec}s)`);
      this.status('question', 'Buzzer frei');

      const buzzed = await this.d.page.waitFor(
        (x) => x.phase !== 'question' || (x.question?.buzzer.status === 'buzzed' && !!x.question.buzzer.buzzedBy),
        this.d.game.buzzWindowSec * 1000,
        250,
      );
      const who = buzzed?.question?.buzzer.buzzedBy;
      if (!who) {
        this.say('Niemand hat gebuzzert.');
        return false;
      }
      if (tried.has(who)) {
        log.info(`${who} hat schon geantwortet – Buzz ignoriert`);
        continue;
      }
      tried.add(who);
      this.say(`🔔 ${who} hat gebuzzert!`);
      if (await this.askAndJudge(who, q, referencePromise, hints, true)) return true;
    }
    return false;
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
        await sleep(this.d.pollMs * 2);
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

  /** Wait for the answer of `player`, or an operator decision; aborts if the question gets closed in the browser. */
  private async collectAnswer(player: string, timeoutMs: number): Promise<AnswerOutcome> {
    const res = await this.whilePage((x) => x.phase === 'question', (signal) => this.collectAnswerRaw(player, timeoutMs, signal));
    return res === 'page-changed' ? { kind: 'skip' } : res;
  }

  private async collectAnswerRaw(player: string, timeoutMs: number, outer: AbortSignal): Promise<AnswerOutcome> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    outer.addEventListener('abort', onAbort);
    const answerP = this.d.bus
      .waitFor('player:answer', (a) => a.player === player || a.player === '@operator', timeoutMs, ac.signal)
      .then((a): AnswerOutcome | null => (a ? { kind: 'answer', answer: a.answer } : null));
    const opP = this.d.bus
      .waitFor('operator:command', (c) => ['richtig', 'falsch', 'r', 'f', 'skip'].includes(c.command), timeoutMs, ac.signal)
      .then((c: HostEvents['operator:command'] | null): AnswerOutcome | null =>
        !c ? null : c.command === 'skip' ? { kind: 'skip' } : { kind: 'override', correct: c.command.startsWith('r') },
      );
    const first = await Promise.race([answerP, opP]);
    ac.abort();
    outer.removeEventListener('abort', onAbort);
    return first ?? { kind: 'timeout' };
  }

  /** Host note → correct MC option → cached/vision-solved answer → null. */
  private async resolveReference(q: QuestionState, hints: string[]): Promise<string | null> {
    if (q.note) return q.note;
    const correct = q.options.find((o) => o.correct);
    if (correct) return correct.label;
    const solver = this.d.judge.solver;
    if (!solver) return q.audio.title;

    const key = JudgeCache.questionKey(q.text, q.imageUrls[0]);
    const cached = this.d.judge.cache.getSolution(key);
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
      log.info(`Lösung (LLM): ${sol.answer} (${Math.round(sol.confidence * 100)}%)`);
      if (sol.confidence < 0.6) return null; // too unsure to grade against – the judge falls back to its own knowledge + hints
      this.d.judge.cache.setSolution(key, sol);
      return sol.answer;
    } catch (e) {
      log.warn(`Lösung konnte nicht bestimmt werden: ${(e as Error).message}`);
      return q.audio.title;
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────
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
