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
- **Kleine Server:** siehe [unten](#kleine-server). Nach einer Änderung von `qbhost.config.json` prüft der Container beim nächsten Start die Sprachmodelle und lädt neue nach (vorhandene werden übersprungen). Erzwingen: `data/voice/.ready` löschen.
- **Sprachsteuerung aus:** `QBHOST_VOICE_SETUP=off` in die `.env` (keine Modell-Downloads) und `"voice": { "enabled": false }` in die Konfiguration.
- **Updates des Servers:** Sicherheitsupdates laufen automatisch (unattended-upgrades). Neue Versionen von Chromium, whisper.cpp und Claude CLI kommen über `deploy/Dockerfile`: Version anheben, pushen.

## Kleine Server

Mit 1–2 vCPU ist das Standardmodell `large-v3-turbo` für die Spracherkennung zu langsam. Gemessen auf 1 vCPU mit whisper-server v1.9.5, warm, je 2–3 s Sprache:

| Modell | Audiofenster | Zeit pro Äußerung | Erkennung |
|---|---|---|---|
| `small-q5_1` | voll (`whisperAudioCtx: 0`) | ~12,5 s | gut |
| `small-q5_1` | `-ac 512` | ~4 s | gut |
| `base-q5_1` | `-ac 512` | ~1,1 s | Befehle und Karten gut, Namen schlecht („George Washington“ → „Deutsch-Warschimtung“) |

Die Vorlage `deploy/qbhost.config.server.example.json` kombiniert deshalb zwei Modelle: `base-q5_1` (60 MB) hört alles außer Antworten, also Kartenwahl, „Quizmaster …“, Ja/Nein und „Hier!“. `small-q5_1` (190 MB) hört nur gesprochene Antworten. Beide laufen mit `whisperAudioCtx: 512`, eine Äußerung darf dann höchstens ~10 s lang sein (Details: [VOICE.md](VOICE.md#zwei-modelle-für-langsame-rechner)):

```json
"voice": { "enabled": true, "whisperModel": "models/ggml-small-q5_1.bin", "whisperFastModel": "models/ggml-base-q5_1.bin", "whisperAudioCtx": 512 }
```

**Antworten mit Parakeet (optional):** `"localStt": "parakeet"` in die `voice`-Einstellung oben. Dann hört NVIDIA Parakeet (sherpa-onnx, im Image vorinstalliert) gesprochene Antworten in ~0,4 s statt ~4,7 s und erkennt Namen besser; `base-q5_1` hört weiter alles andere, `small-q5_1` wird nicht mehr gestartet. Beim nächsten Start lädt der Container das Modell einmalig (487 MB Download, 640 MB auf dem Volume, kurzzeitig beides). Befehle der antwortenden Person („Quizmaster, wiederhole die Frage“) hören Parakeet und danach `base` (~0,4 + 1,3 s), Antworten nur Parakeet.

*Speicher und CPU im Mischbetrieb* (3,8 GB, 1 vCPU), gleichzeitig im RAM:

| Prozess | RAM |
|---|---|
| Parakeet-Worker, 1 Thread (`parakeet.threads` 0 = 1 auf 1 vCPU) | ~0,9 GB (Server-Messung; macOS zeigt 1,5 GB, mit 4 Threads 2,0 GB) |
| whisper-server `base-q5_1`, `-ac 512` | ~0,2 GB |
| Piper `thorsten-high` | ~0,25 GB |
| Chromium (quiz-base) und Node-Bot | grob 0,5–0,8 GB (nicht gemessen) |

Zusammen ~1,9–2,2 GB, mit Chromium bis ~2,7 GB, also etwa 0,5 GB mehr als `small` + `base` (~0,35 + 0,2 GB). Startet der Parakeet-Worker neu (Hänger, Absturz), wird der alte vorher hart beendet; gemessen lagen nie zwei Worker gleichzeitig im Speicher, für einen kurzen Moment kann der Speicher des alten aber noch belegt sein, während der neue lädt. Der neue Worker braucht ~5 s Kaltstart, die wartende Äußerung kommt danach dran. Auf 1 vCPU teilen sich Erkennung, Piper und Chromium den Kern: unter Last etwa doppelte Zeiten.

Messen, bevor man umstellt: am besten **nicht während eines Spiels**. Neben dem laufenden whisper-Bot liegen dann zusätzlich Parakeet (~0,9 GB), ein zweites Piper aus dem Selbsttest und ein zweiter Node-Prozess im RAM (zusammen grob 3,0–3,5 GB), und das Entpacken (bzip2, 487 MB) und Laden des Modells belegen den einen Kern für ein bis zwei Minuten. So geht es: eine Kopie der Konfiguration mit `"localStt": "parakeet"` als `data/probe.json` ablegen, dann `docker compose -f app/deploy/compose.yml exec bot node_modules/.bin/tsx src/cli.ts voice-setup --config .qbhost/probe.json` (lädt nur das Modell nach) und `… exec bot node_modules/.bin/tsx tools/stt-probe.ts --local parakeet <wav…>` (Zeiten, Kaltstart, RAM). Zurück: Zeile entfernen und neu starten. Details: [VOICE.md](VOICE.md#parakeet-statt-whispercpp).

Auf stärkeren Servern `whisperFastModel` und `whisperAudioCtx` weglassen und `whisperModel` wieder auf `models/ggml-large-v3-turbo-q5_0.bin` setzen.
