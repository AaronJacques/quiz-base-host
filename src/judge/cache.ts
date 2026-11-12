import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalize } from './normalize.ts';
import type { JudgeResult } from './judge.ts';

/** Bump when the shape of `solutionKey` changes – older solution entries then no longer match. */
const SOLUTION_KEY_VERSION = 2;

/** What identifies a question's pictures and sound (QuestionState fits). */
export interface QuestionMedia {
  imageUrls: string[];
  audio: { present: boolean; title: string | null };
}

interface CacheFile {
  verdicts: Record<string, JudgeResult>;
  solutions: Record<string, { answer: string; confidence: number }>;
}

/**
 * Persistent cache so replaying a community board (or the same wrong answer
 * twice) never costs a second LLM call.
 */
export class JudgeCache {
  private data: CacheFile = { verdicts: {}, solutions: {} };

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.data = { verdicts: {}, solutions: {}, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        /* corrupt cache → start fresh */
      }
    }
  }

  /**
   * Bump `JUDGE_RULES_VERSION` (llm-judge.ts) when the judging rules change – old verdicts then no longer match.
   * Spoken answers are judged by sound, so they get their own entries. Without a reference the verdict
   * depends on the question's pictures/sound, so `media` (see `mediaKey`) becomes part of the key;
   * `null` there means the media has no stable identity → returns null = do not cache.
   */
  static verdictKey(
    question: string,
    reference: string | null,
    answer: string,
    opts: { spoken?: boolean; version?: number; media?: string | null } = {},
  ): string | null {
    const parts = [`v${opts.version ?? 1}${opts.spoken ? 's' : ''}`, normalize(question), normalize(reference ?? ''), normalize(answer)];
    if (reference === null && opts.media !== undefined) {
      if (opts.media === null) return null;
      if (opts.media) parts.push(`m:${opts.media}`);
    }
    return parts.join('␟');
  }

  /**
   * Stable identity of a question's media: every image URL and the audio track (YouTube title).
   * null when something has none – `data:` images, audio without a title – such questions are never cached.
   */
  static mediaKey(media: QuestionMedia): string | null {
    const parts: string[] = [];
    for (const u of media.imageUrls) {
      if (!u || u.startsWith('data:')) return null;
      parts.push(`img:${u}`);
    }
    if (media.audio.present) {
      if (!media.audio.title?.trim()) return null;
      parts.push(`audio:${media.audio.title.trim()}`);
    }
    return parts.join('|');
  }

  /** Key of the derived solution of a question without note: text + media. null = do not cache. */
  static solutionKey(question: string, media: QuestionMedia): string | null {
    const m = JudgeCache.mediaKey(media);
    return m === null ? null : [`s${SOLUTION_KEY_VERSION}`, normalize(question), m].join('␟');
  }

  getVerdict(key: string): JudgeResult | undefined {
    return this.data.verdicts[key];
  }

  setVerdict(key: string, r: JudgeResult): void {
    this.data.verdicts[key] = r;
    this.flush();
  }

  getSolution(key: string) {
    return this.data.solutions[key];
  }

  setSolution(key: string, s: { answer: string; confidence: number }): void {
    this.data.solutions[key] = s;
    this.flush();
  }

  private flush(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
}
