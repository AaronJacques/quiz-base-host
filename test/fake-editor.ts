import type { ActionResult } from '../src/site/tafelquiz/page.ts';
import type { BoardEditorPort, EditorState, SaveMeta, SaveResult } from '../src/site/editor/page.ts';

interface FakeQuestion {
  text: string;
  points: number;
  expanded: boolean;
  mc: boolean;
  note: string;
  options: string[];
  correct: number;
}

interface FakeCategory {
  name: string;
  count: number;
  board: 1 | 2;
  questions: FakeQuestion[];
}

/**
 * In-memory simulation of quiz-base's Tafelquiz editor with the behaviour seen live:
 * 4 steps, "Benutzerdefiniert" starts empty, a new category starts with 1 question,
 * questions get 100·row points and a 50-point stepper, "Antwortmöglichkeiten anzeigen"
 * (multiple choice) is ON by default, missing category names block "Weiter" with a dialog.
 */
export class FakeBoardEditorPage implements BoardEditorPort {
  step = 0;
  boards: 1 | 2 = 1;
  supers = ['', ''];
  categories: FakeCategory[] = [];
  active = 0;
  dialog: string | null = null;
  loggedIn = true;
  /** Only one question expanded at a time (accordion). */
  accordion = false;
  /** Every n-th text input is silently lost (React flakiness). 0 = never. */
  dropEvery = 0;
  private inputs = 0;
  saved: { meta: SaveMeta; categories: FakeCategory[]; boards: number; supers: string[] } | null = null;
  lobbyClicked = false;
  log: string[] = [];

  private ok(what: string): Promise<ActionResult> {
    this.log.push(what);
    return Promise.resolve({ ok: true });
  }
  private fail(error: string): Promise<ActionResult> {
    return Promise.resolve({ ok: false, error });
  }
  private lost(): boolean {
    this.inputs++;
    return this.dropEvery > 0 && this.inputs % this.dropEvery === 0;
  }
  private q(i: number): FakeQuestion | undefined {
    return this.categories[this.active]?.questions[i];
  }

  async start(): Promise<void> {
    this.step = 1;
    this.categories = [];
    this.boards = 1;
    this.supers = ['', ''];
    this.dialog = null;
  }

  async state(): Promise<EditorState> {
    const cat = this.categories[this.active];
    return {
      url: 'fake://configure-lobby',
      heading: 'Quiz konfigurieren',
      step: this.step || null,
      title: this.step === 4 && cat ? `Fragen für: ${cat.name}` : '',
      templates: this.step === 1 ? ['Klassisches Spiel', 'Schnelles Spiel', 'Benutzerdefiniert'] : [],
      boardCountButtons: this.step === 2 || this.step === 3 ? ['1 Board', '2 Boards'] : [],
      supers: this.step === 3 ? this.supers.slice(0, this.boards) : [],
      categories: this.step === 3 ? this.categories.map((c) => ({ name: c.name, count: c.count, board: this.boards === 2 ? c.board : null })) : [],
      tabs: this.step === 4 ? this.categories.length : 0,
      questions:
        this.step === 4 && cat
          ? cat.questions.map((q) => ({
              text: q.text,
              points: q.points,
              expanded: q.expanded,
              mc: q.expanded ? q.mc : null,
              note: q.expanded && !q.mc ? q.note : null,
              options: q.expanded && q.mc ? [...q.options] : [],
              correct: q.expanded && q.mc ? q.correct : null,
            }))
          : [],
      dialog: this.dialog,
      buttons: [],
    };
  }

  async loginState(): Promise<boolean | null> {
    return this.loggedIn;
  }

  async chooseTemplate(name: string): Promise<ActionResult> {
    if (this.step !== 1) return this.fail('kein Template-Schritt');
    const n = { 'Klassisches Spiel': 4, 'Schnelles Spiel': 3, Benutzerdefiniert: 0 }[name];
    if (n === undefined) return this.fail('Template fehlt: ' + name);
    this.categories = Array.from({ length: n }, () => this.newCategory(n));
    this.step = 2;
    return this.ok(`template ${name}`);
  }

  private newCategory(count: number): FakeCategory {
    return { name: '', count, board: 1, questions: [] };
  }

  async clickButton(label: string): Promise<ActionResult> {
    if (this.dialog) return this.fail('Dialog blockiert');
    if (label === '1 Board' || label === '2 Boards') {
      this.boards = label === '2 Boards' ? 2 : 1;
      return this.ok(label);
    }
    if (label === '+ Kategorie hinzufügen' && this.step === 3) {
      this.categories.push(this.newCategory(1));
      return this.ok('add category');
    }
    if (label === 'Weiter →') {
      if (this.step === 2) this.step = 3;
      else if (this.step === 3) {
        if (this.categories.some((c) => !c.name.trim())) {
          this.dialog = 'Kategorienamen fehlen';
          return this.ok('weiter blocked');
        }
        for (const c of this.categories) {
          while (c.questions.length < c.count) c.questions.push({ text: '', points: (c.questions.length + 1) * 100, expanded: false, mc: true, note: '', options: ['', '', '', ''], correct: 0 });
          c.questions.length = c.count;
        }
        this.active = 0;
        this.step = 4;
      } else return this.fail('Weiter nicht möglich');
      return this.ok('weiter');
    }
    if (label === 'Lobby erstellen') {
      this.lobbyClicked = true;
      return this.ok('lobby');
    }
    return this.fail('Button fehlt: ' + label);
  }

  async dismissDialog(): Promise<ActionResult> {
    this.dialog = null;
    return this.ok('dismiss');
  }

  async setSuper(i: number, value: string): Promise<ActionResult> {
    if (this.step !== 3 || i >= this.boards) return this.fail('Oberkategorie fehlt');
    this.supers[i] = value;
    return this.ok('super');
  }

  async setCategoryName(i: number, value: string): Promise<ActionResult> {
    const c = this.categories[i];
    if (this.step !== 3 || !c) return this.fail('Kategorie fehlt');
    if (!this.lost()) c.name = value;
    return this.ok('name');
  }

  async changeCount(i: number, delta: 1 | -1): Promise<ActionResult> {
    const c = this.categories[i];
    if (this.step !== 3 || !c) return this.fail('Kategorie fehlt');
    c.count = Math.min(10, Math.max(1, c.count + delta));
    return this.ok('count');
  }

  async toggleCategoryBoard(i: number): Promise<ActionResult> {
    const c = this.categories[i];
    if (this.step !== 3 || !c || this.boards !== 2) return this.fail('Board-Umschalter fehlt');
    c.board = c.board === 1 ? 2 : 1;
    return this.ok('toggle board');
  }

  async deleteCategory(i: number): Promise<ActionResult> {
    if (this.step !== 3 || !this.categories[i]) return this.fail('Kategorie fehlt');
    this.categories.splice(i, 1);
    return this.ok('delete category');
  }

  async selectCategory(n: number): Promise<ActionResult> {
    if (this.step !== 4 || !this.categories[n - 1]) return this.fail('Kategorie-Tab fehlt');
    this.active = n - 1;
    return this.ok(`tab ${n}`);
  }

  async expandQuestion(i: number): Promise<ActionResult> {
    const q = this.q(i);
    if (!q) return this.fail('Frage fehlt');
    if (this.accordion) for (const o of this.categories[this.active]!.questions) o.expanded = false;
    q.expanded = true;
    return this.ok('expand');
  }

  async setQuestionText(i: number, value: string): Promise<ActionResult> {
    const q = this.q(i);
    if (!q) return this.fail('Frage fehlt');
    if (!this.lost()) q.text = value;
    return this.ok('text');
  }

  async setMc(i: number, on: boolean): Promise<ActionResult> {
    const q = this.q(i);
    if (!q?.expanded) return this.fail('MC-Schalter fehlt (Frage zugeklappt?)');
    q.mc = on;
    return this.ok('mc');
  }

  async setNote(i: number, value: string): Promise<ActionResult> {
    const q = this.q(i);
    if (!q?.expanded || q.mc) return this.fail('Notizfeld fehlt');
    if (!this.lost()) q.note = value;
    return this.ok('note');
  }

  async setOption(i: number, k: number, value: string): Promise<ActionResult> {
    const q = this.q(i);
    if (!q?.expanded || !q.mc || k > 3) return this.fail('Antwortfeld fehlt');
    q.options[k] = value;
    return this.ok('option');
  }

  async setCorrect(i: number, k: number): Promise<ActionResult> {
    const q = this.q(i);
    if (!q?.expanded || !q.mc || k > 3) return this.fail('Auswahl fehlt');
    q.correct = k;
    return this.ok('correct');
  }

  async changePoints(i: number, delta: 1 | -1): Promise<ActionResult> {
    const q = this.q(i);
    if (!q?.expanded) return this.fail('Punkte-Stepper fehlt');
    q.points = Math.max(50, q.points + delta * 50);
    return this.ok('points');
  }

  async save(meta: SaveMeta): Promise<SaveResult> {
    if (!this.loggedIn) return { ok: false, error: 'nicht angemeldet' };
    if (this.step !== 4) return { ok: false, error: 'Editor nicht fertig' };
    this.saved = { meta, categories: structuredClone(this.categories), boards: this.boards, supers: this.supers.slice(0, this.boards) };
    return { ok: true, url: 'https://www.quiz-base.de/board/fake-1' };
  }
}
