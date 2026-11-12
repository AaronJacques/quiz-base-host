# Changelog

Alle wichtigen Änderungen an diesem Projekt stehen hier.
Format: [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionierung: [SemVer](https://semver.org/lang/de/).

## [Unreleased]

### Behoben
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
- `qbhost voice-setup` lädt jedes konfigurierte `ggml-*.bin`-Whisper-Modell und bricht ohne Homebrew mit einer klaren Anleitung ab statt mit `spawn brew ENOENT`.
- `qbhost doctor` nennt Lösungen: fehlender Chromium, fehlende Claude CLI, keine Konfigurationsdatei. Orca und Claude CLI werden nur geprüft, wenn sie konfiguriert sind.

### Hinzugefügt
- Öffentliches Repo: Lizenz (MIT), Installationsanleitung ([docs/INSTALL.md](docs/INSTALL.md)), Konfigurationsreferenz ([docs/CONFIG.md](docs/CONFIG.md)), Beitragsrichtlinien, Sicherheitsmeldungen, Issue- und PR-Vorlagen, Dependabot.
- Deployment für einen Server per Docker-Image: [docs/DEPLOY.md](docs/DEPLOY.md). Dort nutzt der Judge die Anthropic-API (`llm.provider: "anthropic"`), die Claude CLI ist im Image nicht enthalten.

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
