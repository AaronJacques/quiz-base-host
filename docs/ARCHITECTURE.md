# Architektur

## Leitprinzipien

1. **Deterministisch zuerst, LLM zuletzt.** Alles, was sich mit Code entscheiden lässt, wird mit Code entschieden. Das LLM ist ein austauschbarer *Bewertungs-Baustein*, nicht der Steuermann. Deshalb läuft der Host problemlos mit Haiku.
2. **Eine Stelle pro Wissen.** DOM-Wissen über quiz-base steht nur im Probe, Spielregeln nur in `rules.ts`, Konfiguration nur in `config.ts`.
3. **Schichten kommunizieren über Interfaces und einen Event-Bus**, nie über konkrete Klassen. Konkrete Klassen werden nur in `app.ts` (Composition Root) zusammengesteckt.

## Schichten

```
src/
├── cli.ts                 Kommandozeile (discord, host, boards, login, board-create, probe, judge, doctor)
├── app.ts                 CLI-Modus: eine Runde mit Terminal + Spieler-Pult
├── board-cli.ts           `qbhost login` (sichtbarer Browser, Nutzer meldet sich selbst an) und `qbhost board-create`
├── board-studio.ts        BoardStudio = Generator + Register + Board-Editor im eingeloggten Browser; vom CLI und vom Bot genutzt
├── session.ts             GameSession = eine Runde (Browser, Bus, Controller, Judge); vom CLI und vom Bot genutzt
├── config.ts              Zod-Schema mit allen Einstellungen + Defaults
│
├── core/                  framework-freie Basis
│   ├── types.ts           Domänenmodell (TafelquizState, QuestionState, …)
│   ├── events.ts          typisierter EventBus (host:* raus, player:*/operator:* rein); Fehler eines Handlers (auch async) werden geloggt, nie weitergereicht
│   └── logger.ts
│
├── browser/               "Wie kommt JS in einen Tab?"  – kein quiz-base-Wissen
│   ├── driver.ts          BrowserDriver-Interface: open, goto, evaluate(expr), screenshot
│   ├── playwright-driver.ts   eigener Chromium (persistentes Profil) + CDP-Attach an Chrome
│   └── orca-driver.ts     Orca-Built-in-Browser über `orca eval/goto/screenshot`
│
├── site/                  "Wie sieht quiz-base aus?"  – das gesamte DOM-Wissen
│   ├── lobby.ts           Wizard: Format → öffentliches oder eigenes Board → Vorschau → Warteraum
│   ├── editor/            Account-Menü, Tafelquiz-Board-Editor (`/configure-lobby?format=tafelquiz`), „Meine Boards“
│   │   ├── probe.browser.js   In-Page-Skript: Login-Status, Editor-Schritte, Speichern-Dialog, Meine Boards (reines Browser-JS)
│   │   ├── page.ts            BoardEditorPort + Fassade über dem Probe (speichern, Editor-Link, löschen)
│   │   └── writer.ts          writeBoard(): Board über den Port eintragen, jede Eingabe zurücklesen, speichern
│   └── tafelquiz/
│       ├── probe.browser.js   In-Page-Skript: readState() + Aktionen (reines Browser-JS)
│       └── page.ts            typisierte Fassade (TafelquizPort) über dem Probe
│
├── modes/                 "Wie wird das Spiel geleitet?"
│   ├── mode.ts            GameMode-Interface
│   └── tafelquiz/
│       ├── controller.ts  Zustandsmaschine Lobby → Board → Frage → Buzzer → Ergebnis
│       └── rules.ts       Punkteregeln (reine Funktion)
│
├── judge/                 "Ist die Antwort richtig?"
│   ├── normalize.ts       Normalisierung, Levenshtein, Zahlen, Lösungsvarianten
│   ├── number-words.ts    deutsche Zahlwörter → Werte ("neunzehnhundertsiebenundsiebzig" = 1977, "vierte", "eins komma fünf")
│   ├── fuzzy-judge.ts     kostenlos, konservativ ("unsure" statt raten); nie "richtig" für Absicherungen ("A oder B", "nicht A", Listen); Zahlenregeln
│   ├── llm-judge.ts       Bewertung + Lösen von Bildfragen per LLM
│   ├── operator-judge.ts  Mensch im Terminal
│   ├── cascade-judge.ts   Chain of Responsibility mit Cache vor teuren Stufen
│   └── cache.ts           persistenter Cache (.qbhost/judge-cache.json); Schlüssel mit Medienidentität (Bild-URLs, Audio-Titel)
│
├── llm/                   "Wie rede ich mit Claude?"
│   ├── client.ts          LlmClient-Interface (einmalige JSON-Antwort) + UsageMeter
│   ├── claude-cli.ts      `claude -p` headless, ohne Tools/MCP/Settings → Abo statt API-Key
│   └── anthropic-api.ts   offizielles SDK, messages.parse + Zod, effort "low"
│
├── boardgen/              "Wie entsteht ein neues Board?"  – ohne Browser
│   ├── spec.ts            BoardSpec (Parameter), Niveaus, Fingerprint (gleiche Anfrage = gleiches Board), MC-Plätze
│   ├── schema.ts          Zod-Schemas der LLM-Ausgabe (bewusst locker) + fertiges Board
│   ├── prompts.ts         Erzeugung, Prüfrunde, gezielte Reparatur (stabile System-Prompts)
│   ├── validate.ts        deterministische Prüfregeln: Anzahl, Längen, Dubletten, Lösung in der Frage, Notiz-Trenner
│   ├── generator.ts       erzeugen → prüfen → Retry mit Fehlerliste → Prüfrunde → Reparatur → Board bauen
│   ├── cost.ts            Kostenschätzung vorab (Abo vs. API)
│   ├── store.ts           .qbhost/boards/: Entwürfe mit Lösungen + Register (Fingerprint → Board → Link)
│   └── format.ts          öffentliche Vorschau (ohne Lösungen) / volle Vorschau (DM, Terminal)
│
├── discord/               Discord-Bot (Hauptbedienung)
│   ├── gateway.ts         ChatGateway-Interface (testbar ohne Discord)
│   ├── discord-gateway.ts discord.js-Implementierung
│   ├── bot.ts             Befehle, Verknüpfung Discord↔quiz-base, Kartenwahl, Antworten, Rendering
│   ├── pick-parser.ts     "nin 200" → Karte + Prüfung frei/schon weg (reine Funktion)
│   ├── board-flow.ts      `!quiz erstellen`: Rückfrage + Kosten → erzeugen → Vorschau (Channel) / Lösungen (DM) → anlegen
│   ├── create-parser.ts   "Star Wars 5x4 profi mc 25%" → BoardSpec (reine Funktion)
│   ├── store.ts           pro Server: Verknüpfungen + Regeln (.qbhost/discord/)
│   └── format.ts          Hilfe-/Regeltexte
│
├── voice/                 "Wie spricht und hört der Host?"  (alles lokal)
│   ├── transport.ts       VoiceTransport-Interface: play(pcm), onUtterance(pro Sprecher)
│   ├── discord-voice.ts   @discordjs/voice: Opus empfangen/dekodieren, Sprache als Opus abspielen (DAVE)
│   ├── opus.ts            eigene Anbindung an libopus (WASM aus opusscript): Decoder pro Sprecher, Encoder, Paketprüfung
│   ├── loopback.ts        Voice-Raum per HTTP – Tests und Agenten-Spieler ohne Discord
│   ├── stt.ts             whisper.cpp-Server (warm, startet nach Absturz neu), Halluzinationsfilter
│   ├── children.ts        ein gemeinsamer Exit-Hook, der whisper-server/Piper mit dem Prozess beendet
│   ├── tts.ts             Piper (Python-Worker, warm) oder macOS say, mit Cache
│   ├── voice-host.ts      Sprechwarteschlange (nächster Satz wird vorab erzeugt), Echo-Schutz, Lautstärke-/Längenfilter
│   ├── commands.ts        Rufname „Quizmaster“, Sprachbefehle, „Buzzer!“, gesprochene Zahlen
│   ├── narration.ts       Moderationstexte (reine Funktionen)
│   └── index.ts           VoiceKit-Fabrik, `qbhost voice-setup`
│
└── channels/              "Wie reden Menschen mit dem Host?"
    ├── channel.ts         Channel-Interface
    ├── terminal.ts        Operator-Konsole
    └── web/               Spieler-Pult (HTTP + Server-Sent Events, ohne Dependencies)
```

## Datenfluss einer Frage

```
controller.onBoard     host:turn ───────────────► Spieler-Pult zeigt Raster
                       ◄─────────────── player:pick (Spieler am Zug tippt "Nintendo 200")
page.openCell(col,row) ──► quiz-base öffnet Frage für alle
controller.onQuestion  host:question ───────────► Pult zeigt Frage
                       resolveReference() läuft parallel: Notiz → MC-Option → Cache → Vision-LLM
page.startTimer(45)    host:await-answer ───────► Pult zeigt Eingabefeld + Countdown
                       ◄─────────────── player:answer-pending "luigi mario" (nur Sprache, Rückfrage „Luigi Mario?“)
judge.prejudge()       Fuzzy → Cache → Haiku im Hintergrund, ohne Operator, nichts öffentlich
                       ◄─────────────── player:answer "luigi mario" (getippt, oder „Ja“)
judge.judge()          Ergebnis von prejudge (gleiche Frage, Person, Antwort), sonst: Fuzzy ─(unsicher)─► Cache ─(Miss)─► Haiku ─(Fehler)─► Operator (Lösung nur per host:notice.detail)
page.award(±)          quick buttons (+Wert/+½/−½) oder manueller Punkte-Dialog
page.animate()         "Richtig"/"Falsch"-Animation für alle
(falsch) buzzerRound   releaseBuzzer → warten auf "X hat gebuzzert" (feste Fensterlänge, skip beendet) → erneut fragen/bewerten
page.closeQuestion()   quiz-base gibt den Zug weiter → nächster onBoard-Durchlauf
```

Jeder Warteschritt läuft über `whilePage()`: Ändert ein Mensch im Browser den Zustand (Frage manuell geöffnet/geschlossen, Spiel beendet), bricht das Warten ab und die Hauptschleife liest den neuen Zustand. Die Phasen-Handler sind idempotent, daher kann qbhost auch in ein laufendes Spiel einsteigen.

**Spielende mitten in der Frage:** `GameSession.endGame()` stoppt zuerst den Controller (AbortSignal) und klickt erst dann „Spiel beenden“. Der Controller prüft das Signal nach jedem Warten und nach der Bewertung: Eine abgeschnittene Frage bekommt kein Verdict, keine Punkte, keine Auflösung und keine weiteren Klicks. `close()` wartet, bis „Spiel beenden“ durch ist, bevor der Browser zugeht.

**Zahlen und Jahre** entscheidet der Fuzzy-Stage selbst, ohne LLM (`judgeNumbers` in `fuzzy-judge.ts`). `number-words.ts` liest Ziffern und deutsche Zahlwörter als Werte, auch zusammengesetzt und über mehrere Wörter („neunzehnhundertneunundsiebzig“ = 1979, „neunzehn siebenundsiebzig“ = 1977, „zweitausend fünf“, „der vierte“, „eins komma fünf“, „1,5 Millionen“). Ist die Lösung nur eine Zahl, ist eine andere Zahl falsch und dieselbe richtig, Einheiten und Füllwörter („im Jahr 1977“, „4 Mal“, „1979 glaube ich“) zählen nicht (R1). Fragt die Frage nach dem Jahr, gilt die Kurzform „77“ für 1977. Sonst gilt: gleiche Wörter und eine andere Zahl sind falsch („Apollo 13“ für „Apollo 11“, „Rot Vier“ für „Rot 2“, R2), und bei einer Jahresfrage zählt das eine Jahr einer längeren Lösung („1979“ für „25. Mai 1977“, R3). Diese Fälle gehen weiter an den LLM (R0): Schätzungen und Grenzen („ca.“, „über“, „mindestens“), Bereiche („1939–1945“), römische Zahlen, „1.500“ (Tausenderpunkt oder Dezimalpunkt?) und „Millionen“ nur auf einer Seite. An den LLM gehen auch gerundete Werte („42“ oder „42,2“ für 42,195 km, „3,14“ für 3,14159), verschiedene Einheiten („6 Wochen“ für „6 Tage“, „1,5 Stunden“ für „90 Minuten“), Zahlen in mehreren Teilen („12 000“, „19 77“) und Antworten mit anderen Wörtern („Eine neue Hoffnung“ für 4). Leitlinie: Eine richtige Antwort wird nie deterministisch falsch. Ein Wert, den die Lösung irgendwo nennt, auch in Klammern („1977 (1978 in Deutschland)“), ist deshalb nie „falsch“, und im Zweifel entscheidet der LLM. Wörter der Frage neben der Zahl zählen nicht als Inhalt („acht Beine“ auf „Wie viele Beine …?“), bei einer Jahresfrage auch ein Monat („Mai 1977“), solange die Lösung selbst keinen nennt. Der LLM bekommt dann die gelesenen Werte mit (`Zahlenwerte (automatisch gelesen): Antwort 42 | Lösung 42,195`), bei unklaren Schreibweisen jede Lesart („Lösung 12000 oder 12“). Die Klangregel für gesprochene Antworten gilt nicht für Zahlen. Mit neuen Bewertungsregeln steigt `JUDGE_RULES_VERSION`. `createJudge` löscht dann einmal je Prozess die LLM-Urteile anderer Versionen aus dem Cache (`JudgeCache.prune`). Urteile der Spielleitung und Lösungen bleiben.

**Geheimhaltung:** Was die Lösung enthalten kann (Notiz, LLM-Lösung, LLM-Begründung), geht vor `host:reveal` nur in `host:notice.detail` (DM an die Spielleitung, Operator-Konsole). Für erzeugte Boards gilt dasselbe: Fragen, Lösungen, Prüfbefunde und Warnungen gehen nur per DM an die anfragende Person bzw. ins Terminal, nie in einen Channel oder ins `info`-Log. `host:say` ist öffentlich (Web-Pult). Das Web-Pult bekommt `verdict.reason` nie, Discord hält Begründungen bis zur Auflösung zurück, und das `info`-Log zeigt weder LLM-Lösung noch LLM-Begründung (nur `debug`).

## Ein Board erzeugen und anlegen

```
!quiz erstellen … / board-create   BoardSpec (Parameter) ── Fingerprint im Register? → vorhandenes Board / Entwurf
                                   Kostenschätzung ── Bestätigung
BoardGenerator                     1 Aufruf: ganzes Board als JSON ── validate() ─(Strukturfehler)→ Retry mit Fehlerliste
                                   Prüfrunde: Faktencheck + Ersatzfragen im selben Aufruf ── validate() ─(offen)→ 1 Reparatur-Aufruf
                                   Code: nach Schwierigkeit sortieren, Punkte, MC mischen, Notiz "Antwort / Variante / …"
BoardStore                         .qbhost/boards/<id>.json (mit Lösungen), Register: Entwurf
                                   Vorschau: Channel = Name, Kategorien, Punkte · DM/Terminal = alles
writeBoard(BoardEditorPort)        Editor: Benutzerdefiniert → 1/2 Boards → Kategorien → Fragen (zurücklesen, nachbessern) → speichern
BoardStore                         Register: angelegt + Link → `!quiz neu <Name>` startet die Lobby mit dem eigenen Board
```

Das LLM sieht nie den Browser, und der Browser-Teil ruft kein LLM. Spiel und Editor teilen sich das eingeloggte Browser-Profil, deshalb laufen sie nie gleichzeitig (Chromium sperrt ein Profil für eine zweite Instanz).

## Erweiterungspunkte

| Ich will … | Dann … |
|---|---|
| einen **neuen Spielmodus** (Punktejagd, Eagle Eye, …) | `src/site/<modus>/probe.browser.js` + `page.ts` (Port-Interface), `src/modes/<modus>/controller.ts` implementiert `GameMode`; in `app.ts` anhand des erkannten Formats wählen. Erkenntnisse zu Punktejagd stehen in SITE-NOTES.md. |
| eine **andere Chat-Plattform** (Slack, Matrix, Twitch) | `ChatGateway` implementieren und `QuizBot` damit starten – Bot-Logik bleibt gleich. |
| eine **neue Spielregel** per Discord einstellbar machen | Feld in `config.ts` `game` + Eintrag in `RULES` (`rules.ts`) – `!quiz regel` kennt sie dann automatisch. |
| einen **neuen Eingabekanal** (Sprache) | Klasse mit `Channel`-Interface, die `host:*` rendert und `player:pick`/`player:answer` emittiert. In `app.ts` registrieren. Kein Controller-Code nötig. |
| eine **andere Stimme / STT** | `TextToSpeech` bzw. `SpeechToText` implementieren (`src/voice/tts.ts`, `stt.ts`) und in `createVoiceKit` wählen. |
| eine **andere Sprachplattform** (z.B. TeamSpeak, Mumble) | `VoiceTransport` implementieren – `VoiceHost` und alles darüber bleiben gleich. |
| **eigene Hausregeln** | `rules.ts` und neue Felder in `config.ts`. |
| einen **anderen Browser** | `BrowserDriver` implementieren (nur `evaluate(expression)` ist wirklich nötig). |
| ein **anderes Bewertungsverfahren** | `AnswerJudge` implementieren und in `judge/index.ts` in die Kaskade hängen. |
| **Claude als interaktiven Host** (MCP) | MCP-Server, der den EventBus als Tools exponiert (`wait_for_event`, `pick`, `judge`). Der Controller bleibt unverändert, nur der Judge/Channel wird ein MCP-Adapter. |

## Sprache

```
Discord-Voice ─Opus pro Sprecher─► DiscordVoiceTransport ─PCM─► VoiceHost ─(Filter: Länge, Lautstärke, Echo)─► whisper.cpp
                                                                   ▲                                              │ Text
                                   Piper ◄─ Satz ─ VoiceBridge ◄─ host:* (Bus)                                     ▼
                                                                                  QuizBot.onSpeech → Rufname? → Befehl
                                                                                                   → Buzzer? → player:buzz
                                                                                                   → wer ist dran? → wie eine Chat-Nachricht (Karte/Antwort)
```

Gesprochenes wird zu einer synthetischen Chat-Nachricht (`viaVoice: true`) im Channel des Spiels und läuft durch dieselbe Logik wie getippter Text – Kartenparser, Antworten, Menüs, Befehle. Antworten auf gesprochene Eingaben gehen in den Chat **und** in den Voice-Channel. Der Controller kennt Sprache nicht; Ergänzungen sind nur das Event `player:buzz`, das mit dem quiz-base-Buzzer um die Wette läuft, und der Zeitbonus `game.bonusTimeSec`, den die VoiceBridge setzt, solange sie moderiert (getrennt von den Grundwerten, damit Regeländerungen und Reconnects ihn nicht verfälschen).

Der Bot hostet ein Spiel gleichzeitig; es gehört zu dem Discord-Server, auf dem es erstellt wurde. Befehle, Leitungsrechte, Ansagen und der Voice-Channel gelten nur dort.

## Warum keine direkte Supabase-Anbindung?

quiz-base läuft auf Next.js + Supabase (REST + Realtime). Ein eigener Client gegen deren Backend wäre schneller, aber undokumentiert, fragil und würde an der vorgesehenen Nutzung der Seite vorbeigehen. qbhost bedient stattdessen die offizielle Host-Oberfläche wie ein menschlicher Host, und alle Spieler sehen exakt das normale Spiel.
