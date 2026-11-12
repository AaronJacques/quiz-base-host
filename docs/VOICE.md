# Sprachsteuerung (Discord-Voice)

Der Bot kommt in euren Voice-Channel, moderiert das Quiz mit Stimme und versteht, was ihr sagt: Karten, Antworten, „Hier!“ zum Buzzern und Befehle. Tippen ist nur noch für einen Befehl nötig (`!quiz voice` oder `!quiz neu`), auf quiz-base selbst gebt ihr nur euren Namen ein.

**Alles läuft lokal** auf dem Rechner mit dem Bot, kostenlos und ohne Cloud:

| Teil | Werkzeug | Zeit pro Satz (Apple M4) |
|---|---|---|
| Spracherkennung (STT) | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `large-v3-turbo` (quantisiert, 550 MB), dauerhaft geladen | ~0,5–1 s |
| Sprachausgabe (TTS) | [Piper](https://github.com/OHF-Voice/piper1-gpl) Stimme `de_DE-thorsten-high`, dauerhaft geladen | ~0,2–0,5 s |
| Voice-Verbindung | `@discordjs/voice` mit DAVE (Ende-zu-Ende-Verschlüsselung), Opus per WebAssembly | – |

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
| „Quizmaster, los“ | Start erzwingen (Spielleitung) |
| „Quizmaster, das war richtig / falsch“, „weiter“ | Bewertung überstimmen / Buzzer-Runde überspringen (Spielleitung), wie `!quiz richtig/falsch/skip` (siehe DISCORD.md) |
| „Quizmaster, Spiel beenden“ | Spiel beenden (Spielleitung). Nur ganze Sätze wie „Spiel beenden“, „beende das Spiel“, „Quiz beenden“, „Schluss“, „wir hören auf“ – nie ein Wort mitten im Satz („kannst du aufhören zu reden“, „Schlussrunde“) |
| „Quizmaster, tschüss“ | Bot verlässt den Voice-Channel |
| „Quizmaster, Hilfe“ | sagt die Befehle an |

Alles, worauf der Bot reagiert, steht als kleine Zeile im Text-Channel des Spiels (`🎙️ Anna: „Sport für 200“`), damit man Hörfehler sieht. Gesprochenes gehört immer zum Spiel-Channel, auch wenn der Bot mit `!quiz voice` aus einem anderen Channel gerufen wurde. Die Spielleitung kann wie gewohnt per Chat korrigieren (`!quiz richtig`, `!quiz korrektur Anna +100`).

## Datenschutz

- Der Bot sagt beim Beitritt an, dass er zuhört. Er verarbeitet Sprache nur, solange er im Channel ist, und **speichert keine Aufnahmen**.
- Erkannte Sätze landen nur dann im Text-Channel, wenn der Bot darauf reagiert (Karte, Antwort mit Schlüsselwort, Ja/Nein, Befehl). Von allen, die nicht dran sind, wird nur der Anfang einer Äußerung auf den Rufnamen geprüft. Lautes Nachdenken der Person, die dran ist, wird erkannt, aber weder gespeichert noch gepostet.
- Nach 20 Minuten ohne Spiel und ohne Sprache verlässt der Bot den Channel von selbst.

## Tipps & Grenzen

- **Kopfhörer**: Wer den Bot über Lautsprecher hört, schickt seine Stimme zurück ins Mikro. Was jemand sagt, **während der Bot spricht**, wird deshalb ignoriert (`voice.ignoreWhileSpeaking`). Also kurz ausreden lassen. Bei Musikfragen sind Kopfhörer Pflicht.
- Eine Äußerung endet nach ~0,9 s Pause (`voice.silenceMs`). Wer lange Pausen macht, wird früher „abgeschnitten“ – dann einfach weiterreden, die Antwort zählt aber nur einmal.
- Bildfragen: Der Bot sagt „Schaut euch dazu das Bild auf Quiz Base an“ – das Bild sieht man nur im Browser.
- Für Hinweise gibt der Bot Whisper die Kategorien, die Punktwerte des Boards („Sport für 100, 100, 200, …“ – sonst wird „hundert“ schon mal zu „Hunde“) und die Spielernamen mit. **Nie die Lösung**, sonst würde Whisper die richtige Antwort „hören“.
- Gesprochene Antworten werden **nach Klang** bewertet: Aus „Breaking Bad“ macht die Erkennung schon mal „Preaking Bat“ – das zählt ohne LLM. Gleicher Klang allein reicht aber nicht: Zahlen („Apollo 13“ ≠ „Apollo 11“), Vokale („Homburg“ ≠ „Hamburg“, „Guinea“ ≠ „Kenia“) und die grobe Schreibweise müssen auch passen, sonst entscheidet das LLM. Eine verschluckte Antwort wie „Preakidad“ wird nie ohne LLM als falsch gewertet. Kategorien werden ebenfalls nach Klang zugeordnet („Flecken“ → „Flaggen“, Kölner Phonetik).
- Nach der Frage sagt der Bot nur den **Kern der Lösung** an (erster Satz, ohne Klammern und lange Erklärung nach einem Gedankenstrich). Die volle Notiz steht im Chat.
- Solange der Bot moderiert, gibt es **+10 s** Antwort- und Buzzerzeit (`voice.extraTimeSec`, nach Buzzer die Hälfte), weil das Vorlesen Zeit kostet. Der Bonus ist ein eigener Wert (`game.bonusTimeSec`) neben den Regeln: `!quiz regel zeit 30` ergibt mit Voice 40 s, ohne 30 s; `!quiz regeln reset` und Verbindungsabbrüche lassen ihn nicht wachsen oder verschwinden. `!quiz regeln` zeigt ihn an.
- Bricht die Voice-Verbindung ab (Kick, Netz), meldet der Bot das im Chat und gibt die Zusatzzeit zurück; `!quiz voice` holt ihn zurück.
- Stürzt whisper-server ab, startet der Bot ihn bei der nächsten Erkennung neu (wie Piper). Ein whisper-server, den ein hart abgebrochener früherer Lauf zurückgelassen hat, wird übernommen und beim Beenden mit gestoppt.
- Ein Voice-Channel gleichzeitig pro Bot-Instanz.

## Einstellungen (`voice` in `qbhost.config.json`)

| Option | Standard | Bedeutung |
|---|---|---|
| `enabled` | `true` | Sprachsteuerung an (wenn eingerichtet) |
| `autoJoin` | `true` | bei `!quiz neu` automatisch in den Voice-Channel der Spielleitung |
| `tts` | `piper` | `piper` oder `say` (macOS) |
| `piperLengthScale` | `0.95` | Sprechtempo (>1 langsamer) |
| `silenceMs` | `900` | Pause, die eine Äußerung beendet |
| `minSpeechMs` / `minRms` | `350` / `250` | kürzere/leisere Geräusche werden verworfen |
| `ignoreWhileSpeaking` | `true` | Echo-Schutz |
| `wakeWords` | `quizmaster`, … | Rufnamen |
| `scoresEvery` | `3` | Zwischenstand nach jeder n-ten Frage |
| `extraTimeSec` | `10` | zusätzliche Antwort-/Buzzerzeit, solange der Bot spricht (setzt `game.bonusTimeSec`) |

## Ohne Discord testen

`LoopbackTransport` (`src/voice/loopback.ts`) stellt einen „Voice-Raum“ per HTTP bereit: `POST /speak` liefert eine WAV als Äußerung an den Bot, `GET /played` liefert, was der Bot gesagt hat. Damit lassen sich ganze Runden mit synthetischen Spielern (macOS `say`) gegen das echte quiz-base fahren, siehe AGENTS.md. Der Harness (`tools/voice-e2e/harness.ts`) löscht beim Start die Hörpositionen alter Läufe (`seq-*.txt`) und gibt bei einem erneuten `!quiz voice` einen frischen Raum auf demselben Port zurück, der die Nummerierung fortsetzt.
