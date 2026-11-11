import type { BrowserDriver } from '../browser/driver.ts';
import { createLogger, sleep } from '../core/logger.ts';

const log = createLogger('lobby');

export type QuizFormat = 'Tafelquiz' | 'Eagle Eye' | 'Punktejagd' | 'Auktion' | 'Blind Ranking';

/** Small in-page helpers for the create-lobby wizard (format → board → preview → lobby). */
const H = `({
  vis(e){return !!e && e.getClientRects().length>0},
  t(e){return e?(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim():''},
  clickButton(label, prefix){
    const bs=[...document.querySelectorAll('main button')].filter(b=>this.vis(b));
    const b=bs.find(b=>this.t(b)===label)||(prefix?bs.find(b=>this.t(b).startsWith(label)):null)||bs.find(b=>this.t(b).includes(label));
    if(!b) return {ok:false,error:'not found: '+label};
    if(b.disabled) return {ok:false,error:'disabled: '+label};
    b.click(); return {ok:true};
  },
  boardTitles(){ return [...document.querySelectorAll('main h3')].filter(h=>this.vis(h)).map(h=>this.t(h)) },
  pickBoard(title){
    const h=[...document.querySelectorAll('main h3')].find(h=>this.t(h).toLowerCase()===title.toLowerCase())
      ||[...document.querySelectorAll('main h3')].find(h=>this.t(h).toLowerCase().includes(title.toLowerCase()));
    if(!h) return {ok:false,error:'board not found: '+title};
    let e=h; while(e && getComputedStyle(e).cursor!=='pointer') e=e.parentElement;
    (e||h).click(); return {ok:true, title:this.t(h)};
  },
  heading(){ return this.t(document.querySelector('main h1')) },
})`;

async function call<T>(driver: BrowserDriver, expr: string): Promise<T> {
  return driver.evaluate<T>(`${H}.${expr}`);
}

async function until(driver: BrowserDriver, expr: string, timeoutMs = 10000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await call<boolean>(driver, expr).catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Creates a lobby for a public community board. Returns once the waiting room
 * is shown. (Own/saved boards require login – do that once in the persistent
 * browser profile, then extend this with "Eigenes Board".)
 */
export async function createLobbyWithPublicBoard(
  driver: BrowserDriver,
  baseUrl: string,
  format: QuizFormat,
  boardTitle: string,
): Promise<void> {
  log.info(`Erstelle Lobby: ${format} / "${boardTitle}"`);
  await driver.goto(`${baseUrl}/create-lobby`);
  await until(driver, `boardTitles().includes(${JSON.stringify(format)})`);
  await expectOk(call(driver, `clickButton(${JSON.stringify(format)}, true)`), 'Format wählen');
  await until(driver, `heading()===${JSON.stringify(format)}`);
  await expectOk(call(driver, `clickButton('Öffentliches Board verwenden')`), 'Öffentliches Board');
  const loaded = await until(driver, `boardTitles().length>3`, 15000);
  if (!loaded) throw new Error('Board-Liste lädt nicht');
  const picked = await call<{ ok: boolean; title?: string; error?: string }>(driver, `pickBoard(${JSON.stringify(boardTitle)})`);
  if (!picked.ok) throw new Error(picked.error);
  log.info(`Board gewählt: ${picked.title}`);
  await sleep(500);
  await expectOk(call(driver, `clickButton('Board verwenden', true)`), 'Board verwenden');
  await until(driver, `heading()==='Board Vorschau'`);
  await expectOk(call(driver, `clickButton('Lobby erstellen')`), 'Lobby erstellen');
  if (!(await until(driver, `heading()==='Lobby Warteraum'`, 15000))) throw new Error('Warteraum erscheint nicht');
}

export async function listPublicBoards(driver: BrowserDriver, baseUrl: string, format: QuizFormat): Promise<string[]> {
  await driver.goto(`${baseUrl}/create-lobby`);
  await until(driver, `boardTitles().includes(${JSON.stringify(format)})`);
  await call(driver, `clickButton(${JSON.stringify(format)}, true)`);
  await until(driver, `heading()===${JSON.stringify(format)}`);
  await call(driver, `clickButton('Öffentliches Board verwenden')`);
  await until(driver, `boardTitles().length>3`, 15000);
  return call<string[]>(driver, 'boardTitles()');
}

async function expectOk(p: Promise<unknown>, what: string): Promise<void> {
  const r = (await p) as { ok: boolean; error?: string };
  if (!r?.ok) throw new Error(`${what}: ${r?.error ?? 'fehlgeschlagen'}`);
  await sleep(400);
}
