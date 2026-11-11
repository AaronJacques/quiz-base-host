import type { Config } from '../config.ts';
import { AnthropicApiClient } from './anthropic-api.ts';
import { ClaudeCliClient } from './claude-cli.ts';
import type { LlmClient } from './client.ts';

export * from './client.ts';

export function createLlm(config: Config): LlmClient | null {
  const l = config.llm;
  switch (l.provider) {
    case 'anthropic':
      return new AnthropicApiClient({ model: l.model, timeoutMs: l.timeoutMs });
    case 'claude-cli':
      return new ClaudeCliClient({ bin: l.claudeBin, model: l.model, timeoutMs: l.timeoutMs, tmpDir: '.qbhost/tmp' });
    case 'none':
    default:
      return null;
  }
}
