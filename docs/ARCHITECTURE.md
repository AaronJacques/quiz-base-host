# Architektur

## Leitprinzipien

1. **Deterministisch zuerst, LLM zuletzt.** Alles, was sich mit Code entscheiden lässt, wird mit Code entschieden. Das LLM ist ein austauschbarer *Bewertungs-Baustein*, nicht der Steuermann. Deshalb läuft der Host problemlos mit Haiku.
2. **Eine Stelle pro Wissen.** DOM-Wissen über quiz-base steht nur im Probe, Spielregeln nur in `rules.ts`, Konfiguration nur in `config.ts`.
3. **Schichten kommunizieren über Interfaces und einen Event-Bus**, nie über konkrete Klassen. Konkrete Klassen werden nur in `app.ts` (Composition Root) zusammengesteckt.

## Schichten

```
src/
├── cli.ts                 Kommandozeile (discord, host, boards, probe, judge, doctor)
├── app.ts                 CLI-Modus: eine Runde mit Terminal + Spieler-Pult
├── session.ts             GameSession = eine Runde (Browser, Bus, Controller, Judge); vom CLI und vom Bot genutzt
├── config.ts              Zod-Schema mit allen Einstellungen + Defaults
│
├── core/                  framework-freie Basis
│   ├── types.ts           Domänenmodell (TafelquizState, QuestionState, …)
│   ├── events.ts          typisierter EventBus (host:* raus, player:*/operator:* rein)
│   └── logger.ts
│
├── browser/               "Wie kommt JS in einen Tab?"  – kein quiz-base-Wissen
│   ├── driver.ts          BrowserDriver-Interface: open, goto, evaluate(expr), screenshot
│   ├── playwright-driver.ts   eigener Chromium (persistentes Profil) + CDP-Attach an Chrome
│   └── orca-driver.ts     Orca-Built-in-Browser über `orca eval/goto/screenshot`
│
├── site/                  "Wie sieht quiz-base aus?"  – das gesamte DOM-Wissen
│   ├── lobby.ts           Wizard: Format → öffentliches Board → Vorschau → Warteraum
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
│   ├── fuzzy-judge.ts     kostenlos, konservativ ("unsure" statt raten)
│   ├── llm-judge.ts       Bewertung + Lösen von Bildfragen per LLM
│   ├── operator-judge.ts  Mensch im Terminal
│   ├── cascade-judge.ts   Chain of Responsibility mit Cache vor teuren Stufen
│   └── cache.ts           persistenter Cache (.qbhost/judge-cache.json)
│
├── llm/                   "Wie rede ich mit Claude?"
│   ├── client.ts          LlmClient-Interface (einmalige JSON-Antwort) + UsageMeter
│   ├── claude-cli.ts      `claude -p` headless, ohne Tools/MCP/Settings → Abo statt API-Key
│   └── anthropic-api.ts   offizielles SDK, messages.parse + Zod, effort "low"
│
├── discord/               Discord-Bot (Hauptbedienung)
│   ├── gateway.ts         ChatGateway-Interface (testbar ohne Discord)
│   ├── discord-gateway.ts discord.js-Implementierung
│   ├── bot.ts             Befehle, Verknüpfung Discord↔quiz-base, Kartenwahl, Antworten, Rendering
│   ├── pick-parser.ts     "nin 200" → Karte + Prüfung frei/schon weg (reine Funktion)
│   ├── store.ts           pro Server: Verknüpfungen + Regeln (.qbhost/discord/)
│   └── format.ts          Hilfe-/Regeltexte
│
├── voice/                 "Wie spricht und hört der Host?"  (alles lokal)
│   ├── transport.ts       VoiceTransport-Interface: play(pcm), onUtterance(pro Sprecher)
│   ├── discord-voice.ts   @discordjs/voice: Opus empfangen/dekodieren, PCM abspielen (DAVE)
│   ├── loopback.ts        Voice-Raum per HTTP – Tests und Agenten-Spieler ohne Discord
│   ├── stt.ts             whisper.cpp-Server (warm), Halluzinationsfilter
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
                       ◄─────────────── player:answer "luigi mario"
judge.judge()          Fuzzy ─(unsicher)─► Cache ─(Miss)─► Haiku ─(Fehler)─► Operator
page.award(±)          quick buttons (+Wert/+½/−½) oder manueller Punkte-Dialog
page.animate()         "Richtig"/"Falsch"-Animation für alle
(falsch) buzzerRound   releaseBuzzer → warten auf "X hat gebuzzert" → erneut fragen/bewerten
page.closeQuestion()   quiz-base gibt den Zug weiter → nächster onBoard-Durchlauf
```

Jeder Warteschritt läuft über `whilePage()`: Ändert ein Mensch im Browser den Zustand (Frage manuell geöffnet/geschlossen, Spiel beendet), bricht das Warten ab und die Hauptschleife liest den neuen Zustand. Die Phasen-Handler sind idempotent, daher kann qbhost auch in ein laufendes Spiel einsteigen.

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

Gesprochenes wird zu einer synthetischen Chat-Nachricht (`viaVoice: true`) und läuft durch dieselbe Logik wie getippter Text – Kartenparser, Antworten, Menüs, Befehle. Antworten auf gesprochene Eingaben gehen in den Chat **und** in den Voice-Channel. Der Controller kennt Sprache nicht; einzige Ergänzung ist das Event `player:buzz`, das mit dem quiz-base-Buzzer um die Wette läuft.

## Warum keine direkte Supabase-Anbindung?

quiz-base läuft auf Next.js + Supabase (REST + Realtime). Ein eigener Client gegen deren Backend wäre schneller, aber undokumentiert, fragil und würde an der vorgesehenen Nutzung der Seite vorbeigehen. qbhost bedient stattdessen die offizielle Host-Oberfläche wie ein menschlicher Host, und alle Spieler sehen exakt das normale Spiel.
