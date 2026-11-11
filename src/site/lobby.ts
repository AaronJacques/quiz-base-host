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
  norm(x){ return x.toLowerCase().replace(/\\s+/g,' ').trim() },
  pickBoard(title){
    const hs=[...document.querySelectorAll('main h3')].filter(h=>this.vis(h));
    const want=this.norm(title);
    let h=hs.find(h=>this.norm(this.t(h))===want);
    if(!h){
      const partial=hs.filter(h=>this.norm(this.t(h)).includes(want));
      if(partial.length===1) h=partial[0];
      else return {ok:false,error:(partial.length?'mehrdeutig: ':'nicht gefunden: ')+title, candidates:partial.map(h=>this.t(h))};
    }
    let e=h; while(e && getComputedStyle(e).cursor!=='pointer') e=e.parentElement;
    (e||h).click(); return {ok:true, title:this.t(h)};
  },
  search(q){
    const i=document.querySelector('main input[placeholder^="Nach Boards suchen"]');
    if(!i) return {ok:false,error:'Suchfeld fehlt'};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,q);
    i.dispatchEvent(new Event('input',{bubbles:true}));
    return {ok:true};
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
  await openPublicBoards(driver, baseUrl, format);
  await searchBoards(driver, boardTitle);
  const picked = await call<{ ok: boolean; title?: string; error?: string }>(driver, `pickBoard(${JSON.stringify(boardTitle)})`);
  if (!picked.ok) throw new Error(`Board ${picked.error}`);
  log.info(`Board gewählt: ${picked.title}`);
  await sleep(500);
  await expectOk(call(driver, `clickButton('Board verwenden', true)`), 'Board verwenden');
  await until(driver, `heading()==='Board Vorschau'`);
  await expectOk(call(driver, `clickButton('Lobby erstellen')`), 'Lobby erstellen');
  if (!(await until(driver, `heading()==='Lobby Warteraum'`, 15000))) throw new Error('Warteraum erscheint nicht');
}

/**
 * Public boards of a format. Without a query: quiz-base's default selection
 * (~40 boards). With a query: quiz-base's own search, which also finds boards
 * that are not in the default selection.
 */
export async function listPublicBoards(driver: BrowserDriver, baseUrl: string, format: QuizFormat, query?: string): Promise<string[]> {
  await openPublicBoards(driver, baseUrl, format);
  if (query?.trim()) await searchBoards(driver, query.trim());
  return call<string[]>(driver, 'boardTitles()');
}

async function openPublicBoards(driver: BrowserDriver, baseUrl: string, format: QuizFormat): Promise<void> {
  await driver.goto(`${baseUrl}/create-lobby`);
  await until(driver, `boardTitles().includes(${JSON.stringify(format)})`);
  await expectOk(call(driver, `clickButton(${JSON.stringify(format)}, true)`), 'Format wählen');
  await until(driver, `heading()===${JSON.stringify(format)}`);
  await expectOk(call(driver, `clickButton('Öffentliches Board verwenden')`), 'Öffentliches Board');
  if (!(await until(driver, `boardTitles().length>3`, 15000))) throw new Error('Board-Liste lädt nicht');
}

/** Types into quiz-base's board search and waits until the (debounced, server-side) result list settles. */
async function searchBoards(driver: BrowserDriver, query: string): Promise<void> {
  const sig = () => call<string[]>(driver, 'boardTitles()').then((t) => t.join('|'));
  const before = await sig();
  await expectOk(call(driver, `search(${JSON.stringify(query)})`), 'Board-Suche');
  const end = Date.now() + 4000;
  let last = await sig();
  while (last === before && Date.now() < end) {
    await sleep(300);
    last = await sig();
  }
  // Settled = unchanged over two consecutive polls.
  for (let stable = 0; stable < 2 && Date.now() < end + 4000; ) {
    await sleep(400);
    const now = await sig();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

async function expectOk(p: Promise<unknown>, what: string): Promise<void> {
  const r = (await p) as { ok: boolean; error?: string };
  if (!r?.ok) throw new Error(`${what}: ${r?.error ?? 'fehlgeschlagen'}`);
  await sleep(400);
}
