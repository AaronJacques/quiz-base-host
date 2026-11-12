# Konfiguration

Diese Seite listet alle Einstellungen. Die Quelle ist [`src/config.ts`](../src/config.ts) (Zod-Schema mit Defaults). Die zur Laufzeit änderbaren Spielregeln stehen in [`src/modes/tafelquiz/rules.ts`](../src/modes/tafelquiz/rules.ts).

## So funktioniert die Konfiguration

Es gibt drei Ebenen, die spätere überschreiben:

1. **Defaults** aus `src/config.ts`. Ohne Konfigurationsdatei läuft alles.
2. **`qbhost.config.json`** im Projektordner (gitignored). Vorlage: [`qbhost.config.example.json`](../qbhost.config.example.json).
   Nur die Optionen angeben, die du ändern willst. Der Rest bleibt auf dem Default.
3. **CLI-Optionen**, z.B. `--driver orca --page 12`. Sie gewinnen gegen die Datei.

Eine andere Datei wählst du mit `--config <datei>`.

**Ungültige Werte** bricht qbhost beim Start mit einer Zod-Fehlermeldung ab. Tippfehler im Schlüsselnamen werden **nicht** gemeldet, sie werden einfach ignoriert. Wenn eine Option „nichts bewirkt“, prüfe die Schreibweise hier.

**Geheimnisse gehören nicht in die Datei.** Token und API-Keys kommen aus `.env` (siehe [INSTALL.md](INSTALL.md#4-env-und-qbhostconfigjson-anlegen)). Der Discord-Token wird über `discord.tokenEnv` gelesen, nicht direkt aus der Datei.

## `baseUrl`

| Option | Default | Bedeutung |
|---|---|---|
| `baseUrl` | `https://www.quiz-base.de` | Basis-URL der Plattform. Nur ändern, wenn quiz-base umzieht oder du eine Testinstanz nutzt. |

## `browser`

Steuert den Browser, auf dem die Host-Ansicht von quiz-base läuft.

| Option | Default | Bedeutung |
|---|---|---|
| `driver` | `playwright` | `playwright` = eigener Chromium, `orca` = Orca-Built-in-Browser, `cdp` = laufender Chrome mit `--remote-debugging-port`. |
| `headless` | `false` | `true` = Browser unsichtbar. Standard ist sichtbar, damit du zusehen kannst. Die Beispiel-Datei setzt `true`. |
| `profileDir` | `.qbhost/profile` | Persistentes Browser-Profil, damit ein quiz-base-Login erhalten bleibt. |
| `cdpUrl` | `http://127.0.0.1:9222` | Nur für `driver: "cdp"`. |
| `orcaPageId` | – | Nur für `driver: "orca"`: vorhandene `browserPageId` nutzen statt einen neuen Tab zu öffnen. CLI: `--page <id>`. |
| `orcaBin` | `orca` | Pfad zur Orca-CLI. |
| `pollMs` | `500` | Abfrageintervall der Seite in Millisekunden (mindestens 100). |

## `game`

Ablauf und Punkte des Tafelquiz. Die Punkteregeln sind **pro Server zur Laufzeit änderbar** (siehe [Spielregeln](#spielregeln-zur-laufzeit-änderbar)).

| Option | Default | Bedeutung |
|---|---|---|
| `publicBoard` | – | Board, das automatisch als Lobby erstellt wird (Titel wie bei „Öffentliches Board verwenden“). Leer = Lobby manuell erstellen. CLI: `--board "<Titel>"`. Im Discord-Bot ohne Wirkung, dort wählt man das Quiz im Chat. |
| `minPlayers` | `2` | Mindestzahl Spieler, bevor das Spiel startet. |
| `autoStart` | `false` | Spiel automatisch starten, sobald alle bereit sind. Sonst startet die Spielleitung mit `start`. CLI: `--auto-start`. Im Discord-Bot gilt stattdessen `discord.autoStart`. |
| `pickReminderSec` | `45` | Sekunden, bis der Spieler am Zug eine Frage wählt. Danach kommt eine Erinnerung. |
| `answerTimeoutSec` | `45` | Antwortzeit für den Spieler am Zug. |
| `buzzerOnWrong` | `true` | Nach einer falschen Antwort den Buzzer für alle anderen freigeben. |
| `buzzWindowSec` | `15` | Zeit zum Buzzern. |
| `buzzAnswerTimeoutSec` | `25` | Antwortzeit für den Buzzer-Gewinner. |
| `bonusTimeSec` | `0` | Zusatzzeit auf Antwort- und Buzzerzeit. Der Voice-Bot setzt sie automatisch auf `voice.extraTimeSec`, solange er moderiert, und danach auf 0 zurück. Von Hand selten nötig. |
| `correctFactor` | `1` | Faktor auf den Fragewert bei richtiger Antwort. `1` = voller Wert. |
| `wrongFactor` | `0.5` | Faktor bei falscher Antwort (als Abzug). `0.5` = halber Wert, `0` = kein Abzug. |
| `buzzerCorrectFactor` | `1` | Wie `correctFactor`, aber für Buzzer-Antworten. |
| `buzzerWrongFactor` | `0.5` | Wie `wrongFactor`, aber für Buzzer-Antworten. |
| `autoplayAudio` | `true` | YouTube- und Audio-Fragen automatisch abspielen. |
| `revealPauseSec` | `4` | Pause zwischen Auflösung und Schließen der Frage, damit alle die Lösung lesen. |
| `autoEnd` | `true` | Am Ende das Spiel auf der Seite automatisch beenden. |

Faktoren sind Multiplikatoren. Bei einem Fragewert von 200 ergibt `correctFactor: 1` +200, `wrongFactor: 0.5` −100.

## `judge`

Bewertet Antworten. Ablauf: Fuzzy-Vergleich → Cache → LLM → Spielleitung. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

| Option | Default | Bedeutung |
|---|---|---|
| `strategy` | `cascade` | `cascade` = erst Fuzzy, nur bei Unsicherheit das LLM. `fuzzy` = nie das LLM. `operator` = die Spielleitung entscheidet alles Unsichere. CLI: `--judge`. |
| `acceptThreshold` | `0.86` | Ab dieser Ähnlichkeit (0 bis 1) gilt eine Antwort ohne LLM als richtig. |
| `rejectThreshold` | `0.35` | Unter dieser Ähnlichkeit gilt sie im `fuzzy`-Modus als falsch. |
| `solveMissingNotes` | `true` | Bei Fragen ohne Lösungsnotiz (z.B. nur Bild) die Lösung per Vision-LLM bestimmen. `false` = solche Fragen gehen an die Spielleitung. |
| `cacheFile` | `.qbhost/judge-cache.json` | Bewertungs-Cache. Spart LLM-Aufrufe bei wiederholten Antworten. |

## `llm`

Das Sprachmodell, das unsichere Antworten bewertet.

| Option | Default | Bedeutung |
|---|---|---|
| `provider` | `claude-cli` | `claude-cli` = `claude -p` über dein Claude-Code-Abo. `anthropic` = Anthropic-API mit `ANTHROPIC_API_KEY`. `none` = kein LLM, unsichere Fälle gehen an die Spielleitung. CLI: `--llm`. |
| `model` | `haiku` | Modell. `haiku`, `sonnet`, `opus` oder eine volle Modell-ID (bei `anthropic`). CLI: `--model`. |
| `claudeBin` | `claude` | Pfad zur Claude-CLI, nur für `claude-cli`. |
| `timeoutMs` | `30000` | Zeitlimit pro LLM-Aufruf in Millisekunden. |

Mit `none` oder ohne Claude-Zugang funktioniert das Spiel weiter, nur unsichere Antworten landen bei der Spielleitung.

## `discord`

Discord-Bot (`npx qbhost discord`). Einrichtung: [DISCORD.md](DISCORD.md).

| Option | Default | Bedeutung |
|---|---|---|
| `tokenEnv` | `DISCORD_TOKEN` | Name der Umgebungsvariable mit dem Bot-Token. Der Token selbst gehört in `.env`. |
| `channelIds` | `[]` | Nur in diesen Channels reagiert der Bot (Präfix und @Erwähnung). Leer = überall, wo er lesen kann. Channel-ID: Entwicklermodus in Discord, dann „Kanal-ID kopieren“. |
| `prefix` | `!quiz` | Befehlspräfix. |
| `autoStart` | `true` | Spiel automatisch starten, sobald alle in quiz-base bereit **und** mit Discord verknüpft sind. `!quiz los` erzwingt den Start. |
| `lobbyTimeoutMin` | `20` | Lobby schließen, wenn das Spiel nach so vielen Minuten nicht gestartet ist. |
| `dataDir` | `.qbhost/discord` | Speicherort für Verknüpfungen und gespeicherte Regeln pro Server. |

## `voice`

Sprachsteuerung im Voice-Channel. Alles läuft lokal: whisper.cpp (Spracherkennung) und Piper oder macOS `say` (Sprachausgabe). Einrichtung: `npx qbhost voice-setup`, Details: [VOICE.md](VOICE.md).

| Option | Default | Bedeutung |
|---|---|---|
| `enabled` | `true` | Sprachsteuerung an (sofern eingerichtet). |
| `autoJoin` | `true` | Bei `!quiz neu` automatisch in den Voice-Channel der Spielleitung kommen. |
| `dir` | `.qbhost/voice` | Ordner für Modelle und die Python-Umgebung. |
| `whisperBin` | `whisper-server` | Pfad zum whisper.cpp-Server. |
| `whisperModel` | `models/ggml-large-v3-turbo-q5_0.bin` | Whisper-Modell, relativ zu `dir`. |
| `whisperPort` | `8178` | Port des lokalen Whisper-Servers. |
| `language` | `de` | Sprache der Spracherkennung. |
| `tts` | `piper` | `piper` (natürlich, lokal, muss eingerichtet werden) oder `say` (nur macOS, ohne Einrichtung). |
| `piperVoice` | `models/de_DE-thorsten-high.onnx` | Piper-Stimme, relativ zu `dir`. |
| `piperLengthScale` | `0.95` | Sprechtempo. Über 1 = langsamer, unter 1 = schneller. |
| `sayVoice` | `Anna` | Stimme für `tts: "say"`. Deutsche Stimmen mit vollem Namen angeben, z.B. `Anna`, `Reed (Deutsch (Deutschland))`. |
| `silenceMs` | `900` | Sprechpause, nach der eine Äußerung als beendet gilt. |
| `minSpeechMs` | `350` | Kürzere Geräusche werden verworfen (Husten, Klicks). |
| `minRms` | `250` | Leisere Geräusche werden verworfen. |
| `maxSpeechSec` | `15` | Obergrenze für eine Äußerung in Sekunden. |
| `ignoreWhileSpeaking` | `true` | Was jemand sagt, während der Bot spricht, wird ignoriert (Schutz vor Echo ohne Kopfhörer). |
| `wakeWords` | `quizmaster`, `quiz master`, `quizmeister`, `quizhost`, `quiz host` | Rufnamen für Sprachbefehle. |
| `extraTimeSec` | `10` | Zusätzliche Antwort- und Buzzerzeit, solange der Bot spricht. |
| `scoresEvery` | `3` | Punktestand nach jeder n-ten Frage ansagen. `0` = nie. |

## `companion`

Das Web-Spieler-Pult (`http://<rechner>:4747`). Mitspieler öffnen es im Browser und wählen dort Karten und Antworten.

| Option | Default | Bedeutung |
|---|---|---|
| `enabled` | `true` | Spieler-Pult starten. CLI: `--no-companion`. |
| `port` | `4747` | Port. CLI: `--port`. |
| `host` | `0.0.0.0` | Adresse, auf der gelauscht wird. `0.0.0.0` = aus dem ganzen Netzwerk erreichbar, sonst nur `127.0.0.1` (nur dieser Rechner). Das Pult hat keine Anmeldung, daher nur in einem Netz, dem du vertraust. |

## Spielregeln (zur Laufzeit änderbar)

Diese Regeln kannst du im Discord-Chat ändern (`!quiz regel …`). Sie werden pro Server in `discord.dataDir` gespeichert und gelten ab der nächsten Frage. Während eines Spiels darf nur die Spielleitung ändern.

| Discord-Name | Config-Schlüssel | Bedeutung |
|---|---|---|
| `plus`, `richtig` | `correctFactor` | Punkte für richtige Antwort |
| `minus`, `falsch` | `wrongFactor` | Abzug für falsche Antwort |
| `buzzerplus`, `buzzerrichtig` | `buzzerCorrectFactor` | Punkte für richtige Buzzer-Antwort |
| `buzzerminus`, `buzzerfalsch` | `buzzerWrongFactor` | Abzug für falsche Buzzer-Antwort |
| `buzzer` | `buzzerOnWrong` | Buzzer nach falscher Antwort freigeben (`an` / `aus`) |
| `zeit`, `antwortzeit` | `answerTimeoutSec` | Antwortzeit in Sekunden (5 bis 600) |
| `buzzerzeit` | `buzzWindowSec` | Zeit zum Buzzern in Sekunden (5 bis 600) |
| `buzzerantwortzeit` | `buzzAnswerTimeoutSec` | Antwortzeit nach Buzzer in Sekunden (5 bis 600) |

Faktoren akzeptieren `100%`, `50%`, `0.5`, `1/2`, `halb`, `2x`, `nichts`. Beispiel: `!quiz regel minus 0` = kein Abzug.

Diese Regeln sind **nicht** in der Konfigurationsdatei, sondern im Chat gespeichert. `!quiz regeln reset` setzt sie auf die Standardwerte aus `game` zurück.

## Beispiele

**Ohne Discord, nur Terminal und Spieler-Pult, Browser sichtbar:**

```json
{
  "browser": { "headless": false },
  "game": { "publicBoard": "Allgemeinwissen Quiz v1", "autoStart": true },
  "llm": { "provider": "claude-cli" }
}
```

**Ohne LLM, nur Fuzzy-Vergleich, Spielleitung entscheidet den Rest:**

```json
{
  "judge": { "strategy": "fuzzy" },
  "llm": { "provider": "none" }
}
```

**Discord nur in einem Channel, Sprache mit macOS-Stimme:**

```json
{
  "discord": { "channelIds": ["123456789012345678"] },
  "voice": { "tts": "say", "sayVoice": "Reed (Deutsch (Deutschland))" }
}
```

Die Channel-ID ist ein Platzhalter. Trag deine eigene ein.
