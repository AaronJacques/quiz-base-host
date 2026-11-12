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

## Als Nächstes
1. **Slash-Commands** (`/quiz neu`) mit Autocomplete für Boards, zusätzlich zum Präfix.
2. **Barge-in**: Bot verstummt, wenn jemand dazwischenredet (statt Echo-Schutz per Ignorieren) – braucht Echo-Erkennung.
3. **Musikfragen im Voice-Channel**: Audio direkt in Discord abspielen statt nur auf quiz-base.
4. **Punktejagd**: rein mechanisch (aufdecken → auflösen → weiter), kein LLM nötig. Notizen in SITE-NOTES.md.
5. **Eagle Eye**: Buzzer + Bewertung wie Tafelquiz, Lösung steht im Host-Board.
6. **Board-Generator**: Claude erstellt aus einem Thema ein komplettes Tafelquiz-Board (mit Lösungen) und trägt es im Board-Editor ein.
7. **Eigene Boards** aus dem Account (Login im persistenten Browser-Profil, dann „Eigenes Board“ im Lobby-Wizard).
8. **Resume-Sicherheit**: Fragezustand persistieren, damit ein Neustart mitten in einer Frage nicht erneut fragt.
9. **MCP-Server** (optional): Claude-Code-Session als interaktiver Host mit Tools `wait_for_event`, `decide`, `say`.
