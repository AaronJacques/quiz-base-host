import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalize } from './normalize.ts';
import type { JudgeResult } from './judge.ts';

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

  static verdictKey(question: string, reference: string | null, answer: string): string {
    return [normalize(question), normalize(reference ?? ''), normalize(answer)].join('␟');
  }

  static questionKey(question: string, imageUrl?: string): string {
    return normalize(question) + '␟' + (imageUrl ?? '');
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
