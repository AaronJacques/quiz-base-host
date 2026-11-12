import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalize } from '../judge/normalize.ts';
import type { GeneratedBoard } from './schema.ts';

export interface BoardRecord {
  id: string;
  title: string;
  fingerprint: string;
  /** draft = generated only; created = saved on quiz-base. */
  status: 'draft' | 'created';
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Local register of generated boards in `boardgen.dir` (gitignored – the files contain the
 * solutions). Remembers which request (fingerprint) led to which board, so a repeated request
 * does not create a second board, and lets `!quiz neu <Name>` find own boards.
 */
export class BoardStore {
  constructor(private dir: string) {}

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private boardFile(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
  }

  private write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  }

  list(): BoardRecord[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const data = JSON.parse(readFileSync(this.indexFile, 'utf8')) as { boards?: BoardRecord[] };
      return Array.isArray(data.boards) ? data.boards : [];
    } catch {
      return [];
    }
  }

  private saveIndex(boards: BoardRecord[]): void {
    this.write(this.indexFile, { boards });
  }

  /** Stores a freshly generated board as draft and returns its record. */
  saveDraft(board: GeneratedBoard): BoardRecord {
    const now = new Date().toISOString();
    const slug = normalize(board.title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
    const rec: BoardRecord = {
      id: `${slug}-${Date.now().toString(36)}`,
      title: board.title,
      fingerprint: board.fingerprint,
      status: 'draft',
      url: null,
      createdAt: now,
      updatedAt: now,
    };
    this.write(this.boardFile(rec.id), board);
    this.saveIndex([...this.list(), rec]);
    return rec;
  }

  load(id: string): GeneratedBoard {
    return JSON.parse(readFileSync(this.boardFile(id), 'utf8')) as GeneratedBoard;
  }

  get(id: string): BoardRecord | undefined {
    return this.list().find((r) => r.id === id);
  }

  markCreated(id: string, url: string | null, title?: string): BoardRecord {
    const boards = this.list();
    const rec = boards.find((r) => r.id === id);
    if (!rec) throw new Error(`Board ${id} nicht im Register`);
    rec.status = 'created';
    rec.url = url;
    if (title) rec.title = title;
    rec.updatedAt = new Date().toISOString();
    this.saveIndex(boards);
    return rec;
  }

  /** Newest record for a request; a created board wins over drafts. */
  byFingerprint(fp: string): BoardRecord | undefined {
    const hits = this.list().filter((r) => r.fingerprint === fp);
    return hits.filter((r) => r.status === 'created').at(-1) ?? hits.at(-1);
  }

  /** Created boards by name: exact (normalised) title first, otherwise titles containing the query. */
  findCreated(name: string): BoardRecord[] {
    const want = normalize(name);
    if (!want) return [];
    const created = this.list().filter((r) => r.status === 'created');
    const exact = created.filter((r) => normalize(r.title) === want);
    return exact.length ? exact : created.filter((r) => normalize(r.title).includes(want));
  }

  /** The board was deleted on quiz-base: back to a local draft (keeps the questions, no new LLM cost). */
  markDeleted(id: string): void {
    const boards = this.list();
    const rec = boards.find((r) => r.id === id);
    if (!rec) return;
    rec.status = 'draft';
    rec.url = null;
    rec.updatedAt = new Date().toISOString();
    this.saveIndex(boards);
  }

  remove(id: string): void {
    this.saveIndex(this.list().filter((r) => r.id !== id));
    rmSync(this.boardFile(id), { force: true });
  }
}
