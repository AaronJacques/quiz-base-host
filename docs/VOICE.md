# Sprachsteuerung (Discord-Voice)

Der Bot kommt in euren Voice-Channel, moderiert das Quiz mit Stimme und versteht, was ihr sagt: Karten, Antworten, „Hier!“ zum Buzzern und Befehle. Tippen ist nur noch für einen Befehl nötig (`!quiz voice` oder `!quiz neu`), auf quiz-base selbst gebt ihr nur euren Namen ein.

**Alles läuft lokal** auf dem Rechner mit dem Bot, kostenlos und ohne Cloud:

| Teil | Werkzeug | Zeit pro Satz (Apple M4) |
|---|---|---|
| Spracherkennung (STT) | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `large-v3-turbo` (quantisiert, 550 MB), dauerhaft geladen | ~0,5–1 s |
| Sprachausgabe (TTS) | [Piper](https://github.com/OHF-Voice/piper1-gpl) Stimme `de_DE-thorsten-high`, dauerhaft geladen | ~0,2–0,5 s |
| Voice-Verbindung | `@discordjs/voice` mit DAVE (Ende-zu-Ende-Verschlüsselung), Opus per WebAssembly (eigene Anbindung, `src/voice/opus.ts`) | – |

## Einrichten (einmalig)

```bash
npx qbhost voice-setup     # macOS: brew install whisper.cpp; lädt Modelle (~700 MB), Python-Umgebung für Piper, Selbsttest (Linux: docs/INSTALL.md)
npm run doctor             # „Sprachsteuerung (STT/TTS lokal)“ muss ✅ sein
npx qbhost discord
```

Im Developer Portal ist nichts zusätzlich nötig (der Voice-States-Intent ist nicht privilegiert). Der Bot braucht im Voice-Channel die Rechte **Verbinden** und **Sprechen**. Bestehende Einladungen: Server-Einstellungen → Rollen → Bot-Rolle bzw. Channel-Berechtigungen prüfen.

Ohne Piper geht es auch mit der macOS-Stimme: `"voice": { "tts": "say" }` in `qbhost.config.json`.

## Ablauf

```
(alle im Voice-Channel)
Anna tippt:  !quiz voice                  → Bot kommt in Annas Voice-Channel
             (oder direkt !quiz neu … – dann kommt er automatisch dazu)
Anna:  „Quizmaster, neues Quiz Allgemeinwissen“
Bot:   „Dazu passen 4 Boards. 1: Allgemeinwissen Quiz v1. 2: … Welche Nummer?“
Anna:  „Nummer eins“
Bot:   „Die Lobby ist offen! Den Link findet ihr im Chat …“   (Link im Text-Channel)
       Alle öffnen den Link, geben ihren Namen ein, „Ich bin bereit!“
Bot:   „Anna ist da. Ben ist da. Los geht's mit Allgemeinwissen Quiz v1!
        Die Kategorien sind: Flaggen, Sport, … Anna, du bist dran. Welche Karte?“
Anna:  „Sport für zweihundert“
Bot:   „Sport für 200. Wie lang ist ein Marathon? Anna, deine Antwort?“
Anna:  „Ähm … Ben, waren das nicht 40 Kilometer?“         (laut nachgedacht → zählt nicht)
Ben:   „Meine Antwort wäre 50“                             (Ben ist nicht dran → wird gar nicht erst erkannt)
Anna:  „Okay, meine Antwort ist 42 Kilometer“
Bot:   „42 Kilometer?“
Anna:  „Ja“
Bot:   „Richtig! Plus 200.“
```

Wer im Voice-Channel ist und auf quiz-base **denselben Namen** wie in Discord benutzt, wird automatisch verknüpft. Sonst: „Quizmaster, ich bin Benjamin“.

## Was der Bot versteht

**Ohne Rufname** – nur von der Person, die gerade dran ist:
- Karte: „Sport für 200“, „Geschichte dreihundert“, „die zweite Kategorie für 100“
- **Antwort nur mit Schlüsselwort**, wenn er dich fragt: „Meine Antwort ist …“, „Die Antwort lautet …“, „Meine finale Antwort ist …“, „Antwort: …“, „Ich antworte mit …“ (Füllwörter davor wie „Okay, äh“ sind egal). Alles andere ist lautes Nachdenken und zählt nicht. Der Bot wiederholt die Antwort einmal kurz („42 Kilometer?“):
  - „Ja“ / „Genau“ / „Richtig“ → abgegeben
  - „Nein“ / „Warte“ → verworfen, neu antworten
  - ein neues „Meine Antwort ist …“ ersetzt die alte – auch mit Bestätigungswort davor: „Genau, meine Antwort ist zehn“ ist die neue Antwort „zehn“ (wieder mit Rückfrage), nicht das „Ja“ zur alten
  - Korrektur im selben Satz: Es gilt das **letzte** Schlüsselwort und das, was nach einer Korrektur kommt. „Meine Antwort ist Nabu, ach nein, Tatooine“, „… Nabu – nein, warte, Tatooine“, „… Nabu, ich meine Tatooine“ und „Meine Antwort ist Nabu … meine Antwort ist Tatooine“ ergeben alle „Tatooine“. Die Antwort „Nein“ bleibt „Nein“.
  - läuft die Zeit ab, bevor du bestätigst, gilt die zuletzt genannte Antwort. Kommt „Meine Antwort ist …“ erst in den letzten 1,5 Sekunden (oder danach, solange der Bot noch wartet), fragt der Bot nicht mehr nach, sondern gibt sie sofort ab.
  - Wird das Spiel beendet, während eine Antwort noch auf „Ja“ wartet, verfällt sie: keine Bewertung, keine Punkte.
  Wer das Schlüsselwort vergisst, wird einmal pro Spiel daran erinnert. Getippte Antworten im Chat brauchen kein Schlüsselwort.
- In Menüs: „Nummer zwei“, „das erste“
- Nach einer falschen Antwort („Jetzt die anderen!“), alle, die noch nicht geantwortet haben: „Hier!“, „Ich!“ oder „Buzzer!“ als ganze, kurze Äußerung. Kein Buzz sind: ein bloßes „Ja“, eine Frage („Ich?“) und Sätze, die den Buzzer nur erwähnen („kein Buzzer für mich“). Der Buzzer auf quiz-base geht weiterhin auch; wer zuerst ist, gewinnt. Das Buzzer-Fenster hat eine feste Länge: Wer schon geantwortet hat und trotzdem buzzert, verlängert es nicht. (Der Bot selbst sagt nicht „Buzzer“ – die deutsche Stimme spricht es als „Butzer“.)

**Wer nicht dran ist, ist für den Bot stumm.** Er prüft bei diesen Personen nur die ersten 2 Sekunden einer Äußerung auf „Quizmaster“; der Rest wird nicht einmal transkribiert. Ihr könnt also frei mitraten und diskutieren.

**Mit Rufname „Quizmaster, …“** (auch „Quiz Master“, „Quizmeister“) – alle, jederzeit:

| Sagen | Wirkung |
|---|---|
| „Quizmaster, neues Quiz *Name*“ | Lobby mit Quiz-Auswahl (wie `!quiz neu`) |
| „Quizmaster, ich bin *Name*“ | mit quiz-base-Namen verknüpfen |
| „Quizmaster, Stand“ / „wie ist der Punktestand“ | Punktestand |
| „Quizmaster, was ist noch frei?“ | freie Karten |
| „Quizmaster, wiederholen“ | Frage (oder Zug) noch einmal |
| „Quizmaster, los“ / „start“ | Start erzwingen (Spielleitung). Der Bot antwortet sofort („Okay, wir starten!“) oder sagt, wer noch fehlt („Es fehlt noch: Ben.“) |
| „Quizmaster, das war richtig / falsch“, „weiter“ | Bewertung überstimmen / Buzzer-Runde überspringen (Spielleitung), wie `!quiz richtig/falsch/skip` (siehe DISCORD.md) |
| „Quizmaster, Spiel beenden“ | Spiel beenden (Spielleitung). Nur ganze Sätze wie „Spiel beenden“, „Spiel abbrechen“, „beende das Spiel“, „Quiz beenden“, „wir hören auf“ – nie ein Wort mitten im Satz („kannst du aufhören zu reden“, „Schlussrunde“). Kurze Wörter wie „Stopp“, „Abbrechen“, „Aufhören“, „Schluss“ beenden nicht, der Bot fragt nach: „Soll ich das Spiel beenden? Sag: Quizmaster, Spiel beenden.“ |
| „Quizmaster, tschüss“ | Bot verlässt den Voice-Channel |
| „Quizmaster, Hilfe“ | sagt die Befehle an |

Alles, worauf der Bot reagiert, steht als kleine Zeile im Text-Channel des Spiels (`🎙️ Anna: „Sport für 200“`), damit man Hörfehler sieht. Gesprochenes gehört immer zum Spiel-Channel, auch wenn der Bot mit `!quiz voice` aus einem anderen Channel gerufen wurde. Die Spielleitung kann wie gewohnt per Chat korrigieren (`!quiz richtig`, `!quiz korrektur Anna +100`).

## Datenschutz

- Der Bot sagt beim Beitritt an, dass er zuhört. Er verarbeitet Sprache nur, solange er im Channel ist, und **speichert keine Aufnahmen**.
- Erkannte Sätze landen nur dann im Text-Channel, wenn der Bot darauf reagiert (Karte, Antwort mit Schlüsselwort, Ja/Nein, Befehl). Von allen, die nicht dran sind, wird nur der Anfang einer Äußerung auf den Rufnamen geprüft. Lautes Nachdenken der Person, die dran ist, wird erkannt, aber weder gespeichert noch gepostet.
- Nach 20 Minuten ohne Spiel und ohne Sprache verlässt der Bot den Channel von selbst.
- Standardmäßig bleibt alle Sprache auf dem Rechner. Mit Cloud-Erkennung (`voice.stt: "deepgram"`) geht Audio an Deepgram, welches genau, steht unter [Erkennung: lokal oder Cloud](#erkennung-lokal-oder-cloud).

## Tipps & Grenzen

- **Kopfhörer**: Wer den Bot über Lautsprecher hört, schickt seine Stimme zurück ins Mikro. Was jemand sagt, **während der Bot spricht**, wird deshalb ignoriert (`voice.ignoreWhileSpeaking`). Also kurz ausreden lassen. Bei Musikfragen sind Kopfhörer Pflicht.
- **Dazwischenreden (Barge-in)**: Ausnahme ist, wer gerade dran ist. Sagt der Bot einen Hinweis, eine Erinnerung oder eine Rückfrage („Welche Karte? Sag zum Beispiel …“, „Anna, du bist noch dran …“, „Anna, deine Antwort?“, „Tatooine?“), darf diese Person hineinreden: Der Bot verstummt und wertet, was sie sagt. Klingt es wie seine eigene Ansage (Echo über Lautsprecher), verwirft er es. Fragen, Lösungen und Zug-Ansagen laufen immer zu Ende, und für alle anderen bleibt der Echo-Schutz. Abschalten: `voice.bargeIn: false`.
- **Hinweise** („Welche Karte? …“) kommen nur, wenn die Person am Zug nach der Zug-Ansage etwas sagt, das keine Karte ist, und höchstens einmal pro Zug. Zwischen Bewertung und nächstem Zug und beim Zugwechsel gibt es keine. Hinweis und Erinnerung stapeln sich nicht.
- Eine Äußerung endet nach ~0,9 s Pause (`voice.silenceMs`). Wer lange Pausen macht, wird früher „abgeschnitten“ – dann einfach weiterreden, die Antwort zählt aber nur einmal.
- Bildfragen: Der Bot sagt „Schaut euch dazu das Bild auf Quiz Base an“ – das Bild sieht man nur im Browser.
- Für Hinweise gibt der Bot Whisper die Kategorien, die Punktwerte des Boards („Sport für 100, 100, 200, …“ – sonst wird „hundert“ schon mal zu „Hunde“) und die Spielernamen mit. **Nie die Lösung**, sonst würde Whisper die richtige Antwort „hören“.
- Gesprochene Antworten werden **nach Klang** bewertet: Aus „Breaking Bad“ macht die Erkennung schon mal „Preaking Bat“ – das zählt ohne LLM. Gleicher Klang allein reicht aber nicht: Zahlen („Apollo 13“ ≠ „Apollo 11“), Vokale („Homburg“ ≠ „Hamburg“, „Guinea“ ≠ „Kenia“) und die grobe Schreibweise müssen auch passen, sonst entscheidet das LLM. Eine verschluckte Antwort wie „Preakidad“ wird nie ohne LLM als falsch gewertet. Kategorien werden ebenfalls nach Klang zugeordnet („Flecken“ → „Flaggen“, Kölner Phonetik).
- Nach der Frage sagt der Bot nur den **Kern der Lösung** an (erster Satz, ohne Klammern und lange Erklärung nach einem Gedankenstrich). Die volle Notiz steht im Chat.
- Solange der Bot moderiert, gibt es **+10 s** Antwort- und Buzzerzeit (`voice.extraTimeSec`, nach Buzzer die Hälfte), weil das Vorlesen Zeit kostet. Der Bonus ist ein eigener Wert (`game.bonusTimeSec`) neben den Regeln: `!quiz regel zeit 30` ergibt mit Voice 40 s, ohne 30 s; `!quiz regeln reset` und Verbindungsabbrüche lassen ihn nicht wachsen oder verschwinden. `!quiz regeln` zeigt ihn an.
- Bricht die Voice-Verbindung ab (Kick, Netz), meldet der Bot das im Chat und gibt die Zusatzzeit zurück; `!quiz voice` holt ihn zurück.
- Stürzt whisper-server ab, startet der Bot ihn bei der nächsten Erkennung neu (wie Piper). Ein whisper-server, den ein hart abgebrochener früherer Lauf zurückgelassen hat, wird übernommen und beim Beenden mit gestoppt.
- Ein Voice-Channel gleichzeitig pro Bot-Instanz.
- **Strg+C**: Der Bot beendet ein laufendes Spiel, verabschiedet sich noch („Ich muss leider los. Tschüss!“) und räumt whisper-server und Piper auf. Ein zweites Strg+C (später als 2 s danach) erzwingt das Beenden.
- **Opus**: Empfang und Wiedergabe laufen über eine eigene Anbindung an die WebAssembly-Version von libopus aus `opusscript` (`src/voice/opus.ts`), nicht über dessen JS-Hülle und nicht über prism-media. Die Hülle schrieb Audiodaten an die doppelte Speicheradresse. Mit zwei gleichzeitigen Sprechern zerstörte das den Opus-Speicher und beendete den ganzen Prozess. Kaputte oder noch verschlüsselte Pakete, Pakete über 60 ms und leere Pakete werden übersprungen. Nach einem Fehler im WASM-Modul nimmt der Bot ein frisches. Ein Fehler kostet höchstens dieses eine Paket.

## Einstellungen (`voice` in `qbhost.config.json`)

| Option | Standard | Bedeutung |
|---|---|---|
| `enabled` | `true` | Sprachsteuerung an (wenn eingerichtet) |
| `autoJoin` | `true` | bei `!quiz neu` automatisch in den Voice-Channel der Spielleitung |
| `tts` | `piper` | `piper` oder `say` (macOS) |
| `piperLengthScale` | `0.95` | Sprechtempo (>1 langsamer) |
| `ttsSplitSentences` | `false` | lange Ansagen satzweise sprechen, siehe [Schneller erster Ton](#schneller-erster-ton) |
| `ttsDiskCache` | `false` | feste Standardsätze auf Platte cachen und vorab erzeugen, siehe [Schneller erster Ton](#schneller-erster-ton) |
| `whisperModel` | `models/ggml-large-v3-turbo-q5_0.bin` | genaues Hauptmodell (Antworten) |
| `whisperFastModel` | leer (aus) | zweites, schnelles Modell für alles außer Antworten, eigener whisper-server auf `whisperPort + 1` |
| `whisperAudioCtx` | `0` (volles Fenster) | Audiofenster `-ac` für whisper-server; 512 ≈ 10 s, begrenzt `maxSpeechSec` entsprechend |
| `stt` | `whisper` | `whisper` (lokal) oder `deepgram` (Cloud), siehe [Erkennung: lokal oder Cloud](#erkennung-lokal-oder-cloud) |
| `sttCloudFor` | `answer`, `confirm`, `full` | welche Phasen die Cloud hört; `wake` bleibt lokal |
| `cloudFallback` | `local` | bei Cloud-Ausfall dieselbe Äußerung lokal erkennen; `none` = kein Rückfall |
| `warmFallback` | `true` | lokale Rückfall-Modelle beim Beitritt mitstarten |
| `sttTimeoutMs` | `2500` | Frist je Cloud-Versuch, danach lokal |
| `cloudCooldownSec` | `300` | nach 3 Cloud-Fehlern in Folge so lange nur lokal |
| `deepgram` | EU-Endpunkt, `DEEPGRAM_API_KEY`, `nova-3` | Anbieter-Einstellungen; der Schlüssel kommt aus `.env` |
| `silenceMs` | `900` | Pause, die eine Äußerung beendet |
| `minSpeechMs` / `minRms` | `350` / `250` | kürzere/leisere Geräusche werden verworfen |
| `ignoreWhileSpeaking` | `true` | Echo-Schutz |
| `bargeIn` | `true` | Wer dran ist, darf Hinweise, Erinnerungen und Rückfragen unterbrechen |
| `wakeWords` | `quizmaster`, … | Rufnamen |
| `scoresEvery` | `3` | Zwischenstand nach jeder n-ten Frage |
| `extraTimeSec` | `10` | zusätzliche Antwort-/Buzzerzeit, solange der Bot spricht (setzt `game.bonusTimeSec`) |
| `latencyLog` | `true` | `⏱`-Zeilen zur Latenz auf `info`, siehe [Latenz messen](#latenz-messen) |

## Zwei Modelle für langsame Rechner

Auf einem Mac reicht ein Modell. Auf kleinen Servern ist ein genaues Modell für jeden Satz zu langsam (Messwerte: [DEPLOY.md](DEPLOY.md#kleine-server)). Dann hört ein **schnelles Modell** (`whisperFastModel`) alles, wobei keine gesprochene Antwort erwartet wird: Kartenwahl, die Prüfung auf „Quizmaster“, Befehle, „Ja“/„Nein“ und „Hier!“. Das **genaue Hauptmodell** (`whisperModel`) hört nur die Person, die eine offene Frage beantworten soll, denn Antworten enthalten oft Namen. Das schnelle Modell macht aus „George Washington“ schon mal „Deutsch-Warschimtung“.

Während der Rückfrage („Tatooine?“) hört zuerst das schnelle Modell, damit „Ja“ schnell ankommt. Hört es dabei ein neues „Meine Antwort ist …“, geht dieselbe Aufnahme noch einmal an das Hauptmodell, und dessen Ergebnis zählt. Fällt das schnelle Modell aus, übernimmt das Hauptmodell.

`whisperAudioCtx` verkleinert das Audiofenster des Encoders (`-ac`): 512 statt 1500 macht beide Modelle etwa dreimal schneller, sie hören dann aber nur ~10 s. Längere Äußerungen schneidet der Bot deshalb nach `maxSpeechSec` ab, das automatisch auf dieses Fenster begrenzt wird.

```json
"voice": { "whisperModel": "models/ggml-small-q5_1.bin", "whisperFastModel": "models/ggml-base-q5_1.bin", "whisperAudioCtx": 512 }
```

`npx qbhost voice-setup` lädt beide Modelle, `npm run doctor` prüft beide.

## Erkennung: lokal oder Cloud

Standard ist alles lokal (`voice.stt: "whisper"`), wie oben beschrieben. Auf einem kleinen Server mit 1 vCPU braucht das genaue Modell aber mehrere Sekunden pro Äußerung (gemessen: `base` ~1,3 s, `small` ~4,5 s, unter Last etwa doppelt so lang). Mit `voice.stt: "deepgram"` hört stattdessen Deepgram (EU-Endpunkt `api.eu.deepgram.com`) in den Phasen, die in `sttCloudFor` stehen. Die Sprachausgabe bleibt immer lokal (Piper).

**Einrichten:**
1. Bei Deepgram ein Konto anlegen und einen API-Key erzeugen (Rolle „Member“ reicht).
2. In `.env`: `DEEPGRAM_API_KEY=…` (anderer Name über `voice.deepgram.keyEnv`, Vorlage `.env.example`). Der Schlüssel steht nie in der Config-Datei und nie im Log, auch nicht in Fehlermeldungen. Fehlt er, startet die Sprachsteuerung nicht, und der Bot meldet „Deepgram-Schlüssel fehlt“.
3. In `qbhost.config.json` die Cloud einschalten, die lokalen Modelle bleiben für die Rufnamen-Prüfung und den Rückfall:
   ```json
   "voice": { "stt": "deepgram", "whisperModel": "models/ggml-small-q5_1.bin", "whisperFastModel": "models/ggml-base-q5_1.bin", "whisperAudioCtx": 512 }
   ```
4. `npx qbhost voice-setup` (lädt die lokalen Modelle; ruft Deepgram nicht auf), dann `npm run doctor`. Der zeigt `Deepgram-Schlüssel: gesetzt (DEEPGRAM_API_KEY)` bzw. `fehlt` und prüft, ob der Endpunkt erreichbar ist. Dafür baut er nur eine TLS-Verbindung auf und schickt keine Anfrage: Das kostet nichts, prüft aber auch nicht, ob der Schlüssel gilt. Einen ungültigen Schlüssel merkt der Bot an der ersten Äußerung (Warnung „Deepgram-Schlüssel ungültig“, dann nur lokal).

**Was der Bot an Deepgram schickt:** `POST https://api.eu.deepgram.com/v1/listen?model=nova-3&language=de&punctuate=true&keyterm=…&mip_opt_out=true` mit `Authorization: Token <Schlüssel>` und der Äußerung als WAV (16 kHz, mono, 16 bit). Der EU-Endpunkt verarbeitet nur in der EU; fällt er aus, weicht Deepgram nicht auf andere Regionen aus (dann greift unser Rückfall). `mip_opt_out=true` ist fest eingebaut und nicht abschaltbar: Ohne ihn darf Deepgram die Aufnahmen zum Trainieren seiner Modelle behalten (Model Improvement Program). Laut Deepgram kann das Abmelden den Preis beeinflussen, siehe deren Preisseite. Jeder Begriff des Prompts wird ein eigener `keyterm` (höchstens 50; Deepgram erlaubt insgesamt 500 Tokens und empfiehlt 20–50 Begriffe). Die Verbindung bleibt zwischen Äußerungen offen, es gibt also nicht bei jeder Äußerung einen neuen TLS-Handshake.

**Wer hört was?** Je Phase (`attention`) entscheidet `sttCloudFor`:
- `answer` (wer eine Frage beantwortet), `confirm` (Rückfrage „Paris?“), `full` (Kartenwahl, „Hier!“, Menüs): Standard Cloud.
- `wake` (die Prüfung auf „Quizmaster“ bei allen, die nicht dran sind): Standard **lokal**.
- Was nicht in der Liste steht, hört lokal nach der bekannten Regel: Antworten das Hauptmodell, alles andere das schnelle Modell (falls gesetzt).
- In der Rückfrage gibt es die zweite Erkennung mit dem Hauptmodell nur, wenn Rückfrage und Antwort von verschiedenen Engines gehört werden. Hört die Cloud beide, geht dieselbe Aufnahme nicht zweimal hin.

**Welches Audio verlässt den Server?** Grundsatz: Audio geht nur dann an Deepgram, wenn der Bot die sprechende Person **eindeutig** als die erkennt, die laut Spiel gerade sprechen darf, und die Phase in `sttCloudFor` steht – oder wenn die **lokale** Prüfung den Rufnamen gehört hat. In jedem Zweifel und bei jedem Fehler bleibt das Audio lokal oder wird verworfen.
- Mit `stt: "whisper"`: keines.
- **Die Berechtigung muss die ganze Äußerung lang gelten:** Die Cloud hört eine Äußerung nur, wenn die Person schon bei ihrem Beginn und noch bei ihrem Ende ohne Unterbrechung sprechen durfte (Beginn = Ende minus Audiodauer, bzw. die frühere Startmeldung von Discord). Wer vor dem eigenen Zug, vor seiner Antwortzeit oder vor dem Öffnen des Buzzers losspricht, wird lokal erkannt – langsamer, aber nicht verloren.
- **Cloud-Erkennung setzt die Verknüpfung voraus** (quiz-base-Name ↔ Discord, siehe [DISCORD.md](DISCORD.md)). Unverknüpfte Personen – Zuschauer, aber auch eine Spielerin, deren quiz-base-Name nicht verknüpft ist – hört der Bot nur lokal. Ist die Person am Zug unverknüpft, hört er alle Unverknüpften lokal ganz (es könnte ja sie sein), aber nichts davon geht in die Cloud.
- Gibt es für eine Äußerung, die nicht in die Cloud darf, keine lokale Erkennung (Server ohne whisper), verwirft der Bot sie ebenfalls (Zähler `verworfen`, höchstens eine Warnung pro Minute) – nie ersatzweise Cloud.
- Scheitert die lokale Prüfung auf den Rufnamen (whisper abgestürzt, Modell nicht bereit), verwirft der Bot die Äußerung (Zähler `verworfen`, höchstens eine Warnung pro Minute). Sie geht nie ersatzweise in die Cloud. Ebenso fällt eine lokale Phase, deren Modell scheitert, nur auf das lokale Hauptmodell zurück.

Mit `stt: "deepgram"` und der Standardliste (`answer`, `confirm`, `full`) gilt, ob das Audio in die Cloud geht:

| Phase | dran (verknüpft) | nicht dran (verknüpft) | unverknüpft (Zuschauer) |
|---|---|---|---|
| ohne Spiel | lokal (Rufname) | lokal (Rufname) | lokal (Rufname) |
| Menü („Quizmaster, neues Quiz …“) | **Cloud** für die Person, die gefragt hat – nur solange das Menü ihre Wahl annimmt (höchstens 5 min, bis zur Wahl, zum Abbruch oder zu einem neuen Menü) | lokal (Rufname) | lokal (Rufname) |
| Lobby, vor Spielbeginn | lokal (Rufname) | lokal (Rufname) | lokal (Rufname) |
| Kartenwahl | **Cloud** | lokal (Rufname) | lokal (Rufname) |
| Frage (Antwortzeit) | **Cloud**, auch lautes Nachdenken | lokal (Rufname) | lokal (Rufname) |
| Rückfrage („Paris?“) | **Cloud** | lokal (Rufname) | lokal (Rufname) |
| Buzzer offen | wer schon geantwortet hat: lokal, ganz gehört | wer noch buzzern darf: **Cloud** | lokal (Rufname) |
| Spielende | lokal (Rufname) | lokal (Rufname) | lokal (Rufname) |
| Kartenwahl, Person am Zug unverknüpft | – | lokal (Rufname) | lokal, ganz gehört (könnte die Person am Zug sein) |

„lokal (Rufname)“: nur der Anfang wird lokal auf „Quizmaster“ geprüft. Hört die lokale Prüfung den Rufnamen, geht die ganze Äußerung als Befehl in die Cloud (kurze Befehle bis 2 s erkennt die lokale Prüfung schon ganz, die gehen gar nicht hin). Bei offenem Buzzer hört der Bot alle verknüpften Spieler ganz (wie ohne Cloud), in die Cloud geht aber nur, wer laut Spiel noch buzzern darf: Wer diese Frage schon beantwortet hat, darf nicht noch einmal, und sein Nebengespräch bleibt lokal. Die Tabelle prüft `test/voice-cloud-privacy.test.ts` in einem ganzen Spiel.

- Steht `wake` ausdrücklich in `sttCloudFor`, geht auch die Prüfung auf den Rufnamen in die Cloud, also der Anfang jeder Äußerung aller Anwesenden. Das ist eine bewusste Entscheidung für Server, auf denen gar kein whisper laufen soll.
- Zur Aufnahme schickt der Bot Schlüsselbegriffe mit (`deepgram.keyterms`): Kategorien, Punktwerte, Spielernamen, Boardtitel und feste Wörter wie „Meine Antwort ist“. Sie stammen aus derselben Quelle wie der Whisper-Prompt (`voicePrompt`) und enthalten **nie die Lösung**.

**Rückfall und Fristen.** Jede Cloud-Anfrage hat `sttTimeoutMs` (2,5 s). Danach wird sie abgebrochen, und dieselbe Aufnahme geht sofort an die lokale Engine dieser Phase. Kommt die Cloud-Antwort doch noch, wird sie verworfen; jede Äußerung zählt genau einmal. Beide Engines laufen nie gleichzeitig, auf 1 vCPU würde die lokale die Ersparnis auffressen.

| Fehler | Verhalten |
|---|---|
| Zeitüberschreitung (auch 408), Netzfehler, 429, 5xx, andere 4xx (z.B. 404) | diese Äußerung lokal; nach 3 Fehlern in Folge `cloudCooldownSec` (300 s) nur lokal, dann ein neuer Versuch |
| 401/403 (Schlüssel ungültig) | lokal, eine Warnung „Deepgram-Schlüssel ungültig“, Cloud bis zum Neustart aus |
| 402 (Guthaben aufgebraucht) | lokal, eine Warnung „Deepgram-Guthaben aufgebraucht“, Cloud bis zum Neustart aus – danach geht kein Audio mehr hin |
| 400/413/422 (diese Aufnahme kaputt, zu groß, Upload abgebrochen) | nur diese Anfrage lokal, zählt nicht als Störung |

Weiterleitungen folgt der Bot nicht, und `deepgram.baseUrl` muss mit `https://` beginnen (nur zu `127.0.0.1`/`localhost` geht `http://`, für Tests). Eine andere Adresse ist beim Laden der Konfiguration ein Fehler; Schlüssel und Audio gehen nie unverschlüsselt über das Netz.

**Schlechtester Fall der Latenz.** Hängt die Cloud, kommt der Text einer Antwort erst nach `sttTimeoutMs` (2,5 s) plus der lokalen Erkennung mit dem Hauptmodell: mit der Server-Vorlage (`small`, ~4,5 s auf 1 vCPU, unter Last ~9 s) also nach **7–11,5 s**. Ist der Rückfall nicht vorgewärmt (`warmFallback: false`), kommt der Kaltstart des whisper-servers dazu, geschätzt **9–14 s**. Für Kartenwahl und Rückfrage (Rückfall `base`, ~1,3–2,6 s) sind es ~4–5 s. Der Breaker begrenzt das auf die ersten 3 Äußerungen eines Ausfalls; eine Cloud, die nur jedes zweite Mal hängt, öffnet ihn aber nie (er zählt Fehler in Folge). Eine Antwort kurz vor Ablauf der Antwortzeit kann so verfallen. `sttTimeoutMs` nach den ersten echten Messungen prüfen; 1,5 s senkt den schlechtesten Fall um 1 s.

**RAM.** `warmFallback: true` hält die lokalen Rückfall-Modelle dauerhaft geladen, auch solange die Cloud läuft – also genauso viel Speicher wie ganz lokal. Jeder whisper-server braucht mindestens die Größe seines Modells (`base-q5_1` 60 MB, `small-q5_1` ~190 MB, `large-v3-turbo-q5_0` 574 MB) plus Arbeitsspeicher für die Erkennung; den echten Wert auf dem Server mit `docker stats` ablesen. Mit `warmFallback: false` spart ein kleiner Server den Speicher des Hauptmodells, bezahlt ihn aber beim ersten Ausfall mit dem Kaltstart. Die Rufnamen-Prüfung (Standard lokal) läuft immer.

Mit `cloudFallback: "none"` oder wenn die lokale Erkennung nicht eingerichtet ist bzw. ebenfalls scheitert, gibt es keinen Rückfall (auch kein Ausweichen auf ein anderes lokales Modell). Dann steht wie bisher `Erkennung: …` im Log, und der Bot schreibt einmal pro Spiel „⚠️ Sprache gestört – bitte tippen“ in den Spiel-Channel. Getippte Antworten und Befehle funktionieren immer.

**Messen: lokal gegen Cloud.** `tools/stt-probe.ts` schickt echte Aufnahmen über dieselbe Route wie der Bot (`answer`) und misst:

```sh
npx tsx tools/stt-probe.ts --engine local --prompt 'Quizmaster, Meine Antwort ist, Geschichte, Paris' clips/*.wav
npx tsx tools/stt-probe.ts --engine cloud --prompt 'Quizmaster, Meine Antwort ist, Geschichte, Paris' clips/*.wav
```

- Jede WAV-Datei läuft `--runs` mal (Standard 5) plus einen Aufwärmlauf, der nicht zählt (Modell laden, Verbindung aufbauen).
- Ausgabe je Datei: Engine, Median, Maximum, ob ein Rückfall nötig war, und der erkannte Text. Am Ende p50/p90 über alle Läufe.
- Ohne `--engine` gilt die Konfiguration samt Rückfall. `--engine local` erzwingt whisper.cpp, `--engine cloud` erzwingt Deepgram ohne Rückfall, damit Fehler sichtbar werden. `--config <datei>` nimmt eine andere Konfiguration.
- Fehlt der Schlüssel, bricht das Werkzeug mit „Deepgram-Schlüssel fehlt“ ab. Es gibt nur die Texte der übergebenen Clips aus, keine Schlüssel.
- Jeder Cloud-Lauf ist eine echte, abgerechnete Anfrage (wenige Sekunden Audio je Lauf).

Beispiel (Mac M-Serie, whisper `large-v3-turbo-q5_0`, Clips aus der Benchmark-Sammlung):

```
Route answer: whisper:large-v3-turbo-q5_0, 5 Läufe + 1 Aufwärmlauf je Datei

Datei           Audio    Engine                       Median   Max      Rückfall  Text
ja-anna.wav     461 ms   whisper:large-v3-turbo-q5_0  1062 ms  1078 ms  nein      „Ja.“
paris-anna.wav  1834 ms  whisper:large-v3-turbo-q5_0  1085 ms  1108 ms  nein      „Meine Antwort ist Paris.“

Gesamt: n=10 p50=1073 ms p90=1095 ms
```

**Was muss lokal da sein?** `voice-setup` und `doctor` richten sich nach der Einstellung. whisper.cpp und die Modelle der Phasen, die lokal hören (Standard: die Rufnamen-Prüfung), sind Pflicht. Die Rückfall-Modelle lädt `voice-setup` mit; fehlen sie, zeigt `doctor` „⚠️ Rückfall nicht verfügbar: …“, die Sprachsteuerung startet trotzdem (der Beitritt scheitert auch mit `warmFallback` nicht, es gibt nur eine Warnung), und ein Cloud-Ausfall führt dann zum Hinweis im Chat. Mit `cloudFallback: "none"` und `wake` in `sttCloudFor` braucht der Server gar kein whisper. `warmFallback` (Standard `true`) startet die Rückfall-Modelle schon beim Beitritt; sonst kostet der erste Ausfall einen Kaltstart von mehreren Sekunden.

## Schneller erster Ton

Piper liefert Audio erst, wenn der ganze Text fertig ist, und arbeitet einen Text nach dem anderen ab. Eine lange Quizfrage (~250 Zeichen) braucht deshalb auf dem Mac gut 3 s und auf einem Server mit 1 vCPU rund 8 s bis zum ersten Ton. Zwei Schalter helfen, ganz ohne Cloud. Beide sind standardmäßig aus, die Server-Vorlage (`deploy/qbhost.config.server.example.json`) schaltet sie ein.

**`ttsSplitSentences`: satzweise sprechen.** Der Bot teilt jede Ansage an Satzenden in Teile. Der erste Teil klingt, sobald er fertig ist, und die übrigen entstehen, während er spielt. Piper ist schneller als Echtzeit, deshalb ist der nächste Teil meist fertig, bevor der vorige ausklingt. Gemessen auf dem Mac (Piper, 5 Läufe) für die lange Frage: erster Ton 3,2 s → 0,87 s (p50), keine Lücke zwischen den Teilen.
- Getrennt wird nur nach `.`, `!` oder `?` mit Leerzeichen und Großbuchstabe, Ziffer oder Anführungszeichen danach. Nie nach einer Zahl („1. September“, „Geschichte für 200.“), einem einzelnen Buchstaben („z. B.“) oder einer Abkürzung („ca.“, „Nr.“, „Chr.“), nie nach „…“ und nie innerhalb der Antwortmöglichkeiten („A: … B: …“). Kommas trennen nie, das würde die Betonung zerreißen. Teile unter 25 Zeichen hängt der Bot an den nächsten (den letzten an den vorigen), damit kurze Sätze wie „Richtig! Plus 200.“ ein Stück bleiben.
- Alle Teile einer Ansage gehören zusammen. Was für die Ansage gilt, gilt für alle Teile: Unterbricht die Person, die dran ist, einen Hinweis (`bargeIn`), oder ersetzt eine neuere Ansage mit demselben Zweck die alte (etwa „wer ist dran“), fällt der ganze Rest weg. Teile, die die Sprachausgabe noch nicht begonnen hat, werden gar nicht mehr erzeugt, damit die nächste Ansage nicht dahinter wartet. Nur die gerade laufende Synthese läuft zu Ende, gespielt wird sie nicht, und die Schlange wartet nicht auf sie. Zwischen zwei Teilen kommt keine andere Ansage.
- Eine Ansage gilt vom Beginn ihres ersten Teils bis zum Ende ihres letzten als „der Bot spricht“, auch in einer Pause, in der der nächste Teil noch erzeugt wird. Auf einem langsamen Server kann das bei Multiple Choice gut eine Sekunde sein. Barge-in verwirft auch in dieser Pause den Rest. Wer nicht dran ist, kann dort ebenso wenig unterbrechen, und eine Antwort in der Pause einer Frage wird wie beim Sprechen ignoriert, auch wenn sie erst nach dem letzten Teil fertig ist. Kommt der nächste Teil nicht innerhalb von 15 s (`PART_GAP_LIMIT_MS`, etwa weil die Sprachausgabe hängt), verwirft der Bot den Rest der Ansage, schreibt eine Warnung ins Log und hört wieder zu. So bleibt er bei einer hängenden Engine stumm, aber nicht taub. Die 15 s sind großzügig gewählt: Piper braucht auf 1 vCPU selten mehr als 4 s für einen Satz.
- Der Echo-Schutz vergleicht mit dem Teil, der gerade spielt, und in der Pause mit dem Teil davor.
- Jede einzelne Synthese hat eine Frist von 10 s + 60 ms je Zeichen (246 Zeichen: 24,8 s, etwa das Dreifache dessen, was Piper auf 1 vCPU braucht). Verliert Piper eine Antwort oder hängt der Worker, gibt der Bot diesen Satz danach auf, beendet den Piper-Prozess und startet ihn beim nächsten Satz neu. Ins Log kommt eine Warnung ohne den Ansagetext. So bleibt der Bot auch dann nicht dauerhaft stumm, wenn die Ansage vorher per Barge-in, Ersatz oder Spielende verworfen wurde. Das gilt mit und ohne Satzteilung; bei `say` wird der Prozess nach der Frist beendet.

**`ttsDiskCache`: feste Sätze auf Platte.** Sätze, die immer gleich lauten („Jetzt die anderen! Wer es weiß, ruft: Hier!“, „Okay. Deine Antwort?“, Regel- und Hilfesätze), legt der Bot als Audio unter `<dir>/tts-cache/` ab, also `.qbhost/voice/tts-cache/`, auf dem Server im `data/`-Volume. Sie überleben Neustarts und klingen sofort (`⏱ ansage … cache=ja`, gemessen 0 ms statt ~0,5 s auf dem Mac).
- Auf die Platte kommt nur, was in `FIXED_LINES` (`src/voice/narration.ts`) steht, und zwar nur genau dieser Text oder genau einer seiner Teile. Diese Sätze enthalten keine Namen, Punkte, Kategorien, Fragen, Antworten oder Lösungen. Ein Satz mit Spielinhalt landet nie auf der Platte, auch dann nicht, wenn er mit einem festen Satz beginnt.
- Dateiname: SHA-256 aus Engine, Stimme, Sprechtempo und Text. Eine andere Stimme oder ein anderes Tempo trifft also nie alte Dateien. Geschrieben wird erst in eine `.part`-Datei, dann umbenannt. Kaputte oder fremde Dateien ignoriert der Bot und schreibt sie neu. Beim Start prüft er von jeder Datei Kopf und Länge; nur geprüfte Dateien zählen als `cache=ja`. Der Ordner darf jederzeit gelöscht werden.
- **Vorwärmen:** Nach dem Beitritt erzeugt der Bot fehlende feste Sätze bis 80 Zeichen im Hintergrund. Das geschieht nur, wenn seit 3 s nichts gesprochen, erkannt oder erzeugt wurde, und immer nur ein Satz auf einmal. Nach jedem Satz wartet er wieder volle 3 s Ruhe ab, damit ein Server mit 1 vCPU nie lange am Stück mit Piper belegt ist. In Discord zählt schon der Sprechbeginn einer Person als Aktivität, bis ihre Äußerung verarbeitet ist. Im Loopback-Raum (Harness) gibt es kein Signal für den Sprechbeginn, dort zählt erst die fertige Äußerung. Eine echte Ansage wartet im schlechtesten Fall hinter dem einen kurzen Satz, der gerade erzeugt wird. Das gilt auch, wenn jemand während dieser Synthese zu sprechen beginnt, denn sie lässt sich nicht abbrechen. Längere feste Sätze (Hilfe, Regeln) landen beim ersten echten Sprechen im Cache. Da der Cache Neustarts überlebt, läuft das Vorwärmen nur beim ersten Start mit einer Stimme.
- Mit `ttsSplitSentences` speichert der Bot die einzelnen Teile fester Sätze, nicht die ganzen Sätze. Nach dem Umschalten werden sie deshalb einmal neu erzeugt.

`⏱`-Zeilen mit Satzteilung: Jeder Teil bekommt eine eigene `⏱ ansage`-Zeile. `⏱ reaktion` misst bis zum ersten hörbaren Teil. Bei späteren Teilen enthält `warte` auch die Zeit, in der die Teile davor gesprochen wurden. `tts` beginnt bei geteilten Ansagen genau dann, wenn die Sprachausgabe den Teil übernimmt. Wartet eine Ansage hinter einem Satz, der gerade vorgewärmt wird, zählt diese Zeit zu `warte`, nicht zu `tts`. Wird Teil 1 nie hörbar (keine Synthese, Wiedergabe gescheitert), misst `reaktion` bis zum nächsten hörbaren Teil.

## Latenz messen

Mit `voice.latencyLog` (Standard `true`) schreibt der Bot `⏱`-Zeilen auf die Log-Ebene `info`. Sie enthalten nur Schlüssel=Wert-Paare mit Engine, Zählern und Millisekunden, nie erkannten oder gesprochenen Text, Namen oder Lösungen. So lassen sich Mac, VPS, lokale und Cloud-Engines mit demselben Log vergleichen. Gemessen wird nur über Zeitstempel, der Sprachpfad wartet auf nichts davon. Mit `latencyLog: false` entsteht keine einzige `⏱`-Zeile.

```
⏱ erkennung engine=whisper:large-v3-turbo-q5_0 attention=answer audio=2300ms stt=412ms rueckfall=nein
⏱ ansage engine=piper:de_DE-thorsten-high zeichen=42 tts=310ms cache=nein warte=0ms
⏱ reaktion gesamt=1840ms pause=900ms stt=412ms logik=35ms tts=310ms start=183ms
⏱ bilanz n=12 stt_p50=… stt_p90=… tts_p50=… tts_p90=… reaktion_p50=… reaktion_p90=… verworfen=7 rueckfaelle=0
```

**`erkennung`** – eine Zeile je Äußerung, die der Bot verwendet, also genau die, deren Transkript er in den Chat schreibt: Sprachbefehl, Buzzer, Kartenwahl, Menüauswahl, Antwort mit Schlüsselwort, „Ja“/„Nein“ in der Rückfrage. Alles andere bekommt keine Zeile und zählt nur in `verworfen` der Bilanz (Regel 8: Nebengespräche nicht auf `info`): eine Prüfung auf den Rufnamen ohne „Quizmaster“, Nebengespräch und lautes Nachdenken, nichts erkannt, Echo. Die Zeile entsteht in dem Moment, in dem der Bot die Äußerung verwendet; ihre Zeiten sind dann schon gemessen, eine lange oder fehlschlagende Bewertung verschiebt sie nicht.
- `engine`: Spracherkennung und Modell. Liefen zwei Durchgänge mit verschiedenen Modellen (Rückfrage mit neuer Antwort, schnelles Modell fiel aus), stehen beide mit `+` verbunden.
- `attention`: wie genau der Bot zuhörte (`answer`, `confirm`, `full`, `wake`).
- `audio`: Länge der Aufnahme.
- `stt`: Zeit vom Eingang der fertigen Äußerung bis zum erkannten Text, alle Durchgänge zusammen.
- `rueckfall`: `ja`, wenn eine andere Engine übernehmen musste: Die Cloud fiel aus und die lokale Erkennung hörte dieselbe Äußerung (`engine=deepgram:nova-3+whisper:…`), die Cloud war nach Fehlern pausiert (`engine=whisper:…`), oder das schnelle Modell fiel aus und das Hauptmodell übernahm (`engine=schnell+haupt`). Jeder Rückfall zählt in `rueckfaelle` der Bilanz, auch bei Äußerungen ohne eigene Zeile.

**`ansage`** – eine Zeile je Satz, sobald er hörbar startet. Ein Satz, der nie abgespielt wird (Wiedergabe scheitert, Discord startet nicht), bekommt keine Zeile.
- `engine`: Sprachausgabe und Stimme.
- `zeichen`: Länge des gesprochenen Satzes in Zeichen.
- `tts`: reine Synthesedauer, vom tatsächlichen Start der Synthese bis zum fertigen Audio. Wartet ein Satz hinter einer noch laufenden Synthese (Piper arbeitet einen Satz nach dem anderen ab), beginnt die Messung erst, wenn diese fertig ist.
- `cache`: ob das Audio aus dem Satz-Cache kam (`CachedTts`, wiederkehrende Sätze wie „Buzzer frei!“). Dann ist `tts` die Wartezeit auf das schon vorhandene Audio, zählt nicht in `tts_p50/p90` der Bilanz und hält den nächsten Satz nicht auf.
- `warte`: Zeit, die der Satz ohne eigene Synthese verbrachte, also das Warten auf eine laufende Synthese davor plus das Warten, bis der vorige Satz zu Ende gesprochen war.

**`reaktion`** – Zeit vom Ende einer Äußerung bis zum ersten Ton der Antwort. Gezählt wird der erste Satz, der in die Schlange kommt, nachdem der Bot eine Äußerung verwendet hat (siehe `erkennung`); auf Nebengespräche und lautes Nachdenken folgt also nie eine Reaktion. Kommt der Satz später als 15 s nach dem Ende der Spiellogik, gibt es keine Zeile. Eine neuere verwendete Äußerung ersetzt eine ältere, die noch auf ihre Antwort wartet; ein Nebengespräch dazwischen ändert nichts. Bei der Kartenwahl ist die Reaktion die vorgelesene Frage. Wird der Antwortsatz vor dem Abspielen ersetzt, verworfen oder scheitert seine Synthese, gibt es keine Reaktionszeile. Die Teile ergeben zusammen `gesamt`.
- `gesamt`: Ende des Sprechens bis zum Wiedergabestart der Antwort.
- `pause`: Ende des Sprechens bis zum Eingang beim Bot, also vor allem die Stille, an der das Ende erkannt wird (`silenceMs`).
- `stt`: Eingang bis erkannter Text, wie in `erkennung`.
- `logik`: erkannter Text bis zum Einreihen der Antwort, also Spiellogik und Bewertung (auch ein LLM-Aufruf).
- `tts`: reine Synthesedauer der Antwort, wie in `ansage`.
- `start`: alles zwischen Einreihen und Ton außer der Synthese: Warten auf eine laufende Synthese, auf den vorigen Satz und bis der Transport wirklich abspielt.

**`bilanz`** – am Ende jedes Spiels (auch bei `!quiz ende` und wenn das Spiel abbricht) und beim Verlassen des Voice-Channels, danach beginnt die Zählung neu. `n` ist die Zahl der `erkennung`-Zeilen. `stt_p50/p90` zählen alle vollständig erkannten Äußerungen, auch die verworfenen (ohne die kurze Prüfung auf den Rufnamen), denn die Erkennung kostet dieselbe Zeit. Dazu kommen p50/p90 von `tts` (ohne Cache-Treffer) und `reaktion.gesamt`, `verworfen` und `rueckfaelle`. Wurde seit der letzten Bilanz nichts vollständig erkannt, gibt es keine; Spielende und Verlassen direkt nacheinander ergeben also nur eine. Auch Plaudern nach dem Spiel ohne „Quizmaster“ erzeugt beim Verlassen keine Bilanz mit `n=0`; diese Verwerfungen erscheinen in `verworfen` der nächsten Bilanz.

**Auswerten:** `tools/voice-latency.ts` liest ein Log von stdin und gibt p50/p90 je Schritt und Engine aus. Es nimmt nur Zeilen im Format des Loggers (`12:00:00 [voice] ⏱ …`, auch hinter dem Präfix von `docker compose logs`) und verträgt ANSI-Farben und CRLF.

```sh
npx tsx tools/voice-latency.ts < .qbhost/voice-e2e.log
ssh quizmaster-vps 'docker compose -f /opt/quizmaster/app/deploy/compose.yml logs --no-color bot' | npx tsx tools/voice-latency.ts
```

Grenzen: Der Wiedergabestart kommt vom Transport (`play(pcm, { onStart })`). Discord meldet ihn, sobald der Player auf „Playing“ wechselt, Loopback sofort. Ein Transport ohne `onStart` (`reportsStart`) zählt den Aufruf von `play`. Der Start der Synthese wird für Engines geschätzt, die einen Satz nach dem anderen bearbeiten (Piper). Bei `say`, das parallel synthetisiert, kann `tts` deshalb zu kurz sein. Im Loopback-Raum (Harness) ist `pause` fast 0, weil der Client eine fertige WAV schickt und es keine Stillerkennung gibt. In Discord steckt dort `silenceMs`, Loopback-Reaktionen sind also um diese Zeit kürzer.

## Ohne Discord testen

`LoopbackTransport` (`src/voice/loopback.ts`) stellt einen „Voice-Raum“ per HTTP bereit: `POST /speak` liefert eine WAV als Äußerung an den Bot, `GET /played` liefert, was der Bot gesagt hat. Damit lassen sich ganze Runden mit synthetischen Spielern (macOS `say`) gegen das echte quiz-base fahren, siehe AGENTS.md. Der Harness (`tools/voice-e2e/harness.ts`) löscht beim Start die Hörpositionen alter Läufe (`seq-*.txt`) und gibt bei einem erneuten `!quiz voice` einen frischen Raum auf demselben Port zurück, der die Nummerierung fortsetzt.
