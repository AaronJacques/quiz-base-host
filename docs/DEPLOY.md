# Betrieb auf einem VPS (CI/CD)

Der Discord-Bot läuft dauerhaft auf einem VPS als **Docker-Container**. Jeder Push auf `main` wird getestet und, wenn die Tests grün sind, automatisch ausgerollt.

```
Push auf main ──► GitHub Actions: Typecheck + Tests
                     │ grün
                     ▼
                  Deploy-Job ──ssh──► VPS (User deploy)
                                       /opt/quizmaster/app.new  ← git archive des Commits
                                       deploy/remote-deploy.sh:
                                         1. docker compose build   (der alte Bot läuft weiter)
                                         2. app.new → app, app → app.prev
                                         3. docker compose up -d   (Bot startet neu)
                                         4. wartet auf „Bereit.“ im Log
                                            sonst Rollback auf app.prev
```

Das Image wird **auf dem VPS selbst** gebaut. So wird whisper.cpp für genau diese CPU kompiliert, und es braucht keine Container-Registry. Unveränderte Schichten (Chromium, whisper.cpp, Piper, `node_modules`) kommen aus dem Docker-Cache. Deshalb dauert ein normales Deploy nur wenige Sekunden, nur der allererste Build etwa 5–10 Minuten.

Im Image steckt alles, was der Bot braucht:
- Node, Playwright-Chromium headless
- whisper.cpp `whisper-server`
- Piper (`/opt/piper`)

Die Bewertung läuft auf dem Server über die Anthropic-API (`llm.provider: "anthropic"`), eine Claude CLI ist im Image nicht nötig.

## Aufbau auf dem Server

| Pfad (`/opt/quizmaster`) | Inhalt | Wer schreibt |
|---|---|---|
| `.env` | `DISCORD_TOKEN` und `ANTHROPIC_API_KEY` | einmalig von Hand, Besitzer `deploy`, Rechte 600 |
| `qbhost.config.json` | Server-Konfiguration, Vorlage: `deploy/qbhost.config.server.example.json` (`headless: true`!) | einmalig von Hand |
| `data/` | `.qbhost` des Containers: Browser-Profil, Bewertungs-Cache, Discord-Verknüpfungen, Sprachmodelle (~700 MB) | Bot |
| `app/`, `app.prev/` | aktuelles und voriges Release | CI |

Der Container läuft als Benutzer `deploy`, nicht als root, ohne Linux-Capabilities (`cap_drop: ALL`) und mit `no-new-privileges`. Es sind keine Ports offen, der Bot baut nur ausgehende Verbindungen auf (Discord, quiz-base, Anthropic).

## Einmalige Einrichtung

1. **Server:** Ubuntu LTS, Docker Engine mit Compose-Plugin, Benutzer `deploy` in der Gruppe `docker`, Ordner `/opt/quizmaster` mit `data/` (Besitzer `deploy`).
2. **Secrets und Konfiguration auf den Server.** Sie verlassen deinen Rechner nur in Richtung deines eigenen Servers:
   ```bash
   scp .env deploy@<VPS>:/opt/quizmaster/.env && ssh deploy@<VPS> chmod 600 /opt/quizmaster/.env
   # Server-Konfiguration aus der Vorlage (headless: true, deine Channel-IDs) anlegen und kopieren:
   scp qbhost.config.server.json deploy@<VPS>:/opt/quizmaster/qbhost.config.json
   ```
   Die Server-`.env` braucht `DISCORD_TOKEN=…` und `ANTHROPIC_API_KEY=…`. Am besten nimmst du für den Server einen **eigenen API-Key** mit Ausgabenlimit (Anthropic Console → eigener Workspace → Limits). Bei Haiku kostet ein Spiel meist unter 2 Cent, das Limit schützt bei einem Leck.
3. **GitHub** (Repo → Settings → Secrets and variables → Actions):

   | Name | Art | Wert |
   |---|---|---|
   | `VPS_HOST` | Secret | IP oder Hostname |
   | `VPS_SSH_KEY` | Secret | privater Schlüssel, der nur für `deploy@VPS` gilt |
   | `VPS_KNOWN_HOSTS` | Secret | Ausgabe von `ssh-keyscan -t ed25519 <VPS>` |
   | `DEPLOY_ENABLED` | Variable | `true` (ohne diese Variable laufen nur die Tests) |

   Per CLI: `gh secret set VPS_SSH_KEY < ~/.ssh/quizmaster_deploy` usw., dazu `gh variable set DEPLOY_ENABLED --body true`.
4. **Erstes Deploy:** Actions → CI/CD → „Run workflow“ oder ein Push auf `main`. Beim ersten Start lädt der Container die Sprachmodelle, das dauert ein paar Minuten (der Deploy wartet bis zu 15 Minuten).

> ⚠️ **Nur eine Instanz pro Discord-Token.** Läuft der Bot gleichzeitig lokal (`npx qbhost discord`) und auf dem Server, antworten beide. Lokal zum Entwickeln einen eigenen Test-Bot oder Test-Channel verwenden.

## Bedienung

```bash
ssh quizmaster-vps                                          # Admin-Zugang
cd /opt/quizmaster && export QBHOST_HOME=$PWD
docker compose -f app/deploy/compose.yml logs -f bot        # Logs live
docker compose -f app/deploy/compose.yml restart bot        # Neustart
docker compose -f app/deploy/compose.yml exec bot node_modules/.bin/tsx src/cli.ts doctor   # Selbstdiagnose
```

- **Deploy während eines Spiels:** Ein laufendes Spiel wird beim Neustart beendet (der Bot hat 40 s, es auf quiz-base sauber zu schließen). Pushes auf `main` also nicht mitten in einer Runde.
- **Rollback von Hand:** `mv app app.bad && mv app.prev app && docker image tag quizmaster:prev quizmaster:latest && docker compose -f app/deploy/compose.yml up -d --no-build`
- **Kleine Server:** Mit 1–2 vCPU ist das Standardmodell `large-v3-turbo` zu langsam. Die Vorlage nutzt deshalb `ggml-small-q5_1.bin` (190 MB). Auf stärkeren Servern kann `whisperModel` wieder auf `models/ggml-large-v3-turbo-q5_0.bin` gesetzt werden. Danach `data/voice/.ready` löschen, damit das neue Modell geladen wird.
- **Sprachsteuerung aus:** `QBHOST_VOICE_SETUP=off` in die `.env` (keine Modell-Downloads) und `"voice": { "enabled": false }` in die Konfiguration.
- **Updates des Servers:** Sicherheitsupdates laufen automatisch (unattended-upgrades). Neue Versionen von Chromium, whisper.cpp und Claude CLI kommen über `deploy/Dockerfile`: Version anheben, pushen.
