import type { z } from 'zod';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { PlaywrightDriver } from '../src/browser/playwright-driver.ts';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { onStopSignal } from '../src/core/signals.ts';
import { cleanSpokenAnswer, QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter, type JsonRequest, type JsonResponse, type LlmClient } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { decodeWav, durationMs, encodeWav, resample, rms, toChannels, type Pcm } from '../src/voice/audio.ts';
import { confirmReply, confirmWaits, endAskReply, extractAnswer, isBuzz, isEcho, mentionsCard, spokenNumber, spokenToDigits, stripWakeWord, voiceCommand } from '../src/voice/commands.ts';
import { VoiceBridge } from '../src/discord/voice-bridge.ts';
import { LoopbackTransport } from '../src/voice/loopback.ts';
import { createVoiceKit, voiceProblems } from '../src/voice/index.ts';
import { CONFIRM_AGAIN_LINE, END_ASK_LINE, END_KEEP_LINE, gameOverLine, GOODBYE_LINE, questionLine, revealLine, turnLine, verdictLine } from '../src/voice/narration.ts';
import { cleanTranscript, collapseLoops, WhisperServerStt, type SpeechToText } from '../src/voice/stt.ts';
import { VoiceHost, type Attention } from '../src/voice/voice-host.ts';
import type { Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import type { TextToSpeech } from '../src/voice/tts.ts';
import { forSpeech } from '../src/voice/voice-host.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel(process.env.QB_LOG as any ?? 'error');
const WAKE = ['quizmaster', 'quiz master', 'quizmeister'];

describe('voice: audio', () => {
  it('round-trips WAV and resamples', () => {
    const pcm: Pcm = { rate: 22050, channels: 1, samples: Int16Array.from({ length: 22050 }, (_, i) => Math.round(Math.sin(i / 10) * 8000)) };
    const back = decodeWav(encodeWav(pcm));
    expect(back.rate).toBe(22050);
    expect(back.samples.length).toBe(22050);
    const up = toChannels(resample(pcm, 48000), 2);
    expect(up.channels).toBe(2);
    expect(Math.round(durationMs(up))).toBe(1000);
    expect(rms(up)).toBeGreaterThan(4000);
  });
});

describe('voice: commands', () => {
  it('detects the wake word in the ways Whisper writes it', () => {
    expect(stripWakeWord('Quizmaster, wie ist der Stand?', WAKE)).toBe('wie ist der stand');
    expect(stripWakeWord('Hey Quiz-Master: neues Quiz Allgemeinwissen', WAKE)).toBe('neues quiz allgemeinwissen');
    expect(stripWakeWord('Quiz Meister wiederholen', WAKE)).toBe('wiederholen');
    expect(stripWakeWord('Ich nehme Sport für 200', WAKE)).toBeNull();
  });

  it('maps spoken instructions to commands', () => {
    expect(voiceCommand('neues Quiz Allgemeinwissen Quiz v1')).toEqual({ name: 'neu', args: ['allgemeinwissen', 'quiz', 'v1'] });
    expect(voiceCommand('ein neues Spiel')).toEqual({ name: 'neu', args: [] });
    expect(voiceCommand('ich bin Benjamin')).toEqual({ name: 'ich', args: ['benjamin'] });
    expect(voiceCommand('wie ist der Punktestand')?.name).toBe('stand');
    expect(voiceCommand('wie ist der Stand')?.name).toBe('stand');
    expect(voiceCommand('was ist noch frei')?.name).toBe('brett');
    expect(voiceCommand('kannst du das wiederholen')?.name).toBe('wiederholen');
    expect(voiceCommand('das war richtig')?.name).toBe('richtig');
    expect(voiceCommand('Spiel beenden')?.name).toBe('ende');
    expect(voiceCommand('tschüss')).toEqual({ name: 'voice', args: ['aus'] });
    expect(voiceCommand('blablub')).toBeNull();
  });

  it('understands buzzes, spoken numbers and point values', () => {
    expect(isBuzz('Buzzer!')).toBe(true);
    expect(isBuzz('Ich!')).toBe(true);
    expect(isBuzz('Ich weiß es')).toBe(true);
    expect(isBuzz('Ich glaube, es ist Paris')).toBe(false);
    expect(spokenNumber('Nummer zwei')).toBe(2);
    expect(spokenNumber('das erste bitte')).toBe(1);
    expect(spokenNumber('3')).toBe(3);
    expect(spokenNumber('Allgemeinwissen')).toBeNull();
    expect(spokenToDigits('Sport für zweihundert')).toBe('Sport für 200');
    expect(spokenToDigits('Filme hundert')).toBe('Filme 100');
    expect(spokenToDigits('Sport4300')).toBe('Sport für 300'); // Whisper hears "für" as "four"
    expect(spokenToDigits('Sport 4 200')).toBe('Sport für 200');
    expect(spokenToDigits('Sport 400')).toBe('Sport 400');
    expect(spokenToDigits('fünfhundertfünfzig bitte')).toBe('550 bitte');
    expect(spokenToDigits('Musik tausend')).toBe('Musik 1000');
  });

  it('takes spoken answers only with the keyword, and understands the confirmation', () => {
    expect(extractAnswer('Meine Antwort ist Paris.')).toBe('Paris');
    expect(extractAnswer('Okay, äh, meine Antwort ist: Luigi Mario')).toBe('Luigi Mario');
    expect(extractAnswer('Die Antwort lautet 42 Kilometer')).toBe('42 Kilometer');
    expect(extractAnswer('Meine finale Antwort ist B')).toBe('B');
    expect(extractAnswer('Antwort: Breaking Bad')).toBe('Breaking Bad');
    expect(extractAnswer('Nein, meine Antwort ist Berlin')).toBe('Berlin');
    expect(extractAnswer('Ich antworte mit Rom')).toBe('Rom');
    expect(extractAnswer('Meine Antwort ist')).toBe('');
    expect(extractAnswer('Antwort Istanbul')).toBe('Istanbul');
    expect(extractAnswer('Paris')).toBeNull();
    expect(extractAnswer('Ich weiß die Antwort nicht')).toBeNull();
    expect(extractAnswer('Was ist denn die Antwort?')).toBeNull();
    expect(extractAnswer('Antworten ist schwer')).toBeNull();
    expect(confirmReply('Ja.')).toBe('yes');
    expect(confirmReply('Ja, genau')).toBe('yes');
    expect(confirmReply('Richtig')).toBe('yes');
    expect(confirmReply('Nein')).toBe('no');
    expect(confirmReply('Nö, warte')).toBe('no');
    expect(confirmReply('Ja, nein, doch nicht')).toBe('no');
    expect(confirmReply('Keine Ahnung')).toBeNull();
    expect(isBuzz('Ja')).toBe(false);
    expect(isBuzz('Hier!')).toBe(true);
  });

  it('cleans transcripts and spoken answers', () => {
    expect(cleanTranscript(' Vielen Dank.')).toBe('');
    expect(cleanTranscript('Untertitel im Auftrag des ZDF, 2021')).toBe('');
    expect(cleanTranscript('[Musik] Luigi Mario')).toBe('Luigi Mario');
    expect(cleanSpokenAnswer('Ähm, ich glaube das ist Luigi Mario.')).toBe('Luigi Mario');
    expect(cleanSpokenAnswer('Moment')).toBe('');
    expect(cleanSpokenAnswer('Ja')).toBe('Ja');
    expect(forSpeech('🎯 <@123> (**Anna**) ist am Zug – schreib z.B. `Sport 100`')).toBe('(Anna) ist am Zug – schreib zum Beispiel Sport 100');
  });

  it('narrates naturally', () => {
    expect(gameOverLine([{ name: 'Ben', score: -50 }, { name: 'Anna', score: -150 }] as never)).toContain('Vorne liegt Ben mit -50 Punkten');
    const t = { player: 'Anna', open: [{ col: 0, row: 0, category: 'Sport', points: 100, answered: false }], grid: [], categories: ['Sport', 'Film'], board: { active: 1, count: 1 } };
    expect(turnLine(t, true)).toBe('Die Kategorien sind: Sport und Film. Anna, du bist dran. Welche Karte? Noch frei: Sport 100.');
    expect(questionLine({ player: 'Anna', category: 'Sport', points: 100, text: 'Wie viele Pins?', hasImage: true, hasAudio: false, options: ['8', '10'] }))
      .toBe('Sport für 100. Wie viele Pins? Die Möglichkeiten: A: 8. B: 10. Schaut dazu aufs Bild.');
    expect(verdictLine({ player: 'Anna', answer: 'zehn', correct: true, delta: 100 }, true)).toBe('„zehn“. Richtig! Plus 100.');
    expect(gameOverLine([{ name: 'Ben', score: 100, isTurn: false, hasBuzzed: false }, { name: 'Anna', score: 300, isTurn: false, hasBuzzed: false }]))
      .toContain('Gewonnen hat Anna mit 300 Punkten');
  });
});

describe('voice: controller', () => {
  it('accepts a buzz by voice (player:buzz) instead of the quiz-base buzzer', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbv-'));
    const config = ConfigSchema.parse({
      game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 1, buzzWindowSec: 2, buzzAnswerTimeoutSec: 1 },
      judge: { cacheFile: path.join(tmp, 'c.json') },
      llm: { provider: 'none' },
    });
    const bus = new EventBus();
    const page = new FakeTafelquizPage(['Anna', 'Ben'], [[{ category: 'Sport', points: 100, text: 'Pins beim Bowling?', note: '10' }]]);
    const controller = new TafelquizController({ page, bus, judge: createJudge(config, bus, null, new UsageMeter()), game: config.game, pollMs: 20 });
    bus.on('host:turn', ({ player, open }) => (open.length ? setTimeout(() => bus.emit('player:pick', { player, col: 0, row: 0 }), 5) : void page.endGame()));
    bus.on('host:await-answer', ({ player, viaBuzzer }) => setTimeout(() => bus.emit('player:answer', { player, answer: viaBuzzer ? 'zehn' : 'fünf' }), 5));
    bus.on('host:notice', (n) => {
      if (n.kind === 'buzzer-open') setTimeout(() => bus.emit('player:buzz', { player: 'Ben' }), 20);
    });
    await controller.run(new AbortController().signal);
    expect(page.players.find((p) => p.name === 'Ben')!.score).toBe(100);
    expect(page.players.find((p) => p.name === 'Anna')!.score).toBe(-50);
  }, 10000);
});

// ───────────────────────────── bot with a fake voice room ─────────────────────────────

/** Utterance audio is fake: the first sample is an id that the fake STT maps back to text. */
class FakeRoom implements VoiceTransport {
  label = 'fake';
  played: string[] = [];
  closed = false;
  /** How long playing one sentence takes (`played` lists it once it is over). */
  playDelay = 0;
  /** A sentence whose playback never ends (hanging speech output). */
  hang = '';
  private handlers: ((u: Utterance) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  constructor(private texts: Map<number, string>) {}
  async play(pcm: Pcm) {
    const text = this.texts.get(pcm.samples[0]!) ?? '?';
    if (text === this.hang) return new Promise<void>(() => {});
    if (this.playDelay) await new Promise((r) => setTimeout(r, this.playDelay));
    this.played.push(text);
  }
  stop() {}
  onUtterance(h: (u: Utterance) => void) {
    this.handlers.push(h);
  }
  onClose(h: () => void) {
    this.closeHandlers.push(h);
  }
  async close() {
    this.closed = true;
  }
  /** Discord dropped the connection by itself (kick, network). */
  drop() {
    this.closeHandlers.forEach((h) => h());
  }
  /** `ms`: how long the utterance is (default 500 ms). */
  speak(speaker: Speaker, text: string, ms = 500) {
    const id = 1000 + this.texts.size;
    this.texts.set(id, text);
    const samples = new Int16Array(Math.round(ms * 16)).fill(4000);
    samples[0] = id;
    const now = Date.now();
    for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: now - 500, endedAt: now });
  }
  all() {
    return this.played.join('\n');
  }
}

/** `calls` records every full transcription (a wake-word check uses only the wake words as prompt), `prompts` their prompts. */
function voiceKit(texts: Map<number, string>, calls: string[] = [], prompts: string[] = []): VoiceKit {
  const stt: SpeechToText = {
    transcribe: async (p, prompt = '') => {
      const text = texts.get(p.samples[0]!) ?? '';
      if (prompt.includes('Meine Antwort ist')) {
        calls.push(text);
        prompts.push(prompt);
      }
      return text;
    },
    close: async () => {},
  };
  const tts: TextToSpeech = {
    synth: async (text) => {
      const id = 1000 + texts.size;
      texts.set(id, text);
      return { rate: 16000, channels: 1, samples: Int16Array.from([id, 0, 0]) };
    },
    close: async () => {},
  };
  return { stt, tts, warmup: async () => {} };
}

/** An LLM for the judge of FakeSession games (null = fuzzy only, as before). */
let judgeLlm: LlmClient | null = null;

class FakeSession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  page = new FakeTafelquizPage(
    ['Anna', 'Ben'],
    [
      [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
      [{ category: 'Film', points: 200, text: 'Wie viele Episoden hat die Skywalker-Saga?', note: '9' }],
    ],
  );
  private ac = new AbortController();
  board = '';
  constructor(private config: Config) {
    this.rules = { ...config.game };
    // Like GameSession: operator point corrections go straight to the page.
    this.bus.on('operator:command', ({ command, args }) => {
      if (command === 'punkte') void this.page.award(args.slice(0, -1).join(' '), Number(args.at(-1)));
    });
  }
  async createLobby(board: string) {
    this.board = board;
    return { code: 'ABC123', joinUrl: 'https://www.quiz-base.de/join?code=ABC123' };
  }
  async run() {
    const judge = createJudge(this.config, this.bus, judgeLlm, this.meter);
    await new TafelquizController({ page: this.page, bus: this.bus, judge, game: this.rules, pollMs: 20 }).run(this.ac.signal);
  }
  async endGame() {
    this.ac.abort(); // like GameSession: stop the controller first, then end on the page
    await this.page.endGame();
  }
  async close() {
    this.ac.abort();
  }
}

async function until(fn: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

describe('QuizBot voice', () => {
  it('plays a whole game by voice: board choice, auto-link, picks, answers, voice buzzer', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbvoice-'));
    const config = ConfigSchema.parse({
      game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 3, buzzWindowSec: 2, buzzAnswerTimeoutSec: 2, minPlayers: 2 },
      judge: { cacheFile: path.join(tmp, 'cache.json'), strategy: 'fuzzy' },
      llm: { provider: 'none' },
      discord: { dataDir: tmp },
      voice: { ignoreWhileSpeaking: false, scoresEvery: 1 },
    });
    const texts = new Map<number, string>();
    const sttCalls: string[] = [];
    const room = new FakeRoom(texts);
    const anna: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
    const ben: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };
    const sent: string[] = [];
    let handler: (m: ChatMessage) => Promise<void> | void = () => {};
    const gw: ChatGateway = {
      botUserId: 'bot',
      onMessage: (h) => (handler = h),
      send: async (_c, t) => void sent.push(t),
      sendDirect: async () => {},
      react: async () => {},
      joinVoice: async () => room,
      voiceMembers: () => [anna, ben],
    };
    let session: FakeSession | null = null;
    const bot = new QuizBot({
      gateway: gw,
      config,
      store: new GuildStore(tmp),
      createSession: (cfg) => (session = new FakeSession(cfg)),
      listBoards: async (q) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
      voice: voiceKit(texts, sttCalls),
    });

    await handler({ id: '1', channelId: 'chan', guildId: 'guild', author: { ...anna, isBot: false }, content: '!quiz voice', mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc' });
    await until(() => room.all().includes('Quizmaster'));

    room.speak(anna, 'Quizmaster, neues Quiz Board');
    await until(() => room.all().includes('Dazu passen 2 Boards'));
    room.speak(anna, 'Nummer eins');
    await until(() => !!bot.activeGame?.turn, 8000); // both linked automatically via voice members → auto start
    expect(session!.board).toBe('Test Board');
    expect(room.all()).toContain('Die Kategorien sind: Sport und Film. Anna, du bist dran.');

    room.speak(ben, 'Sport hundert'); // not Ben's turn → ignored
    room.speak(anna, 'Sport für hundert');
    await until(() => !!bot.activeGame?.awaiting);
    expect(room.all()).toContain('Sport für 100. Wie viele Pins beim Bowling?');
    room.speak(ben, 'Meine Antwort ist zwölf'); // not Ben's question → never even transcribed in full
    room.speak(anna, 'Ähm, zehn, oder?'); // thinking aloud, no keyword → does not count
    room.speak(anna, 'Okay, meine Antwort ist zehn.');
    await until(() => room.played.includes('zehn?'));
    expect(bot.activeGame?.awaiting?.player).toBe('Anna'); // not submitted before "Ja"
    room.speak(anna, 'Ja, genau.');
    await until(() => room.all().includes('Richtig! Plus 100.'));

    await until(() => bot.activeGame?.turn?.player === 'Ben' && !bot.activeGame.questionOpen);
    room.speak(ben, 'Film zweihundert');
    await until(() => bot.activeGame?.awaiting?.player === 'Ben');
    room.speak(ben, 'Meine Antwort ist acht');
    await until(() => room.played.includes('acht?'));
    room.speak(ben, 'Nein, warte.');
    await until(() => room.played.includes('Okay. Deine Antwort?'));
    room.speak(ben, 'Die Antwort ist sieben');
    await until(() => room.played.includes('sieben?'));
    room.speak(ben, 'Ja');
    await until(() => room.all().includes('Jetzt die anderen! Wer es weiß'));
    room.speak(anna, 'Ja'); // side talk, not a buzz
    room.speak(anna, 'Hier!');
    await until(() => bot.activeGame?.awaiting?.player === 'Anna');
    room.speak(anna, 'Meine Antwort lautet neun');
    await until(() => room.played.includes('neun?'));
    room.speak(anna, 'Richtig');
    await until(() => room.all().includes('Das Spiel ist vorbei'), 8000);

    expect(session!.page.players.find((p) => p.name === 'Anna')!.score).toBe(300);
    expect(session!.page.players.find((p) => p.name === 'Ben')!.score).toBe(-100);
    expect(room.all()).toContain('Gewonnen hat Anna mit 300 Punkten');
    expect(sent.join('\n')).toContain('🎙️ Anna: „Meine Antwort lautet neun“');
    expect(sent.join('\n')).not.toContain('Sport hundert'); // ignored chatter is not transcribed into the chat
    expect(sent.join('\n')).not.toContain('oder?'); // nor is thinking aloud
    expect(sttCalls).not.toContain('Meine Antwort ist zwölf'); // Ben was muted: only the wake-word check ran
    expect(sttCalls).toContain('Ähm, zehn, oder?'); // Anna was on turn → heard in full (and ignored)
    await bot.shutdown();
  }, 30000);
});

describe('voice: free cards', () => {
  it('speaks runs of card values as ranges', async () => {
    const { freeCardsLine } = await import('../src/voice/narration.ts');
    const cell = (category: string, points: number, answered = false) => ({ col: category === 'Sport' ? 0 : 1, row: points / 100 - 1, category, points, answered });
    const grid = [100, 200, 300, 400, 500].flatMap((p) => [cell('Sport', p), cell('Film', p)]);
    const open = grid.filter((c) => !(c.category === 'Sport' && c.points === 400));
    expect(freeCardsLine(open, grid)).toBe('Noch frei: Sport 100 bis 300 und 500; Film 100 bis 500.');
  });
});

describe('voice: reveal & rules', () => {
  it('speaks solutions without extras and announces the rules', async () => {
    const { revealLine, rulesLine } = await import('../src/voice/narration.ts');
    expect(revealLine('42,195 km (26,22 Meilen)')).toBe('Die richtige Antwort war: 42,195 km.');
    expect(revealLine('Vereinigte Staaten / USA')).toBe('Die richtige Antwort war: Vereinigte Staaten oder USA.');
    expect(rulesLine({ correctFactor: 1, wrongFactor: 0.5, buzzerOnWrong: true, buzzerCorrectFactor: 1, buzzerWrongFactor: 0.5 }))
      .toBe('Die Regeln: Richtig gibt den vollen Wert. Falsch kostet die Hälfte. Nach einer falschen Antwort dürfen die anderen ran: einfach Hier rufen.');
  });
});

// ───────────────────────────── review fixes ─────────────────────────────

/** Bot + fake voice room + real controller on the fake page; every `!quiz voice` gets a new room. */
/** `fast`: the kit gets a second (fast) model; `models` records which model heard what ("fast: …", "main: …"). */
function voiceSetup(game: Record<string, unknown> = {}, voice: Record<string, unknown> = {}, members: Speaker[] = [annaS, benS], discord: Record<string, unknown> = {}, fast = false) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qbvoice-'));
  const config = ConfigSchema.parse({
    game: { revealPauseSec: 0, revealPauseSolvedSec: 0, answerTimeoutSec: 10, buzzWindowSec: 2, buzzAnswerTimeoutSec: 2, minPlayers: 2, ...game },
    judge: { cacheFile: path.join(tmp, 'cache.json'), strategy: judgeLlm ? 'cascade' : 'fuzzy' },
    llm: { provider: 'none' },
    discord: { dataDir: tmp, ...discord },
    voice: { ignoreWhileSpeaking: false, ...voice },
  });
  const texts = new Map<number, string>();
  const prompts: string[] = [];
  const rooms: FakeRoom[] = [];
  const sent: { ch: string; text: string }[] = [];
  let handler: (m: ChatMessage) => Promise<void> | void = () => {};
  const gw: ChatGateway = {
    botUserId: 'bot',
    onMessage: (h) => (handler = h),
    send: async (ch, text) => void sent.push({ ch, text }),
    sendDirect: async () => {},
    react: async () => {},
    joinVoice: async () => (rooms.push(new FakeRoom(texts)), rooms.at(-1)!),
    voiceMembers: () => members,
  };
  let session: FakeSession | null = null;
  const kit = voiceKit(texts, [], prompts);
  const models: string[] = [];
  if (fast) {
    const tagged = (tag: string, inner: SpeechToText): SpeechToText => ({
      transcribe: async (p, prompt) => {
        const text = await inner.transcribe(p, prompt);
        if (prompt !== WAKE.join(', ') && !prompt?.startsWith('quizmaster,')) models.push(`${tag}: ${text}`);
        return text;
      },
      close: async () => {},
    });
    const main = kit.stt;
    kit.stt = tagged('main', main);
    kit.fastStt = tagged('fast', main);
  }
  const bot = new QuizBot({
    gateway: gw,
    config,
    store: new GuildStore(tmp),
    createSession: (cfg) => (session = new FakeSession(cfg)),
    listBoards: async (q) => ['Test Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
    voice: kit,
  });
  let n = 0;
  const write = (who: Speaker, content: string, extra: Partial<ChatMessage> = {}) =>
    handler({ id: `m${++n}`, channelId: 'chan', guildId: 'guild', author: { ...who, isBot: false }, content, mentionsBot: false, mentions: [], canManage: false, voiceChannelId: 'vc', ...extra });
  const room = () => rooms.at(-1)!;
  const chat = (ch?: string) => sent.filter((m) => !ch || m.ch === ch).map((m) => m.text).join('\n');
  return { bot, write, room, rooms, sent, chat, prompts, models, session: () => session!, config };
}
const annaS: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const benS: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };

/** Voice on, game created, both auto-linked via the voice members and the game started. */
async function voiceGame(t: ReturnType<typeof voiceSetup>) {
  await t.write(annaS, '!quiz voice');
  await until(() => t.room()?.all().includes('Quizmaster'));
  await t.write(annaS, '!quiz neu Test Board');
  await until(() => !!t.bot.activeGame?.turn && !t.bot.activeGame.questionOpen, 8000);
}

describe('voice: commands (review fixes)', () => {
  it('ends the game only on whole, unambiguous phrases (F13)', () => {
    for (const s of ['kannst du aufhören zu reden', 'ist das die Schlussrunde?', 'wie ist der Stand zum Schluss', 'ich will noch nicht aufhören', 'aufhören'])
      expect(voiceCommand(s)?.name).not.toBe('ende');
    for (const s of ['Spiel beenden', 'beende das Spiel', 'bitte das Spiel beenden', 'Quiz beenden', 'wir hören auf', 'Spiel beenden bitte', 'Spiel abbrechen'])
      expect(voiceCommand(s)?.name).toBe('ende');
    expect(voiceCommand('ende')?.name).toBe('ende?'); // a bare word asks back
    expect(voiceCommand('wie ist der Stand zum Schluss')?.name).toBe('stand');
  });

  it('treats "Genau, meine Antwort ist …" as a new answer, not as "Ja" (F14)', () => {
    expect(extractAnswer('Genau, meine Antwort ist zehn')).toBe('zehn');
    expect(extractAnswer('Richtig, die Antwort lautet Rom')).toBe('Rom');
    expect(confirmReply('Genau, meine Antwort ist zehn')).toBeNull();
    expect(confirmReply('Genau')).toBe('yes');
  });

  it('counts only real claims as a buzz (F15)', () => {
    for (const s of ['kein Buzzer für mich', 'Ich?', 'Bass', 'der Buzzer ist kaputt', 'ich weiß es nicht']) expect(isBuzz(s)).toBe(false);
    for (const s of ['Buzzer!', 'Hier!', 'Ich!', 'Ich, ich!', 'Ich weiß es', 'Hier, Buzzer']) expect(isBuzz(s)).toBe(true);
  });

  it('speaks only the core of a long note (F23)', () => {
    expect(revealLine('1. September 1939 - In Europa begann der Zweite Weltkrieg am 1. September 1939 mit dem von Adolf Hitler befohlenen Überfall auf Polen.'))
      .toBe('Die richtige Antwort war: 1. September 1939.');
    expect(revealLine('Tatooine. Anakin wurde dort als Sklave geboren.')).toBe('Die richtige Antwort war: Tatooine.');
    expect(revealLine('Bryan Adams - Summer Of 69')).toBe('Die richtige Antwort war: Bryan Adams - Summer Of 69.');
    expect(revealLine('Eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn').split(' ').length).toBeLessThanOrEqual(19);
  });

  it('the bridge speaks the core, not the whole note (F23)', async () => {
    const said: string[] = [];
    const host = { say: async (t: string) => void said.push(t), clear: () => {} } as unknown as VoiceHost;
    const bus = new EventBus();
    new VoiceBridge(host, { scoresEvery: 0, extraTimeSec: 0, board: () => 'X' }).attach(bus);
    bus.emit('host:reveal', { answer: '1. September 1939 - In Europa begann der Zweite Weltkrieg mit dem Überfall auf Polen.' });
    expect(said).toEqual(['Die richtige Antwort war: 1. September 1939.']);
  });
});

describe('QuizBot voice (review fixes)', () => {
  it('maps spoken input to the game channel, not the channel voice was called from (F8)', async () => {
    const t = voiceSetup();
    await t.write(annaS, '!quiz voice', { channelId: 'other' });
    await until(() => t.room()?.all().includes('Quizmaster'));
    await t.write(annaS, '!quiz neu Test Board', { channelId: 'chan' });
    await until(() => !!t.bot.activeGame?.turn && !t.bot.activeGame.questionOpen, 8000);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    await until(() => t.chat('chan').includes('🎙️ Anna: „Sport für hundert“'));
    await t.bot.shutdown();
  }, 20000);

  it('does not narrate or leave for a game on another server (F7)', async () => {
    const t = voiceSetup({}, {}, [annaS]);
    await t.write(benS, '!quiz voice', { guildId: 'g2', channelId: 'c2' });
    await until(() => t.room()?.all().includes('Quizmaster'));
    await t.write(annaS, '!quiz neu Test Board', { voiceChannelId: undefined });
    await until(() => !!t.bot.activeGame?.lobby);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.room().all()).not.toContain('Lobby');
    await t.write(benS, '!quiz voice aus', { guildId: 'g2', channelId: 'c2' });
    await until(() => t.chat('c2').includes('anderen Server'));
    expect(t.session().rules.bonusTimeSec).toBe(0);
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 15000);

  it('gives the voice bonus back when the room drops and does not double it on rejoin (F10)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    expect(t.session().rules.bonusTimeSec).toBe(10);
    t.room().drop();
    expect(t.session().rules.bonusTimeSec).toBe(0);
    await until(() => t.chat().includes('Voice-Verbindung ist weg'));
    await t.write(annaS, '!quiz voice');
    await until(() => t.rooms.length === 2 && t.room().all().includes('Quizmaster'));
    t.room().drop();
    await t.write(annaS, '!quiz voice');
    await until(() => t.rooms.length === 3 && t.room().all().includes('Quizmaster'));
    expect(t.session().rules.bonusTimeSec).toBe(10);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => !!t.bot.activeGame?.awaiting);
    expect(t.bot.activeGame?.awaiting?.timeoutSec).toBe(20); // 10 s + 10 s bonus, not more
    await t.bot.shutdown();
    expect(t.session().rules.answerTimeoutSec).toBe(10);
  }, 25000);

  it('keeps rule changes and the voice bonus apart (F18)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    await t.write(annaS, '!quiz regel zeit 30');
    expect(t.session().rules.answerTimeoutSec).toBe(30);
    expect(t.session().rules.bonusTimeSec).toBe(10);
    await t.write(annaS, '!quiz regeln reset');
    expect(t.session().rules.answerTimeoutSec).toBe(10);
    expect(t.session().rules.bonusTimeSec).toBe(10); // reset does not drop the bonus
    await t.write(annaS, '!quiz regel zeit 30');
    await t.write(annaS, '!quiz voice aus');
    expect(t.session().rules.bonusTimeSec).toBe(0);
    expect(t.session().rules.answerTimeoutSec).toBe(30); // leaving voice keeps the new base value
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 20000);

  it('judges the asked-back answer early, shows nothing of it before "Ja", and "Ja" takes it (latency-logic 3)', async () => {
    const calls: { answer: string; done: boolean }[] = [];
    judgeLlm = {
      name: 'gate',
      completeJson: async <S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> => {
        const call = { answer: req.prompt.match(/Antwort des Spielers: (.*)/)?.[1] ?? '?', done: false };
        calls.push(call);
        await new Promise((r) => setTimeout(r, 80));
        call.done = true;
        return { data: { correct: false, reason: 'GEHEIMER-GRUND Pins' } as z.infer<S>, costUsd: 0.0001, ms: 80 };
      },
    };
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      const t = voiceSetup();
      await voiceGame(t);
      const bus = t.session().bus;
      const events: { ev: string; payload: unknown }[] = [];
      const emit = bus.emit.bind(bus);
      (bus as { emit: typeof bus.emit }).emit = (ev, payload) => {
        events.push({ ev, payload });
        emit(ev, payload);
      };
      t.room().speak(annaS, 'Sport für hundert');
      await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
      await new Promise((r) => setTimeout(r, 800)); // earlier chat messages are out (bundled for 600 ms)
      const mark = { events: events.length, chat: t.sent.length, played: t.room().played.length, log: lines.length };
      t.room().speak(annaS, 'Meine Antwort ist Kegel');
      await until(() => t.room().played.includes('Kegel?'));
      await until(() => calls.length === 1 && calls[0]!.done); // judged before "Ja"
      await new Promise((r) => setTimeout(r, 800)); // the chat bundles messages for 600 ms
      // Before "Ja": only the private pending event on the bus, only the transcript in the chat, only "Kegel?" spoken.
      expect(events.slice(mark.events).map((e) => e.ev)).toEqual(['player:answer-pending']);
      expect(t.sent.slice(mark.chat).map((m) => m.text).join('\n')).toBe('-# 🎙️ Anna: „Meine Antwort ist Kegel“');
      expect(t.room().played.slice(mark.played)).toEqual(['Kegel?']);
      const logBefore = lines.slice(mark.log).join('');
      expect(logBefore).not.toContain('GEHEIM');
      expect(logBefore).not.toMatch(/llm:|→ (wrong|correct)|Pins/);
      t.room().speak(annaS, 'Ja');
      await until(() => t.room().all().includes('Leider falsch'));
      expect(calls).toHaveLength(1); // "Ja" took the early result
      expect(t.session().meter.byPurpose).toEqual({ prejudge: 1 });
      await t.bot.shutdown();
    } finally {
      spy.mockRestore();
      setLogLevel('error');
      judgeLlm = null;
    }
  }, 20000);

  it('takes the new answer when a confirmation word comes with the keyword (F14)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zwölf');
    await until(() => t.room().played.includes('zwölf?'));
    t.room().speak(annaS, 'Genau, meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    expect(t.bot.activeGame?.awaiting?.player).toBe('Anna'); // still waiting for "Ja"
    t.room().speak(annaS, 'Ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'));
    await t.bot.shutdown();
  }, 20000);

  it('submits an answer said in the last moment without waiting for "Ja" (F17)', async () => {
    // Without grace for "Ja" (`confirmGraceSec: 0`) – the behaviour before package C; with grace see "Nachfrist" below.
    const t = voiceSetup({ answerTimeoutSec: 3, confirmGraceSec: 0 }, { extraTimeSec: 0 });
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    await new Promise((r) => setTimeout(r, 1800)); // later than T − 1.5 s
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.chat().includes('„zehn“ ist richtig'), 4000);
    expect(t.chat()).not.toContain('(keine Antwort)');
    await t.bot.shutdown();
  }, 20000);

  it('discards an answer waiting for "Ja" when the leader ends the game by voice (F6)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Quizmaster, Spiel beenden');
    await until(() => t.bot.activeGame === null);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.chat()).not.toMatch(/ist (richtig|falsch)/);
    expect(t.session().page.players.every((p) => p.score === 0)).toBe(true);
    expect(t.session().page.log).not.toContain('award Anna 100');
    await t.bot.shutdown();
  }, 20000);

  it('gives the recogniser the point values of the board, never the solution (F22)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    const prompt = t.prompts.at(-1)!;
    expect(prompt).toContain('100');
    expect(prompt).toContain('200');
    expect(prompt).not.toContain('Pins'); // no question text
    expect(t.prompts.join('\n')).not.toMatch(/\b10\b|\b9\b/); // notes ("10", "9") never
    await t.bot.shutdown();
  }, 20000);
});

describe('voice: whisper loops are kept once (collapseLoops)', () => {
  const loop = (unit: string, n: number, rest = '') => `${Array(n).fill(unit).join(', ')}${rest}`;

  it('cuts a loop on the prompt down to one copy, also with a cut-off rest at the end', () => {
    // Measured (base, VPS / large, Mac): the pass loops until the token limit.
    expect(collapseLoops(loop('Sport, Serie 200', 25, ', Sp'))).toBe('Sport, Serie 200');
    expect(collapseLoops(`Geschichte, Flügel, ${loop('Fügel', 26)}`)).toBe('Geschichte, Flügel, Fügel');
    expect(collapseLoops(`füllen, ${loop('Flaggen, Sport, Serie', 30, ', Flaggen, Sport, Se')}`)).toBe('füllen, Flaggen, Sport, Serie');
    expect(collapseLoops(loop('Geschichte 300', 8))).toBe('Geschichte 300');
    expect(collapseLoops(`${loop('Sport für 100, 200, 300, 400', 7)},`)).toBe('Sport für 100, 200, 300, 400');
    expect(collapseLoops(`Meine Antwort ist ${loop('Paris', 12)}.`)).toBe('Meine Antwort ist Paris');
    // The kept text still makes the same card as before.
    expect(spokenToDigits(collapseLoops(loop('Sport, Serie 200', 25)))).toContain('200');
  });

  it('never changes real answers and names that repeat a word', () => {
    for (const t of [
      'Duran Duran',
      'Meine Antwort ist Duran Duran',
      'Baden-Baden',
      'Bora Bora',
      'New York, New York',
      'Tora! Tora! Tora!',
      'Sing, Sing, Sing',
      'Meine Antwort ist Que Sera, Sera',
      'Na na na na na, hey hey, goodbye',
      'Mahna Mahna',
      'Ja, ja, ja',
      'Sport für 100',
      'Geschichte 300, Geschichte 300',
      '',
    ])
      expect(collapseLoops(t)).toBe(t);
  });
});

describe('voice: whisper-server restarts (F5, F21)', () => {
  const freePort = () =>
    new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });

  function fakeWhisper() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qbwhisper-'));
    mkdirSync(path.join(dir, 'models'));
    writeFileSync(path.join(dir, 'models/m.bin'), 'x');
    const bin = path.join(dir, 'fake-whisper-server.mjs');
    writeFileSync(
      bin,
      [
        '#!/usr/bin/env node',
        "import http from 'node:http';",
        "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
        "http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(req.url === '/inference' ? JSON.stringify({ text: 'Sport für 100' }) : 'ok')); }).listen(port, '127.0.0.1');",
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { dir, bin };
  }
  const pcm: Pcm = { rate: 16000, channels: 1, samples: new Int16Array(1600) };

  it('starts a crashed server again on the next recognition, with one shared exit hook', async () => {
    const { dir, bin } = fakeWhisper();
    const cfg = ConfigSchema.parse({ voice: { dir, whisperBin: bin, whisperModel: 'models/m.bin', whisperPort: await freePort() } }).voice;
    const stt = new WhisperServerStt(cfg);
    const exitHooks = process.listenerCount('exit');
    try {
      expect(await stt.transcribe(pcm)).toBe('Sport für 100');
      for (let i = 0; i < 2; i++) {
        const pid = (stt as unknown as { proc: { pid: number } }).proc.pid;
        process.kill(pid, 'SIGKILL'); // like `pkill -9 whisper-server` mid-game
        await until(() => !(stt as unknown as { proc: unknown }).proc, 3000);
        expect(await stt.transcribe(pcm)).toBe('Sport für 100');
        expect((stt as unknown as { proc: { pid: number } }).proc.pid).not.toBe(pid);
      }
      expect(process.listenerCount('exit')).toBeLessThanOrEqual(exitHooks + 1);
    } finally {
      await stt.close();
    }
  }, 20000);

  it('asks whisper-server without temperature fallback (temperature 0, temperature_inc 0) – latency-logic 1', async () => {
    const http = await import('node:http');
    const bodies: string[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/inference') bodies.push(Buffer.concat(chunks).toString('latin1'));
        res.end(req.url === '/inference' ? JSON.stringify({ text: 'Sport für 100' }) : 'ok');
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    const { dir } = fakeWhisper();
    const stt = new WhisperServerStt(ConfigSchema.parse({ voice: { dir, whisperModel: 'models/m.bin', whisperPort: port } }).voice);
    try {
      expect(await stt.transcribe(pcm, 'Sport, Flaggen')).toBe('Sport für 100');
      const field = (name: string) => bodies[0]!.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
      expect(field('temperature')).toBe('0');
      expect(field('temperature_inc')).toBe('0');
      expect(field('prompt')).toBe('Sport, Flaggen');
    } finally {
      await stt.close();
      srv.close();
    }
  });

  it('recovers when a server it did not start goes away', async () => {
    const { dir, bin } = fakeWhisper();
    const port = await freePort();
    const foreign = spawn(bin, ['--port', String(port)], { stdio: 'ignore' });
    const cfg = ConfigSchema.parse({ voice: { dir, whisperBin: bin, whisperModel: 'models/m.bin', whisperPort: port } }).voice;
    const stt = new WhisperServerStt(cfg);
    try {
      for (let i = 0; i < 40 && !(await fetch(`http://127.0.0.1:${port}`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await stt.transcribe(pcm)).toBe('Sport für 100'); // uses the running server
      expect((stt as unknown as { proc: unknown }).proc).toBeNull();
      foreign.kill('SIGKILL');
      await new Promise((r) => foreign.once('exit', r));
      expect(await stt.transcribe(pcm)).toBe('Sport für 100'); // fetch failed → started its own
      expect((stt as unknown as { proc: unknown }).proc).not.toBeNull();
    } finally {
      foreign.kill();
      await stt.close();
    }
  }, 20000);
});

describe('voice: loopback room (F19)', () => {
  it('a new room continues the numbering of the old one and reports when it is closed', async () => {
    const a = new LoopbackTransport(0);
    const b = new LoopbackTransport(0, 1000, 7);
    expect(b.lastSeq).toBe(7);
    await b.play({ rate: 16000, channels: 1, samples: new Int16Array(16) });
    expect(b.lastSeq).toBe(8);
    await a.listen();
    expect(a.closed).toBe(false);
    await a.close();
    expect(a.closed).toBe(true);
  });
});

// ───────────────────────────── findings from the live Discord test ─────────────────────────────

describe('voice: commands (live test)', () => {
  it('asks back on short stop words instead of "not understood", ends only on whole phrases', () => {
    for (const s of ['Stop!', 'Stopp', 'Abbrechen!', 'aufhören', 'hör auf', 'Schluss', 'kannst du aufhören', 'Halt'])
      expect(voiceCommand(s)?.name).toBe('ende?');
    for (const s of ['Spiel abbrechen', 'Spiel beenden', 'stopp das Spiel', 'brich das Spiel ab', 'Schluss für heute'])
      expect(voiceCommand(s)?.name).toBe('ende');
    for (const s of ['kannst du aufhören zu reden', 'ist das die Schlussrunde?']) expect(voiceCommand(s)?.name ?? '').not.toMatch(/^ende/);
  });

  it('takes the last keyword and corrections inside one utterance', () => {
    expect(extractAnswer('Meine Antwort ist, Nabu, Ach nein, Tatooine, meine Antwort ist Tatooine.')).toBe('Tatooine');
    expect(extractAnswer('Meine Antwort ist Nabu, ach nein, Tatooine')).toBe('Tatooine');
    expect(extractAnswer('Meine Antwort ist Nabu, nein, Tatooine.')).toBe('Tatooine');
    expect(extractAnswer('Meine Antwort ist Nabu. Nein, warte, Tatooine')).toBe('Tatooine');
    expect(extractAnswer('Meine Antwort ist Nabu, ich meine Tatooine')).toBe('Tatooine');
    expect(extractAnswer('Meine Antwort ist Nabu, meine Antwort ist')).toBe('Nabu');
    // Not corrections: the answer "Nein", a word that only contains "nein", an article in the answer.
    expect(extractAnswer('Meine Antwort ist: Nein.')).toBe('Nein');
    expect(extractAnswer('Meine Antwort ist Neinstedt')).toBe('Neinstedt');
    expect(extractAnswer('Meine Antwort ist die Antwort auf alles')).toBe('die Antwort auf alles');
    expect(confirmReply('Nein')).toBe('no');
  });

  it('tells its own voice coming back from a player repeating the example', () => {
    const hint = 'Welche Karte? Sag zum Beispiel: Flaggen für 100.';
    expect(isEcho('Sag zum Beispiel Flaggen für 100', hint)).toBe(true);
    expect(isEcho('Flaggen für 100', hint)).toBe(false);
    expect(isEcho('Ja', 'Tatooine?')).toBe(false);
    expect(isEcho('Meine Antwort ist Paris', 'Sag: Meine Antwort ist, und dann deine Antwort.')).toBe(false);
  });
});

/** Playback takes real time and can be cut; people start speaking (barge-in signal) before their utterance is complete. */
class TimedRoom implements VoiceTransport {
  label = 'timed';
  played: string[] = [];
  stops = 0;
  private handlers: ((u: Utterance) => void)[] = [];
  private startHandlers: ((s: Speaker) => void)[] = [];
  private stopNow: (() => void) | null = null;
  constructor(private texts: Map<number, string>, private ms = 400) {}
  play(pcm: Pcm) {
    this.played.push(this.texts.get(pcm.samples[0]!) ?? '?');
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.ms);
      this.stopNow = () => (clearTimeout(t), resolve());
    });
  }
  stop() {
    this.stops++;
    this.stopNow?.();
  }
  onUtterance(h: (u: Utterance) => void) {
    this.handlers.push(h);
  }
  onSpeechStart(h: (s: Speaker) => void) {
    this.startHandlers.push(h);
  }
  onClose() {}
  async close() {}
  startSpeaking(s: Speaker): number {
    this.startHandlers.forEach((h) => h(s));
    return Date.now();
  }
  utter(s: Speaker, text: string, startedAt: number) {
    const id = 5000 + this.texts.size;
    this.texts.set(id, text);
    const samples = new Int16Array(8000).fill(4000);
    samples[0] = id;
    this.handlers.forEach((h) => h({ speaker: s, pcm: { rate: 16000, channels: 1, samples }, startedAt, endedAt: Date.now() }));
  }
}

function bargeInHost(voice: Record<string, unknown> = {}) {
  const texts = new Map<number, string>();
  const room = new TimedRoom(texts);
  const heard: string[] = [];
  const kit = voiceKit(texts);
  const host = new VoiceHost({
    transport: room,
    stt: kit.stt,
    tts: kit.tts,
    cfg: ConfigSchema.parse({ voice }).voice,
    prompt: () => '',
    onSpeech: (s, text) => void heard.push(`${s.displayName}: ${text}`),
    mayInterrupt: (s) => s.id === annaS.id, // Anna is on turn
  });
  return { host, room, heard };
}

describe('voice: barge-in for the person on turn', () => {
  it('stops a hint when the person on turn starts talking and takes what they say', async () => {
    const { host, room, heard } = bargeInHost();
    void host.say('Welche Karte? Sag zum Beispiel: Sport für 100.', { key: 'hint', interruptible: true });
    await until(() => room.played.length === 1);
    const t0 = room.startSpeaking(annaS);
    expect(room.stops).toBe(1);
    room.utter(annaS, 'Film für 200', t0);
    await until(() => heard.length === 1);
    expect(heard).toEqual(['Anna: Film für 200']);
  });

  it('keeps everybody else, questions and solutions under the echo protection', async () => {
    const { host, room, heard } = bargeInHost();
    void host.say('Welche Karte? Sag zum Beispiel: Sport für 100.', { interruptible: true });
    await until(() => room.played.length === 1);
    const t0 = room.startSpeaking(benS); // not on turn
    room.utter(benS, 'Quizmaster, Stand', t0);
    void host.say('Sport für 100. Wie viele Pins hat Bowling?'); // a question
    await until(() => room.played.length === 2);
    const t1 = room.startSpeaking(annaS);
    room.utter(annaS, 'Meine Antwort ist zehn', t1);
    await new Promise((r) => setTimeout(r, 100));
    expect(room.stops).toBe(0);
    expect(heard).toEqual([]);
  });

  it('drops its own voice coming back, and can be switched off', async () => {
    const a = bargeInHost();
    void a.host.say('Welche Karte? Sag zum Beispiel: Sport für 100.', { interruptible: true });
    await until(() => a.room.played.length === 1);
    a.room.utter(annaS, 'Sag zum Beispiel Sport für 100', Date.now());
    await new Promise((r) => setTimeout(r, 100));
    expect(a.heard).toEqual([]);

    const b = bargeInHost({ bargeIn: false });
    void b.host.say('Welche Karte? Sag zum Beispiel: Sport für 100.', { interruptible: true });
    await until(() => b.room.played.length === 1);
    b.room.utter(annaS, 'Film für 200', b.room.startSpeaking(annaS));
    await new Promise((r) => setTimeout(r, 100));
    expect(b.room.stops).toBe(0);
    expect(b.heard).toEqual([]);
  });

  it('a reminder replaces a queued pick hint instead of stacking up behind it', async () => {
    const { host, room } = bargeInHost();
    const bus = new EventBus();
    const bridge = new VoiceBridge(host, { scoresEvery: 0, extraTimeSec: 0, board: () => 'Test' });
    bridge.attach(bus);
    void host.say('Eine lange Ansage.');
    void bridge.say('Welche Karte? Sag zum Beispiel: Sport für 100.', 'hint', { interruptible: true });
    bus.emit('host:notice', { kind: 'reminder', text: '', player: 'Anna' });
    await until(() => room.played.length === 2, 3000);
    await new Promise((r) => setTimeout(r, 500));
    expect(room.played).toEqual(['Eine lange Ansage.', 'Anna, du bist noch dran. Sag zum Beispiel: Kategorie und Punkte.']);
  });
});

describe('QuizBot voice (live test)', () => {
  it('"Quizmaster, stopp" asks back, "Spiel abbrechen" ends', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, Stopp!');
    await until(() => t.room().played.includes('Soll ich das Spiel beenden? Sag Ja oder Nein.'));
    expect(t.room().all()).not.toContain('nicht verstanden');
    expect(t.bot.activeGame?.phase).toBe('running');
    t.room().speak(annaS, 'Quizmaster, Spiel abbrechen');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 20000);

  it('takes the corrected answer of one utterance', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist, zwölf, ach nein, zehn, meine Antwort ist zehn.');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'));
    await t.bot.shutdown();
  }, 20000);

  it('answers "Quizmaster, start" in the lobby out loud: who is missing, or that it starts', async () => {
    const t = voiceSetup({}, {}, [annaS, benS], { autoStart: false });
    await t.write(annaS, '!quiz voice');
    await until(() => t.room()?.all().includes('Quizmaster'));
    await t.write(annaS, '!quiz neu Test Board');
    await until(() => t.bot.activeGame?.phase === 'lobby' && t.bot.activeGame.lobbyPlayers.length === 2, 8000);
    t.session().page.notReady.add('Ben');
    await until(() => t.bot.activeGame?.canStart === false);
    t.room().speak(annaS, 'Quizmaster, start');
    await until(() => t.room().all().includes('Es fehlt noch: Ben.'));
    t.session().page.notReady.clear();
    await until(() => t.bot.activeGame?.canStart === true);
    t.room().speak(annaS, 'Quizmaster, start');
    await until(() => t.room().played.includes('Okay, wir starten!'));
    await until(() => t.bot.activeGame?.phase === 'running', 8000);
    await t.bot.shutdown();
  }, 25000);

  it('gives the pick hint only after the turn was announced – not between verdict and next turn – and once', async () => {
    const t = voiceSetup({ revealPauseSec: 1, revealPauseSolvedSec: 1 });
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'));
    // The old turn is still Anna's until the next one comes: her cheering is no pick attempt.
    t.room().speak(annaS, 'Juhu, super');
    await until(() => t.bot.activeGame?.turn?.player === 'Ben', 6000);
    await until(() => t.room().all().includes('Ben, du bist dran'));
    expect(t.room().all()).not.toContain('Welche Karte? Sag');
    // Side talk without a card in it gets no hint at all …
    t.room().speak(benS, 'Ähm, keine Ahnung');
    await new Promise((r) => setTimeout(r, 400));
    expect(t.room().all()).not.toContain('Welche Karte? Sag');
    expect(t.chat()).not.toContain('Welche Karte?');
    // … a card attempt that does not fit gets it, once per turn.
    t.room().speak(benS, 'Hund für 250');
    await until(() => t.room().all().includes('Welche Karte? Sag zum Beispiel: Film für 200.'));
    t.room().speak(benS, 'Katze für 350');
    await new Promise((r) => setTimeout(r, 300));
    expect(t.room().played.filter((p) => p.startsWith('Welche Karte?'))).toHaveLength(1);
    expect(t.chat().match(/Welche Karte\?/g)).toHaveLength(1);
    await t.bot.shutdown();
  }, 25000);
});

describe('voice: Ctrl+C', () => {
  const python = path.resolve('.qbhost/voice/venv/bin/python');
  const model = path.resolve('.qbhost/voice/models/de_DE-thorsten-high.onnx');
  const installed = (() => {
    try {
      return !!(statSync(python) && statSync(model));
    } catch {
      return false;
    }
  })();

  it.skipIf(!installed)('the Piper worker ignores SIGINT (no traceback, the goodbye still works) and ends with its stdin', async () => {
    const proc = spawn(python, [path.resolve('src/voice/piper_worker.py'), model, '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    await until(() => out.includes('"ready"'), 30000);
    proc.kill('SIGINT'); // what the terminal sends to the whole process group on Ctrl+C
    proc.stdin.write(JSON.stringify({ id: 1, text: 'Tschüss!' }) + '\n');
    await until(() => out.includes('"id": 1'), 15000);
    expect(out).toContain('"wav"');
    const code = await new Promise<number | null>((resolve) => {
      proc.once('exit', resolve);
      proc.stdin.end();
    });
    expect(code).toBe(0);
    expect(err).not.toContain('Traceback');
  }, 60000);
});

describe('voice: Ctrl+C with a game browser open', () => {
  const hasChromium = (() => {
    try {
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasChromium)('leaves SIGINT/SIGTERM to the bot – Playwright would close the browser and exit(130) before the goodbye', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const driver = new PlaywrightDriver({ profileDir: mkdtempSync(path.join(os.tmpdir(), 'qbprofile-')), headless: true });
    await driver.open();
    try {
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    } finally {
      await driver.close();
    }
  }, 30000);
});

describe('voice: Ctrl+C arrives twice (terminal + tsx)', () => {
  it('shuts down once, ignores the duplicate and forces the exit only on a later Ctrl+C', async () => {
    const exits: number[] = [];
    let stops = 0;
    let finish = () => {};
    const off = onStopSignal(() => new Promise<void>((r) => ((stops++), (finish = r))), { graceMs: 200, exit: (c) => void exits.push(c) });
    try {
      process.emit('SIGINT' as any);
      process.emit('SIGINT' as any); // the relayed copy, a few ms later
      process.emit('SIGTERM' as any);
      await new Promise((r) => setTimeout(r, 20));
      expect(stops).toBe(1);
      expect(exits).toEqual([]); // the goodbye is still being said
      await new Promise((r) => setTimeout(r, 250));
      process.emit('SIGINT' as any); // pressed again
      expect(exits).toEqual([130]);
      finish();
    } finally {
      off();
    }
  });
});

// ───────────────────────────── two Whisper models + audio window (small servers) ─────────────────────────────

describe('voice: fast and precise Whisper model', () => {
  it('limits maxSpeechSec to the audio window', () => {
    expect(ConfigSchema.parse({}).voice.maxSpeechSec).toBe(15);
    expect(ConfigSchema.parse({ voice: { whisperAudioCtx: 512 } }).voice.maxSpeechSec).toBe(10);
    expect(ConfigSchema.parse({ voice: { whisperAudioCtx: 512, maxSpeechSec: 8 } }).voice.maxSpeechSec).toBe(8);
    expect(ConfigSchema.parse({ voice: { whisperAudioCtx: 1500 } }).voice.maxSpeechSec).toBe(15);
    expect(() => ConfigSchema.parse({ voice: { whisperAudioCtx: 2000 } })).toThrow();
  });

  /** A fake whisper-server that answers with its own arguments. */
  function argsWhisper() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'qbwhisper-'));
    mkdirSync(path.join(dir, 'models'));
    writeFileSync(path.join(dir, 'models/main.bin'), 'x');
    writeFileSync(path.join(dir, 'models/fast.bin'), 'x');
    const bin = path.join(dir, 'fake-whisper-server.mjs');
    writeFileSync(
      bin,
      [
        '#!/usr/bin/env node',
        "import http from 'node:http';",
        "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
        "const args = process.argv.slice(2).map((a) => a.replace(/.*\\//, '')).join(' ');",
        "http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(req.url === '/inference' ? JSON.stringify({ text: args }) : 'ok')); }).listen(port, '127.0.0.1');",
      ].join('\n'),
    );
    chmodSync(bin, 0o755);
    return { dir, bin };
  }

  it('runs a second whisper-server for the fast model on the next port, both with -ac, and stops both', async () => {
    const { dir, bin } = argsWhisper();
    const port = 41000 + Math.floor(Math.random() * 2000) * 2;
    const config = ConfigSchema.parse({ voice: { dir, whisperBin: bin, whisperModel: 'models/main.bin', whisperFastModel: 'models/fast.bin', whisperAudioCtx: 512, whisperPort: port } });
    const kit = createVoiceKit(config);
    const pcm: Pcm = { rate: 16000, channels: 1, samples: new Int16Array(1600) };
    try {
      expect(await kit.stt.transcribe(pcm)).toBe(`-m main.bin -l de --host 127.0.0.1 --port ${port} -nt -ac 512`);
      expect(await kit.fastStt!.transcribe(pcm)).toBe(`-m fast.bin -l de --host 127.0.0.1 --port ${port + 1} -nt -ac 512`);
    } finally {
      await kit.close();
    }
    const up = (p: number) => fetch(`http://127.0.0.1:${p}`).then((r) => r.ok, () => false);
    for (let i = 0; i < 60 && ((await up(port)) || (await up(port + 1))); i++) await new Promise((r) => setTimeout(r, 50));
    expect([await up(port), await up(port + 1)]).toEqual([false, false]);
    // Without the options nothing changes: one server, full window.
    const plain = createVoiceKit(ConfigSchema.parse({ voice: { dir, whisperBin: bin, whisperModel: 'models/main.bin', whisperPort: port } }));
    expect(plain.fastStt).toBeUndefined();
    expect((plain.stt as WhisperServerStt).args).not.toContain('-ac');
  }, 20000);

  it('voice-setup and doctor check both models', async () => {
    const { dir, bin } = argsWhisper();
    const config = ConfigSchema.parse({ voice: { dir, whisperBin: bin, tts: 'say', whisperModel: 'models/main.bin', whisperFastModel: 'models/missing.bin' } });
    expect(await voiceProblems(config)).toEqual(['Whisper-Modell fehlt (models/missing.bin)']);
  });

  it('routes by attention: answers to the main model, everything else to the fast one', async () => {
    const texts = new Map<number, string>();
    const room = new FakeRoom(texts);
    const used: string[] = [];
    const stt = (tag: string, wrap = (t: string) => t): SpeechToText => ({
      transcribe: async (p) => {
        const t = texts.get(p.samples[0]!) ?? '';
        used.push(`${tag}: ${t}`);
        return wrap(t);
      },
      close: async () => {},
    });
    let attention: Attention = 'full';
    const heard: string[] = [];
    const kit = voiceKit(texts);
    new VoiceHost({
      transport: room,
      stt: stt('main', (t) => t.replace('zehn', 'Zehn')), // the precise model writes it differently
      fastStt: stt('fast'),
      tts: kit.tts,
      cfg: ConfigSchema.parse({}).voice,
      prompt: () => '',
      onSpeech: (_s, t) => void heard.push(t),
      attention: () => attention,
    });
    const say = async (a: Attention, text: string) => {
      attention = a;
      used.length = 0;
      const n = heard.length;
      room.speak(annaS, text);
      await until(() => heard.length > n || used.length > 0, 2000);
      await new Promise((r) => setTimeout(r, 30));
      return [...used];
    };
    expect(await say('full', 'Sport für 100')).toEqual(['fast: Sport für 100']);
    expect(await say('answer', 'Meine Antwort ist zehn')).toEqual(['main: Meine Antwort ist zehn']);
    expect(await say('confirm', 'Ja')).toEqual(['fast: Ja']);
    expect(await say('confirm', 'Genau, meine Antwort ist zehn')).toEqual(['fast: Genau, meine Antwort ist zehn', 'main: Genau, meine Antwort ist zehn']);
    expect(heard.at(-1)).toBe('Genau, meine Antwort ist Zehn'); // the main model's result counts
    expect(await say('wake', 'Quizmaster, Stand')).toEqual(['fast: Quizmaster, Stand']);
  });

  it('the bot sends picks and "Ja" to the fast model and the answer to the main model', async () => {
    const t = voiceSetup({}, {}, [annaS, benS], {}, true);
    await voiceGame(t);
    t.models.length = 0;
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zwölf');
    await until(() => t.room().played.includes('zwölf?'));
    t.room().speak(annaS, 'Genau, meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'));
    expect(t.models).toEqual([
      'fast: Sport für hundert',
      'main: Meine Antwort ist zwölf',
      'fast: Genau, meine Antwort ist zehn',
      'main: Genau, meine Antwort ist zehn',
      'fast: Ja',
    ]);
    await t.bot.shutdown();
  }, 20000);
});

// ───────────────────────────── feedback from a live game on the server ─────────────────────────────

describe('voice: ending the game as the fast model writes it', () => {
  it('ends on run-together and misheard whole phrases (live game log)', () => {
    // Literally from the channel: two end the game, "Abbrechen" asks back.
    for (const s of ['Quizmaster, Quizabrechen', 'Quizmaster, Spielbänden', 'Quizmaster, Spielbeenden'])
      expect(voiceCommand(stripWakeWord(s, WAKE)!)?.name, s).toBe('ende');
    expect(voiceCommand(stripWakeWord('Quizmaster, Abbrechen', WAKE)!)?.name).toBe('ende?');
    for (const s of ['Spiel bänden', 'Quiz abrechen', 'Spielabbrechen', 'Quizbeenden', 'Spiel beenden'])
      expect(voiceCommand(s)?.name, s).toBe('ende');
    // Participles may be a question about the state ("Spiel abgebrochen?") – they ask back (review F1).
    for (const s of ['Spiel beendet', 'Quiz beendet', 'Quiz abgebrochen', 'das Spiel beendet']) expect(voiceCommand(s)?.name, s).toBe('ende?');
  });

  it('never ends on sentences or on words that only sound similar', () => {
    for (const s of [
      'kannst du aufhören zu reden', 'Schlussrunde', 'das Spiel beenden wir später', 'Geschichte 300',
      'Spiel beginnen', 'Quiz beginnen', 'Spiel bewerten', 'Spiel bestellen', 'Spielstand', 'wann ist Spielende', 'Quiz abgeben',
      'Spiel starten', 'Spiel weiter', 'neues Spiel', 'Spiel beneiden',
    ])
      expect(voiceCommand(s)?.name ?? '', s).not.toMatch(/^ende\??$/);
  });

  it('a plain "Ja" / "Nein" answers the stop question, a "Ja" at the start of a sentence does not', () => {
    for (const s of ['Ja', 'Ja.', 'ja bitte', 'Ja, genau!', 'jawohl']) expect(endAskReply(s), s).toBe('yes');
    for (const s of ['Nein', 'nein, weiter', 'Nee']) expect(endAskReply(s), s).toBe('no');
    for (const s of ['ja, Geschichte 300', 'ja warte mal', 'Meine Antwort ist ja', 'ja ich glaube schon', '']) expect(endAskReply(s), s).toBeNull();
  });

  it('tells card attempts from side talk', () => {
    const cell = (category: string, points: number) => ({ col: 0, row: 0, category, points, answered: false });
    const grid = [cell('Flaggen', 100), cell('Geschichte', 200), cell('Serien und Filme', 300)];
    for (const s of ['Hund für 250', 'Flak für', 'Geschicht', 'Serie, äh', 'zweihundertfünfzig']) expect(mentionsCard(s, grid), s).toBe(true);
    for (const s of ['Ähm, keine Ahnung', 'Juhu, super', 'Hmm, schwierig', 'Was meinst du?', 'ich hol mir kurz was zu trinken']) expect(mentionsCard(s, grid), s).toBe(false);
  });
});

describe('voice: reminders', () => {
  it('speaks only the first reminder of a turn; later ones are chat only', async () => {
    const { host, room } = bargeInHost();
    const bus = new EventBus();
    const bridge = new VoiceBridge(host, { scoresEvery: 0, extraTimeSec: 0, board: () => 'Test' });
    bridge.attach(bus);
    const c = { col: 0, row: 0, category: 'Sport', points: 100, answered: false };
    const turn = (player: string) => ({ player, open: [c], grid: [c], categories: ['Sport'], board: { active: 1, count: 1 } });
    const reminders = () => room.played.filter((p) => p.includes('du bist noch dran'));
    bus.emit('host:turn', turn('Anna'));
    bus.emit('host:notice', { kind: 'reminder', text: '', player: 'Anna' });
    await until(() => reminders().length === 1);
    bus.emit('host:turn', turn('Anna')); // the controller re-emits the same turn after a reminder
    bus.emit('host:notice', { kind: 'reminder', text: '', player: 'Anna' });
    await new Promise((r) => setTimeout(r, 300));
    expect(reminders()).toHaveLength(1);
    bus.emit('host:turn', turn('Ben'));
    bus.emit('host:notice', { kind: 'reminder', text: '', player: 'Ben' });
    await until(() => reminders().length === 2);
    expect(reminders()[1]).toMatch(/^Ben/);
  });

  it('gives no pick hint when the rule is off', async () => {
    const t = voiceSetup({ pickHint: false });
    await voiceGame(t);
    await until(() => t.room().all().includes('Anna, du bist dran'));
    await new Promise((r) => setTimeout(r, 100));
    t.room().speak(annaS, 'Hund für 250');
    await new Promise((r) => setTimeout(r, 400));
    expect(t.room().all()).not.toContain('Welche Karte? Sag');
    await t.bot.shutdown();
  }, 20000);
});

describe('QuizBot voice: ending and leaving (live game feedback)', () => {
  for (const said of ['Quizmaster, Quizabrechen', 'Quizmaster, Spielbänden', 'Quizmaster, Spielbeenden']) {
    it(`"${said}" ends the game`, async () => {
      const t = voiceSetup();
      await voiceGame(t);
      t.room().speak(annaS, said);
      await until(() => t.bot.activeGame === null);
      expect(t.room().all()).not.toContain('nicht verstanden');
      await t.bot.shutdown();
    }, 20000);
  }

  it('"Quizmaster, Abbrechen" asks back; a "Ja" sentence does not count, a plain "Ja" ends', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, Abbrechen');
    await until(() => t.room().played.includes(END_ASK_LINE));
    expect(t.chat()).toContain('Sag „Ja“');
    t.room().speak(annaS, 'ja, warte mal');
    await new Promise((r) => setTimeout(r, 300));
    expect(t.bot.activeGame?.phase).toBe('running');
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 20000);

  it('a bare "Ja" of the leader counts even when someone else is on turn (F4: attention in the window)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame?.turn?.player === 'Ben' && !t.bot.activeGame.questionOpen, 8000);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    t.room().speak(annaS, 'Ja'); // no wake word: only heard because the window lets her through
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 25000);

  it('"Nein" keeps playing; the stop question wins over an answer waiting for "Ja", which stays open', async () => {
    const t = voiceSetup({ answerTimeoutSec: 20 });
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    t.room().speak(annaS, 'Nein');
    await until(() => t.room().played.includes(END_KEEP_LINE));
    expect(t.bot.activeGame?.phase).toBe('running');
    expect(t.bot.activeGame?.pending?.answer).toBe('zehn'); // neither confirmed nor discarded
    expect(t.chat()).not.toMatch(/„zehn“ ist (richtig|falsch)/);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.filter((p) => p === END_ASK_LINE).length === 2);
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame === null);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.chat()).not.toMatch(/ist (richtig|falsch)/);
    expect(t.session().page.log).not.toContain('award Anna 100');
    await t.bot.shutdown();
  }, 25000);

  it('only the leader ends the game; someone else gets no stop question', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(benS, 'Quizmaster, stopp');
    await until(() => t.chat().includes('🔒'));
    expect(t.room().played).not.toContain(END_ASK_LINE);
    t.room().speak(benS, 'Quizmaster, ja');
    await new Promise((r) => setTimeout(r, 300));
    expect(t.bot.activeGame?.phase).toBe('running');
    await t.bot.shutdown();
  }, 20000);

  it('leaves the voice channel after the game, once the last announcement is spoken', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const room = t.room();
    room.playDelay = 60;
    room.speak(annaS, 'Quizmaster, Spiel beenden');
    await until(() => room.closed, 8000);
    const over = room.played.findIndex((p) => p.startsWith('Das Spiel ist vorbei'));
    expect(over).toBeGreaterThan(-1);
    expect(room.played.at(-1)).toBe(GOODBYE_LINE);
    expect(room.played.indexOf(GOODBYE_LINE)).toBeGreaterThan(over);
    expect(t.chat()).toContain('👋 Voice-Channel verlassen.');
    await t.bot.shutdown();
    expect(room.played).not.toContain('Ich muss leider los. Tschüss!'); // gone already – no second goodbye
  }, 20000);

  it('leaves after a regular end as well', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame?.turn?.player === 'Ben' && !t.bot.activeGame.questionOpen, 8000);
    t.room().speak(benS, 'Film für zweihundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Ben');
    t.room().speak(benS, 'Meine Antwort ist neun');
    await until(() => t.room().played.includes('neun?'));
    t.room().speak(benS, 'Ja');
    await until(() => t.room().closed, 10000);
    expect(t.room().played.at(-1)).toBe(GOODBYE_LINE);
    await t.bot.shutdown();
  }, 30000);

  it('stays when a new game starts before it is gone, or when leaveOnGameEnd is off', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const room = t.room();
    room.playDelay = 250;
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.write(annaS, '!quiz neu Test Board');
    await until(() => room.played.includes(GOODBYE_LINE), 8000);
    await new Promise((r) => setTimeout(r, 300));
    expect(room.closed).toBe(false);
    expect(t.chat()).not.toContain('👋 Voice-Channel verlassen.');
    await t.bot.shutdown();

    const off = voiceSetup({}, { leaveOnGameEnd: false });
    await voiceGame(off);
    await off.write(annaS, '!quiz ende');
    await until(() => off.bot.activeGame === null);
    await until(() => off.room().played.some((p) => p.startsWith('Das Spiel ist vorbei')));
    await new Promise((r) => setTimeout(r, 300));
    expect(off.room().closed).toBe(false);
    expect(off.room().played).not.toContain(GOODBYE_LINE);
    await off.bot.shutdown();
  }, 30000);

  it('Ctrl+C during a game says one goodbye only', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    await t.bot.shutdown();
    expect(t.room().played).toContain('Ich muss leider los. Tschüss!');
    expect(t.room().played).not.toContain(GOODBYE_LINE);
    expect(t.room().closed).toBe(true);
  }, 20000);

  it('leaves on command by text and voice; during a game only the leader, and the game goes on in the chat', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    await t.write(benS, '!quiz voice aus');
    expect(t.chat()).toContain('🔒');
    expect(t.room().closed).toBe(false);
    t.room().speak(benS, 'Quizmaster, tschüss');
    await new Promise((r) => setTimeout(r, 200));
    expect(t.room().closed).toBe(false);
    await t.write(annaS, '!quiz voice aus');
    expect(t.rooms[0]!.closed).toBe(true);
    expect(t.chat()).toContain('Das Spiel läuft hier im Chat weiter.');
    expect(t.bot.activeGame?.phase).toBe('running');
    await t.write(annaS, '!quiz voice');
    await until(() => t.rooms.length === 2 && t.room().all().includes('Hallo'));
    t.room().speak(annaS, 'Quizmaster, verlass den Channel');
    await until(() => t.rooms[1]!.closed);
    expect(t.bot.activeGame?.phase).toBe('running');
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 25000);
});

describe('QuizBot voice: review fixes for ending and leaving (F1, F2, F4–F6, F9, F11)', () => {
  /** Anna (leader) answers the first card, so Ben is on turn and Anna is not. */
  async function bensTurn(t: ReturnType<typeof voiceSetup>) {
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame?.turn?.player === 'Ben' && !t.bot.activeGame.questionOpen, 8000);
  }
  const attention = (t: ReturnType<typeof voiceSetup>, id: string) => (t.bot as unknown as { attention(id: string): string }).attention(id);

  it('"Quizmaster, Spiel abgebrochen?" and "Quizmaster, Spielbanken 100" do not end the game (F1)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, Spielbanken 100');
    await new Promise((r) => setTimeout(r, 300));
    expect(t.bot.activeGame?.phase).toBe('running');
    t.room().speak(annaS, 'Quizmaster, Spiel abgebrochen?');
    await until(() => t.room().played.includes(END_ASK_LINE));
    expect(t.bot.activeGame?.phase).toBe('running');
    t.room().speak(annaS, 'Nein');
    await until(() => t.room().played.includes(END_KEEP_LINE));
    await t.bot.shutdown();
  }, 20000);

  it('"Bitte?" or "Klar?" is no "Ja" – the window stays open, a plain "Ja" still ends (F2)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    t.room().speak(annaS, 'Bitte?');
    t.room().speak(annaS, 'Klar?');
    t.room().speak(annaS, 'Quizmaster, ja?');
    await new Promise((r) => setTimeout(r, 400));
    expect(t.bot.activeGame?.phase).toBe('running');
    expect(t.bot.activeGame?.endAsk).not.toBeNull();
    t.room().speak(annaS, 'Ja');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
  }, 20000);

  it('after 20 s the window is closed: "Ja" ends nothing and the leader is not listened to any more (F4)', async () => {
    const t = voiceSetup();
    await bensTurn(t);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    expect(attention(t, annaS.id)).toBe('confirm');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 21_000);
      expect(attention(t, annaS.id)).toBe('wake');
      t.room().speak(annaS, 'Quizmaster, ja');
      await new Promise((r) => setTimeout(r, 400));
      expect(t.bot.activeGame?.phase).toBe('running');
    } finally {
      vi.useRealTimers();
    }
    await t.bot.shutdown();
  }, 25000);

  it('a "Ja" of someone else in the window ends nothing (F4)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    t.room().speak(benS, 'Ja');
    t.room().speak(benS, 'Quizmaster, ja');
    await new Promise((r) => setTimeout(r, 400));
    expect(t.bot.activeGame?.phase).toBe('running');
    await t.bot.shutdown();
  }, 20000);

  it('"Quizmaster, weiter" in the window counts as "Nein" (F11)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    t.room().speak(annaS, 'Quizmaster, stopp');
    await until(() => t.room().played.includes(END_ASK_LINE));
    t.room().speak(annaS, 'Quizmaster, weiter');
    await until(() => t.room().played.includes(END_KEEP_LINE));
    expect(t.bot.activeGame?.phase).toBe('running');
    expect(t.bot.activeGame?.endAsk).toBeNull();
    await t.bot.shutdown();
  }, 20000);

  it('leaves after at most 30 s when the goodbye hangs (F4: GOODBYE_MAX_MS)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const room = t.room();
    room.hang = GOODBYE_LINE;
    const realTimeout = setTimeout; // timers started before faking still need real time
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((r) => realTimeout(r, 25));
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      void t.write(annaS, '!quiz ende');
      // Measured relative to the game's end (F16): how fast the game ends depends on the machine (real timers), the 30 s do not.
      let ended = 0;
      while (t.bot.activeGame && ended < 60) (await tick(), ended++);
      expect(t.bot.activeGame).toBeNull();
      let waited = 0;
      while (!room.closed && waited < 60) (await tick(), waited++);
      expect(room.closed).toBe(true);
      expect(waited).toBeGreaterThanOrEqual(29); // waited for the hanging goodbye …
      expect(waited).toBeLessThanOrEqual(31); // … but not longer than GOODBYE_MAX_MS
    } finally {
      vi.useRealTimers();
    }
    await t.bot.shutdown();
  }, 20000);

  it('stays while the board menu for the next game is open (F5)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const room = t.room();
    room.playDelay = 150;
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.write(annaS, '!quiz neu');
    await until(() => t.chat().includes('welches Quiz'));
    await until(() => room.played.includes(GOODBYE_LINE), 8000);
    await new Promise((r) => setTimeout(r, 300));
    expect(room.closed).toBe(false);
    await t.bot.shutdown();
  }, 20000);

  it('during a game only the leader pulls the bot into another voice channel (F6)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    await t.write(benS, '!quiz voice', { voiceChannelId: 'vc2' });
    expect(t.chat()).toContain('🔒');
    expect(t.rooms).toHaveLength(1);
    expect(t.room().closed).toBe(false);
    await t.write(annaS, '!quiz voice', { voiceChannelId: 'vc2' });
    await until(() => t.rooms.length === 2);
    expect(t.rooms[0]!.closed).toBe(true);
    await t.bot.shutdown();
  }, 20000);

  it('Ctrl+C right after the game: the queued goodbye is still said, and only that one (F9)', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const room = t.room();
    room.playDelay = 100;
    await t.write(annaS, '!quiz ende');
    await until(() => t.bot.activeGame === null);
    await t.bot.shutdown();
    expect(room.played).toContain(GOODBYE_LINE);
    expect(room.played).not.toContain('Ich muss leider los. Tschüss!');
    expect(room.closed).toBe(true);
  }, 20000);
});

describe('QuizBot voice: "ich bin …" links only names of the lobby (review F17)', () => {
  it('"ich bin dran / fertig / bereit / da / raus / weg / neu" links nobody, "ich bin Ben" links Ben', async () => {
    const t = voiceSetup();
    await voiceGame(t);
    const links = () => t.bot['d'].store.get('guild').links as Record<string, string>;
    expect(links()[annaS.id]).toBe('Anna');
    for (const word of ['dran', 'fertig', 'bereit', 'da', 'raus', 'weg', 'neu']) {
      t.room().speak(annaS, `Quizmaster, ich bin ${word}`);
      await until(() => t.chat().includes(`„${word}“ ist kein Name aus der Lobby`));
      expect(links()[annaS.id], word).toBe('Anna');
    }
    // Still linked as Anna: her pick is taken.
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    // A real player name of the game links.
    t.room().speak(benS, 'Quizmaster, ich bin Ben');
    await until(() => t.chat().includes('= **Ben**'));
    expect(links()[benS.id]).toBe('Ben');
    await t.bot.shutdown();
  }, 25000);
});

describe('voice: keyword and confirmation (package C)', () => {
  it('takes more ways of saying the keyword – also "mein Antwort", corrections and the wake word in front', () => {
    const answers: [string, string][] = [
      ['Nein, mein Antwort ist Hans Zimmer', 'Hans Zimmer'], // live game 20.11.
      ['Mein Antwort ist Paris', 'Paris'],
      ['Meiner Antwort ist Paris', 'Paris'],
      ['Maine Antwort ist Paris', 'Paris'],
      ['Meine Antwort es Paris', 'Paris'],
      ['Meine Antwort ist: Paris', 'Paris'],
      ['Quizmaster, meine Antwort ist Paris', 'Paris'],
      ['Ich korrigiere, meine Antwort ist Tatooine', 'Tatooine'],
      ['Äh, also, meine Antwort ist Rom', 'Rom'],
      ['Meine Antwort ist Es', 'Es'], // Stephen King
      ['Meine Antwort ist Nabu, mein Antwort ist Tatooine', 'Tatooine'],
      ['Oh, quatsch, meine Antwort ist Bern', 'Bern'],
    ];
    for (const [said, answer] of answers) expect(extractAnswer(said), said).toBe(answer);
    for (const said of ['Eine Antwort ist schwer', 'Meine Antwort war falsch', 'Die Antworten sind schwer', 'Ich hab keine Antwort']) expect(extractAnswer(said), said).toBeNull();
    expect(extractAnswer('Meine Antwort es')).toBe(''); // keep listening, not the answer "es"
    expect(cleanSpokenAnswer('mein Antwort ist Paris')).toBe('Paris');
  });

  it('understands "Ja" and "Nein" – a "Ja" with anything else after it is no "Ja"', () => {
    for (const [said, pending] of [['Ja?'], ['Jo'], ['Jawohl'], ['Yeah'], ['Ja, das ist meine Antwort'], ['Ja, Paris', 'Paris'], ['Quizmaster, ja'], ['Äh, ja'], ['Das stimmt'], ['Auf jeden Fall']] as [string, string?][])
      expect(confirmReply(said, pending), said).toBe('yes');
    for (const said of ['Ja, warte', 'Moment', 'Okay', 'Mhm', 'Hä', 'Doch', 'Ja, aber', 'Ja oder Rom', 'Keine Ahnung']) expect(confirmReply(said, 'Paris'), said).toBeNull();
    for (const said of ['No', 'Nope', 'Nicht ganz', 'Quizmaster, nein', 'Ja, nein, doch nicht']) expect(confirmReply(said), said).toBe('no');
    expect(confirmReply('Ja, Nicht ohne meine Tochter', 'Nicht ohne meine Tochter')).toBe('yes'); // the answer's own words
    expect(confirmReply('Nein, mein Antwort ist Hans Zimmer')).toBeNull(); // a new answer, handled as one
    expect([confirmWaits('Moment'), confirmWaits('Warte mal'), confirmWaits('Hä'), confirmWaits('Ja')]).toEqual([true, true, false, false]);
  });
});

describe('QuizBot voice: keyword, confirmation and grace (package C)', () => {
  /** Anna picks Sport 100 ("Wie viele Pins beim Bowling?", 10) and is asked; returns the time of the ask. */
  async function asked(t: ReturnType<typeof voiceSetup>) {
    await voiceGame(t);
    t.room().speak(annaS, 'Sport für hundert');
    await until(() => t.bot.activeGame?.awaiting?.player === 'Anna');
    return Date.now();
  }
  const answersOf = (t: ReturnType<typeof voiceSetup>) => {
    const out: string[] = [];
    t.session().bus.on('player:answer', (a) => void out.push(a.answer));
    return out;
  };
  /** Info lines of the logger while `fn` runs. */
  async function infoLog(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    setLogLevel('info');
    try {
      await fn();
    } finally {
      spy.mockRestore();
      setLogLevel('error');
    }
    return lines.join('');
  }

  it('"Nein, mein Antwort ist Hans Zimmer" in the confirmation corrects the answer, it is not discarded (live game 20.11.)', async () => {
    const t = voiceSetup();
    await asked(t);
    const answers = answersOf(t);
    t.room().speak(annaS, 'Meine Antwort ist Tanzzimmer');
    await until(() => t.room().played.includes('Tanzzimmer?'));
    t.room().speak(annaS, 'Nein, mein Antwort ist Hans Zimmer');
    await until(() => t.room().played.includes('Hans Zimmer?'));
    expect(t.room().played).not.toContain('Okay. Deine Antwort?');
    t.room().speak(annaS, 'Ja');
    await until(() => answers.length === 1);
    expect(answers).toEqual(['Hans Zimmer']);
    await t.bot.shutdown();
  }, 20000);

  it('"Quizmaster, meine Antwort ist …" and "Quizmaster, ja" of the person answering are the answer; for everybody else commands stay commands', async () => {
    const t = voiceSetup();
    await asked(t);
    const answers = answersOf(t);
    const notUnderstood = () => t.room().played.filter((p) => p.startsWith('Das habe ich nicht verstanden')).length;
    t.room().speak(annaS, 'Quizmaster, meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    expect(notUnderstood()).toBe(0);
    t.room().speak(benS, 'Quizmaster, meine Antwort ist neun'); // Ben is not asked: a command, as before
    await until(() => notUnderstood() === 1);
    expect(t.bot.activeGame?.pending?.answer).toBe('zehn');
    const questions = () => t.room().played.filter((p) => p.includes('Pins')).length;
    const before = questions();
    t.room().speak(annaS, 'Quizmaster, wiederhole die Frage'); // no keyword, no yes/no: still a command
    await until(() => questions() === before + 1);
    expect(answers).toEqual([]);
    t.room().speak(annaS, 'Quizmaster, ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'));
    expect(answers).toEqual(['zehn']);
    await t.bot.shutdown();
  }, 20000);

  it('grace: an answer 0.5 s before the end of the answer time (D0) is asked back, "Ja" 4.5 s after D0 counts and is judged', async () => {
    // Before package C it was submitted unconfirmed (≥ D0 − 1.5 s). Now "Ja" has until min(D0 + 8, said + 8) − 1.5 s = D0 + 6 s.
    const t = voiceSetup({ answerTimeoutSec: 3, confirmGraceSec: 8 }, { extraTimeSec: 0 });
    const at = await asked(t);
    const answers = answersOf(t);
    await new Promise((r) => setTimeout(r, Math.max(0, at + 2500 - Date.now())));
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    await new Promise((r) => setTimeout(r, Math.max(0, at + 3000 + 4500 - Date.now())));
    expect(answers).toEqual([]); // still waiting for "Ja" – not submitted, no timeout
    expect(t.chat()).not.toContain('(keine Antwort)');
    t.room().speak(annaS, 'Ja');
    await until(() => t.chat().includes('„zehn“ ist richtig'), 4000);
    expect(answers).toEqual(['zehn']);
    expect(Date.now() - at).toBeLessThan(3000 + 6000); // by the "Ja", before the bot would have submitted it
    await t.bot.shutdown();
  }, 25000);

  it('no "Ja" at all: at the end of the time for "Ja" the answer counts as said (confirmAtDeadline on)', async () => {
    const t = voiceSetup({ answerTimeoutSec: 2, confirmGraceSec: 1 }, { extraTimeSec: 0 });
    await asked(t);
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.chat().includes('„zehn“ ist richtig'), 6000);
    expect(t.chat()).not.toContain('(keine Antwort)');
    await t.bot.shutdown();
  }, 20000);

  it('confirmAtDeadline off: an answer without "Ja" lapses – the controller gives "(keine Antwort)"', async () => {
    const t = voiceSetup({ answerTimeoutSec: 3, confirmGraceSec: 2, confirmAtDeadline: false }, { extraTimeSec: 0 });
    await asked(t);
    const answers = answersOf(t);
    t.room().speak(annaS, 'Meine Antwort ist zehn');
    await until(() => t.room().played.includes('zehn?'));
    await until(() => t.chat().includes('(keine Antwort)'), 10000);
    expect(answers).toEqual([]);
    expect(t.chat()).not.toContain('„zehn“ ist');
    await t.bot.shutdown();
  }, 25000);

  it('an unclear reply gets one "Ja oder nein?", a second one nothing; "Moment" keeps the answer open – logs without text', async () => {
    const t = voiceSetup();
    await asked(t);
    const answers = answersOf(t);
    const again = () => t.room().played.filter((p) => p === CONFIRM_AGAIN_LINE).length;
    const log = await infoLog(async () => {
      t.room().speak(annaS, 'Vielleicht Kegelbahn'); // no keyword
      await until(() => t.room().played.some((p) => p.startsWith('Sag: Meine Antwort ist')));
      t.room().speak(annaS, 'Meine Antwort ist zehn');
      await until(() => t.room().played.includes('zehn?'));
      t.room().speak(annaS, 'Hä');
      await until(() => again() === 1);
      t.room().speak(annaS, 'Hä');
      await new Promise((r) => setTimeout(r, 400));
      t.room().speak(annaS, 'Moment');
      await new Promise((r) => setTimeout(r, 400));
      expect(again()).toBe(1);
      expect(t.bot.activeGame?.pending?.answer).toBe('zehn');
      expect(answers).toEqual([]);
      t.room().speak(annaS, 'Ja');
      await until(() => answers.length === 1);
    });
    expect(answers).toEqual(['zehn']);
    expect(log).toContain('🎙 Anna: ohne Schlüsselwort (2 Wörter)');
    expect(log.split('🎙 Anna: Rückfrage unklar (1 Wörter) – frage nach').length - 1).toBe(1);
    expect(log).not.toMatch(/Kegelbahn|Hä|Moment/); // only what the bot acted on is logged with text (rule 8)
    await t.bot.shutdown();
  }, 20000);

  it('a short "Ja" in the confirmation is heard (minConfirmSpeechMs); what is dropped shows on info without text – only for the person answering', async () => {
    const t = voiceSetup();
    await asked(t);
    const answers = answersOf(t);
    const log = await infoLog(async () => {
      t.room().speak(annaS, 'Meine Antwort ist zehn');
      await until(() => t.room().played.includes('zehn?'));
      t.room().speak(annaS, 'Jawohl', 200); // < 250 ms: dropped
      t.room().speak(benS, 'Blablub', 200); // not asked: stays on debug
      t.room().speak(annaS, '', 500); // nothing recognised
      await new Promise((r) => setTimeout(r, 400));
      expect(answers).toEqual([]);
      t.room().speak(annaS, 'Ja', 280); // shorter than minSpeechMs (350), long enough for a confirmation
      await until(() => answers.length === 1);
    });
    expect(answers).toEqual(['zehn']);
    expect(log).toMatch(/🔇 Anna \(Rückfrage\): verworfen – zu kurz \(200 ms, rms \d+\)/);
    expect(log).toContain('🔇 Anna (Rückfrage): nichts erkannt (500 ms)');
    expect(log).not.toMatch(/Jawohl|Blablub|🔇 Ben/);
    await t.bot.shutdown();
  }, 20000);
});
