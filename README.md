# quiz-base-host 🎙️

Ein Discord-Bot, der auf [quiz-base.de](https://www.quiz-base.de) die Rolle des **Hosts / Gamemasters** übernimmt. Dann muss niemand aus der Runde die Antworten kennen, und alle spielen mit. Auf Wunsch moderiert er **per Stimme im Voice-Channel** und versteht, was ihr sagt – komplett lokal.

Unterstützt: **Tafelquiz** (inkl. 2 Boards, Bild- und Audiofragen, Buzzer). Weitere Formate: siehe [Roadmap](docs/ROADMAP.md).

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

## Schnellstart (Discord)

Voraussetzungen: Node ≥ 22 und eines davon:
- [Claude Code](https://claude.com/claude-code), eingeloggt (Bewertung über dein Abo)
- `ANTHROPIC_API_KEY`

```bash
git clone <repo> && cd quiz-base-host
npm install
npx playwright install chromium
cp .env.example .env              # DISCORD_TOKEN eintragen → docs/DISCORD.md
npm run doctor
npx qbhost discord
```

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
npx qbhost voice-setup    # einmalig: whisper.cpp, Modelle (~700 MB), Piper
```

Dann im Voice-Channel sitzen und `!quiz neu` (oder `!quiz voice`) tippen – ab da geht alles per Stimme: „Quizmaster, neues Quiz Allgemeinwissen“, „Sport für 200“, „Hier!“. Details: **[docs/VOICE.md](docs/VOICE.md)**.

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

Defaults stehen in [`src/config.ts`](src/config.ts). Für Anpassungen `qbhost.config.example.json` nach `qbhost.config.json` kopieren.

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
