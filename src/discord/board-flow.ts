import type { BoardStudio } from '../board-studio.ts';
import { estimateText, formatUsd, fullPreview, publicPreview, specLines, specProblems, type BoardRecord, type BoardSpec } from '../boardgen/index.ts';
import type { Config } from '../config.ts';
import { createLogger } from '../core/logger.ts';
import { parseCreateArgs } from './create-parser.ts';
import { mention, type ChatGateway, type ChatMessage } from './gateway.ts';

const log = createLogger('discord');

const PENDING_TTL_MS = 10 * 60_000;

const PUBLISH_HINT = 'Veröffentlichen kannst du selbst unter „Meine Boards“ auf quiz-base.';

interface Pending {
  userId: string;
  guildId: string;
  channelId: string;
  stage: 'confirm-generate' | 'generating' | 'confirm-create' | 'creating';
  spec: BoardSpec;
  recordId?: string;
  expires: number;
}

export interface BoardFlowDeps {
  gateway: ChatGateway;
  config: Config;
  studio: BoardStudio;
  /** Public chat message (the bot's batching `say`). */
  say: (channelId: string, text: string) => Promise<void>;
  /** Why boards cannot be created right now (a game runs), or null. */
  blockedBy: (guildId: string) => string | null;
}

/**
 * `!quiz erstellen <Thema> [Optionen]`: parameters + cost → "ja" → generate → public preview
 * (name, categories, points) + full preview with solutions by DM → "anlegen" → saved on quiz-base.
 * Solutions never go to a channel. Only server admins and `boardgen.creatorIds` may create.
 */
export class BoardCreateFlow {
  private pending = new Map<string, Pending>();
  private busy: Pending | null = null;

  constructor(private d: BoardFlowDeps) {}

  private get prefix(): string {
    return this.d.config.discord.prefix;
  }

  /** The editor is open in the shared browser profile – no lobby may start now. */
  get creating(): boolean {
    return this.busy?.stage === 'creating';
  }

  private allowed(msg: ChatMessage): boolean {
    return msg.canManage || this.d.config.boardgen.creatorIds.includes(msg.author.id);
  }

  async command(msg: ChatMessage, args: string[]): Promise<void> {
    if (!msg.guildId) return;
    if (!this.allowed(msg)) return this.d.say(msg.channelId, '🔒 Boards erstellen dürfen nur Server-Admins („Server verwalten“) oder freigeschaltete Nutzer (`boardgen.creatorIds`).');
    const why = this.d.studio.unavailable();
    if (why) return this.d.say(msg.channelId, `🔇 ${why}`);
    const text = args.join(' ').trim();
    if (!text) return this.d.say(msg.channelId, this.usage());
    const blocked = this.d.blockedBy(msg.guildId);
    if (blocked) return this.d.say(msg.channelId, blocked);
    if (this.busy) return this.d.say(msg.channelId, `⏳ Ich ${this.busy.stage === 'creating' ? 'lege gerade schon ein Board an' : 'erzeuge gerade schon ein Board'}. Gleich wieder frei.`);

    const { spec, force, publicAsked } = parseCreateArgs(text, this.d.studio.defaults(''));
    const problems = specProblems(spec);
    if (problems.length) return this.d.say(msg.channelId, `⚠️ ${problems.join(' ')}\n${this.usage()}`);

    const existing = force ? undefined : this.d.studio.existing(spec);
    if (existing?.status === 'created') {
      // The editor link shows the solutions: only by DM.
      if (existing.url) await this.dm(msg.author.id, `🔗 **${existing.title}** im Editor von quiz-base: ${existing.url}`);
      return this.d.say(msg.channelId, [
        `♻️ Das gleiche Board gibt es schon: **${existing.title}**`,
        `Spielen: \`${this.prefix} neu ${existing.title}\` · Neuer Entwurf: dieselbe Anfrage mit \`nochmal\`.`,
      ].join('\n'));
    }
    if (existing) {
      const p = this.open(msg, spec, 'confirm-create');
      p.recordId = existing.id;
      await this.d.say(msg.channelId, `♻️ Für diese Anfrage gibt es schon einen Entwurf (keine neuen Kosten).`);
      return this.showDraft(p, existing);
    }
    this.open(msg, spec, 'confirm-generate');
    await this.d.say(msg.channelId, [
      `🧠 **Neues Board erzeugen?** ${mention(msg.author.id)}`,
      ...specLines(spec, this.d.studio.estimate(spec)),
      publicAsked ? `ℹ️ ${PUBLISH_HINT}` : '',
      'Schreib `ja`, dann lege ich los (dauert 1–3 Minuten). `abbrechen` bricht ab.',
    ].filter(Boolean).join('\n'));
  }

  /** Answers to an open request ("ja", "anlegen", "nochmal", "abbrechen"). Returns true if consumed. */
  async onMessage(msg: ChatMessage): Promise<boolean> {
    const p = this.pending.get(msg.author.id);
    if (!p || p.channelId !== msg.channelId) return false;
    if (Date.now() > p.expires) {
      this.pending.delete(msg.author.id);
      return false;
    }
    const t = msg.content.trim().toLowerCase().replace(/[.!]+$/, '');
    if (/^(abbrechen|abbruch|stop|cancel|nein)$/.test(t)) {
      if (p.stage === 'generating' || p.stage === 'creating') {
        await this.d.say(msg.channelId, '⏳ Läuft schon, das lasse ich zu Ende laufen.');
        return true;
      }
      this.pending.delete(msg.author.id);
      await this.d.say(msg.channelId, p.recordId ? '🗑️ Okay, ich lege nichts an. (Der Entwurf bleibt lokal gespeichert.)' : 'Okay, kein neues Board.');
      return true;
    }
    if (p.stage === 'confirm-generate' && /^(ja|jo|ok|okay|los|klar)$/.test(t)) {
      void this.generate(p);
      return true;
    }
    if (p.stage === 'confirm-create' && /^(anlegen|ja|speichern)$/.test(t)) {
      void this.create(p);
      return true;
    }
    if (p.stage === 'confirm-create' && /^(nochmal|neu|neuer entwurf)$/.test(t)) {
      void this.generate(p);
      return true;
    }
    if ((p.stage === 'generating' || p.stage === 'creating') && /^(ja|anlegen|nochmal)$/.test(t)) {
      await this.d.say(msg.channelId, '⏳ Läuft schon …');
      return true;
    }
    return false;
  }

  /** Direct message; false if the user does not accept DMs. */
  private async dm(userId: string, text: string): Promise<boolean> {
    try {
      await this.d.gateway.sendDirect(userId, text);
      return true;
    } catch (e) {
      log.warn(`DM an ${userId}: ${(e as Error).message}`);
      return false;
    }
  }

  private open(msg: ChatMessage, spec: BoardSpec, stage: Pending['stage']): Pending {
    const p: Pending = { userId: msg.author.id, guildId: msg.guildId!, channelId: msg.channelId, stage, spec, expires: Date.now() + PENDING_TTL_MS };
    this.pending.set(msg.author.id, p);
    return p;
  }

  private async generate(p: Pending): Promise<void> {
    if (this.busy) return this.d.say(p.channelId, '⏳ Ich bin gerade mit einem anderen Board beschäftigt. Gleich noch einmal versuchen.');
    p.stage = 'generating';
    this.busy = p;
    await this.d.say(p.channelId, `⏳ Claude schreibt das Board zu **${p.spec.topic}** … (1–3 Minuten)`);
    try {
      const { record } = await this.d.studio.generate(p.spec, (text) => void this.d.say(p.channelId, text));
      p.recordId = record.id;
      p.stage = 'confirm-create';
      p.expires = Date.now() + PENDING_TTL_MS;
      await this.showDraft(p, record);
    } catch (e) {
      log.error(`Board-Generator: ${(e as Error).message}`);
      this.pending.delete(p.userId);
      await this.d.say(p.channelId, `⚠️ Das Board konnte ich nicht erzeugen: ${(e as Error).message}`);
    } finally {
      this.busy = null;
    }
  }

  /** Public preview (no questions, no solutions) + full preview by DM. */
  private async showDraft(p: Pending, record: BoardRecord): Promise<void> {
    const board = this.d.studio.load(record.id);
    let dmOk = true;
    try {
      for (const part of fullPreview(board)) await this.d.gateway.sendDirect(p.userId, part);
    } catch (e) {
      dmOk = false;
      log.warn(`DM an ${p.userId}: ${(e as Error).message}`);
    }
    await this.d.say(p.channelId, [
      publicPreview(board),
      dmOk ? `📬 ${mention(p.userId)}, Fragen und Lösungen hab ich dir per DM geschickt.` : `⚠️ ${mention(p.userId)}, ich konnte dir keine DM schicken (DMs von Server-Mitgliedern erlauben). Fragen und Lösungen zeige ich hier nicht.`,
      board.warnings.length ? `⚠️ ${board.warnings.length} Frage(n) solltest du in der Vorschau prüfen.` : '',
      'Schreib `anlegen`, dann speichere ich es auf quiz-base (als privaten Entwurf). `nochmal` = neuer Entwurf, `abbrechen` = verwerfen.',
    ].filter(Boolean).join('\n'));
  }

  private async create(p: Pending): Promise<void> {
    if (!p.recordId) return;
    const blocked = this.d.blockedBy(p.guildId);
    if (blocked) return this.d.say(p.channelId, blocked);
    if (this.busy) return this.d.say(p.channelId, '⏳ Ich bin gerade mit einem anderen Board beschäftigt. Gleich noch einmal `anlegen`.');
    const board = this.d.studio.load(p.recordId);
    p.stage = 'creating';
    this.busy = p;
    await this.d.say(p.channelId, `⏳ Lege **${board.title}** auf quiz-base an … (ca. 1 Minute)`);
    try {
      const rec = await this.d.studio.create(p.recordId);
      this.pending.delete(p.userId);
      const cost = this.d.studio.estimate(board.spec).viaSubscription ? `über dein Claude-Abo (API-Gegenwert ${formatUsd(board.costUsd)})` : formatUsd(board.costUsd);
      // The editor link shows the solutions: only by DM, never in the channel.
      const linked = rec.url ? await this.dm(p.userId, `🔗 **${rec.title}** im Editor von quiz-base: ${rec.url}\n${PUBLISH_HINT}`) : false;
      await this.d.say(p.channelId, [
        `✅ **${rec.title}** ist auf quiz-base angelegt (privater Entwurf). Mit \`${this.prefix} neu ${rec.title}\` spielen.`,
        `${linked ? '📬 Den Link hab ich dir per DM geschickt. ' : ''}${PUBLISH_HINT}`,
        `Kosten: ${cost}, ${board.calls} Aufrufe.`,
      ].join('\n'));
    } catch (e) {
      log.error(`Board anlegen: ${(e as Error).message}`);
      p.stage = 'confirm-create';
      p.expires = Date.now() + PENDING_TTL_MS;
      await this.d.say(p.channelId, `⚠️ Anlegen hat nicht geklappt: ${(e as Error).message}\nDer Entwurf ist gespeichert, \`anlegen\` versucht es noch einmal.`);
    } finally {
      this.busy = null;
    }
  }

  usage(): string {
    const p = this.prefix;
    return [
      `**🧠 Board erzeugen:** \`${p} erstellen <Thema> [Optionen]\``,
      `Beispiel: \`${p} erstellen Star Wars 5x4 profi\` · \`${p} erstellen Tiere kinder 3x3 mc 25%\``,
      `Optionen: \`5x4\` (Kategorien × Stufen) · \`kinder\`/\`schule\`/\`oberstufe\`/\`kneipe\`/\`profi\` · \`2 boards\` · \`mc 25%\` · \`sprache en\` · \`schritt 200\` · \`; name: …\` · \`; themen: A, B, C\` · \`nochmal\``,
      `Kosten mit den Standardwerten: ${estimateText(this.d.studio.estimate(this.d.studio.defaults('Beispiel')))}`,
    ].join('\n');
  }
}
