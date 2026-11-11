# Roadmap

## ✅ v0.1 – Tafelquiz
- Lobby per öffentlichem Board automatisch erstellen, Auto-Start
- Zug-/Frage-/Buzzer-/Punkte-Ablauf, 2 Boards, Audio-Autoplay, Spielende
- Bewertungs-Kaskade Fuzzy → Cache → Haiku → Operator, Vision-Lösung für Bildfragen ohne Notiz
- Spieler-Pult (Web), Operator-Konsole, Browser: Playwright / Orca / Chrome (CDP)

## Als Nächstes
1. **Discord-Kanal**: Bot im Text-Channel der Runde (`!nehme Nintendo 200`, Antworten als Nachricht). Ersetzt das Spieler-Pult für Remote-Runden ohne Tunnel.
2. **Sprachausgabe**: Fragen/Urteile per TTS vorlesen (macOS `say` → virtuelles Audiogerät → Discord).
3. **Spracheingabe**: Voice-Channel mitschneiden, lokal transkribieren (whisper.cpp), Antworten des Spielers am Zug erkennen. Damit entfällt das Tippen.
4. **Punktejagd**: rein mechanisch (aufdecken → auflösen → weiter), kein LLM nötig. Notizen in SITE-NOTES.md.
5. **Eagle Eye**: Buzzer + Bewertung wie Tafelquiz, Lösung steht im Host-Board.
6. **Board-Generator**: Claude erstellt aus einem Thema ein komplettes Tafelquiz-Board (mit Lösungen) und trägt es im Board-Editor ein.
7. **Eigene Boards** aus dem Account (Login im persistenten Browser-Profil, dann „Eigenes Board“ im Lobby-Wizard).
8. **Resume-Sicherheit**: Fragezustand persistieren, damit ein Neustart mitten in einer Frage nicht erneut fragt.
9. **MCP-Server** (optional): Claude-Code-Session als interaktiver Host mit Tools `wait_for_event`, `decide`, `say`.
