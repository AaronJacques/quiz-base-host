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
import { createLogger } from '../core/logger.ts';
import { durationMs, pcmFromBuffer, pcmToBuffer, resample, toChannels, type Pcm } from './audio.ts';
import { OpusDecoders, OpusEncoder, opusSelfTest } from './opus.ts';
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

/**
 * Real Discord voice (DAVE E2EE via @snazzah/davey): plays and receives Opus with our own glue
 * (`opus.ts`) – prism-media's opus streams are not used, see there why. Nothing that goes wrong with
 * one utterance (bad packets, an Opus fault, a throwing handler) may escape into Discord's event
 * handlers: an exception there would end the whole process.
 */
export class DiscordVoiceTransport implements VoiceTransport {
  readonly label: string;
  private player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  private handlers: ((u: Utterance) => void)[] = [];
  private startHandlers: ((s: Speaker) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private listening = new Set<string>();
  private decoders = new OpusDecoders();
  private encoder = new OpusEncoder();
  private closed = false;

  /** @internal – use `join`; tests pass a fake connection. */
  constructor(private conn: VoiceConnection, private opts: DiscordVoiceOptions) {
    this.label = `discord:${opts.channelId}`;
    conn.subscribe(this.player);
    this.player.on('error', (e) => log.warn(`Wiedergabe: ${e.message}`));
    conn.receiver.speaking.on('start', (userId) => {
      try {
        this.listen(userId);
      } catch (e) {
        log.warn(`Empfang (${userId}): ${(e as Error).message}`);
      }
    });
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
    opusSelfTest();
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
    for (const h of this.startHandlers) safely(() => h(speaker));
    const opus = this.conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: this.opts.silenceMs } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = this.opts.maxSpeechSec * 48000 * 2 * 2;
    const finish = () => {
      if (!this.listening.delete(userId)) return;
      opus.removeListener('data', onPacket);
      if (!bytes) return;
      const pcm = pcmFromBuffer(Buffer.concat(chunks), 48000, 2);
      const u: Utterance = { speaker, pcm, startedAt, endedAt: Date.now() - this.opts.silenceMs };
      for (const h of this.handlers) safely(() => h(u));
    };
    // Packets arrive DAVE-decrypted – or as they are while the E2EE session is not ready yet. Whatever
    // libopus cannot use is skipped by the decoder pool; it never throws.
    const onPacket = (packet: Buffer) => {
      if (this.closed || bytes > maxBytes) return;
      const pcm = this.decoders.decode(userId, packet);
      if (!pcm) return;
      chunks.push(pcm);
      bytes += pcm.length;
      if (bytes > maxBytes) opus.destroy(); // monologue guard
    };
    opus.on('data', onPacket);
    opus.on('error', (e) => log.debug(`Empfang (${speaker.displayName}): ${e.message}`));
    opus.once('end', () => safely(finish));
    opus.once('close', () => safely(finish));
  }

  async play(pcm: Pcm): Promise<void> {
    if (this.closed || !pcm.samples.length) return;
    const raw = pcmToBuffer(toChannels(resample(pcm, 48000), 2));
    const resource = createAudioResource(Readable.from(this.encoder.packets(raw)), { inputType: StreamType.Opus });
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

  onSpeechStart(handler: (s: Speaker) => void): void {
    this.startHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.player.stop(true);
    this.decoders.close();
    this.encoder.close();
    for (const h of this.closeHandlers) safely(h);
  }

  async close(): Promise<void> {
    if (this.conn.state.status !== VoiceConnectionStatus.Destroyed) this.conn.destroy();
    this.markClosed();
  }
}

/** Runs a callback from inside Discord's event handlers: an exception there would end the process. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    log.warn(`Voice: ${(e as Error)?.message ?? e}`);
  }
}
