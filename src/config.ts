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

  discord: z
    .object({
      /** Token kommt aus der Umgebung (DISCORD_TOKEN bzw. .env), nie aus der Config-Datei. */
      tokenEnv: z.string().default('DISCORD_TOKEN'),
      /** Überwachte Channel-IDs: dort reichen `!quiz …`-Befehle. Leer = Befehle mit Präfix überall. Ein @Mention funktioniert immer. */
      /** Channels the bot works in (prefix and @mention). Empty = every channel it can see. */
      channelIds: z.array(z.string()).default([]),
      prefix: z.string().default('!quiz'),
      /** Lobby wird geschlossen, wenn das Spiel nach so vielen Minuten nicht gestartet ist. */
      lobbyTimeoutMin: z.number().int().default(20),
      /** Automatisch starten, sobald alle in quiz-base bereit UND mit Discord verknüpft sind. */
      autoStart: z.boolean().default(true),
      dataDir: z.string().default('.qbhost/discord'),
    })
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
