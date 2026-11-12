import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { cleanSpokenAnswer, QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import { decodeWav, durationMs, encodeWav, resample, rms, toChannels, type Pcm } from '../src/voice/audio.ts';
import { confirmReply, extractAnswer, isBuzz, spokenNumber, spokenToDigits, stripWakeWord, voiceCommand } from '../src/voice/commands.ts';
import { gameOverLine, questionLine, turnLine, verdictLine } from '../src/voice/narration.ts';
import { cleanTranscript, type SpeechToText } from '../src/voice/stt.ts';
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
      game: { autoStart: true, minPlayers: 2, revealPauseSec: 0, answerTimeoutSec: 1, buzzWindowSec: 2, buzzAnswerTimeoutSec: 1 },
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
  all() {
    return this.played.join('\n');
  }
}

/** `calls` records every full transcription (a wake-word check uses only the wake words as prompt). */
function voiceKit(texts: Map<number, string>, calls: string[] = []): VoiceKit {
  const stt: SpeechToText = {
    transcribe: async (p, prompt = '') => {
      const text = texts.get(p.samples[0]!) ?? '';
      if (prompt.includes('Meine Antwort ist')) calls.push(text);
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
    await this.page.endGame();
    this.ac.abort();
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
      game: { revealPauseSec: 0, answerTimeoutSec: 3, buzzWindowSec: 2, buzzAnswerTimeoutSec: 2, minPlayers: 2 },
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
