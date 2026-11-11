---
name: quiz-host
description: Startet und betreut Claude als Host für ein Tafelquiz auf quiz-base.de (Orca-Browser oder eigener Browser). Verwenden bei "hoste ein Quiz", "sei Quiz-Host", "starte quiz-base", "Tafelquiz Lobby erstellen".
---

# Quiz-Host starten

Die Spiel-Engine (`qbhost`) leitet das Spiel selbstständig. Du startest sie nur und bleibst für Rückfragen erreichbar. Spiele das Spiel **nicht** selbst über Browser-Befehle: Das würde unnötig Tokens kosten.

1. `npm run doctor` im Repo-Root ausführen, bei ❌ dem Nutzer den Grund nennen.
2. Board klären: Wenn der Nutzer keins nennt, `npx qbhost boards` zeigen und fragen (oder er erstellt die Lobby selbst im Browser).
3. Browser wählen:
   - Orca: `orca tab create --url https://www.quiz-base.de --json` → `browserPageId`, dann `--driver orca --page <id>`.
   - Sonst Standard (eigenes Chromium-Fenster).
4. Im Hintergrund starten und die Ausgabe in eine Datei leiten:
   `npx qbhost host --driver orca --page <id> --board "<Titel>" --auto-start > .qbhost/host.log 2>&1`
5. Aus dem Log Lobby-Code und Spieler-Pult-URL an den Nutzer geben. Für Freunde außerhalb des WLANs einen Tunnel auf Port 4747 vorschlagen.
6. Danach nur auf Nachfrage ins Log schauen (`tail -20 .qbhost/host.log`). Am Ende steht dort die LLM-Verbrauchszeile.

Operator-Eingriffe (nur wenn der Nutzer es möchte) gehen über stdin des Prozesses: `r`, `f`, `skip`, `punkte <Name> <±n>`, `start`.
