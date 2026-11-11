import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { runHost } from './app.ts';
import { runDiscordBot } from './discord/index.ts';
import { createDriver } from './browser/index.ts';
import { loadConfig, type Config } from './config.ts';
import { EventBus } from './core/events.ts';
import { setLogLevel } from './core/logger.ts';
import { createJudge } from './judge/index.ts';
import { createLlm, UsageMeter } from './llm/index.ts';
import { listPublicBoards } from './site/lobby.ts';
import { TafelquizPage } from './site/tafelquiz/page.ts';

const run = promisify(execFile);

const USAGE = `qbhost – Claude als Host für quiz-base.de (Tafelquiz)

Befehle:
  host     Spiel hosten, Bedienung über Terminal + Web-Spieler-Pult (Standard)
  discord  Als Discord-Bot laufen (Token in DISCORD_TOKEN bzw. .env)
  boards   Öffentliche Tafelquiz-Boards auflisten
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
  },
});

// Secrets like DISCORD_TOKEN may live in a local .env file (gitignored).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env */
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.verbose) setLogLevel('debug');

const config: Config = loadConfig(values.config ?? 'qbhost.config.json', {
  browser: { driver: values.driver as any, orcaPageId: values.page, headless: values.headless },
  game: { publicBoard: values.board, autoStart: values['auto-start'] },
  llm: { provider: values.llm as any, model: values.model },
  judge: { strategy: values.judge as any },
  companion: { enabled: values['no-companion'] ? false : undefined, port: values.port ? Number(values.port) : undefined },
});

const [command = 'host', ...rest] = positionals;

switch (command) {
  case 'host':
    await runHost(config);
    break;

  case 'discord':
    try {
      await runDiscordBot(config);
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    break;

  case 'boards': {
    const driver = createDriver(config);
    await driver.open(config.baseUrl);
    const titles = await listPublicBoards(driver, config.baseUrl, 'Tafelquiz');
    console.log(titles.map((t) => `• ${t}`).join('\n'));
    await driver.close();
    break;
  }

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
    await check('Claude CLI', async () => (await run(config.llm.claudeBin, ['--version'])).stdout.trim());
    await check('Orca CLI', async () => (await run(config.browser.orcaBin, ['--version'])).stdout.trim().split('\n')[0]!);
    await check('Playwright Chromium', async () => {
      const { chromium } = await import('playwright');
      const b = await chromium.launch({ headless: true });
      const v = b.version();
      await b.close();
      return v;
    });
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
