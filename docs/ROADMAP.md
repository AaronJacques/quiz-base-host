# Roadmap

## ✅ v0.1 – Tafelquiz
- Lobby per öffentlichem Board automatisch erstellen, Auto-Start
- Zug-/Frage-/Buzzer-/Punkte-Ablauf, 2 Boards, Audio-Autoplay, Spielende
- Bewertungs-Kaskade Fuzzy → Cache → Haiku → Operator, Vision-Lösung für Bildfragen ohne Notiz
- Spieler-Pult (Web), Operator-Konsole, Browser: Playwright / Orca / Chrome (CDP)

## ✅ v0.2 – Discord-Bot
- Lobby per Chat-Befehl mit Quiz-Auswahl (Rückfrage, Suche auf quiz-base, Nachfrage bei mehreren Treffern), Beitrittslink, Verknüpfung Discord↔quiz-base (automatisch per Name oder `!quiz ich`)
- Kartenwahl in natürlicher Sprache mit Prüfung frei/schon weg, Antworten im Chat
- Punkteregeln per Chat (`!quiz regel …`), Spielleitung mit Overrides, Lösungen nur per DM vor der Auflösung

## ✅ v0.3 – Sprache im Voice-Channel
- Bot moderiert per Stimme (Piper, lokal) und versteht Karten, Antworten, „Buzzer!“ und „Quizmaster, …“-Befehle (whisper.cpp, lokal)
- Quiz-Auswahl, Verknüpfung und Spielleitung auch per Sprache; Echo-Schutz, Füllwort-Filter, Kölner Phonetik für Hörfehler
- End-to-End getestet mit zwei Haiku-Agenten als Spieler gegen das echte quiz-base (Loopback-Voice-Raum)

## ✅ v0.4 – Eigene Boards per KI
- `qbhost login`: einmal selbst im Browserfenster bei quiz-base anmelden, das Profil bleibt gespeichert
- Board-Generator: Claude (Sonnet) schreibt ein komplettes Tafelquiz (Kategorien × Stufen, 1–2 Boards, Niveau, Sprache, Multiple-Choice-Anteil) mit Lösungen und Varianten im Format des Judges; Prüfregeln im Code, zweite Prüfrunde (Faktencheck) ersetzt schwache Fragen
- Anlegen über den Board-Editor von quiz-base (privater Entwurf unter „Meine Boards“, veröffentlichen von Hand), danach `!quiz neu <Name>` bzw. `qbhost host --board "<Name>"` (Lobby über „Eigenes Board verwenden“); `qbhost board-delete` löscht wieder
- `qbhost board-create` (Terminal, Vorschau mit Lösungen) und `!quiz erstellen` (Discord, Lösungen nur per DM, nur Server-Admins/`boardgen.creatorIds`, kein Board doppelt)

## Als Nächstes
1. **Slash-Commands** (`/quiz neu`) mit Autocomplete für Boards, zusätzlich zum Präfix.
2. **Barge-in**: Bot verstummt, wenn jemand dazwischenredet (statt Echo-Schutz per Ignorieren) – braucht Echo-Erkennung.
3. **Musikfragen im Voice-Channel**: Audio direkt in Discord abspielen statt nur auf quiz-base.
4. **Punktejagd**: rein mechanisch (aufdecken → auflösen → weiter), kein LLM nötig. Notizen in SITE-NOTES.md.
5. **Eagle Eye**: Buzzer + Bewertung wie Tafelquiz, Lösung steht im Host-Board.
6. **Board-Generator, Ausbau**: einzelne Fragen per Chat ersetzen („ersetze Sport 300“), Bildfragen mit frei lizenzierten Bildern, alle Boards des Accounts (nicht nur die selbst erzeugten) per `!quiz neu` finden.
7. **Resume-Sicherheit**: Fragezustand persistieren, damit ein Neustart mitten in einer Frage nicht erneut fragt.
8. **MCP-Server** (optional): Claude-Code-Session als interaktiver Host mit Tools `wait_for_event`, `decide`, `say`.
