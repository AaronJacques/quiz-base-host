# AGENTS.md

Hinweise für KI-Agenten (Claude Code, Codex, …), die an diesem Repo arbeiten. `CLAUDE.md` importiert diese Datei.

## Was das Projekt ist

`qbhost` übernimmt auf [quiz-base.de](https://www.quiz-base.de) die Host-Rolle in **Tafelquiz**-Runden. Eine deterministische Engine bedient die normale Host-Oberfläche in einem Browser. Ein LLM (standardmäßig Claude Haiku) wird nur gerufen, um unsichere Antworten zu bewerten oder Bildfragen ohne hinterlegte Lösung zu lösen. Bedienung: **Discord-Bot** (Hauptziel), alternativ Terminal + Web-Spieler-Pult.

## Stack & Befehle

- Node ≥ 22, TypeScript (ESM, `.ts`-Imports), ausgeführt mit `tsx`, kein Build-Schritt.
- `npm test` (vitest), `npm run typecheck`. **Beides muss vor jedem Commit grün sein.**
- `npx qbhost discord | host | boards | probe | judge | doctor`, siehe `npx qbhost --help`.
- Laufzeitdaten in `.qbhost/` (gitignored); Secrets nur in `.env` (gitignored, Vorlage `.env.example`).

## Architektur in einem Satz pro Ordner

| Ordner | Verantwortung | Darf importieren |
|---|---|---|
| `src/core` | Typen, typisierter `EventBus`, Logger | nichts aus `src` |
| `src/browser` | `BrowserDriver`: JS-Ausdruck in einem Tab ausführen (Playwright / Orca / CDP) | core |
| `src/site` | **Alles DOM-Wissen über quiz-base** (`probe.browser.js`) + Lobby-Wizard | core, browser |
| `src/modes/tafelquiz` | Spielablauf (`controller.ts`) und Punkteregeln (`rules.ts`) | core, site (nur `TafelquizPort`), judge |
| `src/judge` | Antwortbewertung: Fuzzy → Cache → LLM → Operator | core, llm |
| `src/llm` | `LlmClient`: Claude-CLI (`claude -p`) oder Anthropic-SDK | core |
| `src/channels` | Terminal + Web-Spieler-Pult (nur über den EventBus) | core |
| `src/discord` | Discord-Bot: Befehle, Verknüpfung, Kartenwahl, Rendering | core, modes/rules, session (Typen) |
| `src/session.ts` | Eine Spielrunde: Browser + Bus + Controller + Judge | alles |
| `src/app.ts`, `src/cli.ts` | Composition Root / CLI | alles |

Ausführlich: `docs/ARCHITECTURE.md`. DOM-Fakten: `docs/SITE-NOTES.md`. Discord-Bedienung: `docs/DISCORD.md`.

## Regeln für Änderungen

1. **DOM-Selektoren nur in `src/site/**/probe.browser.js`.** Die Datei ist reines Browser-JS: ein einziger Objekt-Ausdruck, synchrone Methoden, JSON-Rückgaben, keine Template-Literals mit `${}`. Neue Erkenntnisse über die Seite in `docs/SITE-NOTES.md` festhalten.
2. **Der Controller kennt nur `TafelquizPort`.** Neue Seitenaktion = Probe-Methode → `TafelquizPort` + `TafelquizPage` → `test/fake-page.ts`.
3. **Kanäle (Terminal, Web, Discord) sprechen nur über den EventBus** (`host:*` raus, `player:*`/`operator:*` rein). Kein Kanal ruft den Browser oder den Controller direkt.
4. **LLM sparsam.** Jede LLM-Nutzung läuft über `AnswerJudge`/`LlmJudge`, wird vorher deterministisch gefiltert und gecacht. Ziel: Haiku reicht, < 2 Cent pro Spiel.
5. **Keine Lösungen leaken.** Nichts, was die Lösung enthalten kann (Notiz, LLM-Begründung, Bild-URL), darf vor `host:reveal` in einen öffentlichen Kanal. Rückfragen an die Spielleitung mit Lösung nur per DM (`host:notice.detail`).
6. **Einstellungen** immer in `src/config.ts` (Zod, Default, Kommentar). Zur Laufzeit änderbare Spielregeln zusätzlich in `RULES` (`src/modes/tafelquiz/rules.ts`), dann sind sie automatisch per Discord einstellbar.
7. **Sprache:** UI, Logs, Doku und Discord-Texte auf Deutsch; Code, Bezeichner und Code-Kommentare auf Englisch.
8. Neue Logik bekommt Tests. Spielabläufe testet man gegen `FakeTafelquizPage`, Discord-Abläufe mit dem `FakeGateway` in `test/discord-bot.test.ts`, also ohne Netzwerk und Token.

## Live testen (gegen das echte quiz-base)

- `npx qbhost probe --driver orca --page <id>` zeigt, was die Engine auf der Seite sieht.
- Testspieler brauchen **eigene Browser-Kontexte** (Playwright `browser.newContext()` pro Spieler), sonst teilen sie sich die anonyme Supabase-Session. Ablauf: `/join?code=XXXX` → `Beitreten` → `input[placeholder="Dein Name"]` → `Beitreten` → `Ich bin bereit!` (bei Musik-Boards zusätzlich `Sound aktivieren`).
- Der Discord-Bot lässt sich ohne Discord testen, indem man `QuizBot` mit einem eigenen `ChatGateway` (z.B. stdin/stdout) und einer echten `GameSession` startet.
- Erstellte Test-Lobbys wieder schließen bzw. Spiele beenden. Es sind echte Lobbys auf einer fremden Plattform.

## Nicht tun

- Keine direkten Aufrufe der Supabase-API von quiz-base. Wir bedienen nur die offizielle Oberfläche.
- Keine Secrets (Discord-Token, API-Keys) in Code, Config-Beispiele oder Logs.
- Keine LLM-Aufrufe im Polling-Pfad (`state()` läuft ~2×/s).
