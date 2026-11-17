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
- **quiz-base-Anmeldung für eigene Boards:** vom Mac aus mit `npx qbhost login --server quizmaster-vps`, siehe [unten](#quiz-base-anmeldung-auf-dem-server).
- **Sprachsteuerung aus:** `QBHOST_VOICE_SETUP=off` in die `.env` (keine Modell-Downloads) und `"voice": { "enabled": false }` in die Konfiguration.
- **Updates des Servers:** Sicherheitsupdates laufen automatisch (unattended-upgrades). Neue Versionen von Chromium, whisper.cpp und Claude CLI kommen über `deploy/Dockerfile`: Version anheben, pushen.

## quiz-base-Anmeldung auf dem Server

Eigene Boards (`!quiz erstellen`, Lobbys mit eigenen Boards) brauchen ein quiz-base-Konto. Auf dem Server gibt es kein Browserfenster, und der SSH-Server erlaubt keine Port-Weiterleitung (`ssh -L` geht nicht). Deshalb baut `qbhost` den Weg selbst: Du meldest dich **in deinem eigenen Chrome auf dem Mac** an, die Seite läuft aber im Browser auf dem Server. Die Sitzung entsteht direkt auf dem Server, kein Token wird kopiert. Danach braucht der Bot den Mac nicht mehr.

```
Chrome (chrome://inspect) ─► 127.0.0.1:9223 auf dem Mac ─► ssh quizmaster-vps ─► Login-Container ─► Chromium (DevTools-Port nur im Container)
```

### Anmelden

Voraussetzungen:
- Der Server läuft mit einem Stand, der `login --remote-stdio` kennt (ab diesem Release, also erst deployen).
- Der SSH-Benutzer (`admin`) darf `sudo -n docker …` ohne Passwort und hat eine POSIX-Login-Shell (bash, dash, zsh; nicht csh/tcsh).
- Kein Push auf `main` während der Anmeldung (siehe unten).

Auf dem Mac im Repo-Ordner:

```bash
npx qbhost login --server quizmaster-vps
```

1. Rückfrage „Der Bot wird für die Anmeldung kurz gestoppt; ein laufendes Spiel bricht dabei ab. Jetzt stoppen? [j/N]“: mit `j` bestätigen, wenn gerade niemand spielt. Ohne Rückfrage: `--yes`. Vorher prüft qbhost den Port auf dem Mac und auf dem Server Image, Konfiguration und Profilordner. Scheitert etwas davon, bleibt der Bot unberührt.
2. Warten, bis `🔐 Tunnel steht: 127.0.0.1:9223 …` erscheint (der Server stoppt den Bot und startet den Login-Browser, ~10–20 s).
3. In Chrome `chrome://inspect` öffnen.
4. Nur beim ersten Mal: neben „Discover network targets“ auf **Configure…** klicken, **`127.0.0.1:9223`** eintragen (genau so, nicht `localhost:9223`: Unter `localhost` könnte ein anderes Programm über IPv6 antworten), **Done**. Chrome merkt sich das.
5. Unter **Remote Target** erscheint `127.0.0.1:9223` mit „Quiz-Base – Multiplayer Quiz …“. Darunter auf **inspect** klicken.
6. Es öffnet sich ein DevTools-Fenster, links siehst du die Seite vom Server mit dem offenen Anmelde-Dialog. Ist sie zu klein, zieh die Trennlinie nach rechts. Fehlt die Seite, klick oben links auf das Bildschirm-Symbol „Toggle screencast“.
7. In dieser Seite selbst E-Mail und Passwort eingeben und **Anmelden** klicken. Den rechten DevTools-Teil brauchst du nicht.
8. qbhost erkennt die Anmeldung und schließt den Tunnel. Das DevTools-Fenster meldet dann „disconnected“, es kann zu. Am Ende stehen `✅ Der Bot ist bei quiz-base angemeldet.`, `▶ Bot läuft wieder.` und `✔ Kontrolle: Der Bot läuft.` War der Bot schon vor dem Aufruf aus (z. B. absichtlich), bleibt er aus, und die Kontrolle sagt `Der Bot war vorher aus und bleibt aus.` Gestartet wird er dann nicht, etwa damit nicht zwei Bots mit demselben Discord-Token laufen.

Abbrechen geht jederzeit mit **Strg+C**: Der Port auf dem Mac schließt sofort, der Server schließt den Browser sauber und startet den Bot wieder. Ein zweites Strg+C bricht hart ab, der Server räumt trotzdem auf. Spätestens nach 15 Minuten ist alles von selbst zu. `--port <n>` wählt einen anderen Port auf dem Mac, falls 9223 belegt ist; dann in Schritt 4 `127.0.0.1:<n>` eintragen.

### Was dabei passiert und wer was sieht

- **Server:** Image, Benutzer, Daten- und Konfigurationspfad liest das Skript aus dem Bot-Container selbst (`docker inspect`), den Profilordner aus der Bot-Konfiguration (`browser.profileDir`, muss in `data/` liegen, nicht in `data/home` oder `data/voice`). Der Profilordner darf keine `.`- oder `..`-Teile enthalten und nicht über einen Symlink erreichbar sein; sonst bricht das Skript ab, bevor es etwas ändert. Dann wird der Bot gestoppt, damit nicht zwei Browser dasselbe Profil benutzen. Bis er wieder läuft, steht seine Neustart-Regel auf `always`: Startet der Server oder Docker mitten in der Anmeldung neu, startet der Bot trotzdem wieder. Danach gilt wieder `unless-stopped`; scheitert das Zurücksetzen, sagt das Skript es mit dem Befehl dafür. **Ausnahme live-restore:** Ist in Docker `live-restore` aktiv (`docker info` zeigt „Live Restore Enabled: true“) oder lässt sich das nicht feststellen, bleibt die Regel unverändert. Mit live-restore überlebt der Login-Container einen Neustart von Docker, und `always` würde den Bot daneben starten: Dann liefen zwei Browser auf einem Profil. In diesem Fall bleibt der Bot nach einem Server-Neustart mitten in der Anmeldung aus, und die Kontrolle am Ende meldet es.
- **Login-Container** (`docker run --rm`, Name `qbhost-login`):
  - Headless Chromium mit dem Bot-Image.
  - **Nur der Profilordner** (`data/profile`) ist eingehängt und beschreibbar.
  - Die Konfiguration ist nur lesbar eingehängt; sie enthält keine Geheimnisse.
  - Das Dateisystem des Images ist schreibgeschützt (`--read-only`).
  - HOME, Downloads und Temp-Dateien liegen im Arbeitsspeicher (tmpfs) und verschwinden mit dem Container.
  - Der Rest von `data/` (HOME des Bots, Board-Register, Verknüpfungen, Bewertungs-Cache, Sprachmodelle) ist im Login-Container nicht sichtbar.
  - Er bekommt **keine** `.env` (keine Tokens) und keine Linux-Capabilities, öffnet keinen Port nach außen und schreibt **kein Container-Log** (`--log-driver none`).
  - Der DevTools-Port hängt nur an 127.0.0.1 *im* Container; andere Container und Benutzer auf dem Server erreichen ihn nicht.
  - Das Profil gehört danach wie vorher dem Benutzer des Bots.
- **Ende:** Anmeldung erkannt, Strg+C, Verbindung weg oder 15 Minuten um. Dann wird der Container erst sauber gestoppt (`docker stop`), nötigenfalls hart beendet (`timeout -k`) und entfernt. Danach wird der Bot gestartet, wenn er vorher lief. Zum Schluss fragt qbhost über eine zweite SSH-Verbindung nach, ob der Bot wirklich läuft, und sagt sonst, wie man ihn startet.
- **Das Skript** für den Server schickt dein Mac bei jedem Aufruf mit (`tools/server-login.sh` aus deinem Repo). Auf dem Server wird nichts aus dem Release-Ordner ausgeführt. Es ruft nur `sudo -n docker …` auf.
- **SSH:** Die Verbindung leitet nichts weiter, auch wenn deine `~/.ssh/config` es für den Host vorsieht: kein ssh-Agent, kein X11, keine Ports, kein `LocalCommand`, keine geteilte Master-Verbindung.
- **Deine Tastendrücke** gehen diesen Weg: Chrome-DevTools auf dem Mac → 127.0.0.1:9223 (qbhost leitet die Bytes nur weiter, ohne sie zu lesen oder zu speichern) → SSH (verschlüsselt) → Docker → Chromium im Container → quiz-base (HTTPS). qbhost gibt selbst nichts in die Seite ein und liest keine Formularfelder. Erkannt wird die Anmeldung wie beim lokalen `qbhost login` nur an der Beschriftung im Benutzermenü.
- **Ehrliche Grenzen:**
  - Solange der Tunnel steht (höchstens 15 Minuten), kann **jedes Programm, das 127.0.0.1:9223 auf deinem Mac erreicht**, den Server-Browser fernsteuern. Das sind deine eigenen Programme, andere Benutzer des Macs, Apps mit Netzwerkzugriff und eventuell Docker-Desktop-Container. Wer das tut, kann die quiz-base-Sitzung benutzen oder austauschen (z. B. den Bot mit einem *eigenen* quiz-base-Konto anmelden, sodass deine Boards samt Lösungen dort landen). Er kann Seiten aufrufen, die Konfiguration lesen und das Profil verändern, also Cookies, Seitenspeicher, Cache und Service Worker der quiz-base-Seite (quiz-base registriert einen, `sw.js`). **Das wirkt beim Bot weiter**, bis du dich abmeldest (`--logout`), denn der Bot benutzt genau dieses Profil. An Discord-Token, API-Keys und den Rest von `data/` kommt er darüber nicht: Sie sind im Login-Container nicht vorhanden. Programme startet der Bot aus dem Profil nicht (keine Erweiterungen, Playwright startet Chromium mit `--disable-extensions`, Node lädt nichts von dort). Webseiten in deinem Browser können den Port nicht benutzen, Chromium prüft Host und Origin. Führ währenddessen nichts Fremdes aus. Kommt dir ein Lauf verdächtig vor: `--logout` und neu anmelden.
  - **Wer root (oder Docker-Rechte) auf dem Server hat**, kann während der Anmeldung mitlesen und das Profil später jederzeit lesen. Das gilt für das gespeicherte Profil aber ohnehin.
  - Das DevTools-Fenster zeigt im Netzwerk-Tab auch die Anmeldeanfrage. Teile davon keine Screenshots.
- Die Anmeldung bleibt im Profil `data/profile`, bis quiz-base sie beendet oder du dich abmeldest.

### Abmelden (Rückweg)

```bash
npx qbhost login --server quizmaster-vps --logout
```

Das stoppt den Bot kurz, löscht den Profilordner des Bots auf dem Server und startet den Bot wieder. Danach gehen nur noch öffentliche Boards. Ob quiz-base die Sitzung damit auch auf seiner Seite beendet, ist nicht geprüft. Wer sichergehen will, ändert danach sein quiz-base-Passwort.

### Wenn etwas schiefgeht

- **`Server-Stand zu alt … erst deployen`:** Das Image auf dem Server kennt den Login über den Tunnel noch nicht. Pushen bzw. deployen, dann noch einmal. Der Bot wurde dabei nicht gestoppt (bzw. läuft wieder).
- **`Port 9223 ist auf dem Mac belegt` bzw. `Auf [::1]:9223 lauscht schon ein anderes Programm`:** `--port 9224` angeben und in `chrome://inspect` `127.0.0.1:9224` eintragen.
- **Unter „Remote Target“ steht nichts:** Läuft `npx qbhost login --server …` noch? Ist unter „Configure…“ `127.0.0.1:<Port>` eingetragen und „Discover network targets“ angehakt?
- **Deploy während der Anmeldung:** Ein Push auf `main` startet den neuen Bot, während der Login-Browser noch dasselbe Profil benutzt. Das Skript erkennt das am Ende („Während der Anmeldung wurde neu deployt …“) und startet den alten Container nicht mehr. Die Anmeldung danach sicherheitshalber wiederholen. Besser: während der Anmeldung nicht pushen und keine Worker-Branches mergen.
- **Server oder Docker mitten in der Anmeldung neu gestartet:** Der Bot startet wegen der Regel `always` von selbst wieder (bei live-restore nicht, siehe oben); die Anmeldung ist verloren und muss wiederholt werden. Die Neustart-Regel bleibt dann bis zum nächsten Deploy auf `always`. Die nächste Kontrolle meldet das. Zurück von Hand: `sudo docker update --restart unless-stopped <Bot-Container>`.
- **`⚠️ Neustart-Regel … steht noch auf "always"`** bzw. **`blieb auf "always"`:** den genannten `docker update`-Befehl auf dem Server ausführen.
- **`⚠️ Der Bot lief vorher und läuft jetzt nicht`** (die Kontrolle am Ende sagt, mit welchem Befehl man ihn startet), oder du willst selbst nachsehen:
  ```bash
  ssh quizmaster-vps
  sudo docker ps -a --filter label=com.docker.compose.service=bot   # Status
  sudo docker rm -f qbhost-login                                     # Login-Container, falls noch da
  sudo docker start quizmaster-bot-1                                 # Bot starten (Name aus der ersten Zeile)
  ```
- **`Nicht angemeldet`:** Die Anmeldung wurde nicht erkannt, z. B. wegen eines falschen Passworts oder weil die Zeit um war. Einfach noch einmal starten.

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

Zusammen ~1,9–2,2 GB, mit Chromium bis ~2,7 GB, also etwa 0,5 GB mehr als `small` + `base` (~0,35 + 0,2 GB). Startet der Parakeet-Worker neu (Hänger, Absturz), wird der alte vorher hart beendet; gemessen lagen nie zwei Worker gleichzeitig im Speicher, für einen kurzen Moment kann der Speicher des alten aber noch belegt sein, während der neue lädt. Der neue Worker braucht ~3–5 s; so lange hört `base` die Antworten. Auf 1 vCPU teilen sich Erkennung, Piper und Chromium den Kern: unter Last etwa doppelte Zeiten.

*Kaltstart nach einem Server-Neustart:* Dann liegt das Modell nicht im Seitencache, und der erste Start des Workers dauerte gemessen **53 s** (danach 9 s, 3–4 s; nach einem Neustart nur des Containers 3 s). Der Bot liest die Modelldateien deshalb beim Start einmal im Hintergrund (`parakeet.preload: "cache"`, Log „Parakeet-Modell vorgewärmt (… MB in … s)“), und bis Parakeet bereit ist, hört `base` die Antworten – niemand wartet. **Auf 1 vCPU `"parakeet": { "preload": "start" }` setzen** (Worker schon beim Bot-Start laden, ständig ~0,9 GB): `cache` reicht dort nicht. Am 17.11.2026 kam der erste Voice-Beitritt 9,5 Stunden nach dem Vorwärmen; der Worker brauchte trotzdem 55 s (36 s davon Rechenzeit) und belegte den Kern. In dieser Zeit lieferte Piper 10 s lang keinen Ton, whisper-server war erst nach 20 s bereit, die Lobby baute sich zäh auf, Befehle reagierten kaum – „niemand wartet“ gilt nur für die Erkennung, nicht für den Kern. Mit `start` lädt der Worker direkt nach dem Bot-Start (gemessen 3 s) und ist beim Beitritt längst bereit. Messen: `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches` (leert den Seitencache), Container neu starten, im Log die Zeit von „Parakeet-Modell vorgewärmt“ und beim ersten Voice-Beitritt „Parakeet bereit (… s)“ ablesen; Antworten davor tragen in der `⏱`-Zeile `rueckfall=ja`.

Messen, bevor man umstellt: am besten **nicht während eines Spiels**. Neben dem laufenden whisper-Bot liegen dann zusätzlich Parakeet (~0,9 GB), ein zweites Piper aus dem Selbsttest und ein zweiter Node-Prozess im RAM (zusammen grob 3,0–3,5 GB), und das Entpacken (bzip2, 487 MB) und Laden des Modells belegen den einen Kern für ein bis zwei Minuten. So geht es: eine Kopie der Konfiguration mit `"localStt": "parakeet"` als `data/probe.json` ablegen, dann `docker compose -f app/deploy/compose.yml exec bot node_modules/.bin/tsx src/cli.ts voice-setup --config .qbhost/probe.json` (lädt nur das Modell nach) und `… exec bot node_modules/.bin/tsx tools/stt-probe.ts --local parakeet <wav…>` (Zeiten, Kaltstart, RAM). Zurück: Zeile entfernen und neu starten. Details: [VOICE.md](VOICE.md#parakeet-statt-whispercpp).

Auf stärkeren Servern `whisperFastModel` und `whisperAudioCtx` weglassen und `whisperModel` wieder auf `models/ggml-large-v3-turbo-q5_0.bin` setzen.
