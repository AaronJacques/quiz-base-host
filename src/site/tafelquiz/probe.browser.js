/*
 * In-page probe for the quiz-base.de Tafelquiz HOST view.
 *
 * This file is plain browser JavaScript. It is read as text and evaluated as a
 * single object-literal expression inside the page by every BrowserDriver, so:
 *   - no imports, no top-level statements, no template literals with ${} that
 *     the TS side might confuse – just one `({ ... })` expression;
 *   - every method must be synchronous and return JSON-serialisable data.
 *
 * ALL knowledge about quiz-base's DOM lives here (plus docs/SITE-NOTES.md).
 * When the site changes, this is the file to fix.
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
  btn(label, root, mode) {
    const bs = this.all('button', root || document);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return (
      bs.find((b) => norm(b.getAttribute('aria-label')) === label) ||
      bs.find((b) => norm(b.textContent) === label) ||
      (mode === 'prefix' ? bs.find((b) => norm(b.textContent).startsWith(label)) : null) ||
      null
    );
  },
  click(label, root, mode) {
    const b = this.btn(label, root, mode);
    if (!b) return { ok: false, error: 'button not found: ' + label };
    if (b.disabled) return { ok: false, error: 'button disabled: ' + label };
    b.click();
    return { ok: true };
  },
  section(label) {
    return this.one('[aria-label="' + label + '"]');
  },
  dialogEl() {
    return this.one('[role=dialog],[role=alertdialog]');
  },
  setInput(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  },
  realImageUrl(src) {
    if (!src) return src;
    if (src.startsWith('data:')) return 'data:';
    try {
      const u = new URL(src, location.href);
      if (u.pathname.startsWith('/_next/image')) return u.searchParams.get('url') || src;
      return u.href;
    } catch (e) {
      return src;
    }
  },

  /**
   * Text of an element with formulas read once and readably. quiz-base itself writes formulas as Unicode text
   * ("a² + b² = c²", "ln(eˣ)") – that is the fast path. <sup>/<sub> become "²"/"₂" (else "^(…)"/"_(…)"),
   * KaTeX/MathJax (visible HTML + hidden MathML = everything twice) are read from their MathML only.
   */
  mathT(el) {
    if (!el) return '';
    if (!el.querySelector('sup,sub,math,.katex,mjx-container')) return this.t(el);
    return this.mathWalk(el).replace(/\s+/g, ' ').replace(/\s+([?!.,;:)])/g, '$1').replace(/\(\s+/g, '(').trim();
  },
  mathScript(text, table, mark) {
    const cs = Array.from(text.replace(/\s+/g, ''));
    if (!cs.length) return '';
    if (cs.every((c) => table[c])) return cs.map((c) => table[c]).join('');
    return mark + (cs.length > 1 ? '(' + cs.join('') + ')' : cs[0]);
  },
  mathWalk(n) {
    const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', x: 'ˣ', y: 'ʸ', i: 'ⁱ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', k: 'ᵏ', t: 'ᵗ' };
    const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', n: 'ₙ', i: 'ᵢ', k: 'ₖ', m: 'ₘ', t: 'ₜ' };
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();
    const kids = () => Array.from(n.childNodes).map((c) => this.mathWalk(c)).join('');
    const part = (i) => (n.children[i] ? this.mathWalk(n.children[i]).trim() : '');
    const group = (x) => (/^[\w.]+$|^[^\s]$/.test(x) ? x : '(' + x + ')');
    if (tag === 'annotation' || tag === 'annotation-xml' || tag === 'script' || tag === 'style') return '';
    if (/\bsr-only\b/.test(typeof n.className === 'string' ? n.className : '')) return '';
    if ((n.classList && n.classList.contains('katex')) || tag === 'mjx-container') {
      const m = n.querySelector('math');
      return m ? ' ' + this.mathWalk(m) + ' ' : this.t(n);
    }
    if (tag === 'sup') return this.mathScript(kids(), SUP, '^');
    if (tag === 'sub') return this.mathScript(kids(), SUB, '_');
    if (tag === 'semantics') return n.children[0] ? this.mathWalk(n.children[0]) : '';
    if (tag === 'msup') return part(0) + this.mathScript(part(1), SUP, '^');
    if (tag === 'msub') return part(0) + this.mathScript(part(1), SUB, '_');
    if (tag === 'msubsup') return part(0) + this.mathScript(part(1), SUB, '_') + this.mathScript(part(2), SUP, '^');
    if (tag === 'mfrac') return group(part(0)) + '/' + group(part(1));
    if (tag === 'msqrt') return '√' + group(kids().trim());
    if (tag === 'mroot') return (part(1) === '3' ? '∛' : part(1) + '√') + group(part(0));
    if (tag === 'mo') {
      const o = (n.textContent || '').trim();
      return /^[=+−\-±×·÷<>≤≥≈≠→]$/.test(o) ? ' ' + o + ' ' : o;
    }
    if (tag === 'mspace') return ' ';
    if (tag === 'br' || tag === 'p' || tag === 'div' || tag === 'li') return ' ' + kids() + ' ';
    return kids();
  },

  /** Multiple choice (`ul > li`): letter `span`, text `span`, at the correct one a check icon and `span.sr-only` „richtig“. */
  choices(s) {
    return Array.from(s.querySelectorAll('ul > li')).map((li, i) => {
      const spans = Array.from(li.children).filter((e) => e.tagName === 'SPAN');
      const hidden = spans.filter((e) => /\bsr-only\b/.test(e.className || ''));
      const shown = spans.filter((e) => hidden.indexOf(e) < 0);
      const head = shown[0] && /^[A-H]$/.test(this.t(shown[0])) ? shown[0] : null;
      const rest = shown.filter((e) => e !== head);
      return {
        letter: head ? this.t(head) : 'ABCDEFGH'.charAt(i) || String(i + 1),
        label: (spans.length ? rest.map((e) => this.mathT(e)).join(' ') : this.mathT(li)).replace(/\s+/g, ' ').trim(),
        correct: hidden.some((e) => /richtig|korrekt|correct/i.test(e.textContent || '')) || /\bborder-success\b/.test(li.className || ''),
      };
    });
  },

  // ───────────────────────── reading ─────────────────────────
  phase() {
    const h1 = this.t(this.one('main h1'));
    if (/SPIEL VORBEI/i.test(this.t(document.querySelector('main')).slice(0, 200))) return 'results';
    if (/Lobby Warteraum/i.test(h1)) return 'lobby';
    if (this.section('Aktive Frage')) return 'question';
    if (this.btn('Sound aktivieren') && !this.one('ul[aria-label=Spieler]')) return 'sound-gate';
    if (this.one('ul[aria-label=Spieler]') && this.gridColumns().length) return 'board';
    return 'unknown';
  },

  lobbyCode() {
    const b = this.one('[aria-label="Lobby-Code kopieren"]');
    const code = this.t(b);
    return /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
  },

  gameListPlayers() {
    return this.all('ul[aria-label=Spieler] button').map((b) => {
      const nameEl = b.querySelector('span[title]');
      const scoreEl = b.querySelector('[data-testid=animated-score]');
      const txt = this.t(b);
      return {
        name: nameEl ? nameEl.getAttribute('title') : txt,
        score: scoreEl ? parseInt(this.t(scoreEl).replace(/[^\d-]/g, ''), 10) || 0 : 0,
        isTurn: /Am Zug/i.test(txt),
        hasBuzzed: /Buzzer$/i.test(txt),
      };
    });
  },

  lobbyPlayers() {
    return this.all('button[aria-label$=" kicken"]').map((b) => {
      const name = b.getAttribute('aria-label').replace(/ kicken$/, '');
      const row = b.closest('li') || b.parentElement.parentElement;
      return { name: name, score: 0, isTurn: false, hasBuzzed: false, ready: !/Wartet/i.test(this.t(row)) };
    });
  },

  /** Results screen ("SPIEL VORBEI!"): name in div[title], score in the next sibling. */
  resultPlayers() {
    const out = [];
    this.all('main div[title]').forEach((el) => {
      const score = el.nextElementSibling;
      if (!score || !/^-?\d+$/.test(this.t(score))) return;
      out.push({ name: el.getAttribute('title'), score: parseInt(this.t(score), 10), isTurn: false, hasBuzzed: false });
    });
    return out;
  },

  gridColumns() {
    // A column is a flex container whose first child is the category header and
    // whose remaining children are point buttons ("100", "200", …).
    const cols = [];
    const seen = new Set();
    this.all('main button').forEach((b) => {
      if (!/^\d+$/.test(this.t(b))) return;
      const col = b.parentElement;
      if (!col || seen.has(col)) return;
      const header = col.firstElementChild;
      if (!header || header.tagName === 'BUTTON') return;
      seen.add(col);
      cols.push(col);
    });
    return cols;
  },

  grid() {
    const cells = [];
    this.gridColumns().forEach((col, c) => {
      const category = this.t(col.firstElementChild);
      Array.from(col.querySelectorAll(':scope > button')).forEach((b, r) => {
        cells.push({
          category: category,
          col: c,
          row: r,
          points: parseInt(this.t(b), 10) || 0,
          answered: b.getAttribute('title') === 'Frage wieder öffnen',
        });
      });
    });
    return cells;
  },

  boards() {
    const bs = this.all('main button').filter((b) => /^Board \d+/.test(this.t(b)));
    if (!bs.length) return { count: 1, active: 1 };
    const active = bs.findIndex((b) => /from-btn-primary-from/.test(b.className));
    return { count: bs.length, active: active >= 0 ? active + 1 : 1 };
  },

  question() {
    const s = this.section('Aktive Frage');
    if (!s) return null;
    const ps = Array.from(s.querySelectorAll('p'));
    const pointsEl = Array.from(s.querySelectorAll('span')).find((e) => /^\d+ Punkte$/.test(this.t(e)));
    const noteLabel = ps.find((p) => /Richtige Antwort/i.test(this.t(p)));
    let note = null;
    if (noteLabel) {
      const nx = noteLabel.nextElementSibling;
      const v = this.mathT(nx);
      note = v && !/Keine Notiz hinterlegt/i.test(v) ? v : null;
    }
    const skip = /^(Richtige Antwort|Keine Notiz|Audio für diese Frage|YouTube Audio|Spieler hören)/i;
    const textEl = ps.find((p) => this.t(p) && !skip.test(this.t(p)) && p !== (noteLabel && noteLabel.nextElementSibling));
    const options = this.choices(s);
    const audioBox = ps.find((p) => /Audio für diese Frage/i.test(this.t(p)));
    const iframe = s.querySelector('iframe');
    const audioEl = s.querySelector('audio');
    const buzzer = this.section('Buzzer');
    const bt = this.t(buzzer && buzzer.querySelector('p'));
    let status = 'unknown';
    let buzzedBy = null;
    const m = bt.match(/^(.+?) hat gebuzzert/i);
    if (m) {
      status = 'buzzed';
      buzzedBy = m[1].trim();
    } else if (/Warten auf Buzzer/i.test(bt)) status = 'open';
    else if (/gesperrt/i.test(bt) || this.btn('Buzzer freigeben', buzzer)) status = 'locked';
    const target = this.one('[aria-label="Punkte vergeben"] strong');
    return {
      points: pointsEl ? parseInt(this.t(pointsEl), 10) : 0,
      text: textEl ? this.mathT(textEl) : '',
      note: note,
      options: options,
      imageUrls: Array.from(s.querySelectorAll('img')).map((i) => this.realImageUrl(i.getAttribute('src'))),
      imagesLoaded: Array.from(s.querySelectorAll('img')).map((i) => (i.complete ? i.naturalWidth > 0 : null)),
      audio: {
        present: !!(audioBox || iframe || audioEl),
        title: iframe ? iframe.getAttribute('title') : null,
        playing: !!this.btn('Pause', s),
      },
      buzzer: { status: status, buzzedBy: buzzedBy },
      pointTarget: target ? this.t(target) : null,
    };
  },

  readState() {
    const phase = this.phase();
    const startBtn = this.all('main button').find((b) => /^(Spiel starten|Warte auf Spieler)/.test(this.t(b)));
    let ready = null;
    if (phase === 'lobby') {
      const lp = this.lobbyPlayers();
      ready = { ready: lp.filter((p) => p.ready).length, total: lp.length };
    }
    const d = this.dialogEl();
    return {
      phase: phase,
      url: location.href,
      lobbyCode: this.lobbyCode(),
      players: phase === 'lobby' ? this.lobbyPlayers() : phase === 'results' ? this.resultPlayers() : this.gameListPlayers(),
      ready: ready,
      canStart: !!startBtn && !startBtn.disabled && /^Spiel starten/.test(this.t(startBtn)),
      boards: this.boards(),
      grid: phase === 'board' || phase === 'question' ? this.grid() : [],
      question: this.question(),
      dialog: d ? this.t(d).slice(0, 300) : null,
    };
  },

  /** Full-resolution image data for vision (data: URIs are not sent with every poll). */
  imageData(index) {
    const s = this.section('Aktive Frage');
    const img = s && s.querySelectorAll('img')[index || 0];
    if (!img) return null;
    const src = img.getAttribute('src');
    if (src && src.startsWith('data:')) return src;
    return this.realImageUrl(src);
  },

  // ───────────────────────── actions ─────────────────────────
  revealCode() {
    if (this.lobbyCode()) return { ok: true };
    return this.click('Lobby-Code anzeigen');
  },
  closeLobby() {
    return this.click('Lobby schließen');
  },
  startGame() {
    return this.click('Spiel starten', null, 'prefix');
  },
  passSoundGate() {
    return this.click('Sound aktivieren');
  },
  selectBoard(n) {
    const b = this.all('main button').find((x) => new RegExp('^Board ' + n + '\\b').test(this.t(x)));
    if (!b) return { ok: false, error: 'board ' + n + ' not found' };
    b.click();
    return { ok: true };
  },
  openCell(col, row) {
    const c = this.gridColumns()[col];
    const b = c && c.querySelectorAll(':scope > button')[row];
    if (!b) return { ok: false, error: 'cell not found ' + col + '/' + row };
    b.click();
    return { ok: true };
  },
  selectPlayer(name) {
    const b = this.all('ul[aria-label=Spieler] button').find((x) => {
      const n = x.querySelector('span[title]');
      return n && n.getAttribute('title') === name;
    });
    if (!b) return { ok: false, error: 'player not found: ' + name };
    b.click();
    return { ok: true };
  },
  /** Quick award via "Punkte vergeben" (only full / half amounts of the open question). */
  quickAward(name, delta) {
    const sec = this.section('Punkte vergeben');
    if (!sec) return { ok: false, error: 'no points section' };
    const label = delta >= 0 ? delta + ' Punkte an ' + name : Math.abs(delta) + ' Punkte von ' + name + ' abziehen';
    return this.click(label, sec);
  },
  openManualPoints() {
    return this.click('Punkte');
  },
  /** Manual points dialog – arbitrary amounts. Call openManualPoints() first. */
  manualAward(name, delta) {
    const d = this.dialogEl();
    if (!d) return { ok: false, error: 'manual dialog not open' };
    const input = d.querySelector('input[aria-label="Punkte für ' + name + '"]');
    if (!input) return { ok: false, error: 'no input for ' + name };
    this.setInput(input, Math.abs(delta));
    let el = input.parentElement;
    while (el && el !== d && !Array.from(el.querySelectorAll('button')).some((b) => /Hinzufügen/.test(b.textContent))) el = el.parentElement;
    const b = Array.from((el || d).querySelectorAll('button')).find((x) => (delta >= 0 ? /Hinzufügen/ : /Abziehen/).test(x.textContent));
    if (!b) return { ok: false, error: 'no add/subtract button' };
    b.click();
    return { ok: true };
  },
  closeDialog() {
    return this.click('Schließen');
  },
  animate(kind) {
    return this.click(kind, this.section('Animation für alle'));
  },
  releaseBuzzer() {
    return this.click('Buzzer freigeben', this.section('Buzzer'));
  },
  resetBuzzer() {
    return this.click('Buzzer zurücksetzen', this.section('Buzzer'));
  },
  startTimer(sec) {
    const s = this.section('Timer');
    if (!s) return { ok: false, error: 'no timer' };
    if (this.btn('Stopp', s)) return { ok: false, error: 'timer running' };
    const preset = this.btn(sec + ' s', s);
    if (preset) preset.click();
    else this.setInput(s.querySelector('input'), sec);
    return this.click('Start', s);
  },
  stopTimer() {
    const s = this.section('Timer');
    return s && this.btn('Stopp', s) ? this.click('Stopp', s) : { ok: true };
  },
  playAudio() {
    const s = this.section('Aktive Frage');
    if (!s) return { ok: false, error: 'no question' };
    return this.btn('Pause', s) ? { ok: true } : this.click('Abspielen', s);
  },
  stopAudio() {
    const s = this.section('Aktive Frage');
    return s && this.btn('Stop', s) ? this.click('Stop', s) : { ok: true };
  },
  closeQuestion() {
    return this.click('Frage schließen', null, 'prefix');
  },
  endGame() {
    return this.click('Spiel beenden');
  },
  confirmDialog(label) {
    const d = this.dialogEl();
    if (!d) return { ok: false, error: 'no dialog' };
    return this.click(label, d, 'prefix');
  },
});
