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
| `whisperModel` | `models/ggml-large-v3-turbo-q5_0.bin` | genaues Hauptmodell (Antworten) |
| `whisperFastModel` | leer (aus) | zweites, schnelles Modell für alles außer Antworten, eigener whisper-server auf `whisperPort + 1` |
| `whisperAudioCtx` | `0` (volles Fenster) | Audiofenster `-ac` für whisper-server; 512 ≈ 10 s, begrenzt `maxSpeechSec` entsprechend |
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
- `rueckfall`: ob eine andere Engine übernehmen musste. Heute immer `nein`, die Provider-Schicht (Cloud → lokal) füllt das Feld. Auch der Ausfall des schnellen Modells, bei dem das Hauptmodell übernimmt, zählt noch nicht als Rückfall (dann steht nur `engine=schnell+haupt`).

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

**`bilanz`** – am Ende jedes Spiels (auch bei `!quiz ende` und wenn das Spiel abbricht) und beim Verlassen des Voice-Channels, danach beginnt die Zählung neu. `n` ist die Zahl der `erkennung`-Zeilen. `stt_p50/p90` zählen alle vollständig erkannten Äußerungen, auch die verworfenen (ohne die kurze Prüfung auf den Rufnamen), denn die Erkennung kostet dieselbe Zeit. Dazu kommen p50/p90 von `tts` (ohne Cache-Treffer) und `reaktion.gesamt`, `verworfen` und `rueckfaelle`. Hat seit der letzten Bilanz niemand gesprochen, gibt es keine; Spielende und Verlassen direkt nacheinander ergeben also nur eine.

**Auswerten:** `tools/voice-latency.ts` liest ein Log von stdin und gibt p50/p90 je Schritt und Engine aus. Es nimmt nur Zeilen im Format des Loggers (`12:00:00 [voice] ⏱ …`, auch hinter dem Präfix von `docker compose logs`) und verträgt ANSI-Farben und CRLF.

```sh
npx tsx tools/voice-latency.ts < .qbhost/voice-e2e.log
ssh quizmaster-vps 'docker compose -f /opt/quizmaster/app/deploy/compose.yml logs --no-color bot' | npx tsx tools/voice-latency.ts
```

Grenzen: Der Wiedergabestart kommt vom Transport (`play(pcm, { onStart })`). Discord meldet ihn, sobald der Player auf „Playing“ wechselt, Loopback sofort. Ein Transport ohne `onStart` (`reportsStart`) zählt den Aufruf von `play`. Der Start der Synthese wird für Engines geschätzt, die einen Satz nach dem anderen bearbeiten (Piper). Bei `say`, das parallel synthetisiert, kann `tts` deshalb zu kurz sein. Im Loopback-Raum (Harness) ist `pause` fast 0, weil der Client eine fertige WAV schickt und es keine Stillerkennung gibt. In Discord steckt dort `silenceMs`, Loopback-Reaktionen sind also um diese Zeit kürzer.

## Ohne Discord testen

`LoopbackTransport` (`src/voice/loopback.ts`) stellt einen „Voice-Raum“ per HTTP bereit: `POST /speak` liefert eine WAV als Äußerung an den Bot, `GET /played` liefert, was der Bot gesagt hat. Damit lassen sich ganze Runden mit synthetischen Spielern (macOS `say`) gegen das echte quiz-base fahren, siehe AGENTS.md. Der Harness (`tools/voice-e2e/harness.ts`) löscht beim Start die Hörpositionen alter Läufe (`seq-*.txt`) und gibt bei einem erneuten `!quiz voice` einen frischen Raum auf demselben Port zurück, der die Nummerierung fortsetzt.
