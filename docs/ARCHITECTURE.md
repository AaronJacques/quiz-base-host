# Architektur

## Leitprinzipien

1. **Deterministisch zuerst, LLM zuletzt.** Alles, was sich mit Code entscheiden lässt, wird mit Code entschieden. Das LLM ist ein austauschbarer *Bewertungs-Baustein*, nicht der Steuermann. Deshalb läuft der Host problemlos mit Haiku.
2. **Eine Stelle pro Wissen.** DOM-Wissen über quiz-base steht nur im Probe, Spielregeln nur in `rules.ts`, Konfiguration nur in `config.ts`.
3. **Schichten kommunizieren über Interfaces und einen Event-Bus**, nie über konkrete Klassen. Konkrete Klassen werden nur in `app.ts` (Composition Root) zusammengesteckt.

## Schichten

```
src/
├── cli.ts                 Kommandozeile (host, boards, probe, judge, doctor)
├── app.ts                 Composition Root: baut alles aus der Config zusammen
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
| einen **neuen Eingabekanal** (Discord-Bot, Sprache) | Klasse mit `Channel`-Interface, die `host:*` rendert und `player:pick`/`player:answer` emittiert. In `app.ts` registrieren. Kein Controller-Code nötig. |
| eine **Sprachausgabe** (TTS ins Discord) | Channel, der `host:say` / `host:question` an z. B. macOS `say` oder ElevenLabs gibt. |
| **eigene Hausregeln** | `rules.ts` und neue Felder in `config.ts`. |
| einen **anderen Browser** | `BrowserDriver` implementieren (nur `evaluate(expression)` ist wirklich nötig). |
| ein **anderes Bewertungsverfahren** | `AnswerJudge` implementieren und in `judge/index.ts` in die Kaskade hängen. |
| **Claude als interaktiven Host** (MCP) | MCP-Server, der den EventBus als Tools exponiert (`wait_for_event`, `pick`, `judge`). Der Controller bleibt unverändert, nur der Judge/Channel wird ein MCP-Adapter. |

## Warum keine direkte Supabase-Anbindung?

quiz-base läuft auf Next.js + Supabase (REST + Realtime). Ein eigener Client gegen deren Backend wäre schneller, aber undokumentiert, fragil und würde an der vorgesehenen Nutzung der Seite vorbeigehen. qbhost bedient stattdessen die offizielle Host-Oberfläche wie ein menschlicher Host, und alle Spieler sehen exakt das normale Spiel.
