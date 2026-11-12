// The in-page probe against saved quiz-base DOM (test/fixtures). Needs Playwright's Chromium
// (`npx playwright install chromium`); without it the suite is skipped.
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsonWrap, parseJsonResult, type BrowserDriver } from '../src/browser/driver.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { TafelquizPage } from '../src/site/tafelquiz/page.ts';

setLogLevel('error');

const PROBE = readFileSync(new URL('../src/site/tafelquiz/probe.browser.js', import.meta.url), 'utf8').trim().replace(/;\s*$/, '');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)('probe.browser.js on quiz-base DOM', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  async function question(file: string) {
    await page.setContent(`<html><body><main>${fixture(file)}</main></body></html>`);
    return page.evaluate(`(${PROBE}).question()`) as Promise<{ text: string; note: string | null; options: { letter: string; label: string; correct: boolean }[] }>;
  }

  it('reads multiple-choice options without the hidden "richtig" (it leaked the solution into the chat)', async () => {
    const q = await question('mc-section.html');
    expect(q.text).toBe('Was ist das Gegenteil von "groß"?');
    expect(q.options).toEqual([
      { letter: 'A', label: 'leicht', correct: false },
      { letter: 'B', label: 'schwer', correct: false },
      { letter: 'C', label: 'riesig', correct: false },
      { letter: 'D', label: 'klein', correct: true },
    ]);
    expect(JSON.stringify(q.options.map((o) => o.label))).not.toMatch(/richtig/i);
  });

  it('keeps Unicode formulas of quiz-base as they are', async () => {
    const mc = await question('mc-formula-section.html');
    expect(mc.text).toBe('Für welche Zahl x gilt ln(eˣ) = 5?');
    expect(mc.options.map((o) => `${o.letter}) ${o.label}${o.correct ? ' ✓' : ''}`)).toEqual(['A) x = 1', 'B) x = 5 ✓', 'C) x = 0', 'D) x = x']);
    const note = await question('note-formula-section.html');
    expect(note.text).toBe('Wie lautet die Lösungsformel für eine quadratische Gleichung ax² + bx + c = 0?');
    expect(note.note).toBe('x = (−b ± √(b² − 4ac)) / 2a');
    expect(note.options).toEqual([]);
  });

  it('reads <sup>/<sub>, KaTeX and MathJax once and readably', async () => {
    const q = await question('math-markup-section.html');
    expect(q.text).toBe('Was ergibt x² + 1/2 + √(b − 4) für H₂O und 10⁻³ und e^(i·π) und a³?');
    expect(q.note).toBe('CO₂');
  });

  // Live 12.11.2026: "!quiz ende" with an open question – the bot closed the browser right after "Ja, beenden",
  // before quiz-base had sent the end: the players kept seeing the question with a running timer.
  it('endGame() returns only once quiz-base shows the results (the browser is closed right after)', async () => {
    await page.setContent(`<html><body><main>
      <header><button aria-label="Spiel beenden" onclick="document.getElementById('d').hidden = false">x</button></header>
      <section aria-label="Aktive Frage"><span>100 Punkte</span><p>Wie viel ist 3+4?</p></section>
      <div id="d" role="dialog" hidden><p>Spiel wirklich beenden?</p><button>Abbrechen</button>
        <button onclick="setTimeout(() => { document.querySelector('main').innerHTML = '<div role=dialog><h1>SPIEL VORBEI!</h1><div title=Aaron>Aaron</div><div>-50</div></div>'; }, 400)">Ja, beenden</button></div>
    </main></body></html>`);
    const driver: BrowserDriver = {
      name: 'fixture',
      open: async () => {},
      goto: async () => {},
      currentUrl: async () => page.url(),
      evaluate: async <T>(expr: string) => parseJsonResult<T>(await page.evaluate(jsonWrap(expr))),
      screenshot: async (f: string) => f,
      close: async () => {},
    };
    const host = new TafelquizPage(driver);
    expect((await host.state()).phase).toBe('question');
    expect(await host.endGame()).toEqual({ ok: true });
    const s = await host.state();
    expect(s.phase).toBe('results');
    expect(s.players).toEqual([{ name: 'Aaron', score: -50, isTurn: false, hasBuzzed: false }]);
  }, 15000);
});

