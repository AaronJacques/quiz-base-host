import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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
      /** Sekunden, bis der Spieler am Zug eine Frage wählt (danach Erinnerung). */
      pickReminderSec: z.number().int().default(45),
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
      /** Am Ende das Spiel auf der Seite automatisch beenden. */
      autoEnd: z.boolean().default(true),
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

  /** Sprachsteuerung im Discord-Voice-Channel. Alles lokal: whisper.cpp (STT) + Piper (TTS). Einrichtung: `qbhost voice-setup`. */
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
      /** `piper` (natürlich, lokal) oder `say` (macOS, ohne Einrichtung). */
      tts: z.enum(['piper', 'say']).default('piper'),
      /** Relativ zu `dir`. */
      piperVoice: z.string().default('models/de_DE-thorsten-high.onnx'),
      /** >1 = langsamer, <1 = schneller. */
      piperLengthScale: z.number().default(0.95),
      sayVoice: z.string().default('Anna'),
      /** Sprechpause, nach der eine Äußerung als beendet gilt. */
      silenceMs: z.number().int().default(900),
      /** Kürzere/leisere Äußerungen werden verworfen (Husten, Klicks, Rauschen). */
      minSpeechMs: z.number().int().default(350),
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
    })
    // A smaller audio window hears only its first n/50 seconds – longer utterances would be cut off unheard.
    .transform((v) => ({ ...v, maxSpeechSec: v.whisperAudioCtx > 0 ? Math.min(v.maxSpeechSec, audioCtxSeconds(v.whisperAudioCtx)) : v.maxSpeechSec }))
    .prefault({}),

  companion: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().default(4747),
      host: z.string().default('0.0.0.0'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

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
  return ConfigSchema.parse(merge(fromFile, overrides as any));
}
