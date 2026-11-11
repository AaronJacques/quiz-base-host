import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameRules } from '../modes/tafelquiz/rules.ts';

interface GuildData {
  /** Discord user ID → quiz-base player name (remembered across games). */
  links: Record<string, string>;
  /** Rule overrides set via `!quiz regel …`. */
  rules: Partial<GameRules>;
}

/** Small JSON persistence per Discord server. */
export class GuildStore {
  private cache = new Map<string, GuildData>();

  constructor(private dir: string) {}

  private file(guildId: string): string {
    return path.join(this.dir, `guild-${guildId.replace(/[^\w-]/g, '')}.json`);
  }

  get(guildId: string): GuildData {
    let data = this.cache.get(guildId);
    if (!data) {
      const f = this.file(guildId);
      data = { links: {}, rules: {} };
      if (existsSync(f)) {
        try {
          data = { ...data, ...JSON.parse(readFileSync(f, 'utf8')) };
        } catch {
          /* corrupt → defaults */
        }
      }
      this.cache.set(guildId, data!);
    }
    return data!;
  }

  save(guildId: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(guildId), JSON.stringify(this.get(guildId), null, 2));
  }
}
