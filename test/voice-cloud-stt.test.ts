import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { decodeWav, type Pcm } from '../src/voice/audio.ts';
import { createVoiceKit } from '../src/voice/index.ts';
import { FallbackStt } from '../src/voice/providers.ts';
import { DeepgramStt } from '../src/voice/stt-deepgram.ts';
import type { Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel('error');

const KEY = 'dg-test-SECRET-c0ffee1234';
const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const BEN: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };
const SOLUTIONS = ['10', 'Tatooine'];

/** Room utterances are 0.5 s long: wait until one begun now starts after the last change of permission. */
const settle = () => new Promise((r) => setTimeout(r, 600));

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Real controller + fake quiz-base page (as in discord-bot.test.ts). */
class FakeSession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  page: FakeTafelquizPage;
  private ac = new AbortController();
  board = '';
  constructor(private config: Config) {
    this.page = new FakeTafelquizPage(
      ['Anna', 'Ben'],
      [
        [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: SOLUTIONS[0]! }],
        [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: SOLUTIONS[1]! }],
      ],
    );
    this.rules = { ...config.game };
  }
  async createLobby(board: string) {
    this.board = board;
    return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
  }
  async run() {
    const judge = createJudge(this.config, this.bus, null, this.meter);
    await new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: 20 }).run(this.ac.signal);
  }
  async endGame() {
    this.ac.abort();
    await this.page.endGame();
  }
  async close() {
    this.ac.abort();
  }
}

/** Voice room: utterances carry their text id in the first sample; the bot's speech is recorded by text. */
class Room implements VoiceTransport {
  label = 'room';
  played: string[] = [];
  private handlers: ((u: Utterance) => void)[] = [];
  constructor(private texts: Map<number, string>) {}
  async play(pcm: Pcm) {
    this.played.push(this.texts.get(pcm.samples[0]!) ?? '?');
  }
  stop() {}
  onUtterance(h: (u: Utterance) => void) {
    this.handlers.push(h);
  }
  onClose() {}
  async close() {}
  speak(speaker: Speaker, text: string) {
    const id = 1000 + this.texts.size;
    this.texts.set(id, text);
    const samples = new Int16Array(8000).fill(4000);
    samples[0] = id;
    const now = Date.now();
    for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
  }
}

/**
 * Fake Deepgram `/v1/listen`: reads the utterance id back from the WAV (16 kHz mono passes unchanged) and
 * answers with its text – or never (`hang`). Records each request's keyterms.
 */
async function fakeDeepgram(texts: Map<number, string>) {
  const state = { hang: false, requests: [] as { keyterms: string[]; text: string; auth?: string; mip?: string | null }[], aborted: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    res.on('close', () => {
      if (!res.writableEnded) state.aborted++;
    });
    req.on('end', () => {
      const q = new URL(req.url!, 'http://x').searchParams;
      const text = texts.get(decodeWav(Buffer.concat(chunks)).samples[0]!) ?? '';
      state.requests.push({ keyterms: q.getAll('keyterm'), text, auth: req.headers.authorization, mip: q.get('mip_opt_out') });
      if (state.hang) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ metadata: { duration: 0.5 }, results: { channels: [{ alternatives: [{ transcript: text }] }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, url, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

describe('Cloud STT in a whole game (QuizBot + FakeGateway + fake Deepgram)', () => {
  it('keyterms never contain the solution while a question is open; after a cloud timeout the local fallback hears the answer', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qbcloud-'));
    const texts = new Map<number, string>();
    const dg = await fakeDeepgram(texts);
    const config = ConfigSchema.parse({
      game: { revealPauseSec: 0, answerTimeoutSec: 20, buzzWindowSec: 1, buzzAnswerTimeoutSec: 1, minPlayers: 2 },
      judge: { cacheFile: path.join(dir, 'cache.json'), strategy: 'fuzzy' },
      llm: { provider: 'none' },
      discord: { dataDir: dir },
      voice: { dir, ignoreWhileSpeaking: false, stt: 'deepgram', sttTimeoutMs: 300, deepgram: { baseUrl: dg.url } },
    });
    const room = new Room(texts);
    const local: string[] = [];
    const kit = createVoiceKit(config, {
      env: { DEEPGRAM_API_KEY: KEY },
      // Fake whisper (wake checks and the fallback): hears the utterance's text.
      local: ({ model }) => ({
        engine: `whisper:${path.basename(model, '.bin').replace(/^ggml-/, '')}`,
        transcribe: async (p) => (local.push(texts.get(p.samples[0]!) ?? ''), texts.get(p.samples[0]!) ?? ''),
        close: async () => {},
      }),
    });
    expect((kit.stt as FallbackStt).primary).toBeInstanceOf(DeepgramStt); // the real adapter, only the endpoint is fake
    const voice: VoiceKit = {
      stt: kit.stt,
      fastStt: kit.fastStt,
      confirmStt: kit.confirmStt,
      wakeStt: kit.wakeStt,
      tts: {
        engine: 'piper:test',
        synth: async (text: string) => {
          const id = 1000 + texts.size;
          texts.set(id, text);
          return { rate: 16000, channels: 1, samples: Int16Array.from([id, 0, 0]) };
        },
        close: async () => {},
      },
      warmup: async () => {},
    };
    let handler: (m: ChatMessage) => Promise<void> | void = () => {};
    const sent: string[] = [];
    const gw: ChatGateway = {
      botUserId: 'bot',
      onMessage: (h) => (handler = h),
      send: async (_c, text) => void sent.push(text),
      sendDirect: async () => {},
      react: async () => {},
      joinVoice: async () => room,
      voiceMembers: () => [ANNA, BEN],
    };
    const bot = new QuizBot({
      gateway: gw,
      config,
      store: new GuildStore(dir),
      createSession: (cfg) => new FakeSession(cfg),
      listBoards: async (q) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
      voice,
    });
    const type = (content: string) =>
      handler({ id: content, channelId: 'chan', guildId: 'guild', author: { ...ANNA, isBot: false }, content, mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc' });
    try {
      await type('!quiz voice');
      await until(() => room.played.some((t) => t.includes('Quizmaster')));
      room.speak(ANNA, 'Quizmaster, neues Quiz Board'); // the wake check: local, nothing to the cloud
      await until(() => room.played.some((t) => t.includes('Dazu passen 2 Boards')));
      expect(dg.state.requests).toEqual([]);
      await settle(); // the cloud hears an utterance only if it began after the permission (review F11)
      room.speak(ANNA, 'Nummer eins'); // menu: cloud
      await until(() => !!bot.activeGame?.turn);
      await settle();
      room.speak(ANNA, 'Film für zweihundert');
      await until(() => room.played.some((t) => t.includes('Geburtsplanet')));
      await until(() => !!bot.activeGame?.awaiting);
      await settle();
      // The question is open: Anna answers, the cloud hears it.
      room.speak(ANNA, 'Meine Antwort ist Tatooine');
      await until(() => room.played.includes('Tatooine?'));
      const answer = dg.state.requests.find((r) => r.text === 'Meine Antwort ist Tatooine')!;
      expect(answer.keyterms).toEqual(expect.arrayContaining(['Quizmaster', 'Meine Antwort ist', 'Film', 'Sport', 'Anna', 'Ben']));
      for (const r of dg.state.requests) {
        expect(r.mip).toBe('true');
        expect(r.auth).toBe(`Token ${KEY}`);
        for (const term of r.keyterms) for (const s of SOLUTIONS) expect(term.toLowerCase().split(/[^\p{L}\d]+/u)).not.toContain(s.toLowerCase());
        expect(r.keyterms.join(' ')).not.toMatch(/tatooine/i);
      }
      expect(local).toEqual(['Quizmaster, neues Quiz Board']); // the cloud heard everything else

      // The cloud stops answering: after sttTimeoutMs the same "Ja" is heard locally – once.
      dg.state.hang = true;
      await settle();
      const before = room.played.length;
      room.speak(ANNA, 'Ja, genau.');
      await until(() => room.played.slice(before).some((t) => t.startsWith('Richtig')));
      expect(local.at(-1)).toBe('Ja, genau.');
      expect(dg.state.requests.at(-1)!.text).toBe('Ja, genau.');
      await until(() => dg.state.aborted === 1); // the cloud request was really cut off
      expect(room.played.slice(before).filter((t) => t.startsWith('Richtig'))).toHaveLength(1);
      expect(sent.join('\n')).not.toContain('Sprache gestört');
      expect(sent.join('\n')).not.toContain(KEY);
    } finally {
      await bot.shutdown();
      await dg.close();
    }
  }, 30000);
});
