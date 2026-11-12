/*
 * In-page probe for the quiz-base.de account menu and the Tafelquiz BOARD EDITOR
 * (`/configure-lobby?format=tafelquiz`).
 *
 * Same rules as src/site/tafelquiz/probe.browser.js: plain browser JavaScript,
 * one `({ ... })` object-literal expression, synchronous methods, JSON-serialisable
 * return values, no template literals with ${}.
 *
 * All DOM knowledge about the editor lives here (plus docs/SITE-NOTES.md).
 * Never reads e-mail addresses, passwords or tokens – the account check only
 * looks for fixed menu labels.
 */
({
  // ───────────────────────── helpers ─────────────────────────
  vis(el) {
    return !!el && el.getClientRects().length > 0;
  },
  t(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  },
  all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel)).filter((e) => this.vis(e));
  },
  one(sel, root) {
    return this.all(sel, root)[0] || null;
  },
  norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  },
  btn(label, root, mode) {
    const bs = this.all('button', root || document);
    return (
      bs.find((b) => this.norm(b.getAttribute('aria-label')) === label) ||
      bs.find((b) => this.norm(b.textContent) === label) ||
      (mode === 'prefix' ? bs.find((b) => this.norm(b.textContent).startsWith(label)) : null) ||
      null
    );
  },
  click(label, root, mode) {
    const b = this.btn(label, root, mode);
    if (!b) return { ok: false, error: 'Button fehlt: ' + label };
    if (b.disabled) return { ok: false, error: 'Button gesperrt: ' + label };
    b.click();
    return { ok: true };
  },
  setInput(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },
  dialogEl() {
    const d = this.one('[role=dialog],[role=alertdialog]');
    if (d) return d;
    const backdrop = document.querySelector('[data-testid=dialog-backdrop]');
    return backdrop ? backdrop.parentElement : null;
  },
  /** Largest ancestor of `el` that still holds only this one `sel` element and not the `stop` button. */
  rowOf(el, sel, stop) {
    let e = el;
    while (e.parentElement && e.parentElement !== document.body) {
      const p = e.parentElement;
      if (p.querySelectorAll(sel).length !== 1) break;
      if (stop && Array.from(p.querySelectorAll('button')).some((b) => this.norm(b.textContent) === stop)) break;
      e = p;
    }
    return e;
  },

  // ───────────────────────── account ─────────────────────────
  /** Opens/closes the user menu in the header (it holds the login form when logged out). */
  toggleMenu() {
    const b = this.one('button[aria-label="Benutzermenu"]');
    if (!b) return { ok: false, error: 'Benutzermenü fehlt' };
    b.click();
    return { ok: true };
  },
  /**
   * Login state from the OPEN user menu: logged out = a password field / "Anmelden" button,
   * logged in = one of the fixed account labels. Returns only those labels, never names or e-mails.
   */
  account() {
    const known = ['Abmelden', 'Ausloggen', 'Meine Boards', 'Profil', 'Mein Profil', 'Einstellungen'];
    const labels = this.all('a, button, [role=menuitem]').map((e) => this.norm(e.textContent));
    const found = known.filter((k) => labels.indexOf(k) >= 0);
    const loginForm = !!this.one('input[type=password]') || labels.indexOf('Anmelden') >= 0;
    const menuOpen = loginForm || found.length > 0;
    return { menuOpen: menuOpen, loggedIn: menuOpen ? !loginForm && found.length > 0 : null, labels: found };
  },

  // ───────────────────────── editor: reading ─────────────────────────
  state() {
    const main = document.querySelector('main') || document.body;
    const text = this.t(main);
    const m = text.match(/Schritt (\d) von (\d)/);
    const h2 = this.one('main h2');
    const dlg = this.dialogEl();
    return {
      url: location.href,
      heading: this.t(this.one('main h1')),
      step: m ? parseInt(m[1], 10) : null,
      title: this.t(h2),
      templates: this.all('main h3').map((h) => this.t(h)),
      boardCountButtons: this.all('main button').map((b) => this.t(b)).filter((x) => /^\d Boards?$/.test(x)),
      supers: this.all('main input[placeholder="Oberkategorie eingeben..."]').map((i) => i.value),
      categories: this.categoryRows().map((r) => r.info),
      // The category tabs appear twice (above and below the questions).
      tabs: new Set(this.all('main button[aria-label^="Kategorie "]').map((b) => b.getAttribute('aria-label')).filter((l) => /^Kategorie \d+$/.test(l))).size,
      questions: this.questionRows().map((r) => r.info),
      dialog: dlg ? this.t(dlg).slice(0, 300) : null,
      buttons: this.all('main button').map((b) => this.t(b)).filter((x) => x && x.length < 40),
    };
  },

  /** Step 3: one row per category (name input, "Fragen: n", Board 1/2 toggle, add/remove). */
  categoryRows() {
    const sel = 'input[placeholder="Kategorienamen eingeben..."]';
    return this.all('main ' + sel).map((input) => {
      const row = this.rowOf(input, sel, '+ Kategorie hinzufügen');
      const cm = this.t(row).match(/Fragen:\s*(\d+)/);
      const toggle = this.all('button', row).find((b) => /^Board \d$/.test(this.t(b)));
      return {
        row: row,
        input: input,
        info: {
          name: input.value,
          count: cm ? parseInt(cm[1], 10) : null,
          board: toggle ? parseInt(this.t(toggle).slice(6), 10) : null,
        },
      };
    });
  },

  /** Step 4: one row per question of the selected category (header + expandable panel). */
  questionRows() {
    const sel = 'input[placeholder="Frage eingeben..."]';
    return this.all('main ' + sel).map((input) => {
      const row = this.rowOf(input, sel, '+ Frage hinzufügen');
      const ptsEl = this.all('span', row).find((s) => /^\d+ Punkte$/.test(this.t(s)));
      const box = row.querySelector('input[type=checkbox]');
      const note = row.querySelector('textarea');
      const options = Array.from(row.querySelectorAll('input[placeholder^="Antwort "]'));
      const radios = Array.from(row.querySelectorAll('input[type=radio]'));
      const correct = radios.findIndex((r) => r.checked);
      return {
        row: row,
        input: input,
        info: {
          text: input.value,
          points: ptsEl ? parseInt(this.t(ptsEl), 10) : null,
          expanded: !!this.btn('Einklappen', row),
          mc: box && this.vis(box) ? !!box.checked : null,
          note: note && this.vis(note) ? note.value : null,
          options: options.filter((o) => this.vis(o)).map((o) => o.value),
          correct: correct >= 0 && options.length ? correct : null,
        },
      };
    });
  },

  // ───────────────────────── editor: actions ─────────────────────────
  chooseTemplate(name) {
    const h = this.all('main h3').find((x) => this.t(x) === name);
    if (!h) return { ok: false, error: 'Template fehlt: ' + name };
    let e = h;
    while (e && getComputedStyle(e).cursor !== 'pointer') e = e.parentElement;
    (e || h).click();
    return { ok: true };
  },
  clickButton(label) {
    return this.click(label, document.querySelector('main'));
  },
  dismissDialog() {
    const d = this.dialogEl();
    if (!d) return { ok: true };
    const b = Array.from(d.querySelectorAll('button')).find((x) => /^(OK|Ok|Okay|Schließen|Verstanden)$/.test(this.norm(x.textContent)) || this.norm(x.getAttribute('aria-label')) === 'Schließen');
    if (b) {
      b.click();
      return { ok: true };
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: true };
  },

  // step 3
  setSuper(i, value) {
    const inputs = this.all('main input[placeholder="Oberkategorie eingeben..."]');
    if (!inputs[i]) return { ok: false, error: 'Oberkategorie ' + (i + 1) + ' fehlt' };
    this.setInput(inputs[i], value);
    return { ok: true };
  },
  setCategoryName(i, value) {
    const r = this.categoryRows()[i];
    if (!r) return { ok: false, error: 'Kategorie ' + (i + 1) + ' fehlt' };
    this.setInput(r.input, value);
    return { ok: true };
  },
  /** One click on "Frage hinzufügen" (+1) or "Frage entfernen" (-1) of category i. */
  changeCount(i, delta) {
    const r = this.categoryRows()[i];
    if (!r) return { ok: false, error: 'Kategorie ' + (i + 1) + ' fehlt' };
    return this.click(delta > 0 ? 'Frage hinzufügen' : 'Frage entfernen', r.row);
  },
  toggleCategoryBoard(i) {
    const r = this.categoryRows()[i];
    if (!r) return { ok: false, error: 'Kategorie ' + (i + 1) + ' fehlt' };
    const b = this.all('button', r.row).find((x) => /^Board \d$/.test(this.t(x)));
    if (!b) return { ok: false, error: 'Board-Umschalter fehlt' };
    b.click();
    return { ok: true };
  },
  deleteCategory(i) {
    const r = this.categoryRows()[i];
    if (!r) return { ok: false, error: 'Kategorie ' + (i + 1) + ' fehlt' };
    return this.click('Kategorie löschen', r.row);
  },

  // step 4
  selectCategory(n) {
    return this.click('Kategorie ' + n, document.querySelector('main'));
  },
  expandQuestion(i) {
    const r = this.questionRows()[i];
    if (!r) return { ok: false, error: 'Frage ' + (i + 1) + ' fehlt' };
    if (this.btn('Einklappen', r.row)) return { ok: true };
    return this.click('Ausklappen', r.row);
  },
  setQuestionText(i, value) {
    const r = this.questionRows()[i];
    if (!r) return { ok: false, error: 'Frage ' + (i + 1) + ' fehlt' };
    this.setInput(r.input, value);
    return { ok: true };
  },
  /** Checkbox "Antwortmöglichkeiten anzeigen": on = multiple choice, off = host note. */
  setMc(i, on) {
    const r = this.questionRows()[i];
    if (!r) return { ok: false, error: 'Frage ' + (i + 1) + ' fehlt' };
    const box = r.row.querySelector('input[type=checkbox]');
    if (!box) return { ok: false, error: 'MC-Schalter fehlt (Frage zugeklappt?)' };
    if (!!box.checked !== !!on) box.click();
    return { ok: true };
  },
  setNote(i, value) {
    const r = this.questionRows()[i];
    const ta = r && r.row.querySelector('textarea');
    if (!ta || !this.vis(ta)) return { ok: false, error: 'Notizfeld fehlt (Frage ' + (i + 1) + ')' };
    this.setInput(ta, value);
    return { ok: true };
  },
  setOption(i, k, value) {
    const r = this.questionRows()[i];
    const o = r && r.row.querySelectorAll('input[placeholder^="Antwort "]')[k];
    if (!o) return { ok: false, error: 'Antwort ' + (k + 1) + ' fehlt (Frage ' + (i + 1) + ')' };
    this.setInput(o, value);
    return { ok: true };
  },
  setCorrect(i, k) {
    const r = this.questionRows()[i];
    const radio = r && r.row.querySelectorAll('input[type=radio]')[k];
    if (!radio) return { ok: false, error: 'Auswahl ' + (k + 1) + ' fehlt (Frage ' + (i + 1) + ')' };
    if (!radio.checked) radio.click();
    return { ok: true };
  },
  /** One click on the points stepper of question i (quiz-base steps by 50). */
  changePoints(i, delta) {
    const r = this.questionRows()[i];
    if (!r) return { ok: false, error: 'Frage ' + (i + 1) + ' fehlt' };
    return this.click(delta > 0 ? 'Punkte erhöhen' : 'Punkte verringern', r.row);
  },

  // ───────────────────────── save dialog ─────────────────────────
  // Step 4 "Board speichern" (only when logged in) opens a modal titled "Board speichern" with
  // #save-board-name (required), #save-board-description and the buttons Abbrechen / Speichern.
  // There is no visibility option: saved boards are drafts ("Entwurf"). The modal closes only
  // after a successful save (toast "Board wurde erfolgreich gespeichert").
  saveDialogRoot() {
    const name = this.one('#save-board-name');
    if (!name) return null;
    let e = name;
    while (e.parentElement && e.parentElement !== document.body) {
      const p = e.parentElement;
      if (Array.from(p.querySelectorAll('button')).some((b) => this.norm(b.textContent) === 'Speichern')) return p;
      e = p;
    }
    return null;
  },
  saveDialog() {
    const name = this.one('#save-board-name');
    const desc = this.one('#save-board-description');
    const root = this.saveDialogRoot();
    const btn = root ? Array.from(root.querySelectorAll('button')).find((b) => this.norm(b.textContent) === 'Speichern') : null;
    return {
      open: !!name,
      name: name ? name.value : null,
      description: desc ? desc.value : null,
      canSave: !!btn && !btn.disabled,
    };
  },
  fillSave(field, value) {
    const el = this.one(field === 'name' ? '#save-board-name' : '#save-board-description');
    if (!el) return { ok: false, error: 'Speichern-Dialog fehlt' };
    this.setInput(el, value);
    return { ok: true };
  },
  confirmSave() {
    const root = this.saveDialogRoot();
    if (!root) return { ok: false, error: 'Speichern-Dialog fehlt' };
    return this.click('Speichern', root);
  },
  /** Toasts after saving (the texts are fixed; nothing account-specific is read). */
  saveFeedback() {
    const text = this.t(document.body);
    return {
      saved: text.indexOf('Board wurde erfolgreich gespeichert') >= 0,
      error: text.indexOf('Fehler beim Speichern des Boards') >= 0 ? 'Fehler beim Speichern des Boards' : text.indexOf('Bitte gib dem Board einen Namen') >= 0 ? 'Bitte gib dem Board einen Namen' : null,
    };
  },

  // ───────────────────────── "Meine Boards" (/profil/boards) ─────────────────────────
  // One card per board: h3 = name, a status badge (Entwurf / In Prüfung / Veröffentlicht / Fork),
  // button[aria-label="Mehr Optionen"] (aria-haspopup=menu) → [role=menu] with [role=menuitem]
  // Bearbeiten · Lobby erstellen · Umbenennen · Veröffentlichen · Duplizieren · Löschen.
  boardCards() {
    const menuSel = 'button[aria-label="Mehr Optionen"]';
    return this.all('main h3')
      .map((h) => {
        let e = h;
        while (e.parentElement && e.parentElement !== document.body && e.parentElement.querySelectorAll('h3').length === 1) {
          e = e.parentElement;
          if (e.querySelector(menuSel)) break;
        }
        const menu = e.querySelector(menuSel);
        if (!menu) return null;
        const badge = this.all('span', e).map((s) => this.t(s)).find((x) => /^(Entwurf|In Prüfung|Veröffentlicht)$/.test(x));
        return { el: e, menu: menu, info: { name: this.t(h), status: badge || null } };
      })
      .filter((c) => c);
  },
  myBoards() {
    const main = document.querySelector('main');
    const text = this.t(main);
    return {
      heading: this.t(this.one('main h1')),
      loaded: text.indexOf('Noch keine Quiz Boards erstellt') >= 0 || /\d+ Boards? gefunden/.test(text),
      boards: this.boardCards().map((c) => c.info),
    };
  },
  /** Opens the "Mehr Optionen" menu of the first card with exactly this name. */
  openBoardMenu(name) {
    const want = this.norm(name).toLowerCase();
    const c = this.boardCards().find((x) => this.norm(x.info.name).toLowerCase() === want);
    if (!c) return { ok: false, error: 'Board nicht in „Meine Boards“: ' + name };
    if (c.menu.getAttribute('aria-expanded') !== 'true') c.menu.click();
    return { ok: true };
  },
  clickMenuItem(label) {
    const item = this.all('[role=menuitem]').find((m) => this.norm(m.innerText || m.textContent) === label);
    if (!item) return { ok: false, error: 'Menüpunkt fehlt: ' + label };
    if (item.disabled) return { ok: false, error: 'Menüpunkt gesperrt: ' + label };
    item.click();
    return { ok: true };
  },
  /** Confirm dialog (e.g. "Board löschen?" → "Löschen"). */
  confirmDialog(label) {
    const d = this.dialogEl();
    if (!d) return { ok: false, error: 'Bestätigungsdialog fehlt' };
    return this.click(label, d);
  },
})
