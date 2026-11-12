import {
  BoardGenerator,
  BoardStore,
  boardProvider,
  createBoardLlm,
  defaultSpec,
  estimateCost,
  fingerprint,
  type BoardRecord,
  type BoardSpec,
  type CostEstimate,
  type GeneratedBoard,
} from './boardgen/index.ts';
import { createDriver } from './browser/index.ts';
import type { Config } from './config.ts';
import { createLogger } from './core/logger.ts';
import { UsageMeter } from './llm/client.ts';
import { BoardEditorPage } from './site/editor/page.ts';
import { writeBoard } from './site/editor/writer.ts';

const log = createLogger('boards');

/** What the Discord bot and the CLI need to generate and create boards. */
export interface BoardStudio {
  /** null = ready, otherwise the reason why boards cannot be generated (no LLM). */
  unavailable(): string | null;
  defaults(topic: string): BoardSpec;
  estimate(spec: BoardSpec): CostEstimate;
  /** A board from the same request (created wins over draft). */
  existing(spec: BoardSpec): BoardRecord | undefined;
  generate(spec: BoardSpec, onProgress?: (text: string) => void): Promise<{ board: GeneratedBoard; record: BoardRecord }>;
  load(id: string): GeneratedBoard;
  /** Types the stored draft into quiz-base's editor and saves it (one at a time). */
  create(id: string, onProgress?: (text: string) => void): Promise<BoardRecord>;
  /** Boards created on quiz-base by name (for `!quiz neu <Name>`). */
  findOwn(name: string): BoardRecord[];
}

/** Generator + local register + quiz-base editor in the logged-in browser profile. */
export class QuizBaseBoardStudio implements BoardStudio {
  readonly store: BoardStore;
  private creating = false;

  constructor(private config: Config) {
    this.store = new BoardStore(config.boardgen.dir);
  }

  unavailable(): string | null {
    return boardProvider(this.config) === 'none'
      ? 'Der Board-Generator braucht ein LLM: `boardgen.provider` (oder `llm.provider`) auf `claude-cli` oder `anthropic` setzen.'
      : null;
  }

  defaults(topic: string): BoardSpec {
    return defaultSpec(this.config, topic);
  }

  estimate(spec: BoardSpec): CostEstimate {
    return estimateCost(spec, this.config);
  }

  existing(spec: BoardSpec): BoardRecord | undefined {
    return this.store.byFingerprint(fingerprint(spec));
  }

  async generate(spec: BoardSpec, onProgress?: (text: string) => void): Promise<{ board: GeneratedBoard; record: BoardRecord }> {
    const llm = createBoardLlm(this.config);
    if (!llm) throw new Error(this.unavailable() ?? 'Kein LLM');
    const meter = new UsageMeter();
    const generator = new BoardGenerator({
      llm,
      meter,
      config: this.config.boardgen,
      enforceCostCap: boardProvider(this.config) === 'anthropic',
      onProgress,
    });
    const board = await generator.generate(spec);
    log.info(`Verbrauch Board-Generator: ${meter.summary()}`);
    const record = this.store.saveDraft(board);
    return { board, record };
  }

  load(id: string): GeneratedBoard {
    return this.store.load(id);
  }

  async create(id: string, onProgress?: (text: string) => void): Promise<BoardRecord> {
    if (this.creating) throw new Error('Es wird gerade schon ein Board angelegt.');
    // A second save would create a second board on quiz-base.
    if (this.store.get(id)?.status === 'created') throw new Error('Dieses Board ist schon auf quiz-base angelegt.');
    this.creating = true;
    const board = this.store.load(id);
    const driver = createDriver(this.config);
    try {
      await driver.open(this.config.baseUrl);
      const res = await writeBoard(new BoardEditorPage(driver, this.config.baseUrl), board, { onProgress });
      log.info(`Board „${board.title}“ auf quiz-base angelegt`);
      return this.store.markCreated(id, res.url);
    } finally {
      this.creating = false;
      await driver.close().catch(() => {});
    }
  }

  findOwn(name: string): BoardRecord[] {
    return this.store.findCreated(name);
  }
}
