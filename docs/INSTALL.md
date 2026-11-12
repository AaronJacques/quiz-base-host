# Installation

Diese Anleitung bringt qbhost von null auf einen laufenden Discord-Bot. Du brauchst ungefähr **30 Minuten**, davon die meiste Zeit für Downloads.

> **Ehrlich vorweg:** qbhost ist ein Hobbyprojekt. Der Discord-Bot und das Terminal-Spiel laufen auf **macOS** am besten getestet. **Linux** (Ubuntu/Debian) funktioniert für Bot und Spiel, die Sprachsteuerung ist dort nur mit Mehraufwand machbar. **Windows** geht nur über **WSL2**, nicht nativ.

## Übersicht

1. [Voraussetzungen](#1-voraussetzungen): Node, Git, Claude-Zugang
2. [Repo klonen und installieren](#2-repo-klonen-und-installieren)
3. [Chromium für Playwright](#3-chromium-für-playwright)
4. [`.env` und `qbhost.config.json` anlegen](#4-env-und-qbhostconfigjson-anlegen)
5. [Claude-Zugang einrichten](#5-claude-zugang-einrichten)
6. [Discord-Bot anlegen](#6-discord-bot-anlegen)
7. [Prüfen: `npx qbhost doctor`](#7-prüfen-npx-qbhost-doctor)
8. [Erster Start](#8-erster-start)
9. [Sprachsteuerung (optional)](#9-sprachsteuerung-optional)
10. [Fehlerbehebung](#10-fehlerbehebung)

---

## 1. Voraussetzungen

| Was | Version | Wofür |
|---|---|---|
| **Node.js** | **22 oder neuer** | Laufzeit. Ältere Versionen funktionieren nicht. |
| **npm** | kommt mit Node | Abhängigkeiten installieren |
| **Git** | aktuell | Repo klonen |
| **Claude-Zugang** | eine der drei Optionen unten | Bewertung unklarer Antworten |
| Discord-Account und ein Server | – | Bot-Betrieb |

**Claude-Zugang:** Du brauchst **eine** dieser Optionen. Ganz ohne geht es auch, dann prüft die Spielleitung unklare Antworten selbst.

- **A: Claude Code (Abo).** Empfohlen, wenn du ein Claude-Abo hast. Lokal eingeloggt, keine Kosten pro Aufruf.
- **B: Anthropic-API-Key.** Pro Aufruf abgerechnet. Sinnvoll für Server ohne Abo-Login.
- **C: Ohne LLM.** `"llm": { "provider": "none" }`. Alles deterministisch, unklare Antworten gehen an die Spielleitung.

### Node installieren

**macOS**

```bash
brew install node@22
```

Oder mit [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

**Ubuntu / Debian**

Die Paketquellen liefern oft ein zu altes Node. Nimm nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Terminal neu öffnen, dann:
nvm install 22
nvm use 22
```

**Windows:** In WSL2 (Ubuntu) wie oben mit nvm. Die Windows-Installation von Node ist hier nicht getestet.

Prüfen:

```bash
node -v   # v22.x.x oder höher
npm -v
```

npm meldet bei Node unter 22 eine `EBADENGINE`-Warnung. Lass dich davon nicht täuschen, die Version ist dann trotzdem zu alt.

### Windows: WSL2

Installiere WSL2 mit Ubuntu (PowerShell als Administrator):

```powershell
wsl --install -d Ubuntu
```

Danach alles in der Ubuntu-Shell ausführen, die folgenden Abschnitte gelten dann wie für Ubuntu. Der sichtbare Browser ist unter WSL nicht getestet. Falls er nicht startet, setze `"browser": { "headless": true }`. Die Sprachsteuerung ist unter WSL ebenfalls nicht getestet.

---

## 2. Repo klonen und installieren

```bash
git clone https://github.com/AaronJacques/quiz-base-host.git
cd quiz-base-host
npm ci
```

`npm ci` installiert exakt die Versionen aus `package-lock.json`. Am Ende kommt `found 0 vulnerabilities`. Beim Installieren erscheint eine Warnung `Conflicting peer dependency: opusscript@0.0.8`. Die ist harmlos, `opusscript` in `0.1.1` wird trotzdem genutzt.

**Wichtig:** Alle Befehle in diesem Abschnitt laufen im Projektordner (`quiz-base-host/`). Die Konfigurationsdatei wird relativ zum aktuellen Verzeichnis gesucht. Liegt du woanders, findet qbhost sie nicht und nutzt **still** die Standardwerte.

---

## 3. Chromium für Playwright

qbhost steuert einen eigenen Chromium, um quiz-base.de zu bedienen. Der Browser ist nicht im npm-Paket enthalten und muss einmal geladen werden (ca. 150 MB):

```bash
npx playwright install chromium
```

**Ubuntu / Debian** brauchen zusätzlich Systembibliotheken. Dann nimm:

```bash
npx playwright install --with-deps chromium
```

Wenn das fehlt, meldet `npx qbhost doctor` `❌ Playwright Chromium: browserType.launch: Executable doesn't exist …`. Die Zeile nennt keinen Befehl, also: `npx playwright install chromium` ausführen.

Alternativen zum eigenen Chromium: `--driver cdp` (dein laufender Chrome mit `--remote-debugging-port=9222`) oder `--driver orca` (Orca-IDE). Siehe [README](../README.md#ohne-discord-terminal--spieler-pult).

---

## 4. `.env` und `qbhost.config.json` anlegen

Beides ist **optional**, das Spiel läuft ohne. Für den Discord-Bot brauchst du `.env` mit dem Token.

```bash
cp .env.example .env
```

Trage in `.env` den Discord-Token ein (Schritt 6). Die Variablen sind in [`.env.example`](../.env.example) erklärt. `.env` steht in `.gitignore`, **committe sie nie** und poste den Inhalt nie in einem Issue.

Die Konfiguration ist ebenfalls optional. Wenn du etwas ändern willst:

```bash
cp qbhost.config.example.json qbhost.config.json
```

Nur die Werte angeben, die du ändern willst, den Rest ergänzt qbhost mit den Defaults. Alle Optionen erklärt [CONFIG.md](CONFIG.md).

---

## 5. Claude-Zugang einrichten

### Option A: Claude Code (Abo), lokal

Das Standard-Setup (`"llm": { "provider": "claude-cli" }`). qbhost ruft `claude -p` auf.

```bash
claude            # einmal starten und mit deinem Account anmelden (/login)
```

Prüfen: `claude --version` zeigt eine Version. Es darf kein Login-Dialog kommen.

### Option A': Claude Code auf einem Server (ohne interaktiven Login)

Auf einem Server ohne Browser nimmst du einen langlebigen Token. Auf einem Rechner mit eingeloggtem Claude Code:

```bash
claude setup-token
```

Den ausgegebenen Wert trägst du in `.env` als `CLAUDE_CODE_OAUTH_TOKEN` ein. Der Token gilt nur mit dem Claude-Abo. Behandle ihn wie ein Passwort.

### Option B: Anthropic-API-Key

1. Key in der [Anthropic Console](https://console.anthropic.com/) anlegen. Setze dort ein **Ausgabenlimit**, damit eine Schleife nichts kostet.
2. In `.env`: `ANTHROPIC_API_KEY=sk-ant-…`
3. In `qbhost.config.json`:

```json
{ "llm": { "provider": "anthropic", "model": "haiku" } }
```

Ein Spiel kostet mit Haiku meist unter 2 Cent (siehe [README](../README.md)). Die Deploy-Variante auf einem Server nutzt ebenfalls diesen Weg, siehe [DEPLOY.md](DEPLOY.md).

### Option C: ohne LLM

```json
{ "llm": { "provider": "none" } }
```

---

## 6. Discord-Bot anlegen

Die Schritte im Developer Portal stehen ausführlich in **[DISCORD.md](DISCORD.md)**, sie werden hier nicht doppelt geführt. Kurz gesagt:

1. Anwendung und Bot im [Developer Portal](https://discord.com/developers/applications) anlegen.
2. **Message Content Intent** einschalten. Ohne ihn liest der Bot keine Karten und Antworten.
3. Bot mit der generierten OAuth2-URL in deinen Server einladen. Rechte: siehe DISCORD.md.
4. Den **Token** (Reset Token) in `.env` als `DISCORD_TOKEN=…` eintragen.

Den Token kopierst du nur einmal. Wenn du ihn verlierst, setzt du ihn im Portal neu zurück.

---

## 7. Prüfen: `npx qbhost doctor`

```bash
npx qbhost doctor
```

Die Ausgabe sieht etwa so aus. ✅ ist gut, ❌ heißt: beheben oder bewusst ignorieren.

```
✅ Node: v22.x.x
✅ Discord-Token: gesetzt
✅ Claude CLI: 2.x.x (Claude Code)
❌ Orca CLI: …                      ← egal, wenn du den Orca-Browser nicht nutzt
✅ Playwright Chromium: 145.x.x
❌ Sprachsteuerung (STT/TTS lokal): … → npx qbhost voice-setup   ← egal ohne Sprache
✅ LLM (claude-cli/haiku): correct via fuzzy, correct via llm – …
```

**Was du ignorieren darfst:** Orca CLI (wenn du den Orca-Browser nicht nutzt), Sprachsteuerung (wenn du keine Sprache willst).

**Was du beheben musst:** Node-Version, Playwright-Chromium, Discord-Token (für den Bot), LLM (wenn du eines konfiguriert hast).

Der LLM-Check ruft Haiku zweimal auf. Das kostet etwa 0,04 Cent.

---

## 8. Erster Start

### Variante 1: Discord-Bot (empfohlen)

```bash
npx qbhost discord
```

Im Discord-Channel schreibst du `!quiz neu`. Der Bot fragt nach dem Quiz, erstellt die Lobby und postet den Beitrittslink. Ab hier: [DISCORD.md, Abschnitt Ablauf](DISCORD.md#3-ablauf-einer-runde).

Der Bot muss laufen, solange ihr spielt. Stoppen mit `Strg+C`.

### Variante 2: Terminal und Spieler-Pult (ohne Discord)

```bash
npx qbhost host --board "Allgemeinwissen Quiz v1" --auto-start
```

Die Spieler öffnen `http://<dein-rechner>:4747` und wählen dort Karten. Du steuerst im Terminal (`r`, `f`, `skip`, `hilfe`). Details im [README](../README.md#ohne-discord-terminal--spieler-pult).

### Test ohne Spielbetrieb

Die Tests brauchen keinen Discord-Token und keinen Netzwerkzugriff:

```bash
npm test
npm run typecheck
```

---

## 9. Sprachsteuerung (optional)

Die Sprachsteuerung ist der aufwendigste Teil: Sie braucht whisper.cpp (Spracherkennung), ein Sprachmodell von ca. 550 MB und Piper (Stimme). Alles läuft lokal.

`npx qbhost voice-setup` lädt das Whisper-Modell und die Piper-Stimme und richtet Piper in einer eigenen Python-Umgebung ein. whisper.cpp selbst installiert es nur auf **macOS** (über Homebrew). Unter **Linux** baust du `whisper-server` einmal selbst und legst es in den `PATH`, danach erledigt der Befehl den Rest:

```bash
sudo apt install build-essential cmake git python3-venv
git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp
cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
cmake --build whisper.cpp/build -j --target whisper-server
sudo install -m 755 whisper.cpp/build/bin/whisper-server /usr/local/bin/
```

Am einfachsten ist unter Linux das Docker-Image aus [DEPLOY.md](DEPLOY.md), dort ist alles schon enthalten.

**Modellgröße:** Standard ist `large-v3-turbo` (550 MB, beste Erkennung, braucht eine schnelle CPU oder einen Apple-Chip). Auf schwachen Rechnern oder kleinen Servern ist `"voice": { "whisperModel": "models/ggml-small-q5_1.bin" }` (190 MB) deutlich schneller. Noch schneller: ein zweites, kleines Modell für alles außer Antworten und ein kleineres Audiofenster (`whisperFastModel`, `whisperAudioCtx`, siehe [DEPLOY.md](DEPLOY.md#kleine-server)). `voice-setup` lädt jedes offizielle `ggml-*.bin`-Modell automatisch.

Auf macOS:

```bash
npx qbhost voice-setup       # einmalig: whisper.cpp, Modelle (~700 MB), Piper, Selbsttest
npm run doctor              # „Sprachsteuerung (STT/TTS lokal)“ muss ✅ sein
```

Ohne Piper geht es mit der macOS-Stimme: `"voice": { "tts": "say" }`.

Danach im Discord-Voice-Channel `!quiz neu` tippen, der Bot kommt dazu. Alles Weitere: **[VOICE.md](VOICE.md)**.

Datenschutz: Der Bot hört nur zu, solange er im Voice-Channel ist, speichert keine Aufnahmen und postet nur Sätze, auf die er reagiert. Details in [VOICE.md](VOICE.md#datenschutz).

---

## 10. Fehlerbehebung

Die Punkte sind nach dem Aufwand sortiert, den sie machen, nicht nach Häufigkeit. Die meisten Probleme stehen hier, weil sie beim Testen auf einem frischen Klon auftraten.

### `npx qbhost` oder `npm ci` schlägt mit `EBADENGINE` fehl

Node ist älter als 22. `node -v` prüfen, siehe Abschnitt 1.

### `❌ Playwright Chromium: browserType.launch: Executable doesn't exist`

Der Browser fehlt. `npx playwright install chromium` ausführen. Unter Ubuntu/Debian: `npx playwright install --with-deps chromium`.

### `❌ Claude CLI: spawn claude ENOENT`

Die Claude-CLI ist nicht im `PATH`. Claude Code installieren (siehe [claude.com/claude-code](https://claude.com/claude-code)) und `claude --version` testen. Oder einen anderen Anbieter wählen (Abschnitt 5).

### Der Bot antwortet nicht im Channel

- Message Content Intent im Developer Portal aktiviert? (Ohne ihn liest der Bot keine Nachrichten.)
- Liegt `discord.channelIds` in der Konfiguration? Dann reagiert der Bot nur dort. Die Channel-ID muss stimmen.
- Der Bot hat die Rechte `View Channels` und `Send Messages` im Channel?

### Einstellungen aus `qbhost.config.json` greifen nicht

Die Datei muss im Projektordner liegen, aus dem du qbhost startest. Ein Tippfehler im Schlüssel wird **nicht** gemeldet, sondern ignoriert. Prüfe die Schreibweise in [CONFIG.md](CONFIG.md).

### `❌ Sprachsteuerung … whisper-server fehlt` oder `Piper-Umgebung fehlt`

- macOS: `voice-setup` installiert whisper.cpp über Homebrew (`brew install whisper.cpp`).
- Linux: whisper.cpp wie in [Abschnitt 9](#9-sprachsteuerung-optional) bauen, `whisper-server` in den `PATH` legen oder den Pfad in `voice.whisperBin` setzen.
- `python3 -m venv` schlägt auf Debian/Ubuntu oft fehl, weil das Paket `python3-venv` fehlt: `sudo apt install python3-venv`.
- Nicht getestet ist die Einrichtung unter Linux insgesamt. Wenn es hakt: `voice.enabled: false` setzen, dann läuft der Bot ohne Sprache.

### `DISCORD_TOKEN fehlt` beim Start des Bots

`.env` muss im Projektordner liegen und `DISCORD_TOKEN=<token>` mit dem Token nach dem `=` enthalten. Ein leerer Wert gilt als nicht gesetzt. Nach einer Änderung an `.env` den Bot neu starten.

### Die Bewertung bleibt bei unklaren Antworten hängen

Das LLM braucht Zeit, Standard-Zeitlimit ist 30 s (`llm.timeoutMs`). Bei `claude-cli` prüfen, ob `claude -p "hallo"` im Terminal antwortet. Bei `anthropic` den Key und das Ausgabenlimit prüfen.

### Der sichtbare Browser startet nicht unter WSL2

Nicht getestet. Vermutlich fehlt eine Grafikausgabe (WSLg). Setze dann `"browser": { "headless": true }`.

### `Lobby wurde nicht gestartet` nach 20 Minuten

Standard-Timeout (`discord.lobbyTimeoutMin`). Bei Bedarf erhöhen.

---

Hängst du fest? Bitte ein [Issue](https://github.com/AaronJacques/quiz-base-host/issues/new/choose) mit der Ausgabe von `npx qbhost doctor` öffnen. Dabei keine Tokens einfügen.
