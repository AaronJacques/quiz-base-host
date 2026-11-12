import type { Config } from '../config.ts';
import { AnthropicApiClient } from '../llm/anthropic-api.ts';
import { ClaudeCliClient } from '../llm/claude-cli.ts';
import type { LlmClient } from '../llm/client.ts';
import { boardProvider } from './cost.ts';

export * from './cost.ts';
export * from './format.ts';
export * from './generator.ts';
export * from './schema.ts';
export * from './spec.ts';
export * from './store.ts';

/** LLM for the board generator: provider/model/timeout from `boardgen` (provider `inherit` = `llm.provider`). */
export function createBoardLlm(config: Config): LlmClient | null {
  const b = config.boardgen;
  switch (boardProvider(config)) {
    case 'anthropic':
      return new AnthropicApiClient({ model: b.model, timeoutMs: b.timeoutMs });
    case 'claude-cli':
      return new ClaudeCliClient({ bin: config.llm.claudeBin, model: b.model, timeoutMs: b.timeoutMs, tmpDir: '.qbhost/tmp' });
    default:
      return null;
  }
}
