import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { createLogger } from '../core/logger.ts';
import { durationMs, pcmFromBuffer, pcmToBuffer, resample, toChannels, type Pcm } from './audio.ts';
import type { Speaker, Utterance, VoiceTransport } from './transport.ts';

const log = createLogger('voice');

export interface DiscordVoiceOptions {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  silenceMs: number;
  maxSpeechSec: number;
  /** Member lookup (display name); null for bots/unknown users, whose audio is ignored. */
  speaker: (userId: string) => Speaker | null;
}

/** Real Discord voice: plays raw PCM, receives per-user Opus and decodes it (DAVE E2EE via @snazzah/davey). */
export class DiscordVoiceTransport implements VoiceTransport {
  readonly label: string;
  private player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  private handlers: ((u: Utterance) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private listening = new Set<string>();
  private closed = false;

  private constructor(private conn: VoiceConnection, private opts: DiscordVoiceOptions) {
    this.label = `discord:${opts.channelId}`;
    conn.subscribe(this.player);
    this.player.on('error', (e) => log.warn(`Wiedergabe: ${e.message}`));
    conn.receiver.speaking.on('start', (userId) => this.listen(userId));
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved between channels / short network hiccup → Discord reconnects on its own.
        await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
      } catch {
        log.warn('Voice-Verbindung verloren');
        void this.close();
      }
    });
    conn.on(VoiceConnectionStatus.Destroyed, () => this.markClosed());
  }

  static async join(opts: DiscordVoiceOptions): Promise<DiscordVoiceTransport> {
    const conn = joinVoiceChannel({ guildId: opts.guildId, channelId: opts.channelId, adapterCreator: opts.adapterCreator, selfDeaf: false, selfMute: false });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      conn.destroy();
      throw new Error(`Voice-Channel beitreten fehlgeschlagen: ${(e as Error).message}. Hat der Bot die Rechte „Verbinden“ und „Sprechen“?`);
    }
    log.info(`Im Voice-Channel ${opts.channelId}`);
    return new DiscordVoiceTransport(conn, opts);
  }

  private listen(userId: string): void {
    if (this.closed || this.listening.has(userId)) return;
    const speaker = this.opts.speaker(userId);
    if (!speaker) return;
    this.listening.add(userId);
    const startedAt = Date.now();
    const opus = this.conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: this.opts.silenceMs } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = this.opts.maxSpeechSec * 48000 * 2 * 2;
    const finish = () => {
      if (!this.listening.delete(userId)) return;
      opus.unpipe(decoder);
      decoder.destroy();
      if (!bytes) return;
      const pcm = pcmFromBuffer(Buffer.concat(chunks), 48000, 2);
      const u: Utterance = { speaker, pcm, startedAt, endedAt: Date.now() - this.opts.silenceMs };
      for (const h of this.handlers) h(u);
    };
    decoder.on('data', (d: Buffer) => {
      chunks.push(d);
      bytes += d.length;
      if (bytes > maxBytes) opus.destroy(); // monologue guard
    });
    decoder.on('error', (e: Error) => log.debug(`Opus-Dekodierung (${speaker.displayName}): ${e.message}`));
    opus.on('error', (e) => log.debug(`Empfang (${speaker.displayName}): ${e.message}`));
    opus.once('end', finish);
    opus.once('close', finish);
    opus.pipe(decoder);
  }

  async play(pcm: Pcm): Promise<void> {
    if (this.closed || !pcm.samples.length) return;
    const raw = pcmToBuffer(toChannels(resample(pcm, 48000), 2));
    const resource = createAudioResource(Readable.from([raw]), { inputType: StreamType.Raw });
    this.player.play(resource);
    try {
      await entersState(this.player, AudioPlayerStatus.Playing, 5000);
      await entersState(this.player, AudioPlayerStatus.Idle, durationMs(pcm) + 10_000);
    } catch {
      /* stopped or stuck – carry on */
    }
  }

  stop(): void {
    this.player.stop(true);
  }

  onUtterance(handler: (u: Utterance) => void): void {
    this.handlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.player.stop(true);
    for (const h of this.closeHandlers) h();
  }

  async close(): Promise<void> {
    if (this.conn.state.status !== VoiceConnectionStatus.Destroyed) this.conn.destroy();
    this.markClosed();
  }
}
