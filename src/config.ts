import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { safeBaseUrl } from './voice/http.ts';

/**
 * Single source of truth for all tunables. Defaults are chosen so a game runs
 * without any config file; override via `qbhost.config.json` or CLI flags.
 */
export const ConfigSchema = z.object({
  baseUrl: z.string().default('https://www.quiz-base.de'),

  browser: z
    .object({
      /** `playwright` = eigener Chromium (sichtbar), `orca` = Orca-Built-in-Browser, `cdp` = laufender Chrome mit --remote-debugging-port. */
      driver: z.enum(['playwright', 'orca', 'cdp']).default('playwright'),
      headless: z.boolean().default(false),
      /** Persistentes Profil, damit ein quiz-base-Login erhalten bleibt. */
      profileDir: z.string().default('.qbhost/profile'),
      cdpUrl: z.string().default('http://127.0.0.1:9222'),
      /** Orca: vorhandene browserPageId nutzen statt neuen Tab zu öffnen. */
      orcaPageId: z.string().optional(),
      orcaBin: z.string().default('orca'),
      pollMs: z.number().int().min(100).default(500),
    })
    .prefault({}),

  game: z
    .object({
      /** Board, das automatisch als Lobby erstellt wird (Titel aus "Öffentliches Board verwenden"). Leer = Lobby manuell erstellen. */
      publicBoard: z.string().optional(),
      /** So viele Spieler braucht der automatische Start. Ein ausdrücklicher Start (`start`, Discord `!quiz los`) geht auch mit weniger. */
      minPlayers: z.number().int().min(1).default(2),
      /** Spiel automatisch starten, sobald alle bereit sind. Sonst Operator: `start`. */
      autoStart: z.boolean().default(false),
      /** Sekunden bis zur ersten Erinnerung „du bist dran“, wenn der Spieler am Zug keine Karte wählt. 0 = keine Erinnerung. */
      pickReminderSec: z.number().int().min(0).default(90),
      /** Abstand weiterer Erinnerungen im selben Zug (nur im Chat, gesprochen wird nur die erste). 0 = nur eine Erinnerung. */
      pickReminderRepeatSec: z.number().int().min(0).default(300),
      /** Hinweis „Welche Karte?“, wenn eine gesprochene Kartenwahl nicht klappt – höchstens einmal pro Zug und nur, wenn die Äußerung nach einer Karte klingt. */
      pickHint: z.boolean().default(true),
      /** Antwortzeit für den Spieler am Zug. Wird als Timer auf der Seite gestartet. */
      answerTimeoutSec: z.number().int().default(45),
      /** Nach falscher Antwort Buzzer für alle anderen freigeben. */
      buzzerOnWrong: z.boolean().default(true),
      buzzWindowSec: z.number().int().default(15),
      buzzAnswerTimeoutSec: z.number().int().default(25),
      /**
       * Zusatzzeit in Sekunden auf Antwortzeit und Buzzerfenster (Antwortzeit nach Buzzer: die Hälfte).
       * Setzt der Voice-Bot zur Laufzeit auf `voice.extraTimeSec`, solange er moderiert (Vorlesen braucht Zeit),
       * und wieder auf 0, wenn er geht. Getrennt von den Grundwerten, damit Regeländerungen sie nicht verlieren.
       */
      bonusTimeSec: z.number().int().min(0).default(0),
      // Punkteregeln als Faktor vom Fragewert (1 = voller Wert, 0.5 = halber, 0 = nichts).
      // Standard = klassische quiz-base-Regeln. Per Discord änderbar (`!quiz regel …`).
      correctFactor: z.number().min(0).max(5).default(1),
      wrongFactor: z.number().min(0).max(5).default(0.5),
      buzzerCorrectFactor: z.number().min(0).max(5).default(1),
      buzzerWrongFactor: z.number().min(0).max(5).default(0.5),
      /** YouTube-/Audio-Fragen automatisch abspielen. */
      autoplayAudio: z.boolean().default(true),
      /** Pause zwischen Auflösung und Schließen der Frage, damit alle die Lösung lesen. */
      revealPauseSec: z.number().default(4),
      /** Kürzere Pause, wenn jemand die Frage richtig gelöst hat (Dezimalwerte erlaubt, z.B. 1.5). */
      revealPauseSolvedSec: z.number().min(0).max(30).default(1.5),
      /** Am Ende das Spiel auf der Seite automatisch beenden. */
      autoEnd: z.boolean().default(true),
      /**
       * Sprache: mindestens so viele Sekunden nach der Rückfrage „X?“ bleiben für das „Ja“; verlängert die Antwortzeit
       * bei Bedarf (die Uhr auf quiz-base steht dann schon auf 0). 0 = aus. Per Discord: `!quiz regel nachfrist 5`.
       */
      confirmGraceSec: z.number().int().min(0).max(20).default(8),
      /** Sprache: Eine Antwort, die bei Fristende (plus Nachfrist) noch auf „Ja“ wartet, zählt wie gesagt. Aus = sie verfällt (Zeit abgelaufen). */
      confirmAtDeadline: z.boolean().default(true),
    })
    .prefault({}),

  judge: z
    .object({
      /** `cascade` = erst Fuzzy, nur bei Unsicherheit LLM. `fuzzy` = nie LLM. `operator` = Mensch entscheidet Unsicheres. */
      strategy: z.enum(['cascade', 'fuzzy', 'operator']).default('cascade'),
      /** Ab dieser Ähnlichkeit (0..1) gilt eine Antwort ohne LLM als richtig. */
      acceptThreshold: z.number().min(0).max(1).default(0.86),
      /** Unter dieser Ähnlichkeit gilt sie im `fuzzy`-Modus als falsch. */
      rejectThreshold: z.number().min(0).max(1).default(0.35),
      /** Für Fragen ohne Notiz (nur Bild) die Lösung per Vision-LLM bestimmen. */
      solveMissingNotes: z.boolean().default(true),
      cacheFile: z.string().default('.qbhost/judge-cache.json'),
    })
    .prefault({}),

  llm: z
    .object({
      /** `claude-cli` nutzt dein Claude-Code-Abo (`claude -p`), `anthropic` braucht ANTHROPIC_API_KEY, `none` deaktiviert LLM. */
      provider: z.enum(['claude-cli', 'anthropic', 'none']).default('claude-cli'),
      model: z.string().default('haiku'),
      claudeBin: z.string().default('claude'),
      timeoutMs: z.number().int().default(30000),
    })
    .prefault({}),

  /** Board-Generator: Claude schreibt ein Tafelquiz, qbhost legt es im Board-Editor von quiz-base an (`qbhost board-create`, `!quiz erstellen`). */
  boardgen: z
    .object({
      /** `inherit` = wie `llm.provider`. `claude-cli` = Abo (`claude -p`), `anthropic` = API-Key. */
      provider: z.enum(['inherit', 'claude-cli', 'anthropic']).default('inherit'),
      /** Modell für Erzeugung und Prüfrunde (Alias wie `sonnet` oder volle Modell-ID). */
      model: z.string().default('sonnet'),
      /** Denkaufwand: mehr = gründlicher, aber langsamer und teurer. */
      effort: z.enum(['low', 'medium', 'high']).default('medium'),
      timeoutMs: z.number().int().default(300_000),
      /** Zweite Prüfrunde (Faktencheck), die falsche oder mehrdeutige Fragen ersetzt. */
      review: z.boolean().default(true),
      /** Versuche, bis die Ausgabe gültig ist (Schema + Prüfregeln). */
      maxAttempts: z.number().int().min(1).max(5).default(3),
      /** Abbruch, sobald die gemessenen Kosten eines Boards darüber liegen (API; über das Abo fällt nichts an). */
      maxCostUsd: z.number().min(0).default(1),
      /** Ablage der erzeugten Boards (enthalten die Lösungen!) und des Registers. */
      dir: z.string().default('.qbhost/boards'),
      /** Discord: außer Server-Admins dürfen diese User-IDs Boards erstellen. */
      creatorIds: z.array(z.string()).default([]),
      /** Standardwerte, wenn eine Anfrage nichts anderes sagt. */
      defaults: z
        .object({
          /** Kategorien pro Board (2–8). */
          categories: z.number().int().min(2).max(8).default(4),
          /** Punktestufen pro Kategorie (quiz-base: 1–10). */
          rows: z.number().int().min(1).max(10).default(4),
          /** Punkte pro Stufe (100 → 100, 200, …); quiz-base erlaubt Vielfache von 50. */
          step: z.number().int().min(50).multipleOf(50).default(100),
          boards: z.number().int().min(1).max(2).default(1),
          /** Zielgruppe: kinder (8–10), schule (Kl. 5–7), oberstufe, kneipe (Erwachsene), profi. */
          level: z.enum(['kinder', 'schule', 'oberstufe', 'kneipe', 'profi']).default('kneipe'),
          /** Sprache der Fragen (ISO-Code). */
          language: z.string().default('de'),
          /** Anteil Multiple-Choice-Fragen (0–1). */
          mcShare: z.number().min(0).max(1).default(0),
        })
        .prefault({}),
    })
    .prefault({}),

  discord: z
    .object({
      /** Token kommt aus der Umgebung (DISCORD_TOKEN bzw. .env), nie aus der Config-Datei. */
      tokenEnv: z.string().default('DISCORD_TOKEN'),
      /** Nur in diesen Channels reagiert der Bot (Präfix und @Mention). Leer = überall, wo er lesen kann. */
      channelIds: z.array(z.string()).default([]),
      prefix: z.string().default('!quiz'),
      /** Lobby wird geschlossen, wenn das Spiel nach so vielen Minuten nicht gestartet ist. */
      lobbyTimeoutMin: z.number().int().default(20),
      /** Automatisch starten, sobald alle in quiz-base bereit UND mit Discord verknüpft sind. */
      autoStart: z.boolean().default(true),
      dataDir: z.string().default('.qbhost/discord'),
    })
    .prefault({}),

  /** Sprachsteuerung im Discord-Voice-Channel. Standard alles lokal: whisper.cpp (STT) + Piper (TTS); STT optional per Cloud (`stt`). Einrichtung: `qbhost voice-setup`. */
  voice: z
    .object({
      enabled: z.boolean().default(true),
      /** Bei `!quiz neu` automatisch in den Voice-Channel der Spielleitung kommen. */
      autoJoin: z.boolean().default(true),
      /** Ordner für Modelle und Python-Umgebung. */
      dir: z.string().default('.qbhost/voice'),
      whisperBin: z.string().default('whisper-server'),
      /** Relativ zu `dir`. Das genaue Hauptmodell: hört gesprochene Antworten (und alles, wenn kein `whisperFastModel` gesetzt ist). */
      whisperModel: z.string().default('models/ggml-large-v3-turbo-q5_0.bin'),
      /**
       * Optionales zweites, schnelles Modell (relativ zu `dir`), z.B. `models/ggml-base-q5_1.bin`. Leer = aus.
       * Es läuft als eigener whisper-server auf `whisperPort + 1` und hört alles, wobei keine gesprochene
       * Antwort erwartet wird: Kartenwahl, Rufname-Prüfung, Befehle, Ja/Nein, „Hier!“. Für kleine Server.
       */
      whisperFastModel: z.string().default(''),
      whisperPort: z.number().int().default(8178),
      /**
       * Audiofenster des Whisper-Encoders (`-ac <n>` an whisper-server), 0 = volles Fenster (1500 = 30 s).
       * Kleiner ist viel schneller (auf 1 vCPU: small-q5_1 ~12,5 s → ~4 s), hört aber nur n/50 Sekunden:
       * 512 ≈ 10 s. `maxSpeechSec` wird deshalb auf dieses Fenster begrenzt.
       */
      whisperAudioCtx: z.number().int().min(0).max(1500).default(0),
      language: z.string().default('de'),
      /**
       * Spracherkennung: `whisper` = nur lokal (Engine aus `localStt`, Standard whisper.cpp), `deepgram` = Cloud (Deepgram, EU-Endpunkt,
       * Schlüssel aus `.env`). Mit Cloud hört sie nur die Phasen in `sttCloudFor`, der Rest bleibt lokal.
       * Siehe docs/VOICE.md „Erkennung: lokal oder Cloud“.
       */
      stt: z.enum(['whisper', 'deepgram']).default('whisper'),
      /**
       * Die lokale Erkennung (unabhängig von `stt`): `whisper` = whisper.cpp (Modelle oben), `parakeet` =
       * NVIDIA Parakeet TDT 0.6b v3 über sherpa-onnx (`parakeet` unten) für die Phasen in `parakeetFor`, viel
       * schneller auf kleinen Servern und besser bei Namen, kennt aber keinen Prompt. Mit `stt: deepgram` ist
       * sie für diese Phasen der Rückfall. Siehe docs/VOICE.md „Parakeet statt whisper.cpp“.
       */
      localStt: z.enum(['whisper', 'parakeet']).default('whisper'),
      /**
       * Bei `localStt: parakeet`: welche Phasen Parakeet hört. Standard nur `answer` (gesprochene Antworten):
       * Kurze Befehle („Ja“, „Hier“, „Nein“, Rufname) gibt das Modell oft englisch wieder („Yeah“, „Nine“),
       * die Sprache lässt sich nicht festlegen. Die übrigen Phasen hört whisper wie bisher (`whisperFastModel`,
       * sonst `whisperModel`). Nur zwei Werte: `["answer"]` (Mischbetrieb) oder alle vier Phasen (nur Parakeet,
       * kein whisper-server, Befehle mit den bekannten Schwächen). Einzelne Befehlsphasen brächten nur eine
       * zusätzliche Erkennung (dort zählt ohnehin whispers Text) und sind ein Konfigurationsfehler.
       */
      parakeetFor: z
        .array(z.enum(['answer', 'confirm', 'full', 'wake']))
        .refine(
          (a) => {
            const set = new Set(a);
            return set.size === a.length && ((set.size === 1 && set.has('answer')) || set.size === 4);
          },
          'nur ["answer"] (Parakeet für Antworten, whisper für den Rest) oder alle vier Phasen ["answer", "confirm", "full", "wake"] (nur Parakeet, ohne whisper) – andere Kombinationen brächten nur zusätzliche Erkennungen',
        )
        .default(['answer']),
      /** Parakeet (bei `localStt: parakeet`). Wird nur dann installiert und geladen. */
      parakeet: z
        .object({
          /** Ordner mit encoder/decoder/joiner/tokens, relativ zu `dir`. Das offizielle Modell lädt `voice-setup`. */
          model: z.string().default('models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'),
          /** Rechen-Threads; 0 = automatisch (Kerne, höchstens 4 – auf 1 vCPU also 1). */
          threads: z.number().int().min(0).max(16).default(0),
          /** Frist je Erkennung ab Übergabe an den bereiten Worker: so viele ms plus `deadlinePerSecMs` je Audiosekunde. */
          deadlineMs: z.number().int().min(1000).default(8000),
          deadlinePerSecMs: z.number().int().min(0).default(500),
          /**
           * So lange darf der Worker zum Laden des Modells brauchen. Gemessen auf 1 vCPU: ~3–5 s aus dem
           * Seitencache, 53 s kalt (erster Start nach Server-Neustart, 640 MB von der Platte); unter Last eines
           * laufenden Spiels etwa doppelt. 150 s lassen dafür Luft. Im Mischbetrieb wartet ohnehin keine
           * Äußerung auf den Start (whisper hört so lange).
           */
          startTimeoutMs: z.number().int().min(1000).default(150_000),
          /**
           * Vorwärmen (nur mit `localStt: parakeet`): `cache` = beim Bot-Start die Modelldateien einmal gedrosselt
           * im Hintergrund lesen (landen im Seitencache des Systems, kein eigener Speicher; der Worker startet
           * beim Voice-Beitritt dann in Sekunden), `start` = den Worker schon beim Bot-Start laden (belegt ab dann
           * ständig ~0,9 GB), `off` = erst beim Voice-Beitritt. Der Worker bleibt nach dem ersten Beitritt ohnehin
           * bis zum Beenden geladen.
           */
          preload: z.enum(['cache', 'start', 'off']).default('cache'),
        })
        .prefault({}),
      /**
       * Bei `stt: deepgram`: welche Phasen (`attention`) die Cloud hört. `answer` = wer eine Frage beantwortet,
       * `confirm` = Rückfrage „Paris?“, `full` = Kartenwahl, „Hier!“, Menüs, `wake` = Prüfung auf den Rufnamen
       * bei allen anderen. `wake` fehlt absichtlich: Nebengespräche verlassen den Server nie.
       */
      sttCloudFor: z
        .array(z.enum(['answer', 'confirm', 'full', 'wake']))
        .default(['answer', 'confirm', 'full']),
      /** Fällt die Cloud aus (Zeitüberschreitung, Netz, 429, 5xx, Schlüssel): `local` = dieselbe Äußerung lokal erkennen, `none` = kein Rückfall. */
      cloudFallback: z.enum(['local', 'none']).default('local'),
      /** Die lokalen Rückfall-Modelle beim Beitritt mitstarten (sonst Kaltstart von mehreren Sekunden beim ersten Ausfall). */
      warmFallback: z.boolean().default(true),
      /** Höchstens so lange wartet der Bot auf die Cloud-Erkennung einer Äußerung, dann bricht er ab und erkennt lokal. */
      sttTimeoutMs: z.number().int().min(100).default(2500),
      /** Nach 3 Cloud-Fehlern in Folge so viele Sekunden nur lokal, dann ein neuer Versuch. */
      cloudCooldownSec: z.number().int().min(0).default(300),
      /** Deepgram (bei `stt: deepgram`). Der Schlüssel kommt aus der Umgebung (`keyEnv`, z.B. in `.env`), nie aus der Config-Datei. */
      deepgram: z
        .object({
          /** Nur `https://` (der Schlüssel geht mit); `http://` nur zu 127.0.0.1/localhost (Tests). */
          baseUrl: z
            .string()
            .refine(safeBaseUrl, 'muss mit https:// beginnen (http:// nur zu 127.0.0.1 oder localhost), z.B. https://api.eu.deepgram.com')
            .default('https://api.eu.deepgram.com'),
          keyEnv: z.string().default('DEEPGRAM_API_KEY'),
          sttModel: z.string().default('nova-3'),
          language: z.string().default('de'),
          /** Kategorien, Punktwerte und Namen als Schlüsselbegriffe mitschicken (nie die Lösung). */
          keyterms: z.boolean().default(true),
        })
        .prefault({}),
      /** `piper` (natürlich, lokal) oder `say` (macOS, ohne Einrichtung). */
      tts: z.enum(['piper', 'say']).default('piper'),
      /** Relativ zu `dir`. */
      piperVoice: z.string().default('models/de_DE-thorsten-high.onnx'),
      /** >1 = langsamer, <1 = schneller. */
      piperLengthScale: z.number().default(0.95),
      sayVoice: z.string().default('Anna'),
      /**
       * Lange Ansagen satzweise sprechen: Der erste Satz klingt schon, während die nächsten noch erzeugt
       * werden. Senkt die Zeit bis zum ersten Ton bei langen Fragen auf die Dauer des ersten Satzes.
       */
      ttsSplitSentences: z.boolean().default(false),
      /**
       * Feste Standardsätze (`FIXED_LINES` in `src/voice/narration.ts`, ohne Namen oder Spielinhalt) als
       * Audio unter `<dir>/tts-cache/` ablegen. Überlebt Neustarts; fehlende kurze Sätze werden in
       * Sprechpausen vorab erzeugt.
       */
      ttsDiskCache: z.boolean().default(false),
      /** Sprechpause, nach der eine Äußerung als beendet gilt. */
      silenceMs: z.number().int().default(900),
      /** Kürzere/leisere Äußerungen werden verworfen (Husten, Klicks, Rauschen). */
      minSpeechMs: z.number().int().default(350),
      /** Mindestlänge für eine Äußerung der Person, die gerade eine Rückfrage bestätigt (kurzes „Ja“); sonst gilt `minSpeechMs`. */
      minConfirmSpeechMs: z.number().int().min(100).default(250),
      minRms: z.number().default(250),
      maxSpeechSec: z.number().default(15),
      /** Was jemand sagt, während der Bot spricht, wird ignoriert (Schutz vor Echo ohne Kopfhörer). */
      ignoreWhileSpeaking: z.boolean().default(true),
      /**
       * Barge-in: Wer gerade dran ist, darf Hinweise, Erinnerungen und Rückfragen des Bots unterbrechen
       * („Welche Karte? …“, „Paris?“, „Anna, deine Antwort?“). Der Bot verstummt und wertet die Äußerung,
       * außer sie klingt wie seine eigene Ansage (Echo). Fragen, Lösungen und alle anderen Personen bleiben
       * beim Echo-Schutz. Discord unterdrückt Echo selbst; ohne Kopfhörer und Echo-Unterdrückung: `false`.
       */
      bargeIn: z.boolean().default(true),
      /** Rufname für Sprachbefehle („Quizmaster, Stand“). */
      wakeWords: z.array(z.string()).default(['quizmaster', 'quiz master', 'quizmeister', 'quizhost', 'quiz host']),
      /** Zusätzliche Sekunden für Antwort- und Buzzerzeit, solange der Bot spricht (Vorlesen braucht Zeit). Wird als `game.bonusTimeSec` gesetzt. */
      extraTimeSec: z.number().int().default(10),
      /** Punktestand nach jeder n-ten Frage ansagen (0 = nie). */
      scoresEvery: z.number().int().default(3),
      /**
       * Latenz messen: `⏱`-Zeilen auf `info` für jede erkannte Äußerung, jede Ansage, die Reaktionszeit
       * und eine Bilanz bei Spielende (ohne Texte). Auswertung: `npx tsx tools/voice-latency.ts < log`.
       */
      latencyLog: z.boolean().default(true),
      /**
       * Nach Spielende (reguläres Ende, `!quiz ende`, „Quizmaster, Spiel beenden“, Abbruch) verabschiedet sich der Bot
       * und verlässt den Voice-Channel, sobald die letzte Ansage gesprochen ist. `false` = bleiben (Abschied nach 20 Minuten Stille).
       */
      leaveOnGameEnd: z.boolean().default(true),
    })
    // A smaller audio window hears only its first n/50 seconds – longer utterances would be cut off unheard.
    // (Only whisper has that window – if Parakeet hears every attention, the whole utterance counts.)
    .transform((v) => ({ ...v, maxSpeechSec: !parakeetHearsAll(v) && v.whisperAudioCtx > 0 ? Math.min(v.maxSpeechSec, audioCtxSeconds(v.whisperAudioCtx)) : v.maxSpeechSec }))
    .prefault({}),

  companion: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().default(4747),
      host: z.string().default('0.0.0.0'),
    })
    .prefault({}),

  /** quiz-base-Konto des Bots (eigene Boards): Anmeldung im Leerlauf frisch halten und überwachen. Nur mit `browser.driver: playwright`. */
  account: z
    .object({
      /** Alle so viele Stunden öffnet der Bot im Leerlauf kurz quiz-base, damit die Seite die Sitzung erneuert. 0 = aus. */
      keepAliveHours: z.number().min(0).max(48).default(6),
      /** Zufällige Verschiebung je Lauf (± Minuten). */
      keepAliveJitterMin: z.number().int().min(0).max(120).default(30),
      /** Erste Prüfung so viele Sekunden nach dem Start (Sprachmodelle laden zuerst). */
      startCheckDelaySec: z.number().int().min(0).default(120),
      /** Prüfung so viele Sekunden nach jedem Spiel (im Leerlauf). 0 = keine. */
      afterGameCheckSec: z.number().int().min(0).default(60),
      /** So lange bleibt die Seite höchstens offen, wenn keine Erneuerung zu sehen ist. */
      holdSec: z.number().int().min(5).max(120).default(20),
      /** Anmeldestatus mit Zeitstempeln (ohne Tokens). */
      statusFile: z.string().default('.qbhost/login-status.json'),
      /** Befehl, den Hinweise und DMs zum Neuanmelden nennen (Server: "npx qbhost login --server <ssh-host>"). */
      loginCommand: z.string().default('npx qbhost login'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Does Parakeet hear every attention (no whisper-server at all)? */
export function parakeetHearsAll(v: { localStt: string; parakeetFor: string[] }): boolean {
  return v.localStt === 'parakeet' && ['answer', 'confirm', 'full', 'wake'].every((a) => v.parakeetFor.includes(a));
}

/** Seconds of audio a Whisper encoder window of `n` frames covers (1500 frames = 30 s), rounded down. */
export function audioCtxSeconds(n: number): number {
  return Math.floor(n / 50);
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') out[k] = merge(out[k], v as any);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function loadConfig(file = 'qbhost.config.json', overrides?: DeepPartial<Config>): Config {
  const abs = path.resolve(file);
  const fromFile = existsSync(abs) ? JSON.parse(readFileSync(abs, 'utf8')) : {};
  const parsed = ConfigSchema.safeParse(merge(fromFile, overrides as any));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(Wurzel)'}: ${i.message}`).join('; ');
    throw new Error(`Konfiguration ungültig (${existsSync(abs) ? abs : 'Standardwerte'}): ${issues}`);
  }
  return parsed.data;
}
