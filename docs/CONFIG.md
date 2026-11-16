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
| `minPlayers` | `2` | Mindestzahl Spieler für den automatischen Start. Ein ausdrücklicher Start (`start`, Discord `!quiz los`) geht auch mit weniger, z.B. allein. |
| `autoStart` | `false` | Spiel automatisch starten, sobald alle bereit sind. Sonst startet die Spielleitung mit `start`. CLI: `--auto-start`. Im Discord-Bot gilt stattdessen `discord.autoStart`. |
| `pickReminderSec` | `90` | Sekunden bis zur ersten Erinnerung „du bist dran“, wenn der Spieler am Zug keine Karte wählt. `0` = keine Erinnerung. |
| `pickReminderRepeatSec` | `300` | Abstand weiterer Erinnerungen im selben Zug. Gesprochen wird nur die erste, die weiteren stehen nur im Chat. `0` = nur eine Erinnerung. |
| `pickHint` | `true` | Hinweis „Welche Karte? …“, wenn eine gesprochene Kartenwahl nicht klappt: höchstens einmal pro Zug und nur, wenn die Äußerung nach einer Karte klingt (eine Punktzahl, eine Spalte wie „die zweite“ oder ein Wort, das an eine Kategorie erinnert; keine Jahreszahl), nie bei Gespräch. |
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

## `boardgen`

Der Board-Generator: Claude schreibt ein komplettes Tafelquiz, qbhost legt es über den Board-Editor von quiz-base als eigenes Board an (`npx qbhost board-create`, Discord `!quiz erstellen`). Braucht einmal `npx qbhost login`.

| Option | Default | Bedeutung |
|---|---|---|
| `provider` | `inherit` | `inherit` = wie `llm.provider`. Sonst `claude-cli` (Abo) oder `anthropic` (API-Key), z.B. Boards über das Abo, Bewertungen über die API. |
| `model` | `sonnet` | Modell für Erzeugung und Prüfrunde. Alias (`sonnet`, `opus`, `haiku`) oder volle Modell-ID. CLI: `--gen-model`. |
| `effort` | `medium` | Denkaufwand `low`/`medium`/`high`. Mehr = gründlicher, langsamer, teurer. |
| `timeoutMs` | `300000` | Zeitlimit pro Aufruf (ein Board braucht meist 10–60 s). |
| `review` | `true` | Zweite Prüfrunde: Faktencheck, Eindeutigkeit, Schwierigkeit; ersetzt schwache Fragen. |
| `maxAttempts` | `3` | Versuche, bis die Ausgabe gültig ist (Schema + Prüfregeln). |
| `maxCostUsd` | `1` | Abbruch, wenn ein Board mehr kostet (nur `anthropic`; über das Abo fallen keine Kosten an). |
| `dir` | `.qbhost/boards` | Erzeugte Boards **mit Lösungen** und das Register (welche Anfrage → welches Board). Gitignored. |
| `creatorIds` | `[]` | Discord-User-IDs, die außer Server-Admins Boards erstellen dürfen. |
| `defaults.categories` | `4` | Kategorien pro Board (2–8). |
| `defaults.rows` | `4` | Punktestufen pro Kategorie (1–10, mehr erlaubt quiz-base nicht). |
| `defaults.step` | `100` | Punkte pro Stufe (100 → 100, 200, …), Vielfache von 50. |
| `defaults.boards` | `1` | 1 oder 2 Boards (bei 2 bekommt jedes Board eigene Kategorien). |
| `defaults.level` | `kneipe` | Zielgruppe: `kinder` (8–10), `schule` (Klasse 5–7), `oberstufe`, `kneipe` (Erwachsene), `profi`. |
| `defaults.language` | `de` | Sprache der Fragen (ISO-Code). |
| `defaults.mcShare` | `0` | Anteil Multiple-Choice-Fragen (0–1). quiz-base zeigt dann 4 Antworten; diese Fragen haben keine Host-Notiz. |

Eine Sichtbarkeit gibt es nicht: quiz-base speichert eigene Boards immer als privaten Entwurf. Veröffentlichen geht nur von Hand unter „Meine Boards“ (quiz-base prüft das Board dann).

**Kosten** (Sonnet 5.5, $2 / $10 pro Mio. Tokens, inkl. Denken, gemessen): 2×2-Testboard ca. $0.04, 4×4 ca. $0.10, 2 Boards × 5×5 ca. $0.20. Über `claude-cli` (Abo) fallen keine Zusatzkosten an; angezeigt wird dann der API-Gegenwert. Vor jedem Board nennt qbhost die Schätzung, danach die gemessenen Kosten.

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

Sprachsteuerung im Voice-Channel. Alles läuft lokal: whisper.cpp (Spracherkennung, für Antworten wahlweise Parakeet) und Piper oder macOS `say` (Sprachausgabe). Einrichtung: `npx qbhost voice-setup`, Details: [VOICE.md](VOICE.md).

| Option | Default | Bedeutung |
|---|---|---|
| `enabled` | `true` | Sprachsteuerung an (sofern eingerichtet). |
| `autoJoin` | `true` | Bei `!quiz neu` automatisch in den Voice-Channel der Spielleitung kommen. |
| `dir` | `.qbhost/voice` | Ordner für Modelle und die Python-Umgebung. |
| `whisperBin` | `whisper-server` | Pfad zum whisper.cpp-Server. |
| `whisperModel` | `models/ggml-large-v3-turbo-q5_0.bin` | Whisper-Modell, relativ zu `dir`. Das genaue Hauptmodell: hört gesprochene Antworten, ohne `whisperFastModel` alles. |
| `whisperFastModel` | leer (aus) | Zweites, schnelles Modell, relativ zu `dir`, z.B. `models/ggml-base-q5_1.bin`. Läuft als eigener whisper-server auf `whisperPort + 1` und hört alles, wobei keine Antwort erwartet wird (Kartenwahl, Rufname, Befehle, Ja/Nein, „Hier!“). Siehe [VOICE.md](VOICE.md#zwei-modelle-für-langsame-rechner). |
| `whisperPort` | `8178` | Port des lokalen Whisper-Servers (das schnelle Modell nimmt den nächsten). |
| `whisperAudioCtx` | `0` | Audiofenster des Whisper-Encoders (`-ac <n>`), `0` = volles Fenster (1500 = 30 s). `512` ≈ 10 s ist auf kleinen Servern etwa dreimal schneller. `maxSpeechSec` wird auf das Fenster begrenzt (n/50 Sekunden). |
| `language` | `de` | Sprache der Spracherkennung (whisper, Deepgram; Parakeet erkennt die Sprache selbst). |
| `localStt` | `whisper` | Lokale Spracherkennung: `whisper` (whisper.cpp) oder `parakeet` (NVIDIA Parakeet TDT 0.6b v3 über sherpa-onnx, für die Phasen in `parakeetFor`). Unabhängig von `stt`: mit `stt: deepgram` ist sie der Rückfall. Siehe [VOICE.md](VOICE.md#parakeet-statt-whispercpp). |
| `parakeetFor` | `["answer"]` | Bei `localStt: parakeet`: welche Phasen Parakeet hört (`answer`, `confirm`, `full`, `wake`). Die übrigen hört whisper (`whisperFastModel`, sonst `whisperModel`). Kurze Befehle („Ja“, „Hier“) gibt Parakeet oft englisch wieder, daher Standard nur `answer`. In diesen Phasen zählt Parakeets Text nur als Antwort mit Schlüsselwort; alles andere hört whisper noch einmal. Alle vier = kein whisper-server mehr, dann zählt Parakeets Text für alles. Erlaubt sind nur `["answer"]` und alle vier Phasen; jede andere Kombination ist beim Laden ein Konfigurationsfehler. |
| `parakeet.model` | `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | Modellordner relativ zu `dir` (encoder/decoder/joiner `.int8.onnx` + `tokens.txt`). Das offizielle Modell lädt `voice-setup` (487 MB, geprüft per SHA-256); ein eigener Ordner muss vorhanden sein. |
| `parakeet.threads` | `0` | Rechen-Threads, `0` = Kerne (höchstens 4). |
| `parakeet.deadlineMs` / `deadlinePerSecMs` | `8000` / `500` | Frist je Erkennung ab Übergabe an den bereiten Worker: `deadlineMs` + `deadlinePerSecMs` je Audiosekunde. Danach Neustart des Workers und ein zweiter Versuch; scheitert der auch, wird die Äußerung verworfen. |
| `parakeet.startTimeoutMs` | `60000` | So lange darf der Worker zum Laden des Modells brauchen. |
| `stt` | `whisper` | Spracherkennung: `whisper` (nur lokal, Engine aus `localStt`) oder `deepgram` (Cloud, EU-Endpunkt). Siehe [VOICE.md](VOICE.md#erkennung-lokal-oder-cloud). |
| `sttCloudFor` | `["answer","confirm","full"]` | Bei `stt: deepgram`: welche Phasen die Cloud hört (`answer`, `confirm`, `full`, `wake`). Der Rest hört lokal. `wake` (Rufnamen-Prüfung bei allen, die nicht dran sind) fehlt absichtlich: Nebengespräche verlassen den Server nie. Die Cloud hört nur verknüpfte Personen, die laut Spiel gerade sprechen dürfen; siehe die Tabelle in VOICE.md. |
| `cloudFallback` | `local` | Fällt die Cloud aus: `local` = dieselbe Äußerung lokal erkennen, `none` = kein Rückfall (dann „⚠️ Sprache gestört – bitte tippen“ einmal pro Spiel). |
| `warmFallback` | `true` | Lokale Rückfall-Modelle beim Beitritt mitstarten; sonst Kaltstart von mehreren Sekunden beim ersten Ausfall. Startet eins nicht (Modell fehlt), gibt es eine Warnung, der Beitritt klappt trotzdem. Hält die Modelle dauerhaft im RAM. |
| `sttTimeoutMs` | `2500` | Frist je Cloud-Anfrage in ms; danach wird sie abgebrochen und lokal erkannt. |
| `cloudCooldownSec` | `300` | Nach 3 Cloud-Fehlern in Folge (Zeitüberschreitung, Netz, 429, 5xx) so viele Sekunden nur lokal, dann ein neuer Versuch. |
| `deepgram.baseUrl` | `https://api.eu.deepgram.com` | Deepgram-Endpunkt (EU). Nur `https://`; `http://` nur zu `127.0.0.1`/`localhost` (Tests). Eine andere Adresse ist ein Konfigurationsfehler beim Laden. |
| `deepgram.keyEnv` | `DEEPGRAM_API_KEY` | Name der Umgebungsvariable mit dem Schlüssel (z.B. in `.env`). Der Schlüssel selbst gehört nie in die Config-Datei. |
| `deepgram.sttModel` | `nova-3` | Deepgram-Modell. |
| `deepgram.language` | `de` | Sprache für Deepgram. |
| `deepgram.keyterms` | `true` | Kategorien, Punktwerte und Namen als Schlüsselbegriffe mitschicken (nie die Lösung). |
| `tts` | `piper` | `piper` (natürlich, lokal, muss eingerichtet werden) oder `say` (nur macOS, ohne Einrichtung). |
| `piperVoice` | `models/de_DE-thorsten-high.onnx` | Piper-Stimme, relativ zu `dir`. Jede offizielle Stimme im Schema `models/<sprache>_<REGION>-<name>-<qualität>.onnx` (z.B. `models/de_DE-thorsten-medium.onnx`) lädt `qbhost voice-setup` samt `.onnx.json` aus `rhasspy/piper-voices`; eigene Stimmen bitte selbst ablegen. |
| `piperLengthScale` | `0.95` | Sprechtempo. Über 1 = langsamer, unter 1 = schneller. |
| `ttsSplitSentences` | `false` | Lange Ansagen satzweise sprechen: Der erste Satz klingt, während die nächsten noch erzeugt werden. Siehe [VOICE.md](VOICE.md#schneller-erster-ton). |
| `ttsDiskCache` | `false` | Feste Standardsätze ohne Spielinhalt (`FIXED_LINES`) als Audio unter `<dir>/tts-cache/` ablegen und in Sprechpausen vorab erzeugen. Überlebt Neustarts. |
| `sayVoice` | `Anna` | Stimme für `tts: "say"`. Deutsche Stimmen mit vollem Namen angeben, z.B. `Anna`, `Reed (Deutsch (Deutschland))`. |
| `silenceMs` | `900` | Sprechpause, nach der eine Äußerung als beendet gilt. |
| `minSpeechMs` | `350` | Kürzere Geräusche werden verworfen (Husten, Klicks). |
| `minRms` | `250` | Leisere Geräusche werden verworfen. |
| `maxSpeechSec` | `15` | Obergrenze für eine Äußerung in Sekunden. Mit `whisperAudioCtx` höchstens dessen Fenster (512 → 10 s), außer Parakeet hört alle Phasen. |
| `ignoreWhileSpeaking` | `true` | Was jemand sagt, während der Bot spricht, wird ignoriert (Schutz vor Echo ohne Kopfhörer). |
| `bargeIn` | `true` | Wer gerade dran ist, darf Hinweise, Erinnerungen und Rückfragen des Bots unterbrechen. Der Bot verstummt und wertet die Äußerung, außer sie klingt wie seine eigene Ansage. Fragen, Lösungen und alle anderen Personen bleiben beim Echo-Schutz. `false` = wie früher. |
| `wakeWords` | `quizmaster`, `quiz master`, `quizmeister`, `quizhost`, `quiz host` | Rufnamen für Sprachbefehle. |
| `extraTimeSec` | `10` | Zusätzliche Antwort- und Buzzerzeit, solange der Bot spricht. |
| `scoresEvery` | `3` | Punktestand nach jeder n-ten Frage ansagen. `0` = nie. |
| `leaveOnGameEnd` | `true` | Nach Spielende (reguläres Ende, `!quiz ende`, „Quizmaster, Spiel beenden“, Abbruch) verabschiedet sich der Bot („Tschüss, bis zum nächsten Quiz!“) und verlässt den Voice-Channel, sobald die letzte Ansage gesprochen ist (spätestens nach 30 s, falls die Sprachausgabe hängt). Startet vorher ein neues Spiel oder öffnet jemand das Board-Menü (`!quiz neu`), bleibt er. `false` = bleiben, dann gilt nur der Abschied nach 20 Minuten Stille. |
| `latencyLog` | `true` | `⏱`-Zeilen mit Messwerten (Erkennung, Ansage, Reaktion, Bilanz) auf `info`, ohne Texte. Siehe [VOICE.md](VOICE.md#latenz-messen). `false` = keine einzige `⏱`-Zeile. |

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
| `erinnerung` | `pickReminderSec` | Erste Erinnerung bei der Kartenwahl in Sekunden (5 bis 600, `aus` = keine) |
| `erinnerungstakt`, `nacherinnerung` | `pickReminderRepeatSec` | Weitere Erinnerungen im selben Zug, nur im Chat (5 bis 600, `aus` = keine) |
| `kartenhinweis`, `hinweis` | `pickHint` | Hinweis „Welche Karte?“ bei gesprochener Kartenwahl (`an` / `aus`) |

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

**Boards über das Abo, Bewertungen über die API, zwei Leute dürfen Boards erstellen:**

```json
{
  "llm": { "provider": "anthropic", "model": "haiku" },
  "boardgen": { "provider": "claude-cli", "creatorIds": ["123456789012345678", "234567890123456789"], "defaults": { "level": "schule" } }
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
