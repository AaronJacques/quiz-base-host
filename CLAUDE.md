# CLAUDE.md – quiz-base-host

Node 22 + TypeScript (ESM, ausgeführt mit `tsx`, kein Build-Schritt). Sprache in UI/Logs/Doku: Deutsch; Code/Kommentare: Englisch.

## Befehle
- `npm test` – vitest (Bewertung, Regeln, kompletter Spielablauf gegen `test/fake-page.ts`)
- `npm run typecheck`
- `npx qbhost probe --driver orca --page <id>` – Live-Zustand der Seite als JSON

## Regeln für Änderungen
- DOM-Selektoren **nur** in `src/site/**/probe.browser.js` (reines Browser-JS, ein einziger Objekt-Ausdruck, synchron, JSON-Rückgaben). Änderungen am DOM-Verständnis zusätzlich in `docs/SITE-NOTES.md` festhalten.
- Der Controller spricht nur mit `TafelquizPort`, nie mit Treibern oder DOM. Neue Seitenaktionen: Probe-Methode → `TafelquizPort` + `TafelquizPage` → `FakeTafelquizPage` in den Tests.
- LLM-Aufrufe ausschließlich über `AnswerJudge`/`LlmJudge`. Jede neue LLM-Nutzung muss vorher deterministisch gefiltert und gecacht werden (Ziel: Haiku reicht, < 1 Cent pro Spiel).
- Neue Einstellungen immer in `src/config.ts` (Zod, mit Default und Kommentar).
- Kanäle (`src/channels`) kommunizieren nur über den `EventBus`.

## Live testen
Testspieler in isolierten Browser-Kontexten: siehe `scratch/` (gitignored) bzw. Playwright `browser.newContext()` je Spieler, `/join` → Code → Name → `Ich bin bereit!`.
