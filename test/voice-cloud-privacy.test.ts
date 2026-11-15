import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { QuizBot, type SessionLike, type VoiceKit } from '../src/discord/bot.ts';
import type { ChatGateway, ChatMessage } from '../src/discord/gateway.ts';
import { GuildStore } from '../src/discord/store.ts';
import { createJudge } from '../src/judge/index.ts';
import { UsageMeter } from '../src/llm/client.ts';
import { TafelquizController } from '../src/modes/tafelquiz/controller.ts';
import type { Pcm } from '../src/voice/audio.ts';
import { createVoiceKit } from '../src/voice/index.ts';
import type { Speaker, Utterance, VoiceTransport } from '../src/voice/transport.ts';
import { FakeTafelquizPage } from './fake-page.ts';

setLogLevel('error');

/**
 * Review T2+T3 F1/F2/F8: with `voice.stt: deepgram` (default sttCloudFor) audio goes to the cloud only for
 * someone the bot clearly lets speak now. A whole game is played; in every phase each role says something
 * that changes nothing, and the fake cloud adapter records what reached it.
 */

const ANNA: Speaker = { id: 'u-anna', username: 'anna', displayName: 'Anna' };
const BEN: Speaker = { id: 'u-ben', username: 'ben', displayName: 'Ben' };
/** In the voice channel, not in the game: a spectator. */
const CARL: Speaker = { id: 'u-carl', username: 'carl', displayName: 'Carl' };

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakeSession implements SessionLike {
  bus = new EventBus();
  meter = new UsageMeter();
  rules: Config['game'];
  page: FakeTafelquizPage;
  private ac = new AbortController();
  board = '';
  constructor(
    private config: Config,
    names: string[],
  ) {
    this.page = new FakeTafelquizPage(names, [
      [{ category: 'Sport', points: 100, text: 'Wie viele Pins beim Bowling?', note: '10' }],
      [{ category: 'Film', points: 200, text: 'Geburtsplanet von Anakin?', note: 'Tatooine' }],
    ]);
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
  /** An utterance that ends now; `startedAt` (default 0.5 s ago) is when the transport saw it begin. */
  speak(speaker: Speaker, text: string, startedAt?: number) {
    const id = 1000 + this.texts.size;
    this.texts.set(id, text);
    const samples = new Int16Array(8000).fill(4000);
    samples[0] = id;
    const now = Date.now();
    for (const h of this.handlers) h({ speaker, pcm: { rate: 16000, channels: 1, samples }, startedAt: startedAt ?? now - 500, endedAt: now });
  }
}

function rig(players: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qbprivacy-'));
  const config = ConfigSchema.parse({
    game: { revealPauseSec: 0, answerTimeoutSec: 30, buzzWindowSec: 6, buzzAnswerTimeoutSec: 5, minPlayers: 2 },
    judge: { cacheFile: path.join(dir, 'cache.json'), strategy: 'fuzzy' },
    llm: { provider: 'none' },
    discord: { dataDir: dir, autoStart: false },
    // leaveOnGameEnd off: these tests check who the cloud hears after the game too, in the same room.
    voice: { dir, ignoreWhileSpeaking: false, stt: 'deepgram', whisperFastModel: 'models/ggml-base-q5_1.bin', leaveOnGameEnd: false },
  });
  const texts = new Map<number, string>();
  const room = new Room(texts);
  const local: string[] = [];
  const cloud: string[] = [];
  const kit = createVoiceKit(config, {
    env: { DEEPGRAM_API_KEY: 'dg-test-key-privacy-123' },
    local: ({ model }) => ({ engine: `whisper:${path.basename(model)}`, transcribe: async (p) => (local.push(texts.get(p.samples[0]!) ?? ''), texts.get(p.samples[0]!) ?? ''), close: async () => {} }),
    cloud: () => ({ engine: 'deepgram:nova-3', transcribe: async (p) => (cloud.push(texts.get(p.samples[0]!) ?? ''), texts.get(p.samples[0]!) ?? ''), close: async () => {} }),
  });
  const voice: VoiceKit = {
    stt: kit.stt,
    fastStt: kit.fastStt,
    confirmStt: kit.confirmStt,
    wakeStt: kit.wakeStt,
    localStt: kit.localStt,
    localFastStt: kit.localFastStt,
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
  const gw: ChatGateway = {
    botUserId: 'bot',
    onMessage: (h) => (handler = h),
    send: async () => {},
    sendDirect: async () => {},
    react: async () => {},
    joinVoice: async () => room,
    voiceMembers: () => [ANNA, BEN, CARL],
  };
  let n = 0;
  const type = (content: string) =>
    handler({ id: String(++n), channelId: 'chan', guildId: 'guild', author: { ...ANNA, isBot: false }, content, mentionsBot: false, mentions: [], canManage: true, voiceChannelId: 'vc' });
  const bot = new QuizBot({
    gateway: gw,
    config,
    store: new GuildStore(dir),
    createSession: (cfg) => new FakeSession(cfg, players),
    listBoards: async (q) => ['Test Board', 'Anderes Board'].filter((t) => !q || t.toLowerCase().includes(q.toLowerCase())),
    voice,
  });
  const b = bot as unknown as { attention(id: string): string; cloudAllowed(id: string, startedAt: number): boolean; voice: { bridge: { buzzerOpen: boolean } } | null };
  const rows: string[] = [];
  let k = 0;
  /** `who` says something harmless; records attention and where the audio went. */
  const probe = async (phase: string, role: string, who: Speaker) => {
    const text = `hm mal sehen ${++k}`;
    await new Promise((r) => setTimeout(r, 600)); // the utterance (0.5 s) begins after the last change of state (F11)
    const attention = b.attention(who.id);
    room.speak(who, text);
    await until(() => local.includes(text) || cloud.includes(text));
    await new Promise((r) => setTimeout(r, 20));
    rows.push(`${phase} | ${role} | ${attention} | ${cloud.includes(text) ? 'Cloud' : 'lokal'}`);
  };
  /** `who` says `text` (begun at `startedAt`); resolves with where its audio went. */
  const heardBy = async (who: Speaker, text: string, startedAt?: number): Promise<'Cloud' | 'lokal'> => {
    room.speak(who, text, startedAt);
    await until(() => local.includes(text) || cloud.includes(text));
    return cloud.includes(text) ? 'Cloud' : 'lokal';
  };
  return { bot, b, room, type, rows, probe, local, cloud, heardBy };
}

const settle = () => new Promise((r) => setTimeout(r, 600));

describe('Review T2+T3 F1/F2/F8: phase × speaker role → local or cloud (whole game, fake cloud)', () => {
  it('the cloud hears only the linked player on turn, the menu asker and who may still buzz – nobody else, in no phase', async () => {
    const r = rig(['Anna', 'Ben']);
    const g = () => r.bot.activeGame as unknown as { phase: string; turn: { player: string } | null; awaiting: { player: string } | null; pending: { player: string } | null; answered: Set<string> } | null;
    try {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      await r.probe('ohne Spiel', 'Anna', ANNA);
      await r.probe('ohne Spiel', 'Ben', BEN);
      await r.probe('ohne Spiel', 'Carl (Zuschauer)', CARL);

      r.room.speak(ANNA, 'Quizmaster, neues Quiz Board'); // local wake check
      await until(() => r.room.played.some((t) => t.includes('Dazu passen 2 Boards')));
      await r.probe('Menü', 'Ben (fragte nicht)', BEN);
      await r.probe('Menü', 'Carl (Zuschauer)', CARL);
      r.room.speak(ANNA, 'Nummer eins'); // the asker chooses
      await until(() => g()?.phase === 'lobby');

      await r.probe('Lobby', 'Anna', ANNA);
      await r.probe('Lobby', 'Ben', BEN);
      await r.probe('Lobby', 'Carl (Zuschauer)', CARL);
      await r.type('!quiz los');
      await until(() => !!g()?.turn);
      const onTurn = g()!.turn!.player === 'Anna' ? ANNA : BEN;
      const other = onTurn === ANNA ? BEN : ANNA;

      await r.probe('Kartenwahl', 'dran', onTurn);
      await r.probe('Kartenwahl', 'nicht dran', other);
      await r.probe('Kartenwahl', 'unverknüpft', CARL);
      r.room.speak(onTurn, 'Sport für hundert');
      await until(() => !!g()?.awaiting);

      await r.probe('Frage', 'dran', onTurn);
      await r.probe('Frage', 'nicht dran', other);
      await r.probe('Frage', 'unverknüpft', CARL);
      r.room.speak(onTurn, 'Meine Antwort ist neun');
      await until(() => !!g()?.pending);

      await r.probe('Rückfrage', 'dran', onTurn);
      await r.probe('Rückfrage', 'nicht dran', other);
      await r.probe('Rückfrage', 'unverknüpft', CARL);
      r.room.speak(onTurn, 'Ja');
      await until(() => !!r.b.voice?.bridge.buzzerOpen);

      await r.probe('Buzzer', 'hat schon geantwortet', onTurn);
      await r.probe('Buzzer', 'darf buzzern', other);
      await r.probe('Buzzer', 'unverknüpft', CARL);

      await r.type('!quiz ende');
      await until(() => !r.bot.activeGame);
      await r.probe('Spielende', 'Anna', ANNA);
      await r.probe('Spielende', 'Ben', BEN);
      await r.probe('Spielende', 'Carl (Zuschauer)', CARL);

      // The menu asker: the menu has been chosen from already, so a fresh menu for this row.
      r.room.speak(ANNA, 'Quizmaster, neues Quiz Board');
      await until(() => r.room.played.filter((t) => t.includes('Dazu passen 2 Boards')).length === 2);
      await r.probe('Menü', 'Anna (fragte)', ANNA);

      expect(r.rows).toEqual([
        'ohne Spiel | Anna | wake | lokal',
        'ohne Spiel | Ben | wake | lokal',
        'ohne Spiel | Carl (Zuschauer) | wake | lokal',
        'Menü | Ben (fragte nicht) | wake | lokal',
        'Menü | Carl (Zuschauer) | wake | lokal',
        'Lobby | Anna | wake | lokal',
        'Lobby | Ben | wake | lokal',
        'Lobby | Carl (Zuschauer) | wake | lokal',
        'Kartenwahl | dran | full | Cloud',
        'Kartenwahl | nicht dran | wake | lokal',
        'Kartenwahl | unverknüpft | wake | lokal',
        'Frage | dran | answer | Cloud',
        'Frage | nicht dran | wake | lokal',
        'Frage | unverknüpft | wake | lokal',
        'Rückfrage | dran | confirm | Cloud',
        'Rückfrage | nicht dran | wake | lokal',
        'Rückfrage | unverknüpft | wake | lokal',
        'Buzzer | hat schon geantwortet | full | lokal',
        'Buzzer | darf buzzern | full | Cloud',
        'Buzzer | unverknüpft | wake | lokal',
        'Spielende | Anna | wake | lokal',
        'Spielende | Ben | wake | lokal',
        'Spielende | Carl (Zuschauer) | wake | lokal',
        'Menü | Anna (fragte) | full | Cloud',
      ]);
    } finally {
      await r.bot.shutdown();
    }
  }, 60000);

  it('F2: the player on turn is not linked – they and every spectator are heard locally only, 0 cloud calls', async () => {
    // quiz-base name "Anni" ≠ Discord "Anna": nobody can tell who of the unlinked is speaking.
    const r = rig(['Anni', 'Ben']);
    const g = () => r.bot.activeGame as unknown as { phase: string; turn: { player: string } | null; awaiting: { player: string } | null } | null;
    try {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      await r.type('!quiz neu Test Board');
      await until(() => g()?.phase === 'lobby');
      await r.type('!quiz los');
      await until(() => !!g()?.turn);
      expect(g()!.turn!.player).toBe('Anni');
      await r.probe('Kartenwahl (Anni unverknüpft am Zug)', 'Anna (unverknüpft, vielleicht Anni)', ANNA);
      await r.probe('Kartenwahl (Anni unverknüpft am Zug)', 'Carl (Zuschauer)', CARL);
      await r.probe('Kartenwahl (Anni unverknüpft am Zug)', 'Ben (verknüpft, nicht dran)', BEN);
      // The spectator's private talk (the reviewer's case): local only.
      r.room.speak(CARL, 'Ich schau nur zu, mein Bruder hat heute Geburtstag');
      await until(() => r.local.includes('Ich schau nur zu, mein Bruder hat heute Geburtstag'));
      await new Promise((res) => setTimeout(res, 50));
      expect(r.rows).toEqual([
        'Kartenwahl (Anni unverknüpft am Zug) | Anna (unverknüpft, vielleicht Anni) | full | lokal',
        'Kartenwahl (Anni unverknüpft am Zug) | Carl (Zuschauer) | full | lokal',
        'Kartenwahl (Anni unverknüpft am Zug) | Ben (verknüpft, nicht dran) | wake | lokal',
      ]);
      expect(r.cloud).toEqual([]);
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('F11: the cloud hears an utterance only if the speaker was allowed from its beginning to its end without a break', async () => {
    const r = rig(['Anna', 'Ben']);
    const g = () => r.bot.activeGame as unknown as { phase: string; turn: { player: string } | null; awaiting: { player: string } | null; questionOpen: boolean } | null;
    try {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      await r.type('!quiz neu Test Board');
      await until(() => g()?.phase === 'lobby');
      // Began 2 s before Anna's turn, ended after it began → local.
      const beforeTurn = Date.now() - 2000;
      await r.type('!quiz los');
      await until(() => g()?.turn?.player === 'Anna');
      expect(await r.heardBy(ANNA, 'Ich fange schon mal an zu reden', beforeTurn)).toBe('lokal');
      // Began after the turn began → cloud.
      await settle();
      expect(await r.heardBy(ANNA, 'Hm, welche Karte nehme ich')).toBe('Cloud');
      // Allowed when it began, lost (the question is read) and regained (her answer time) before it ended → local.
      await settle();
      const duringPick = Date.now();
      await r.type('Sport 100'); // typed pick
      await until(() => g()?.awaiting?.player === 'Anna');
      expect(await r.heardBy(ANNA, 'Das weiß ich doch, Moment', duringPick)).toBe('lokal');
      await settle();
      expect(await r.heardBy(ANNA, 'Hm, Bowling, wie viele waren das')).toBe('Cloud'); // begun in her answer time
      // Allowed when it began, lost during it (she answered, wrong) → local. The buzzer opens while Ben talks → local for him.
      await settle();
      const duringAnswer = Date.now();
      await r.type('neun'); // typed answer, wrong → buzzer opens
      await until(() => !!r.b.voice?.bridge.buzzerOpen);
      expect(await r.heardBy(ANNA, 'Mist, das war falsch', duringAnswer)).toBe('lokal');
      expect(await r.heardBy(BEN, 'Ich glaube ich weiß es, warte', duringAnswer)).toBe('lokal');
      // Ben begins after the buzzer opened → cloud; Anna (answered already) stays local.
      await settle();
      expect(await r.heardBy(BEN, 'Hm, zehn vielleicht')).toBe('Cloud');
      expect(await r.heardBy(ANNA, 'Ich darf ja nicht mehr')).toBe('lokal');
      // No beginning known → local.
      expect(await r.heardBy(BEN, 'Ohne Anfang', Number.NaN)).toBe('lokal');
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);

  it('F13: the menu asker is heard by the cloud exactly while the menu takes their choice – not after it expired, was chosen from or cancelled', async () => {
    const r = rig(['Anna', 'Ben']);
    const menuOpens = () => r.room.played.filter((t) => t.includes('Dazu passen 2 Boards')).length;
    const openMenu = async () => {
      const n = menuOpens();
      r.room.speak(ANNA, 'Quizmaster, neues Quiz Board'); // local wake check
      await until(() => menuOpens() === n + 1);
      await settle();
    };
    try {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      await openMenu();
      expect(r.b.attention(ANNA.id)).toBe('full');
      expect(await r.heardBy(ANNA, 'Hm, welches nehmen wir')).toBe('Cloud');
      // 5 minutes later (MENU_TTL_MS): the bot takes no choice any more – nor does the cloud hear her.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
      try {
        expect(r.b.attention(ANNA.id)).toBe('wake');
        expect(await r.heardBy(ANNA, 'Wir reden über was anderes')).toBe('lokal');
        const said = r.room.played.length;
        expect(await r.heardBy(ANNA, 'Nummer eins')).toBe('lokal'); // the expired menu takes no choice …
        await new Promise((res) => setTimeout(res, 100));
        expect(r.bot.activeGame).toBeNull(); // … so no lobby
        expect(r.room.played.length).toBe(said);
      } finally {
        vi.useRealTimers();
      }
      // Cancelled → no more cloud. (While the menu is open, anything she says is a choice – so the permission
      // is read directly here instead of speaking.)
      await openMenu();
      expect(r.b.cloudAllowed(ANNA.id, Date.now() - 100)).toBe(true);
      r.room.speak(ANNA, 'Abbrechen');
      await until(() => r.room.played.some((t) => t.includes('keine neue Lobby')));
      await settle();
      expect(await r.heardBy(ANNA, 'Dann eben nicht')).toBe('lokal');
      expect(r.b.attention(ANNA.id)).toBe('wake');
      // Chosen → no more cloud (the lobby takes no voice input from her either).
      await openMenu();
      expect(r.b.cloudAllowed(ANNA.id, Date.now() - 100)).toBe(true);
      r.room.speak(ANNA, 'Nummer eins');
      await until(() => (r.bot.activeGame as unknown as { phase: string } | null)?.phase === 'lobby');
      await settle();
      expect(await r.heardBy(ANNA, 'Na dann warten wir')).toBe('lokal');
      // Replaced by a menu of somebody else → no more cloud for Anna.
      await r.type('!quiz ende');
      await until(() => !r.bot.activeGame);
      await openMenu();
      expect(r.b.cloudAllowed(ANNA.id, Date.now() - 100)).toBe(true);
      r.room.speak(BEN, 'Quizmaster, neues Quiz Board');
      await until(() => menuOpens() === 4);
      await settle();
      expect(await r.heardBy(ANNA, 'Jetzt fragt Ben')).toBe('lokal');
      expect(r.b.cloudAllowed(BEN.id, Date.now() - 100)).toBe(true);
    } finally {
      vi.useRealTimers();
      await r.bot.shutdown();
    }
  }, 30000);
});

describe('Voice feedback (review of 3098cb2): the stop question gives no cloud permission', () => {
  it('the leader in the "Ja" window is listened to closely, but locally – her "Ja" is heard on this machine', async () => {
    const r = rig(['Ben', 'Anna']); // Ben is on turn first; Anna (who types, so the leader) is not
    const g = () => r.bot.activeGame as unknown as { turn: { player: string } | null; questionOpen: boolean; endAsk: unknown } | null;
    try {
      await r.type('!quiz voice');
      await until(() => r.room.played.some((t) => t.includes('Quizmaster')));
      await r.type('!quiz neu Test Board');
      await until(() => !!r.bot.activeGame);
      await r.type('!quiz los');
      await until(() => !!g()?.turn && !g()!.questionOpen);
      expect(g()!.turn!.player).toBe('Ben');
      r.room.speak(ANNA, 'Quizmaster, stopp'); // local wake check
      await until(() => !!g()?.endAsk);
      await settle();
      expect(r.b.attention(ANNA.id)).toBe('confirm'); // listened to closely because of the window …
      expect(r.b.cloudAllowed(ANNA.id, Date.now() - 100)).toBe(false); // … but never by the cloud
      expect(await r.heardBy(ANNA, 'Ja')).toBe('lokal');
      await until(() => !r.bot.activeGame); // and the local "Ja" ended the game
      expect(r.cloud).not.toContain('Ja');
    } finally {
      await r.bot.shutdown();
    }
  }, 30000);
});
