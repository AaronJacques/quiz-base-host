// End-to-end voice test (run: npx tsx tools/voice-e2e/harness.ts): real QuizBot + real GameSession (quiz-base) + real STT/TTS.
// Only Discord is replaced: chat → log file + HTTP, voice room → LoopbackTransport.
// Player browsers (Anna, Ben) join quiz-base automatically once the lobby link appears.
import http from 'node:http';
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { loadConfig } from '../../src/config.ts';
import { onStopSignal } from '../../src/core/signals.ts';
import { QuizBot } from '../../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../../src/discord/gateway.ts';
import { GuildStore } from '../../src/discord/store.ts';
import { GameSession, fetchPublicBoards } from '../../src/session.ts';
import { createVoiceKit } from '../../src/voice/index.ts';
import { LoopbackTransport } from '../../src/voice/loopback.ts';

const DIR = '.qbhost/voice-e2e';
mkdirSync(DIR, { recursive: true });
const MAX_Q = Number(process.env.MAX_Q ?? 6);
// The harness always tests voice, whatever qbhost.config.json says. AUTO_START=0: the lobby waits for "Quizmaster, los".
// Small-server setup: FAST_MODEL=models/ggml-base-q5_1.bin AUDIO_CTX=512 (second whisper-server, smaller audio window).
const config = loadConfig('qbhost.config.json', {
  browser: { headless: true, profileDir: `${DIR}/host-profile` },
  discord: { dataDir: `${DIR}/discord`, channelIds: [], ...(process.env.AUTO_START === '0' ? { autoStart: false } : {}) },
  voice: {
    enabled: true,
    autoJoin: true,
    ...(process.env.FAST_MODEL ? { whisperFastModel: process.env.FAST_MODEL } : {}),
    ...(process.env.AUDIO_CTX ? { whisperAudioCtx: Number(process.env.AUDIO_CTX) } : {}),
  },
} as any);

const chatLog = `${DIR}/chat.log`;
writeFileSync(chatLog, '');
// Listening positions of earlier runs would make `client.mjs listen` wait for sentences that never come.
for (const f of readdirSync(DIR)) if (/^seq-.*\.txt$/.test(f)) rmSync(`${DIR}/${f}`, { force: true });
const status = { phase: 'start', questions: 0, over: false, joinUrl: '' };
const saveStatus = () => writeFileSync(`${DIR}/status.json`, JSON.stringify(status));
saveStatus();

// A closed room cannot be reused – a rejoin (`!quiz voice` after `voice aus`) gets a new one on the same port.
let room = new LoopbackTransport(4790);
await room.listen();
async function openRoom(): Promise<LoopbackTransport> {
  if (!room.closed) return room;
  room = new LoopbackTransport(4790, 1, room.lastSeq);
  await room.listen();
  return room;
}
const people = { Anna: { id: 'u-anna', username: 'anna', displayName: 'Anna' }, Ben: { id: 'u-ben', username: 'ben', displayName: 'Ben' } };

let handler: (m: ChatMessage) => void | Promise<void> = () => {};
let browser: Browser | null = null;
const gw: ChatGateway = {
  botUserId: 'bot',
  onMessage: (h) => (handler = h),
  send: async (_c, text) => {
    appendFileSync(chatLog, `[BOT] ${text}\n`);
    const m = text.match(/https:\/\/www\.quiz-base\.de\/join\?code=(\w+)/);
    if (m && !status.joinUrl) {
      status.joinUrl = m[0];
      saveStatus();
      void joinPlayers(m[0]);
    }
    if (/Spiel vorbei|Spiel beendet/.test(text)) {
      status.over = true;
      status.phase = 'over';
      saveStatus();
    }
  },
  sendDirect: async (u, text) => void appendFileSync(chatLog, `[DM ${u}] ${text}\n`),
  react: async (_m, e) => void appendFileSync(chatLog, `[react ${e}]\n`),
  joinVoice: () => openRoom(),
  voiceMembers: () => Object.values(people),
};

async function joinPlayers(url: string) {
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false }); // see PlaywrightDriver
  for (const name of Object.keys(people)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.getByRole('button', { name: 'Beitreten' }).first().click({ timeout: 15000 });
    await page.locator('input[placeholder="Dein Name"]').fill(name, { timeout: 15000 });
    await page.getByRole('button', { name: 'Beitreten' }).first().click();
    await page.getByRole('button', { name: 'Ich bin bereit!' }).click({ timeout: 15000 });
    appendFileSync(chatLog, `[harness] ${name} ist auf quiz-base beigetreten und bereit\n`);
  }
  status.phase = 'lobby';
  saveStatus();
}

const kit = createVoiceKit(config);
const bot = new QuizBot({
  gateway: gw,
  config,
  store: new GuildStore(config.discord.dataDir),
  createSession: (cfg) => {
    const s = new GameSession(cfg, []);
    s.bus.on('host:question', () => {
      status.questions++;
      status.phase = 'running';
      saveStatus();
    });
    s.bus.on('host:reveal', () => {
      if (status.questions >= MAX_Q && !status.over) {
        appendFileSync(chatLog, `[harness] ${MAX_Q} Fragen gespielt → Spielleitung beendet\n`);
        setTimeout(() => chat('Anna', '!quiz ende'), 6000);
      }
    });
    return s;
  },
  listBoards: (q) => fetchPublicBoards(config, q),
  voice: kit,
});

let n = 0;
function chat(who: keyof typeof people, content: string) {
  appendFileSync(chatLog, `[${who}] ${content}\n`);
  return handler({ id: `c${++n}`, channelId: 'chan', guildId: 'guild', author: { ...people[who], isBot: false }, content, mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc' });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/status') return void res.end(JSON.stringify(status));
    if (url.pathname === '/chat') {
      void chat(url.searchParams.get('user') as 'Anna', url.searchParams.get('text') ?? '');
      return void res.end('ok');
    }
    res.writeHead(404).end();
  })
  .listen(4791, '127.0.0.1');

// The one typed command: the leader calls the bot into the voice channel.
await chat('Anna', '!quiz voice');
status.phase = 'voice';
saveStatus();

onStopSignal(async () => {
  await bot.shutdown().catch(() => {});
  await kit.close().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(0);
});
