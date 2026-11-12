# quiz-base-host 🎙️

[![CI/CD](https://github.com/AaronJacques/quiz-base-host/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/AaronJacques/quiz-base-host/actions/workflows/ci-cd.yml)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)

Ein Discord-Bot, der auf [quiz-base.de](https://www.quiz-base.de) die Rolle des **Hosts / Gamemasters** übernimmt. Dann muss niemand aus der Runde die Antworten kennen, und alle spielen mit. Auf Wunsch moderiert er **per Stimme im Voice-Channel** und versteht, was ihr sagt – komplett lokal.

Unterstützt: **Tafelquiz** (inkl. 2 Boards, Bild- und Audiofragen, Buzzer). Weitere Formate: siehe [Roadmap](docs/ROADMAP.md).

> **English summary:** qbhost is a Discord bot (German UI) that hosts a *Tafelquiz* round on quiz-base.de. A deterministic engine drives the normal host page in a browser; Claude (Haiku by default) only judges unclear answers and solves image questions without a note. Optional voice control runs locally (whisper.cpp + Piper). Requires Node ≥ 22. Setup: [docs/INSTALL.md](docs/INSTALL.md). Config reference: [docs/CONFIG.md](docs/CONFIG.md). Docs are in German.

> **Hinweis:** qbhost ist **nicht offiziell** mit quiz-base.de verbunden. Es bedient nur die normale Weboberfläche, wie ein Mensch am Host-Bildschirm. Respektiere die Nutzungsbedingungen von quiz-base und schließe Test-Lobbys nach dem Gebrauch. Details: [Disclaimer](#disclaimer).

```
Discord-Channel                         qbhost (läuft auf deinem Rechner)              quiz-base.de
───────────────                         ─────────────────────────────────              ────────────
!quiz neu <Quiz>     ─────────────►     sucht Board, erstellt Lobby        ─────────►  Host-Ansicht
🔗 Beitrittslink     ◄─────────────     postet Link + Code
!quiz ich Benjamin   ─────────────►     verknüpft Discord-User ↔ Spieler
"nintendo 200"       ─────────────►     prüft Karte (frei / schon weg) und öffnet sie ──► alle sehen die Frage
"Luigi Mario"        ─────────────►     bewertet: Fuzzy → Cache → Claude Haiku
✅ +200 · 💡 · 📊     ◄─────────────     vergibt Punkte, Buzzer, Zugwechsel, Endstand ──► Punkte für alle
```

## Highlights

- **Komplett per Discord-Chat bedienbar:** Quiz per Name aussuchen (der Bot fragt nach, statt irgendeins zu nehmen), Lobby erstellen, Beitrittslink, Namen verknüpfen, Karten wählen, antworten, Regeln einstellen, Spielleitung.
- **Sprachsteuerung im Voice-Channel:** Der Bot liest Fragen vor, sagt Punkte und Lösungen an und versteht Karten, Antworten („Meine Antwort ist …“, mit kurzer Rückfrage), „Hier!“ (Buzzer) und „Quizmaster, …“-Befehle. Wer nicht dran ist, kann frei mitreden. Spracherkennung (whisper.cpp) und Stimme (Piper) laufen lokal und kostenlos. → [docs/VOICE.md](docs/VOICE.md)
- **Kartenwahl in natürlicher Sprache:** `Nintendo 200`, `nin 200`, `2 200`, `ich nehme Filme für 300`. Der Bot prüft, ob die Karte existiert, frei oder schon weg ist.
- **Punkteregeln per Chat einstellbar:** `!quiz regel minus 0`, `!quiz regel buzzerplus 50%`, `!quiz regel zeit 30`. Sie werden pro Server gespeichert.
- **Sparsam:** Die Engine spielt deterministisch. Claude wird nur bei unklaren Antworten oder Bildfragen ohne Lösung gefragt, standardmäßig Haiku über dein Claude-Code-Abo. Ein Board mit Lösungsnotizen kostet oft **0 Aufrufe**, ein reines Bilder-Board ohne Notizen ca. **1–2 Cent**.
- **Fair:** Die Lösung erscheint nie vor der Auflösung im Channel. Unsichere Fälle entscheidet die Spielleitung, die die Lösung per DM bekommt.
- **Erweiterbar:** saubere Schichten (Browser · Seite · Spielmodus · Bewertung · Kanäle), siehe [Architektur](docs/ARCHITECTURE.md).

## Voraussetzungen

- **Node.js ≥ 22** und **Git**
- **Ein Claude-Zugang**, eine dieser Optionen:
  - [Claude Code](https://claude.com/claude-code), eingeloggt. Bewertung über dein Abo, keine Kosten pro Aufruf.
  - `ANTHROPIC_API_KEY`. Bezahlung pro Aufruf, mit Ausgabenlimit empfohlen.
  - **Ohne LLM** (`"llm": { "provider": "none" }`). Das Spiel läuft, unklare Antworten entscheidet die Spielleitung.
- **Ein Discord-Account** und ein Server, auf dem du den Bot einladen darfst.
- **Optional, Sprache:** whisper.cpp und Piper, lokal. `qbhost voice-setup` richtet alles ein. Auf macOS installiert es whisper.cpp per Homebrew, unter Linux baust du `whisper-server` einmal selbst oder nimmst das Docker-Image. Unter Windows nur über WSL2. Details: [docs/VOICE.md](docs/VOICE.md) und [docs/INSTALL.md](docs/INSTALL.md#9-sprachsteuerung-optional).

Getestet wurde auf macOS. Linux (Ubuntu/Debian) funktioniert für Bot und Spiel, Windows nur über WSL2.

## Schnellstart (Discord)

```bash
git clone https://github.com/AaronJacques/quiz-base-host.git
cd quiz-base-host
npm ci
npx playwright install chromium   # Browser für quiz-base, ca. 150 MB
cp .env.example .env              # DISCORD_TOKEN eintragen, Anleitung: docs/DISCORD.md
npm run doctor                    # prüft Node, Token, Claude, Browser
npx qbhost discord
```

Die ausführliche Anleitung für macOS, Linux und Windows (WSL2), inklusive Fehlerbehebung: **[docs/INSTALL.md](docs/INSTALL.md)**.

Weitere Dokumente:

| Thema | Datei |
|---|---|
| Installation, Schritt für Schritt | [docs/INSTALL.md](docs/INSTALL.md) |
| Discord-Bot anlegen und bedienen | [docs/DISCORD.md](docs/DISCORD.md) |
| Alle Einstellungen | [docs/CONFIG.md](docs/CONFIG.md) |
| Sprachsteuerung | [docs/VOICE.md](docs/VOICE.md) |
| Server-Betrieb (Docker) | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Aufbau des Codes | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Mitmachen | [CONTRIBUTING.md](CONTRIBUTING.md) |

Dann im Discord-Channel:

```
!quiz neu                 Bot fragt, welches Quiz → Name schreiben → Link wird gepostet
!quiz neu dragon ball     direkt mit Namen (Suche auf quiz-base, Rückfrage bei mehreren Treffern)
!quiz boards [suche]      Board-Liste mit Nummern
!quiz ich <Name>          mit deinem quiz-base-Namen verknüpfen (bei gleichem Namen automatisch)
nintendo 200              wenn du am Zug bist
<deine Antwort>           wenn der Bot dich fragt
!quiz hilfe               alle Befehle
```

Bot-Einrichtung im Developer Portal, alle Befehle und Regeln: **[docs/DISCORD.md](docs/DISCORD.md)**.

### Mit Sprache

```bash
npx qbhost voice-setup    # einmalig: Modelle (~700 MB), Piper; auf macOS auch whisper.cpp
```

Dann im Voice-Channel sitzen und `!quiz neu` (oder `!quiz voice`) tippen – ab da geht alles per Stimme: „Quizmaster, neues Quiz Allgemeinwissen“, „Sport für 200“, „Hier!“. Details: **[docs/VOICE.md](docs/VOICE.md)**.

**Datenschutz:** Während der Bot im Voice-Channel ist, hört er zu und erkennt Sprache lokal auf deinem Rechner. Er speichert keine Aufnahmen. Gepostet wird nur, worauf er reagiert. Alle Mitspielenden sollten wissen, dass er zuhört. Der Bot sagt das beim Beitritt an.

## Ohne Discord: Terminal + Spieler-Pult

```bash
npx qbhost host --board "Allgemeinwissen Quiz v1" --auto-start
```

Spieler wählen Karten und antworten über eine kleine Webseite (`http://<dein-rechner>:4747`). Eingreifen kannst du im Terminal (`r`, `f`, `skip`, `punkte Anna +100`, `hilfe`).

Browser-Varianten (für beide Modi):

| Option | Browser |
|---|---|
| *(Standard)* | eigener Chromium, mit `--headless` unsichtbar |
| `--driver orca --page <browserPageId>` | Tab im Orca-Browser (`orca tab create --url https://www.quiz-base.de --json`) |
| `--driver cdp` | dein laufender Chrome mit `--remote-debugging-port=9222` |

## Konfiguration

Defaults stehen in [`src/config.ts`](src/config.ts). Für Anpassungen `qbhost.config.example.json` nach `qbhost.config.json` kopieren. Jede Option mit Default und Erklärung: **[docs/CONFIG.md](docs/CONFIG.md)**. Die Spielregeln (Punkte, Zeiten) kannst du zusätzlich im Discord-Chat ändern.

| Bereich | Wichtige Optionen |
|---|---|
| `game` | `correctFactor` 1, `wrongFactor` 0.5, `buzzerCorrectFactor` 1, `buzzerWrongFactor` 0.5, `buzzerOnWrong`, `answerTimeoutSec`, `buzzWindowSec` |
| `judge` | `strategy`: `cascade` (Fuzzy → Cache → LLM → Mensch) · `fuzzy` (nie LLM) · `operator` |
| `llm` | `provider`: `claude-cli` (Abo) · `anthropic` (API-Key) · `none`; `model`: `haiku` |
| `voice` | `tts` (`piper`/`say`), `autoJoin`, `silenceMs`, `wakeWords`, `extraTimeSec` – siehe [VOICE.md](docs/VOICE.md) |
| `discord` | `channelIds` (nur dort reagiert der Bot), `prefix` (`!quiz`), `autoStart`, `lobbyTimeoutMin` |
| `browser` | `driver`, `headless`, `pollMs` |

## Befehle (CLI)

```
qbhost discord          Discord-Bot starten
qbhost host             ein Spiel mit Terminal + Web-Spieler-Pult hosten
qbhost boards [suche]   öffentliche Tafelquiz-Boards auflisten / suchen
qbhost probe            aktuellen Seitenzustand als JSON (Debug)
qbhost judge "<Frage>" "<Lösung>" "<Antwort>"
qbhost voice-setup      Sprachsteuerung einrichten (lokales STT/TTS)
qbhost doctor           Umgebung prüfen
```

## Entwicklung

```bash
npm test            # Bewertung, Regeln, Kartenparser, Spielablauf, Discord-Bot, Sprachsteuerung (ohne Netzwerk)
npm run typecheck
```

Für KI-Agenten und Mitwirkende: [AGENTS.md](AGENTS.md) · [Architektur](docs/ARCHITECTURE.md) · [DOM-Notizen zu quiz-base](docs/SITE-NOTES.md)

## Bekannte Einschränkungen

- Ein Spiel gleichzeitig pro Bot-Instanz.
- Gebuzzert wird auf quiz-base oder per Zuruf „Hier!“ im Voice-Channel – wer zuerst ist, gewinnt.
- Ein Neustart des Bots **mitten in einer Frage** stellt die Frage erneut. Zwischen Fragen ist ein Neustart unproblematisch.
- Ist ein Fragebild auf quiz-base selbst kaputt, nutzt Claude nur den Dateinamen als Hinweis. Ist das zu unsicher, entscheidet die Spielleitung.
- quiz-base hat keine offizielle API. qbhost bedient die normale Host-Oberfläche. Ändert sich das Layout, muss nur `src/site/tafelquiz/probe.browser.js` angepasst werden.

## Disclaimer

- qbhost ist ein inoffizielles Projekt. Es ist **nicht mit quiz-base.de verbunden** und nicht von dessen Betreibern unterstützt.
- Das Programm bedient nur die normale Weboberfläche von quiz-base, wie ein Mensch es täte. Es nutzt keine interne API.
- **Respektiere die Nutzungsbedingungen von quiz-base.de.** Du bist selbst dafür verantwortlich, wie du das Programm einsetzt.
- **Schließe Test-Lobbys** und beende Spiele, die du nicht mehr brauchst. Es sind echte Lobbys auf einer fremden Plattform.
- Die Software wird ohne jede Garantie bereitgestellt (siehe [LICENSE](LICENSE)).

## Mitmachen

Beiträge sind willkommen. Die Regeln, Checks (`npm test`, `npm run typecheck`) und die Live-Test-Etikette stehen in **[CONTRIBUTING.md](CONTRIBUTING.md)**. Sicherheitsprobleme bitte privat melden, siehe [SECURITY.md](SECURITY.md). Verhaltensregeln: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Änderungen stehen im [CHANGELOG.md](CHANGELOG.md).

## Lizenz

[MIT](LICENSE), © 2026 Aaron Jacques
