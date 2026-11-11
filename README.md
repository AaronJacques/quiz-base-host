# quiz-base-host

Lässt **Claude** auf [quiz-base.de](https://www.quiz-base.de) die Rolle des **Hosts / Gamemasters** übernehmen. Dann muss niemand aus der Runde die Antworten kennen, und alle können mitspielen.

Aktuell unterstützt: **Tafelquiz** (inkl. 2 Boards, Bild-/Audiofragen, Buzzer). Weitere Modi siehe [Roadmap](docs/ROADMAP.md).

## Wie es funktioniert

```
 Spieler (Handy/PC)                      qbhost (dein Rechner)                       quiz-base.de
 ───────────────────                     ─────────────────────                       ────────────
 quiz-base Lobby  ◄──────────────────────── Host-Browser (Playwright / Orca / Chrome) ──► Host-Ansicht
 Spieler-Pult  ── wählt Frage, tippt ──►  Spiel-Engine (deterministisch)
   (Web-Seite)     Antwort                    │  liest Seite, klickt, vergibt Punkte
                                              ▼
                                         Bewertung: Fuzzy → Cache → Claude Haiku → Operator
```

- **Die Engine macht alles Mechanische ohne KI**: Lobby erstellen, Spiel starten, Zugreihenfolge, Frage öffnen, Audio abspielen, Timer, Buzzer, Punkte (+Wert / −½ Wert), Animationen, Board-Wechsel, Spielende.
- **Claude wird nur gefragt, wenn es wirklich nötig ist**:
  1. eine Antwort ist nicht eindeutig (Fuzzy-Abgleich unsicher) → ~0,03 Cent, ~3 s
  2. eine Frage hat keine hinterlegte Lösung (reine Bildfrage) → Claude schaut sich die Host-Ansicht an → ~0,06 Cent
  
  Exakte/fast exakte Treffer, Zahlen, „keine Ahnung“ und Wiederholungen (Cache) kosten **nichts**. Ein typisches 16-Fragen-Spiel braucht ca. 5–15 Haiku-Aufrufe, also deutlich unter 1 Cent.
- **Spieler-Pult**: Weil quiz-base keinen Chat hat (normalerweise sagt man dem Host per Voice, was man nimmt), öffnen die Spieler eine kleine Webseite des Hosts: Dort wählt der Spieler am Zug seine Frage und tippt seine Antwort. Den Buzzer drücken alle weiterhin auf quiz-base selbst.
- **Operator-Konsole**: Ein Mensch kann im Terminal jederzeit eingreifen (`r`/`f` für richtig/falsch, `skip`, `punkte Anna +100`, …). Greift jemand direkt im Browser ein (Frage öffnen, Spiel beenden), passt sich die Engine an.

## Schnellstart

Voraussetzungen: Node ≥ 22, [Claude Code](https://claude.com/claude-code) eingeloggt (für die Bewertung über dein Abo) **oder** `ANTHROPIC_API_KEY`.

```bash
npm install
npx playwright install chromium   # einmalig, falls noch nicht vorhanden
npm run doctor                     # prüft Claude CLI, Browser, Haiku-Bewertung
```

### Variante A: eigener Browser (Standard)

```bash
npx qbhost host --board "Allgemeinwissen Quiz v1" --auto-start
```

Ein Chromium-Fenster öffnet sich, die Lobby wird erstellt, der Code steht im Terminal.

### Variante B: Orca-Browser

```bash
orca tab create --url https://www.quiz-base.de --json     # → browserPageId
npx qbhost host --driver orca --page <browserPageId> --board "Video Game Quiz" --auto-start
```

Das Spiel läuft sichtbar im Orca-Tab neben deinem Agenten.

### Variante C: dein normaler Chrome

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.qbhost-chrome"
npx qbhost host --driver cdp
```

Ohne `--board` übernimmt qbhost, sobald du selbst im Browser eine Tafelquiz-Lobby erstellt hast (auch eigene Boards mit Login).

### Ablauf für die Runde

1. Spieler treten auf quiz-base mit dem Lobby-Code bei und klicken „Ich bin bereit!“.
2. Spieler öffnen das **Spieler-Pult** (URL steht im Terminal, z. B. `http://192.168.178.20:4747`) und melden sich mit Code + gleichem Namen an.
   *Freunde außerhalb deines WLANs:* Port 4747 per Tunnel freigeben, z. B. `cloudflared tunnel --url http://localhost:4747`.
3. Spiel startet automatisch (`--auto-start`) oder per `start` in der Konsole.
4. Am Zug: Frage im Pult antippen → Antwort tippen → Claude bewertet → bei falsch wird der Buzzer freigegeben.

## Befehle

```
qbhost host     [--driver playwright|orca|cdp] [--page <id>] [--board "<Titel>"] [--auto-start]
                [--llm claude-cli|anthropic|none] [--model haiku|sonnet] [--judge cascade|fuzzy|operator]
                [--no-companion] [--port 4747] [--headless] [--verbose]
qbhost boards   # öffentliche Tafelquiz-Boards auflisten
qbhost probe    # aktuellen Seitenzustand als JSON (Debug, z. B. wenn quiz-base das Layout ändert)
qbhost judge "<Frage>" "<Lösung>" "<Antwort>"   # Bewertung testen
qbhost doctor   # Umgebung prüfen
```

Operator-Konsole während des Spiels: `start`, `r`/`richtig`, `f`/`falsch`, `skip`, `pick <spalte> <zeile>`, `antwort <text>`, `punkte <name> <±n>`, `hilfe`.

## Konfiguration

Alle Optionen mit Defaults stehen in [`src/config.ts`](src/config.ts). Für eigene Hausregeln `qbhost.config.example.json` nach `qbhost.config.json` kopieren, z. B.:

```json
{
  "game": { "answerTimeoutSec": 30, "wrongPenalty": 0, "buzzerOnWrong": true, "penalizeBuzzers": false },
  "llm": { "provider": "claude-cli", "model": "haiku" },
  "judge": { "strategy": "cascade" }
}
```

| Bewertung | Verhalten | LLM-Verbrauch |
|---|---|---|
| `cascade` (Standard) | Fuzzy → Cache → Claude → Operator | minimal |
| `fuzzy` | nur deterministisch, Unsicheres fragt den Operator | null |
| `operator` | Fuzzy für eindeutige Treffer, sonst entscheidet ein Mensch | null |

| LLM-Provider | Voraussetzung |
|---|---|
| `claude-cli` (Standard) | eingeloggtes Claude Code; nutzt `claude -p --model haiku` ohne Tools/MCP → kleiner Prompt |
| `anthropic` | `ANTHROPIC_API_KEY` (oder `ant auth login`), Modell `claude-haiku-5-5` |
| `none` | kein LLM, Bildfragen ohne Notiz brauchen dann den Operator |

## Entwicklung

```bash
npm test          # Unit-Tests (Bewertung, Regeln, kompletter Spielablauf gegen simulierte Seite)
npm run typecheck
```

Architektur & Erweiterung: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · DOM-Wissen über quiz-base: [docs/SITE-NOTES.md](docs/SITE-NOTES.md)

## Bekannte Einschränkungen

- Startest du qbhost **mitten in einer offenen Frage** neu, wird die Frage dem Spieler am Zug noch einmal gestellt (Punkte aus dem ersten Versuch bleiben). Zwischen zwei Fragen neu zu starten ist unproblematisch.
- Ist das Fragebild auf quiz-base selbst kaputt, nutzt Claude nur den Dateinamen der Bild-URL als Hinweis. Ist es zu unsicher, entscheidet der Operator.
- Multiple-Choice-Antwortoptionen im Tafelquiz sind im Probe nur heuristisch erkannt (kein Live-Board mit Optionen gefunden). Hostnotizen funktionieren vollständig.
- quiz-base hat keine offizielle API. qbhost bedient die normale Host-Oberfläche wie ein Mensch. Ändert sich das Layout, muss nur `src/site/tafelquiz/probe.browser.js` angepasst werden.
