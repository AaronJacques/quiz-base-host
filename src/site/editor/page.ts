import { readFileSync } from 'node:fs';
import type { BrowserDriver } from '../../browser/driver.ts';
import { createLogger, sleep } from '../../core/logger.ts';
import type { ActionResult } from '../tafelquiz/page.ts';

const log = createLogger('editor');

const PROBE_SRC = readFileSync(new URL('./probe.browser.js', import.meta.url), 'utf8')
  .trim()
  .replace(/;\s*$/, '');

export interface EditorCategory {
  name: string;
  count: number | null;
  /** 1 or 2 with two boards, null with one board. */
  board: number | null;
}

export interface EditorQuestion {
  text: string;
  points: number | null;
  expanded: boolean;
  /** Multiple choice on (options) or off (host note); null while collapsed. */
  mc: boolean | null;
  note: string | null;
  options: string[];
  correct: number | null;
}

export interface EditorState {
  url: string;
  heading: string;
  /** "Schritt n von 4" of the editor, null outside the editor. */
  step: number | null;
  title: string;
  templates: string[];
  boardCountButtons: string[];
  supers: string[];
  categories: EditorCategory[];
  /** Category tabs in step 4. */
  tabs: number;
  questions: EditorQuestion[];
  dialog: string | null;
  buttons: string[];
}

/** quiz-base's save dialog asks only for name and description – saved boards are private drafts. */
export interface SaveMeta {
  title: string;
  description: string;
}

export interface SaveResult extends ActionResult {
  /** Editor link of the saved board ("Meine Boards" → Bearbeiten). Shows the solutions – DM/terminal only. */
  url?: string | null;
}

/** What the board writer needs from the editor page – lets tests swap in a fake. */
export interface BoardEditorPort {
  /** Opens the empty Tafelquiz editor (step 1). */
  start(): Promise<void>;
  state(): Promise<EditorState>;
  /** true/false from the user menu; null if it cannot be determined (null is never "logged out"). */
  loginState(): Promise<boolean | null>;
  chooseTemplate(name: string): Promise<ActionResult>;
  clickButton(label: string): Promise<ActionResult>;
  dismissDialog(): Promise<ActionResult>;
  setSuper(i: number, value: string): Promise<ActionResult>;
  setCategoryName(i: number, value: string): Promise<ActionResult>;
  changeCount(i: number, delta: 1 | -1): Promise<ActionResult>;
  toggleCategoryBoard(i: number): Promise<ActionResult>;
  deleteCategory(i: number): Promise<ActionResult>;
  /** 1-based category tab in step 4. */
  selectCategory(n: number): Promise<ActionResult>;
  expandQuestion(i: number): Promise<ActionResult>;
  setQuestionText(i: number, value: string): Promise<ActionResult>;
  setMc(i: number, on: boolean): Promise<ActionResult>;
  setNote(i: number, value: string): Promise<ActionResult>;
  setOption(i: number, k: number, value: string): Promise<ActionResult>;
  setCorrect(i: number, k: number): Promise<ActionResult>;
  changePoints(i: number, delta: 1 | -1): Promise<ActionResult>;
  /** Saves the filled editor as own board (needs a quiz-base login). */
  save(meta: SaveMeta): Promise<SaveResult>;
}

/**
 * Pure decision over the reads of one login check: true on the first true; false only after two false reads at
 * least `minGapMs` apart (a page still loading can show "Anmelden" for a moment); otherwise null.
 */
export function decideLogin(reads: { at: number; value: boolean | null }[], minGapMs = 2000): boolean | null {
  if (reads.some((r) => r.value === true)) return true;
  const falses = reads.filter((r) => r.value === false).map((r) => r.at);
  if (falses.length >= 2 && Math.max(...falses) - Math.min(...falses) >= minGapMs) return false;
  return null;
}

/** Up to `attempts` reads `gapMs` apart (stops early on a decision or an abort), decided by decideLogin. */
export async function loginStateWith(
  read: () => Promise<boolean | null>,
  opts: { attempts?: number; gapMs?: number; signal?: AbortSignal } = {},
): Promise<boolean | null> {
  const attempts = opts.attempts ?? 3;
  const gapMs = opts.gapMs ?? 2500;
  const reads: { at: number; value: boolean | null }[] = [];
  for (let i = 0; i < attempts && !opts.signal?.aborted; i++) {
    if (i) await sleep(gapMs, opts.signal);
    if (opts.signal?.aborted) break;
    reads.push({ at: Date.now(), value: await read().catch(() => null) });
    const d = decideLogin(reads);
    if (d !== null) return d;
  }
  return decideLogin(reads);
}

/** Typed façade over the editor probe. Only the board writer talks to it. */
export class BoardEditorPage implements BoardEditorPort {
  constructor(
    private driver: BrowserDriver,
    private baseUrl: string,
  ) {}

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const argList = args.map((a) => JSON.stringify(a)).join(', ');
    return this.driver.evaluate<T>(`(${PROBE_SRC}).${method}(${argList})`);
  }

  private async act(method: string, ...args: unknown[]): Promise<ActionResult> {
    const res = await this.call<ActionResult>(method, ...args);
    // Values may be questions – keep them out of the info log.
    if (!res?.ok) log.debug(`${method}(${args.length} Argumente) → ${res?.error ?? 'fehlgeschlagen'}`);
    return res ?? { ok: false, error: 'kein Ergebnis' };
  }

  async start(): Promise<void> {
    await this.driver.goto(`${this.baseUrl}/configure-lobby?format=tafelquiz`);
  }

  state(): Promise<EditorState> {
    return this.call<EditorState>('state');
  }

  /**
   * Robust login check: up to `attempts` reads of the user menu `gapMs` apart, stops at the first "logged in".
   * "Logged out" needs two such reads at least 2 s apart (decideLogin); anything else is null.
   */
  loginState(opts: { attempts?: number; gapMs?: number; signal?: AbortSignal } = {}): Promise<boolean | null> {
    return loginStateWith(() => this.readLogin(opts.signal), opts);
  }

  /** One read: open the user menu if needed, wait until it shows (≤ 4 s), read, close what we opened. */
  private async readLogin(signal?: AbortSignal): Promise<boolean | null> {
    const before = await this.call<{ menuOpen: boolean }>('account');
    let openedHere = false;
    if (!before.menuOpen) {
      const opened = await this.act('toggleMenu');
      if (!opened.ok) return null;
      openedHere = true;
    }
    let acc = await this.call<{ menuOpen: boolean; loggedIn: boolean | null }>('account');
    for (const end = Date.now() + 4000; !acc.menuOpen && Date.now() < end && !signal?.aborted; ) {
      await sleep(250, signal);
      acc = await this.call<{ menuOpen: boolean; loggedIn: boolean | null }>('account');
    }
    if (openedHere && acc.menuOpen) await this.act('toggleMenu');
    return acc.loggedIn;
  }

  /** Opens the user menu (holds the login form when logged out). */
  async openUserMenu(): Promise<void> {
    const acc = await this.call<{ menuOpen: boolean }>('account');
    if (!acc.menuOpen) await this.act('toggleMenu');
  }

  /** Reads the login state without clicking anything (null while the menu is closed). */
  accountSnapshot(): Promise<{ menuOpen: boolean; loggedIn: boolean | null }> {
    return this.call('account');
  }

  chooseTemplate = (name: string) => this.act('chooseTemplate', name);
  clickButton = (label: string) => this.act('clickButton', label);
  dismissDialog = () => this.act('dismissDialog');
  setSuper = (i: number, v: string) => this.act('setSuper', i, v);
  setCategoryName = (i: number, v: string) => this.act('setCategoryName', i, v);
  changeCount = (i: number, d: 1 | -1) => this.act('changeCount', i, d);
  toggleCategoryBoard = (i: number) => this.act('toggleCategoryBoard', i);
  deleteCategory = (i: number) => this.act('deleteCategory', i);
  selectCategory = (n: number) => this.act('selectCategory', n);
  expandQuestion = (i: number) => this.act('expandQuestion', i);
  setQuestionText = (i: number, v: string) => this.act('setQuestionText', i, v);
  setMc = (i: number, on: boolean) => this.act('setMc', i, on);
  setNote = (i: number, v: string) => this.act('setNote', i, v);
  setOption = (i: number, k: number, v: string) => this.act('setOption', i, k, v);
  setCorrect = (i: number, k: number) => this.act('setCorrect', i, k);
  changePoints = (i: number, d: 1 | -1) => this.act('changePoints', i, d);

  /**
   * "Board speichern" → modal (name, description) → "Speichern". quiz-base saves a private draft;
   * the modal closes only on success. Afterwards the editor link is looked up in "Meine Boards".
   */
  async save(meta: SaveMeta): Promise<SaveResult> {
    const open = await this.act('clickButton', 'Board speichern');
    if (!open.ok) return { ok: false, error: open.error === 'Button fehlt: Board speichern' ? '„Board speichern“ fehlt (nicht angemeldet?)' : open.error };
    if (!(await this.until(async () => (await this.call<SaveDialog>('saveDialog')).open, 5000))) return { ok: false, error: 'Speichern-Dialog erscheint nicht' };

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.act('fillSave', 'name', meta.title);
      await this.act('fillSave', 'description', meta.description);
      await sleep(200);
      const d = await this.call<SaveDialog>('saveDialog');
      if (d.name === meta.title && d.description === meta.description && d.canSave) break;
      if (attempt === 2) return { ok: false, error: 'Name/Beschreibung lassen sich nicht eintragen' };
    }
    const clicked = await this.act('confirmSave');
    if (!clicked.ok) return clicked;

    let error: string | null = null;
    const closed = await this.until(async () => {
      const [d, fb] = await Promise.all([this.call<SaveDialog>('saveDialog'), this.call<{ saved: boolean; error: string | null }>('saveFeedback')]);
      error = fb.error;
      return !d.open || fb.saved;
    }, 30000);
    if (!closed) return { ok: false, error: error ?? 'Speichern dauert zu lange (Dialog bleibt offen)' };
    log.info(`Board „${meta.title}“ gespeichert (Entwurf)`);
    const url = await this.ownBoardLink(meta.title).catch((e: Error) => {
      log.warn(`Link zum Board nicht gefunden: ${e.message}`);
      return null;
    });
    return { ok: true, url };
  }

  /** Own boards from "Meine Boards" (name + status badge). */
  async myBoards(): Promise<OwnBoard[]> {
    await this.driver.goto(`${this.baseUrl}/profil/boards`);
    if (!(await this.until(async () => (await this.call<MyBoards>('myBoards')).loaded, 15000))) {
      const url = await this.driver.currentUrl();
      throw new Error(url.includes('/profil/boards') ? '„Meine Boards“ lädt nicht' : '„Meine Boards“ nicht erreichbar (nicht angemeldet? → npx qbhost login)');
    }
    return (await this.call<MyBoards>('myBoards')).boards;
  }

  /** Editor link of an own board: "Meine Boards" → "Mehr Optionen" → "Bearbeiten" (opens the editor, changes nothing). */
  async ownBoardLink(title: string): Promise<string | null> {
    const boards = await this.myBoards();
    if (!boards.some((b) => norm(b.name) === norm(title))) return null;
    await this.menuItem(title, 'Bearbeiten');
    let url = '';
    const ok = await this.until(async () => (url = await this.driver.currentUrl()).includes('/profil/boards/edit/'), 10000);
    return ok ? url : null;
  }

  /** Deletes an own board ("Mehr Optionen" → "Löschen" → confirm). Returns false if there is none. */
  async deleteOwnBoard(title: string): Promise<boolean> {
    const count = (bs: OwnBoard[]) => bs.filter((b) => norm(b.name) === norm(title)).length;
    const before = count(await this.myBoards());
    if (!before) return false;
    await this.menuItem(title, 'Löschen');
    if (!(await this.until(async () => (await this.call<ActionResult>('confirmDialog', 'Löschen')).ok, 5000))) throw new Error('Löschen: Bestätigung erscheint nicht');
    // While the request runs the list shows a loading state without cards – so wait until it is
    // loaded again with one card less, then verify on a fresh page load (closing the browser
    // earlier would cancel the request).
    await this.until(async () => {
      const m = await this.call<MyBoards>('myBoards');
      return m.loaded && count(m.boards) < before;
    }, 15000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1000 + attempt * 1500);
      if (count(await this.myBoards()) < before) {
        log.info(`Board „${title}“ auf quiz-base gelöscht`);
        return true;
      }
    }
    throw new Error('Löschen: Board ist nach dem Neuladen noch da');
  }

  private async menuItem(title: string, label: string): Promise<void> {
    const opened = await this.act('openBoardMenu', title);
    if (!opened.ok) throw new Error(opened.error);
    if (!(await this.until(async () => (await this.act('clickMenuItem', label)).ok, 5000))) throw new Error(`Menüpunkt „${label}“ fehlt`);
  }

  private async until(check: () => Promise<boolean>, timeoutMs: number, pollMs = 300): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await check().catch(() => false)) return true;
      await sleep(pollMs);
    }
    return false;
  }
}

export interface OwnBoard {
  name: string;
  /** Entwurf / In Prüfung / Veröffentlicht. */
  status: string | null;
}

interface MyBoards {
  heading: string;
  loaded: boolean;
  boards: OwnBoard[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

interface SaveDialog {
  open: boolean;
  name: string | null;
  description: string | null;
  canSave: boolean;
}
