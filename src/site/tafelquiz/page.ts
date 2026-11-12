import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserDriver } from '../../browser/driver.ts';
import type { TafelquizState } from '../../core/types.ts';
import { createLogger, sleep } from '../../core/logger.ts';

const log = createLogger('page');

/** How long ending a game / closing the lobby may take until quiz-base shows it (live: ~0.5 s). */
const END_WAIT_MS = 6000;

const PROBE_SRC = readFileSync(new URL('./probe.browser.js', import.meta.url), 'utf8')
  .trim()
  .replace(/;\s*$/, '');

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** What the game controller needs from the page – lets tests swap in a fake. */
export interface TafelquizPort {
  state(): Promise<TafelquizState>;
  imageData(index?: number): Promise<string | null>;
  /** PNG of what the host currently sees; returns the file path. */
  screenshot(): Promise<string>;
  revealCode(): Promise<ActionResult>;
  startGame(): Promise<ActionResult>;
  passSoundGate(): Promise<ActionResult>;
  selectBoard(n: number): Promise<ActionResult>;
  openCell(col: number, row: number): Promise<ActionResult>;
  animate(kind: 'Richtig' | 'Falsch'): Promise<ActionResult>;
  releaseBuzzer(): Promise<ActionResult>;
  resetBuzzer(): Promise<ActionResult>;
  startTimer(sec: number): Promise<ActionResult>;
  stopTimer(): Promise<ActionResult>;
  playAudio(): Promise<ActionResult>;
  stopAudio(): Promise<ActionResult>;
  closeQuestion(): Promise<ActionResult>;
  award(name: string, delta: number): Promise<ActionResult>;
  endGame(): Promise<ActionResult>;
  waitFor(predicate: (s: TafelquizState) => boolean, timeoutMs: number, pollMs?: number): Promise<TafelquizState | null>;
}

/**
 * Typed façade over the in-page probe. The game controller only talks to this
 * class – it never sees DOM details or the driver.
 */
export class TafelquizPage implements TafelquizPort {
  constructor(private driver: BrowserDriver) {}

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const argList = args.map((a) => JSON.stringify(a)).join(', ');
    return this.driver.evaluate<T>(`(${PROBE_SRC}).${method}(${argList})`);
  }

  private async act(method: string, ...args: unknown[]): Promise<ActionResult> {
    const res = await this.call<ActionResult>(method, ...args);
    if (!res?.ok) log.warn(`${method}(${args.map((a) => JSON.stringify(a)).join(', ')}) → ${res?.error ?? 'failed'}`);
    else log.debug(`${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    return res ?? { ok: false, error: 'no result' };
  }

  state(): Promise<TafelquizState> {
    return this.call<TafelquizState>('readState');
  }

  async screenshot(): Promise<string> {
    await mkdir('.qbhost/tmp', { recursive: true });
    return this.driver.screenshot(path.resolve(`.qbhost/tmp/host-view-${Date.now()}.png`));
  }

  imageData(index = 0): Promise<string | null> {
    return this.call<string | null>('imageData', index);
  }

  revealCode = () => this.act('revealCode');
  startGame = () => this.act('startGame');
  passSoundGate = () => this.act('passSoundGate');
  selectBoard = (n: number) => this.act('selectBoard', n);
  openCell = (col: number, row: number) => this.act('openCell', col, row);
  selectPlayer = (name: string) => this.act('selectPlayer', name);
  animate = (kind: 'Richtig' | 'Falsch') => this.act('animate', kind);
  releaseBuzzer = () => this.act('releaseBuzzer');
  resetBuzzer = () => this.act('resetBuzzer');
  async startTimer(sec: number): Promise<ActionResult> {
    // A running timer must be stopped first; React needs a tick to swap Stopp → Start.
    await this.act('stopTimer');
    await sleep(250);
    return this.act('startTimer', sec);
  }
  stopTimer = () => this.act('stopTimer');
  playAudio = () => this.act('playAudio');
  stopAudio = () => this.act('stopAudio');
  closeQuestion = () => this.act('closeQuestion');

  /**
   * Give or take points. Uses the quick buttons of the open question when the
   * amount matches (full/half value); otherwise falls back to the manual
   * points dialog, which accepts any amount at any time.
   */
  async award(name: string, delta: number): Promise<ActionResult> {
    if (delta === 0) return { ok: true };
    const s = await this.state();
    if (s.question) {
      if (s.question.pointTarget !== name) await this.selectPlayer(name);
      const quick = await this.call<ActionResult>('quickAward', name, delta);
      if (quick.ok) return quick;
    }
    await this.act('openManualPoints');
    await sleep(300);
    const res = await this.act('manualAward', name, delta);
    await sleep(200);
    await this.act('closeDialog');
    return res;
  }

  /**
   * Closes the waiting room (before the game started); confirms a dialog if one appears. Resolves once the waiting
   * room is gone – the browser may be closed right after, and quiz-base must have sent the close by then.
   */
  async closeLobby(): Promise<ActionResult> {
    const r = await this.act('closeLobby');
    await sleep(500);
    if ((await this.state()).dialog) await this.act('confirmDialog', 'Lobby schließen');
    if (r.ok && !(await this.settle((s) => s.phase !== 'lobby'))) log.warn('Lobby schließen: der Warteraum ist noch da');
    return r;
  }

  /**
   * "Spiel beenden" → "Ja, beenden", then waits for the results screen. quiz-base sends the end to the players
   * a moment after the click (live: ~0.5 s); closing the browser right after the click left them on the open question.
   */
  async endGame(): Promise<ActionResult> {
    const r = await this.act('endGame');
    if (!r.ok) return r;
    await sleep(500);
    const c = await this.act('confirmDialog', 'Ja, beenden');
    if (!c.ok) return c;
    if (await this.settle((s) => s.phase === 'results')) return c;
    log.warn('Spiel beenden: quiz-base zeigt keine Ergebnisse');
    return { ok: false, error: 'no results screen after ending the game' };
  }

  /** Like waitFor, but a page that navigates away meanwhile (unreadable for a moment) also counts as settled. */
  private async settle(predicate: (s: TafelquizState) => boolean): Promise<boolean> {
    const end = Date.now() + END_WAIT_MS;
    while (Date.now() < end) {
      const s = await this.state().catch(() => null);
      if (!s || predicate(s)) return true;
      await sleep(250);
    }
    return false;
  }

  /** Poll until `predicate` holds; returns the matching state or null on timeout. */
  async waitFor(predicate: (s: TafelquizState) => boolean, timeoutMs: number, pollMs = 400): Promise<TafelquizState | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await this.state();
      if (predicate(s)) return s;
      await sleep(pollMs);
    }
    return null;
  }
}
