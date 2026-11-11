import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { JsonRequest, JsonResponse, LlmClient } from './client.ts';

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

/** $ per 1M tokens (input, output) – only used for the usage display. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

/** Direct Claude API access (needs ANTHROPIC_API_KEY or an `ant auth login` profile). */
export class AnthropicApiClient implements LlmClient {
  readonly name = 'anthropic';
  private client = new Anthropic();
  private model: string;

  constructor(opts: { model: string; timeoutMs: number }) {
    this.model = MODEL_ALIASES[opts.model] ?? opts.model;
    this.client = new Anthropic({ timeout: opts.timeoutMs, maxRetries: 1 });
  }

  async completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> {
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      if (img.kind === 'url') content.push({ type: 'image', source: { type: 'url', url: img.url } });
      else if (img.kind === 'base64')
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.data } });
      else content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync(img.path).toString('base64') } });
    }
    content.push({ type: 'text', text: req.prompt });

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      // Judging is a classification task – low effort keeps it fast and cheap.
      output_config: { effort: 'low', format: zodOutputFormat(req.schema as any) },
      system: req.system,
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') throw new Error('Modell hat die Bewertung abgelehnt');
    if (response.parsed_output == null) throw new Error('Keine strukturierte Antwort erhalten');

    const [pin, pout] = PRICES[this.model] ?? [0, 0];
    const u = response.usage;
    const cost = ((u.input_tokens + (u.cache_read_input_tokens ?? 0)) * pin + u.output_tokens * pout) / 1e6;
    return { data: response.parsed_output as z.infer<S>, costUsd: cost, ms: Date.now() - started };
  }
}
