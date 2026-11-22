import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { LoginStatusStore } from './account.ts';
import { QuizBaseBoardStudio } from './board-studio.ts';
import { BoardStore, defaultSpec, fullPreview, specLines, specProblems, type BoardSpec, type GeneratedBoard } from './boardgen/index.ts';
import { createDriver } from './browser/index.ts';
import { PlaywrightDriver } from './browser/playwright-driver.ts';
import type { Config } from './config.ts';
import { sleep } from './core/logger.ts';
import { BoardEditorPage } from './site/editor/page.ts';

export const LOGIN_TIMEOUT_MS = 15 * 60_000;

/**
 * `qbhost login`: opens a visible Chromium with the persistent profile so the user can sign in to
 * quiz-base themselves. Never types, reads or stores credentials – it only watches the user menu for
 * the logged-in labels and keeps the profile (cookies) for later headless runs.
 */
export async function runLogin(config: Config): Promise<void> {
  if (config.browser.driver !== 'playwright') {
    console.log(`ℹ️  Browser "${config.browser.driver}": melde dich dort direkt bei quiz-base an. "qbhost login" ist für den eigenen Chromium (Profil ${config.browser.profileDir}).`);
  }
  const t0 = Date.now();
  const driver = new PlaywrightDriver({ profileDir: config.browser.profileDir, headless: false, owner: 'login' });
  let detected = false;
  try {
    await driver.open(config.baseUrl);
    const page = new BoardEditorPage(driver, config.baseUrl);
    await sleep(1500);
    if ((await page.loginState()) === true) {
      await driver.close();
      recordLogin(config, true, t0);
      console.log('✅ Schon bei quiz-base angemeldet. Profil bleibt gespeichert.');
      return;
    }
    // Leave the user menu open – it holds the login form.
    await page.openUserMenu().catch(() => {});
    console.log(
      [
        '🔐 Im Browserfenster: oben rechts im Benutzermenü bei quiz-base anmelden (E-Mail + Passwort).',
        '   qbhost gibt nichts ein und liest nichts mit. Sobald du angemeldet bist, schließt sich das Fenster',
        '   von selbst – oder schließ es selbst. Abbrechen: Strg+C.',
      ].join('\n'),
    );
    detected = await watchLogin(page, Date.now() + LOGIN_TIMEOUT_MS);
  } finally {
    // Closed (and the profile free) before checkLogin opens it again – never two browsers on one profile.
    await driver.close().catch(() => {});
  }
  if (detected) recordLogin(config, true, t0);
  const state = detected ? true : await checkLogin(config);
  if (state === true) console.log('✅ Angemeldet. Das Profil bleibt gespeichert; eigene Boards gehen jetzt.');
  else if (state === null) console.log('❔ Anmeldung nicht sicher erkennbar – `npx qbhost doctor` zeigt später den Stand (der Bot prüft nach dem Start selbst).');
  else console.log('❌ Nicht angemeldet. Bitte "npx qbhost login" noch einmal ausführen.');
  if (state !== true) process.exitCode = 1;
}

/** Writes a check from the login commands into the status file (on the server only useful locally: the login container has no data dir). */
function recordLogin(config: Config, value: boolean | null, t0: number): void {
  new LoginStatusStore(config.account.statusFile).record({
    at: new Date(t0).toISOString(),
    source: 'login',
    result: value === true ? 'ok' : value === false ? 'lost' : 'unclear',
    ms: Date.now() - t0,
  });
}

/**
 * Waits until the user has logged in themselves (or `until` passes, the browser closes, `stop()` says so).
 * Only reads the user menu's labels via the probe – never a form field.
 */
export async function watchLogin(page: BoardEditorPage, until: number, stop: () => boolean = () => false): Promise<boolean> {
  let formSeen = false;
  while (Date.now() < until && !stop()) {
    await sleep(2000);
    if (stop()) break;
    const acc = await page.accountSnapshot().catch(() => 'closed' as const);
    if (acc === 'closed') break;
    let detected = false;
    if (acc.loggedIn) {
      detected = true;
    } else if (acc.menuOpen) {
      formSeen = true;
      continue;
    } else if (formSeen) {
      // quiz-base closes the menu after logging in – check once by opening it briefly.
      formSeen = false;
      detected = (await page.loginState().catch(() => null)) === true;
    }
    if (detected) {
      await sleep(1500);
      return true;
    }
  }
  return false;
}

/**
 * Headless check whether the persistent profile is logged in to quiz-base: true, false (sure: twice "logged out"),
 * or null (could not tell – never treat that as logged out). Writes the result into the status file.
 */
export async function checkLogin(config: Config): Promise<boolean | null> {
  const t0 = Date.now();
  const driver = new PlaywrightDriver({ profileDir: config.browser.profileDir, headless: true, owner: 'login' });
  let state: boolean | null = null;
  try {
    await driver.open(config.baseUrl);
    await sleep(1500);
    state = await new BoardEditorPage(driver, config.baseUrl).loginState();
  } finally {
    await driver.close().catch(() => {});
  }
  recordLogin(config, state, t0);
  return state;
}

/** Extra flags of `qbhost board-create` (merged into the CLI's parseArgs options). */
export const BOARD_CLI_OPTIONS = {
  topic: { type: 'string' },
  themes: { type: 'string' },
  categories: { type: 'string' },
  rows: { type: 'string' },
  step: { type: 'string' },
  boards: { type: 'string' },
  level: { type: 'string' },
  lang: { type: 'string' },
  mc: { type: 'string' },
  name: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  from: { type: 'string' },
  'gen-model': { type: 'string' },
} as const;

const BOARD_USAGE = `qbhost board-create – Tafelquiz-Board von Claude schreiben lassen und auf quiz-base anlegen

  npx qbhost board-create --topic "Star Wars" [Optionen]
  npx qbhost board-create Star Wars --categories 5 --rows 4 --level profi

Optionen (Standardwerte aus boardgen.defaults):
  --topic "<Thema>"          Thema (oder als freie Wörter)
  --themes "A, B, C"         Themenbereiche, je einer pro Kategorie
  --categories <n>           Kategorien pro Board (2–8, Standard 4)
  --rows <n>                 Punktestufen pro Kategorie (1–10, Standard 4)
  --step <n>                 Punkte pro Stufe (Vielfache von 50, Standard 100)
  --boards <1|2>             ein oder zwei Boards
  --level <kinder|schule|oberstufe|kneipe|profi>
  --lang <de|en|…>           Sprache der Fragen (Standard de)
  --mc <0–1 | n%>            Anteil Multiple Choice (Standard 0)
  --name "<Board-Name>"      sonst schlägt Claude einen vor
  --gen-model <modell>       Modell (Standard boardgen.model = sonnet)
  --yes, -y                  ohne Rückfragen
  --dry-run                  nur erzeugen und lokal speichern (.qbhost/boards/), nichts anlegen
  --force                    neu erzeugen, auch wenn es dieselbe Anfrage schon gibt
  --from <datei.json|id>     ein schon erzeugtes Board anlegen (kein neuer LLM-Aufruf)

Boards werden als privater Entwurf gespeichert; veröffentlichen kannst du selbst unter
„Meine Boards“ auf quiz-base. Vorher einmal "npx qbhost login" (eigene Boards brauchen einen
quiz-base-Account).`;

const plain = (s: string) => s.replace(/\*\*/g, '');

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('Keine Rückfrage möglich (kein Terminal) – mit --yes bestätigen.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(j|ja|y|yes)$/i.test((await rl.question(`${question} (j/N) `)).trim());
  } finally {
    rl.close();
  }
}

function share(v: string): number {
  const n = Number(v.replace('%', '').replace(',', '.'));
  return v.endsWith('%') || n > 1 ? n / 100 : n;
}

/** Builds the request from CLI flags on top of `boardgen.defaults`. */
export function specFromFlags(config: Config, values: Record<string, unknown>, rest: string[]): BoardSpec {
  const v = values as Record<string, string | boolean | undefined>;
  const n = (k: string) => (typeof v[k] === 'string' ? Number(v[k]) : undefined);
  const over: Partial<BoardSpec> = {};
  if (v.themes) over.themes = String(v.themes).split(/\s*,\s*/).filter(Boolean);
  if (n('categories') !== undefined) over.categories = n('categories')!;
  if (n('rows') !== undefined) over.rows = n('rows')!;
  if (n('step') !== undefined) over.step = n('step')!;
  if (n('boards') !== undefined) over.boards = n('boards') as 1 | 2;
  if (v.level) over.level = String(v.level) as BoardSpec['level'];
  if (v.lang) over.language = String(v.lang);
  if (v.mc) over.mcShare = share(String(v.mc));
  if (v.name) over.name = String(v.name);
  return defaultSpec(config, String(v.topic ?? rest.join(' ')), over);
}

/** `qbhost board-create`: parameters + cost → generate → full preview in the terminal → create on quiz-base. */
export async function runBoardCreate(config: Config, values: Record<string, unknown>, rest: string[]): Promise<void> {
  if (values.help) return void console.log(BOARD_USAGE);
  if (typeof values['gen-model'] === 'string') config = { ...config, boardgen: { ...config.boardgen, model: values['gen-model'] } };
  const studio = new QuizBaseBoardStudio(config);
  const yes = !!values.yes;

  let recordId: string;
  if (typeof values.from === 'string') {
    recordId = importBoard(studio, values.from);
    const board = studio.load(recordId);
    console.log(fullPreview(board).map(plain).join('\n'));
  } else {
    const spec = specFromFlags(config, values, rest);
    const problems = specProblems(spec);
    if (!spec.topic) return void console.log(BOARD_USAGE);
    if (problems.length) throw new Error(problems.join(' '));
    const why = studio.unavailable();
    if (why) throw new Error(plain(why).replace(/`/g, ''));
    const existing = values.force ? undefined : studio.existing(spec);
    if (existing?.status === 'created') {
      console.log(`♻️  Das gleiche Board gibt es schon: ${existing.title}${existing.url ? ` · ${existing.url}` : ''} (neu erzeugen: --force)`);
      return;
    }
    console.log(['🧠 Neues Board', ...specLines(spec, studio.estimate(spec))].map(plain).join('\n  '));
    if (existing) {
      console.log(`♻️  Für diese Anfrage gibt es schon einen Entwurf (${existing.id}) – ich nehme ihn, ohne neue Kosten. Neu erzeugen: --force`);
      recordId = existing.id;
    } else {
      if (!(await confirm('Erzeugen?', yes))) return;
      const { record } = await studio.generate(spec, (t) => console.log(t));
      recordId = record.id;
    }
    console.log('\n' + fullPreview(studio.load(recordId)).map(plain).join('\n'));
  }
  console.log(`\n💾 Lokal gespeichert: ${path.join(config.boardgen.dir, `${recordId}.json`)}`);
  if (values['dry-run']) return;
  if (!(await confirm('Auf quiz-base anlegen?', yes))) return void console.log(`Später anlegen: npx qbhost board-create --from ${recordId}`);
  const rec = await studio.create(recordId, (t) => console.log(t));
  console.log(`✅ ${rec.title} angelegt (privater Entwurf)${rec.url ? `\n   Editor (zeigt die Lösungen): ${rec.url}` : ''}`);
  console.log('   Veröffentlichen kannst du selbst unter „Meine Boards“ auf quiz-base.');
  console.log(`   Spielen: npx qbhost host --board "${rec.title}" · Discord: ${config.discord.prefix} neu ${rec.title}`);
}

/** `qbhost board-delete "<Name>"`: deletes an own board on quiz-base; the local copy becomes a draft again. */
export async function runBoardDelete(config: Config, rest: string[], yes: boolean): Promise<void> {
  const name = rest.join(' ').trim();
  if (!name) throw new Error('Name fehlt: npx qbhost board-delete "<Name>"');
  if (!(await confirm(`„${name}“ auf quiz-base löschen? Das lässt sich nicht rückgängig machen.`, yes))) return;
  const driver = createDriver(config);
  try {
    await driver.open(config.baseUrl);
    const deleted = await new BoardEditorPage(driver, config.baseUrl).deleteOwnBoard(name);
    if (!deleted) throw new Error(`„${name}“ steht nicht unter „Meine Boards“ (Name genau wie dort angeben).`);
  } finally {
    await driver.close().catch(() => {});
  }
  const store = new BoardStore(config.boardgen.dir);
  for (const rec of store.findCreated(name).filter((r) => r.title.trim().toLowerCase() === name.toLowerCase())) store.markDeleted(rec.id);
  console.log(`🗑️  „${name}“ auf quiz-base gelöscht. Der lokale Entwurf bleibt (wieder anlegen: npx qbhost board-create --from <id>).`);
}

/** `--from`: a store id or a board JSON file (e.g. from another machine). */
function importBoard(studio: QuizBaseBoardStudio, from: string): string {
  if (studio.store.get(from)) return from;
  if (!existsSync(from)) throw new Error(`--from: weder Board-ID noch Datei: ${from}`);
  const board = JSON.parse(readFileSync(from, 'utf8')) as GeneratedBoard;
  if (!Array.isArray(board?.categories) || !board.spec) throw new Error(`--from: ${from} ist kein qbhost-Board`);
  return studio.store.saveDraft(board).id;
}
