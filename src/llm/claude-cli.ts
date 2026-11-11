import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ImageInput, JsonRequest, JsonResponse, LlmClient } from './client.ts';

/**
 * Uses the locally installed Claude Code CLI in headless mode (`claude -p`).
 * Runs on the user's Claude subscription – no API key needed. All tools,
 * MCP servers, settings and skills are switched off so each call only pays
 * for the tiny judging prompt.
 */
export class ClaudeCliClient implements LlmClient {
  readonly name = 'claude-cli';

  constructor(private opts: { bin: string; model: string; timeoutMs: number; tmpDir: string }) {}

  async completeJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<JsonResponse<z.infer<S>>> {
    const started = Date.now();
    const imagePaths = await this.materializeImages(req.images ?? []);
    const args = [
      '-p',
      '--model', this.opts.model,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(cliSchema(req.schema)),
      '--system-prompt', req.system,
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--no-session-persistence',
    ];
    let prompt = req.prompt;
    if (imagePaths.length) {
      // Only the Read tool, only for the image directory – needed to "see" the picture.
      args.push('--tools', 'Read', '--allowedTools', 'Read', '--add-dir', path.resolve(this.opts.tmpDir));
      prompt += '\n\nBild(er) zur Frage (mit dem Read-Tool ansehen):\n' + imagePaths.map((p) => `- ${p}`).join('\n');
    } else {
      args.push('--tools', '');
    }

    const stdout = await this.exec(args, prompt);
    let parsed: { structured_output?: unknown; result?: string; total_cost_usd?: number; is_error?: boolean };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`claude CLI lieferte kein JSON: ${stdout.slice(0, 300)}`);
    }
    if (parsed.is_error) throw new Error(`claude CLI Fehler: ${parsed.result}`);
    const raw = parsed.structured_output ?? safeJson(parsed.result);
    return { data: req.schema.parse(raw), costUsd: parsed.total_cost_usd, ms: Date.now() - started };
  }

  private exec(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude CLI Timeout nach ${this.opts.timeoutMs} ms`));
      }, this.opts.timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out) reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`));
        else resolve(out);
      });
      child.stdin.end(stdin);
    });
  }

  private async materializeImages(images: ImageInput[]): Promise<string[]> {
    if (!images.length) return [];
    await mkdir(this.opts.tmpDir, { recursive: true });
    const paths: string[] = [];
    for (const [i, img] of images.entries()) {
      if (img.kind === 'file') {
        paths.push(path.resolve(img.path));
        continue;
      }
      let bytes: Buffer;
      let ext = 'jpg';
      if (img.kind === 'base64') {
        bytes = Buffer.from(img.data, 'base64');
        ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
      } else {
        const res = await fetch(img.url, { headers: { 'user-agent': 'Mozilla/5.0 (qbhost quiz helper)' } });
        if (!res.ok) throw new Error(`Bild nicht ladbar (${res.status}): ${img.url}`);
        bytes = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get('content-type') ?? '';
        ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : ct.includes('svg') ? 'svg' : 'jpg';
      }
      const file = path.resolve(this.opts.tmpDir, `q-${Date.now()}-${i}.${ext}`);
      await writeFile(file, bytes);
      paths.push(file);
    }
    return paths;
  }
}

/** The CLI validator rejects the draft-2020 `$schema` header zod emits. */
function cliSchema(schema: z.ZodType): object {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function safeJson(s?: string): unknown {
  if (!s) return undefined;
  const m = s.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : s);
  } catch {
    return undefined;
  }
}
