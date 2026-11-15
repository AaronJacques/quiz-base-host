# Changelog

Alle wichtigen Änderungen an diesem Projekt stehen hier.
Format: [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionierung: [SemVer](https://semver.org/lang/de/).

## [Unreleased]

### Behoben
- Die Piper-Frist läuft erst, wenn der Worker an dem Satz arbeitet: Ein kurzer Satz hinter einer langen Frage beendet die laufende Synthese nicht mehr. Ein Neustart während Piper noch lädt verliert keine wartenden Sätze und hinterlässt keinen zweiten Worker; nach dem Beenden läuft kein Piper-Prozess mehr.
- Verlor Piper eine Antwort (hängender Worker) und wurde die Ansage danach verworfen (Barge-in, Ersatz, Spielende), blieben alle späteren Ansagen stumm. Jetzt hat jede Synthese eine Frist (10 s + 60 ms je Zeichen); danach wird der Satz übersprungen, Piper neu gestartet und eine Warnung ohne Ansagetext geloggt.
- **Sprache, aus einem echten Spiel:**
  - „Quizmaster, Spielbeenden“, „Spielbänden“, „Quizabrechen“ (so schreibt das schnelle Whisper-Modell) beenden das Spiel jetzt: Der ganze Befehl wird nach Klang und Vokalen verglichen, nur ein gleich klingender Befehl ohne Zahl und ohne Frage beendet direkt. Ähnliche Wörter („Spiel bieten“), Partizipien („Spiel abgebrochen?“) und Fragen führen zur Rückfrage; mit einer Zahl oder einer Kategorie des Boards („Spielbanken 100“) ist es nie ein Beenden-Befehl. Nach der Rückfrage „Soll ich das Spiel beenden?“ genügt ein klares „Ja“ der Spielleitung (20 s, kein „Bitte?“ oder „Klar?“), „Nein“ oder „weiter“ spielt weiter.
  - Weniger Dazwischenreden bei der Kartenwahl: „Welche Karte?“ nur noch bei einem Kartenversuch, nicht bei Gespräch; die Erinnerung „du bist dran“ kommt erst nach 90 s statt alle 45 s, weitere höchstens alle 5 Minuten und nur im Chat. Neue Regeln `erinnerung`, `erinnerungstakt`, `kartenhinweis` (`!quiz regel …`, auch „aus“), Config `game.pickReminderRepeatSec`, `game.pickHint`. **Eigene `qbhost.config.json`:** Steht dort noch `"pickReminderSec": 45` (aus der alten Beispieldatei), den Eintrag löschen oder auf 90 setzen, sonst bleibt es bei 45 s.
  - Nach Spielende verabschiedet sich der Bot und verlässt den Voice-Channel von selbst (`voice.leaveOnGameEnd`, Standard an). `!quiz voice aus` / „Quizmaster, tschüss“ darf während eines Spiels nur die Spielleitung.
- 24 Findings aus einem vollständigen Code-Review, u.a.:
  - abgesicherte Antworten („Paris oder London“) und Klang-Verwechslungen wie „Apollo 13“ statt „Apollo 11“ werden nicht mehr als richtig gewertet
  - Lösungs-Cache unterscheidet gleichlautende Audio- und Bildfragen
  - kein Lösungs-Leak im Web-Pult
  - whisper-server startet nach einem Absturz neu
  - Spielende mitten in einer Frage kostet keine Punkte
  - Leitungsrechte gelten nur in der eigenen Gilde
  - Sprache funktioniert auch, wenn Voice in einem anderen Channel gestartet wurde
  - ein Browserfehler beendet den Prozess nicht mehr

### Geändert
- `qbhost voice-setup` lädt jede offizielle Piper-Stimme im Schema `models/<sprache>_<REGION>-<name>-<qualität>.onnx` (z.B. `de_DE-thorsten-medium`), nicht nur `thorsten-high`, und meldet einen unpassenden Namen oder einen gescheiterten Download klar. Mit Cloud-Erkennung prüfen `voice-setup` und `doctor` nur, was die Einstellung braucht.
- `⏱`: Fällt das schnelle Whisper-Modell aus und das Hauptmodell übernimmt, steht `rueckfall=ja` und es zählt in `rueckfaelle`. Plaudern nach dem Spiel ohne Rufnamen erzeugt beim Verlassen keine leere zweite Bilanz mehr.
- `!quiz erstellen` ist kein Alias von `!quiz neu` mehr, sondern startet den Board-Generator. Eine Lobby öffnet nur noch `!quiz neu`.
- `qbhost voice-setup` lädt jedes konfigurierte `ggml-*.bin`-Whisper-Modell und bricht ohne Homebrew mit einer klaren Anleitung ab statt mit `spawn brew ENOENT`.
- `qbhost doctor` nennt Lösungen: fehlender Chromium, fehlende Claude CLI, keine Konfigurationsdatei. Orca und Claude CLI werden nur geprüft, wenn sie konfiguriert sind.

### Hinzugefügt
- **Spracherkennung lokal oder Cloud:** `voice.stt` schaltet zwischen whisper.cpp (Standard, unverändert) und Deepgram um, je Phase getrennt (`voice.sttCloudFor`, Standard: Antwort, Rückfrage, Kartenwahl/Menüs; die Prüfung auf den Rufnamen bleibt lokal, Nebengespräche verlassen den Server nie). Fällt die Cloud aus (Frist `sttTimeoutMs`, Netz, 429, 5xx, ungültiger Schlüssel), erkennt der Bot dieselbe Äußerung sofort lokal; nach 3 Fehlern in Folge bleibt er `cloudCooldownSec` lokal. Ohne Rückfall schreibt er einmal pro Spiel „⚠️ Sprache gestört – bitte tippen“. Der Schlüssel kommt nur aus `.env` (`voice.deepgram.keyEnv`) und erscheint nie im Log. Deepgram läuft über den EU-Endpunkt mit Nova-3, Schlüsselbegriffen aus Kategorien, Punkten und Namen (nie der Lösung) und festem `mip_opt_out=true` (keine Nutzung der Aufnahmen zum Training). `npm run doctor` zeigt, ob der Schlüssel gesetzt und der Endpunkt erreichbar ist (ohne Anfrage, ohne Kosten). Siehe [docs/VOICE.md](docs/VOICE.md#erkennung-lokal-oder-cloud).
- Datenschutz der Cloud-Erkennung: Audio geht nur an Deepgram, wenn der Bot die Person eindeutig als die erkennt, die gerade sprechen darf (verknüpft und am Zug, Menü-Fragende, wer noch buzzern darf), oder wenn die lokale Prüfung den Rufnamen gehört hat. Die Berechtigung muss vom Beginn bis zum Ende der Äußerung gelten (wer vor dem eigenen Zug losspricht, wird lokal erkannt), und im Zweifel – keine eindeutige Erlaubnis, kein bekannter Beginn, keine lokale Engine – geht nichts hinaus. Unverknüpfte Personen werden nur lokal erkannt; eine gescheiterte lokale Rufnamen-Prüfung verwirft die Äußerung, statt sie in die Cloud zu schicken. 402 (Guthaben aufgebraucht) schaltet die Cloud bis zum Neustart ab. `deepgram.baseUrl` muss `https://` sein, Weiterleitungen werden nicht verfolgt. Fehlende Rückfall-Modelle sind in `doctor` eine Warnung und verhindern den Beitritt nicht. Tabelle: [docs/VOICE.md](docs/VOICE.md#erkennung-lokal-oder-cloud).
- `tools/stt-probe.ts`: misst die Spracherkennung mit echten WAV-Aufnahmen über dieselbe Route wie der Bot, wahlweise lokal oder Cloud erzwungen (`--engine local|cloud`), mit Median, Maximum, Rückfall, erkanntem Text und p50/p90.
- **Schneller erster Ton, lokal:** `voice.ttsSplitSentences` lässt den Bot lange Ansagen satzweise sprechen. Der erste Satz klingt, während der Rest noch erzeugt wird; bei einer langen Quizfrage (250 Zeichen, Piper auf dem Mac) sinkt die Zeit bis zum ersten Ton von 3,2 s auf 0,9 s. Unterbrechen und Ersetzen gelten für die ganze Ansage, verworfene Teile werden nicht mehr erzeugt. `voice.ttsDiskCache` legt feste Standardsätze ohne Spielinhalt (`FIXED_LINES`) unter `.qbhost/voice/tts-cache/` ab und erzeugt kurze davon in Sprechpausen vorab. Beide Schalter sind standardmäßig aus, die Server-Vorlage schaltet sie ein. Siehe [docs/VOICE.md](docs/VOICE.md#schneller-erster-ton).
- **Eigene Boards per KI:** `qbhost board-create` und `!quiz erstellen <Thema> [Optionen]` lassen Claude (Standard Sonnet, Einstellungen unter `boardgen`) ein komplettes Tafelquiz schreiben – mit Prüfregeln im Code, zweiter Prüfrunde (Faktencheck), Kostenschätzung vorab und Schutz gegen doppelte Boards – und legen es über den Board-Editor von quiz-base als eigenes Board an. Im Discord-Channel stehen nur Name, Kategorien und Punkte; Fragen und Lösungen gehen per DM an die anfragende Person. `!quiz neu <Name>` findet die eigenen Boards. Boards landen als privater Entwurf unter „Meine Boards“ (quiz-base kennt beim Speichern keine Sichtbarkeit); den Link zum Board gibt es nur per DM bzw. im Terminal, weil der Editor die Lösungen zeigt.
- `qbhost board-delete "<Name>"`: eigenes Board auf quiz-base löschen (z.B. Test-Boards); der lokale Entwurf bleibt und lässt sich mit `board-create --from <id>` wieder anlegen.
- `qbhost login`: einmal selbst im sichtbaren Browser bei quiz-base anmelden; das Profil (`browser.profileDir`) bleibt gespeichert.
- Öffentliches Repo: Lizenz (MIT), Installationsanleitung ([docs/INSTALL.md](docs/INSTALL.md)), Konfigurationsreferenz ([docs/CONFIG.md](docs/CONFIG.md)), Beitragsrichtlinien, Sicherheitsmeldungen, Issue- und PR-Vorlagen, Dependabot.
- Deployment für einen Server per Docker-Image: [docs/DEPLOY.md](docs/DEPLOY.md). Dort nutzt der Judge die Anthropic-API (`llm.provider: "anthropic"`), die Claude CLI ist im Image nicht enthalten.
- **Latenz messen:** Der Voice-Bot loggt für jede erkannte Äußerung, jede Ansage und die Reaktionszeit (Ende der Äußerung bis zum ersten Ton der Antwort) `⏱`-Zeilen auf `info`, dazu eine Bilanz mit p50/p90 bei Spielende und beim Verlassen des Voice-Channels. Die Zeilen enthalten nur Engines, Zähler und Millisekunden, keine Texte; Äußerungen, die der Bot nicht verwendet (Nebengespräche), bekommen keine Zeile. `npx tsx tools/voice-latency.ts < log` wertet sie je Schritt und Engine aus. Abschalten mit `voice.latencyLog: false`, siehe [docs/VOICE.md](docs/VOICE.md#latenz-messen).

## [0.3.0] – 2026-11-12

### Hinzugefügt
- Sprachsteuerung im Discord-Voice-Channel: Der Bot moderiert per Stimme (Piper-TTS, lokal) und versteht Karten, Antworten, Buzzer („Hier!“) und „Quizmaster, …“-Befehle (whisper.cpp-STT, lokal).
- Quiz-Auswahl, Verknüpfung und Spielleitung auch per Sprache, Echo-Schutz, Füllwort-Filter, Kölner Phonetik für Hörfehler.
- `qbhost voice-setup` richtet whisper.cpp (macOS per Homebrew), Modelle und Piper ein.
- End-to-End-Test gegen das echte quiz-base mit zwei Agenten als Spieler (Loopback-Voice-Raum).

### Geändert
- Gesprochene Antworten zählen nur mit Schlüsselwort („Meine Antwort ist …“) und nach Bestätigung („Ja“).
- Unbeteiligte Personen im Voice-Channel werden nicht transkribiert, außer auf den Rufnamen.

## [0.2.0] – 2026-11-11

### Hinzugefügt
- Discord-Bot als Hauptbedienung: Lobby per Chat-Befehl (`!quiz neu`), Beitrittslink, Verknüpfung Discord ↔ quiz-base (automatisch per Name oder `!quiz ich`).
- Quiz-Auswahl per Chat mit Rückfrage bei mehreren Treffern, Suche auf quiz-base.
- Kartenwahl in natürlicher Sprache mit Prüfung „frei / schon weg“.
- Punkteregeln per Chat (`!quiz regel …`), gespeichert pro Server.
- Spielleitung mit Overrides (`!quiz richtig`, `!quiz falsch`, `!quiz korrektur`), Lösungen nur per DM vor der Auflösung.
- Beschränkung auf bestimmte Channels (`discord.channelIds`).

## [0.1.0] – 2026-11-11

### Hinzugefügt
- Deterministische Tafelquiz-Engine für quiz-base.de: Lobby per öffentlichem Board, Zug-, Frage-, Buzzer- und Punkteablauf, Spielende.
- Bewertungs-Kaskade Fuzzy → Cache → LLM (Claude Haiku) → Spielleitung, Vision-Lösung für Bildfragen ohne Notiz.
- Spieler-Pult im Web und Operator-Konsole im Terminal.
- Browser-Treiber: Playwright (eigener Chromium), Orca, Chrome per CDP.
- CLI: `host`, `discord`, `boards`, `probe`, `judge`, `doctor`.

[Unreleased]: https://github.com/AaronJacques/quiz-base-host/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AaronJacques/quiz-base-host/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AaronJacques/quiz-base-host/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AaronJacques/quiz-base-host/releases/tag/v0.1.0
