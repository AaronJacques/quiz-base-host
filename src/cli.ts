import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { formatLoginHistory, formatLoginStatus, LoginStatusStore, loginStatusIcon } from './account.ts';
import { runHost } from './app.ts';
import { BOARD_CLI_OPTIONS, runBoardCreate, runBoardDelete, runLogin } from './board-cli.ts';
import { runDiscordBot } from './discord/index.ts';
import { DEFAULT_LOCAL_PORT, LOGIN_CLI_OPTIONS, profileDir, runRemoteLoginStdio, runServerLogin } from './server-login.ts';
import { setupVoice, voiceProblems, voiceWarnings } from './voice/index.ts';
import { deepgramReachable } from './voice/stt-deepgram.ts';
import { createDriver } from './browser/index.ts';
import { closeOpenBrowsers } from './browser/playwright-driver.ts';
import { secretValues } from './core/secrets.ts';
import { onFatalError } from './core/signals.ts';
import { loadConfig, type Config } from './config.ts';
import { EventBus } from './core/events.ts';
import { setLogLevel } from './core/logger.ts';
import { createJudge } from './judge/index.ts';
import { createLlm, UsageMeter } from './llm/index.ts';
import { fetchPublicBoards } from './session.ts';
import { TafelquizPage } from './site/tafelquiz/page.ts';

const run = promisify(execFile);

const USAGE = `qbhost – Claude als Host für quiz-base.de (Tafelquiz)

Befehle:
  host     Spiel hosten, Bedienung über Terminal + Web-Spieler-Pult (Standard)
  discord  Als Discord-Bot laufen (Token in DISCORD_TOKEN bzw. .env)
  boards   Öffentliche Tafelquiz-Boards auflisten (qbhost boards [suche])
  voice-setup  Sprachsteuerung einrichten (whisper.cpp, Modelle, Piper) – einmalig
  login    Bei quiz-base anmelden (sichtbarer Browser, du meldest dich selbst an) – für eigene Boards
           login --server <ssh-host> [--port 9223] [--yes]: den Bot auf dem Server anmelden (docs/DEPLOY.md)
           login --server <ssh-host> --logout: Anmeldung auf dem Server löschen
  board-create  Tafelquiz-Board per KI erzeugen und auf quiz-base anlegen (qbhost board-create --help)
  board-delete  Eigenes Board auf quiz-base löschen: qbhost board-delete "<Name>" [--yes]
  probe    Aktuellen Seitenzustand als JSON ausgeben (Debug)
  judge    Bewertung testen:  qbhost judge "<Frage>" "<Lösung>" "<Antwort>"
  doctor   Umgebung prüfen

Optionen:
  --driver <playwright|orca|cdp>   Browser (Standard: playwright)
  --page <id>                      Orca: vorhandene browserPageId verwenden
  --board "<Titel>"                Lobby mit diesem öffentlichen Board automatisch erstellen
  --auto-start                     Spiel starten, sobald alle bereit sind
  --llm <claude-cli|anthropic|none>
  --model <haiku|sonnet|…>         Modell für Bewertungen (Standard: haiku)
  --judge <cascade|fuzzy|operator>
  --no-companion                   Spieler-Pult nicht starten
  --port <n>                       Port des Spieler-Pults (Standard 4747)
  --headless                       Browser unsichtbar
  --config <datei>                 Konfigurationsdatei (Standard: qbhost.config.json)
  --verbose                        Debug-Logs`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    driver: { type: 'string' },
    page: { type: 'string' },
    board: { type: 'string' },
    'auto-start': { type: 'boolean' },
    llm: { type: 'string' },
    model: { type: 'string' },
    judge: { type: 'string' },
    'no-companion': { type: 'boolean' },
    port: { type: 'string' },
    headless: { type: 'boolean' },
    config: { type: 'string' },
    verbose: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    ...BOARD_CLI_OPTIONS,
    ...LOGIN_CLI_OPTIONS,
  },
});

// Secrets like DISCORD_TOKEN may live in a local .env file (gitignored).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env */
}

if (values.help && positionals[0] !== 'board-create') {
  console.log(USAGE);
  process.exit(0);
}
if (values.verbose) setLogLevel('debug');

let config: Config;
try {
  config = loadConfig(values.config ?? 'qbhost.config.json', {
    browser: { driver: values.driver as any, orcaPageId: values.page, headless: values.headless },
    game: { publicBoard: values.board, autoStart: values['auto-start'] },
    llm: { provider: values.llm as any, model: values.model },
    judge: { strategy: values.judge as any },
    companion: { enabled: values['no-companion'] ? false : undefined, port: values.port ? Number(values.port) : undefined },
  });
} catch (e) {
  // A broken config file is the operator's to fix: one clear line (also for `doctor`), no stack trace.
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
}

const [command = 'host', ...rest] = positionals;

switch (command) {
  case 'host':
    onFatalError(() => closeOpenBrowsers(3000), { secrets: () => secretValues(config) });
    await runHost(config);
    break;

  case 'discord':
    // An exception that escapes would kill Chromium with the process – close the browsers first.
    onFatalError(() => closeOpenBrowsers(3000), { secrets: () => secretValues(config) });
    try {
      await runDiscordBot(config);
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0); // shut down cleanly – nothing may keep the process (or a helper) alive
    break;

  case 'boards': {
    const query = rest.join(' ');
    const titles = await fetchPublicBoards(config, query || undefined);
    console.log(titles.length ? titles.map((t) => `• ${t}`).join('\n') : `Kein Board zu „${query}“ gefunden.`);
    break;
  }

  case 'voice-setup': {
    await setupVoice(config);
    break;
  }

  case 'login':
    if (values['print-profile-dir']) {
      // Read by tools/server-login.sh on the server: which folder of data/ the login container may write.
      console.log(profileDir(config));
    } else if (values['remote-stdio']) {
      // Inside the login container on the server (started by `login --server` – not meant to be typed).
      process.exit(await runRemoteLoginStdio(config));
    } else if (values.server) {
      try {
        process.exit(
          await runServerLogin({
            host: values.server,
            port: values.port ? Number(values.port) : DEFAULT_LOCAL_PORT,
            logout: !!values.logout,
            yes: !!values.yes,
          }),
        );
      } catch (e) {
        console.error(`❌ ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      await runLogin(config);
    }
    break;

  case 'board-create':
  case 'board-delete':
    try {
      await (command === 'board-create' ? runBoardCreate(config, values, rest) : runBoardDelete(config, rest, !!values.yes));
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    break;

  case 'probe': {
    const driver = createDriver(config);
    await driver.open();
    console.log(JSON.stringify(await new TafelquizPage(driver).state(), null, 2));
    await driver.close();
    break;
  }

  case 'judge': {
    const [question = '', reference = '', answer = ''] = rest;
    const meter = new UsageMeter();
    const kit = createJudge(config, new EventBus(), createLlm(config), meter);
    const res = await kit.judge.judge({ question, reference: reference || null, answer });
    console.log(JSON.stringify(res, null, 2));
    console.log(meter.summary());
    break;
  }

  case 'doctor': {
    const check = async (name: string, fn: () => Promise<string>) => {
      try {
        console.log(`✅ ${name}: ${await fn()}`);
      } catch (e) {
        console.log(`❌ ${name}: ${(e as Error).message.split('\n')[0]}`);
      }
    };
    await check('Node', async () => process.version);
    await check('Discord-Token', async () => {
      if (!process.env[config.discord.tokenEnv]) throw new Error(`${config.discord.tokenEnv} fehlt (nur für "qbhost discord" nötig)`);
      return 'gesetzt';
    });
    const configFile = path.resolve(values.config ?? 'qbhost.config.json');
    console.log(existsSync(configFile) ? `ℹ️  Konfiguration: ${configFile}` : `ℹ️  Keine ${path.basename(configFile)} gefunden – es gelten die Standardwerte (Vorlage: qbhost.config.example.json)`);
    {
      // From the status file only – no browser: the bot may hold the profile right now.
      const status = new LoginStatusStore(config.account.statusFile).read();
      const now = Date.now();
      const tail = status.state === 'unknown' && !status.lastCheckAt ? ' (läuft der Bot?)' : '';
      console.log(`${loginStatusIcon(status)} ${formatLoginStatus(status, now, config.account.loginCommand)}${tail}`);
      for (const line of formatLoginHistory(status, now, 5)) console.log(`     ${line}`);
    }
    if (config.llm.provider === 'claude-cli') {
      await check('Claude CLI', async () => {
        try {
          return (await run(config.llm.claudeBin, ['--version'])).stdout.trim();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`"${config.llm.claudeBin}" nicht gefunden – Claude Code installieren und einloggen, oder llm.provider "anthropic" (ANTHROPIC_API_KEY) bzw. "none" setzen`);
          throw e;
        }
      });
    }
    if (config.browser.driver === 'orca') await check('Orca CLI', async () => (await run(config.browser.orcaBin, ['--version'])).stdout.trim().split('\n')[0]!);
    await check('Playwright Chromium', async () => {
      const { chromium } = await import('playwright');
      try {
        const b = await chromium.launch({ headless: true });
        const v = b.version();
        await b.close();
        return v;
      } catch (e) {
        if (/Executable doesn't exist|npx playwright install/.test((e as Error).message)) throw new Error('Chromium fehlt → npx playwright install chromium');
        throw e;
      }
    });
    const cloudStt = config.voice.stt === 'deepgram';
    await check(`Sprachsteuerung (STT ${cloudStt ? 'Cloud + lokal' : 'lokal'}, TTS lokal)`, async () => {
      const problems = await voiceProblems(config);
      if (problems.length) throw new Error(`${problems.join('; ')} → npx qbhost voice-setup`);
      const local = config.voice.localStt === 'parakeet' ? 'Parakeet (sherpa-onnx)' : 'whisper.cpp';
      return `${cloudStt ? `Deepgram (Rückfall ${local})` : local} + ${config.voice.tts === 'piper' ? 'Piper' : 'say'} bereit`;
    });
    for (const w of await voiceWarnings(config).catch(() => [])) console.log(`⚠️  ${w} → npx qbhost voice-setup (bei Cloud-Ausfall sonst nur der Hinweis im Chat)`);
    if (cloudStt) {
      const dg = config.voice.deepgram;
      // Only whether it is set – never the value.
      await check('Deepgram-Schlüssel', async () => {
        if (!process.env[dg.keyEnv]?.trim()) throw new Error(`fehlt (${dg.keyEnv}) → in .env eintragen`);
        return `gesetzt (${dg.keyEnv})`;
      });
      // DNS + TLS only, no request: costs nothing and needs no key.
      await check('Deepgram-Endpunkt', async () => `${new URL(dg.baseUrl).host} erreichbar, TLS in ${await deepgramReachable(dg.baseUrl)} ms (ohne Anfrage, ohne Kosten)`);
    }
    await check(`LLM (${config.llm.provider}/${config.llm.model})`, async () => {
      const meter = new UsageMeter();
      const kit = createJudge({ ...config, judge: { ...config.judge, cacheFile: '.qbhost/doctor-cache.json' } }, new EventBus(), createLlm(config), meter);
      const r = await kit.judge.judge({ question: 'Hauptstadt von Frankreich?', reference: 'Paris', answer: 'die stadt der liebe, paris!' });
      const r2 = await kit.judge.judge({ question: 'Wer malte die Mona Lisa?', reference: 'Leonardo da Vinci', answer: 'da vinci' });
      return `${r.verdict} via ${r.method}, ${r2.verdict} via ${r2.method} – ${meter.summary()}`;
    });
    break;
  }

  default:
    console.log(USAGE);
    process.exit(1);
}
