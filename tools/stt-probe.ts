// Measures speech recognition with real clips – the same routes the bot builds from the config, so local
// and cloud can be compared on the same machine (docs/VOICE.md "Erkennung: lokal oder Cloud"):
//   npx tsx tools/stt-probe.ts [--runs N] [--prompt '<Komma-Liste>'] [--engine local|cloud] [--config <datei>] <wav…>
// Each WAV goes N times (default 5, plus one warm-up run) through the 'answer' route. Prints per file the
// engine, median, maximum, fallback yes/no and the recognised text, then p50/p90 over all runs.
// `--engine local` forces whisper.cpp, `--engine cloud` forces Deepgram without fallback (failures show).
// Prints only the texts of the given clips – never keys or other secrets.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { decodeWav, durationMs, type Pcm } from '../src/voice/audio.ts';
import { percentile } from '../src/voice/latency.ts';
import { createSttRoutes, type SttRoutes } from '../src/voice/providers.ts';
import type { SpeechToText } from '../src/voice/stt.ts';

export type ProbeEngine = 'local' | 'cloud' | undefined;

/** The voice config to measure: as configured, or forced to one engine for the 'answer' route. */
export function probeVoice(v: Config['voice'], engine: ProbeEngine): Config['voice'] {
  if (engine === 'local') return { ...v, stt: 'whisper' };
  if (engine === 'cloud') return { ...v, stt: 'deepgram', sttCloudFor: [...new Set([...v.sttCloudFor, 'answer' as const])], cloudFallback: 'none' };
  return v;
}

export interface ProbeRun {
  ms: number;
  text: string;
  /** The engine that produced the text; after a fallback `cloud→local`. */
  engine: string;
  fallback: boolean;
  error?: string;
}

/** One transcription, timed; never throws (an error is a run with `error`). */
export async function probeOnce(stt: SpeechToText, pcm: Pcm, prompt: string): Promise<ProbeRun> {
  let engine = stt.engine ?? 'unbekannt';
  let fallback = false;
  const t0 = performance.now();
  try {
    const text = await stt.transcribe(pcm, prompt, {
      onFallback: (e) => {
        fallback = true;
        engine = `${stt.engine ?? 'cloud'}→${e}`;
      },
    });
    return { ms: performance.now() - t0, text, engine, fallback };
  } catch (e) {
    return { ms: performance.now() - t0, text: '', engine, fallback, error: (e as Error).message };
  }
}

export interface ProbeRow {
  file: string;
  audioMs: number;
  engines: string[];
  median: number;
  max: number;
  fallback: boolean;
  texts: string[];
  errors: string[];
  runs: ProbeRun[];
}

export function summarizeRuns(file: string, audioMs: number, runs: ProbeRun[]): ProbeRow {
  const ok = runs.filter((r) => !r.error);
  const ms = ok.map((r) => r.ms);
  return {
    file,
    audioMs,
    engines: [...new Set(runs.map((r) => r.engine))],
    median: ms.length ? percentile(ms, 50) : NaN,
    max: ms.length ? Math.max(...ms) : NaN,
    fallback: runs.some((r) => r.fallback),
    texts: [...new Set(ok.map((r) => r.text))],
    errors: [...new Set(runs.flatMap((r) => (r.error ? [r.error] : [])))],
    runs,
  };
}

const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '-');

export function formatProbe(rows: ProbeRow[]): string {
  const head = ['Datei', 'Audio', 'Engine', 'Median', 'Max', 'Rückfall', 'Text'];
  const body = rows.map((r) => [
    r.file,
    fmt(r.audioMs),
    r.engines.join(', '),
    fmt(r.median),
    fmt(r.max),
    r.fallback ? 'ja' : 'nein',
    [r.texts.map((t) => `„${t}“`).join(' | '), ...r.errors.map((e) => `Fehler: ${e}`)].filter(Boolean).join(' '),
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]!))).join('  ');
  const all = rows.flatMap((r) => r.runs.filter((x) => !x.error).map((x) => x.ms));
  const failed = rows.reduce((n, r) => n + r.runs.filter((x) => x.error).length, 0);
  const total = all.length ? `Gesamt: n=${all.length} p50=${fmt(percentile(all, 50))} p90=${fmt(percentile(all, 90))}` : 'Gesamt: keine erfolgreiche Erkennung';
  return [line(head), ...body.map(line), '', `${total}${failed ? `, ${failed} fehlgeschlagen` : ''}`].join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: 'string', default: '5' },
      prompt: { type: 'string', default: '' },
      engine: { type: 'string' },
      config: { type: 'string' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !positionals.length) {
    console.log("Aufruf: npx tsx tools/stt-probe.ts [--runs N] [--prompt '<Komma-Liste>'] [--engine local|cloud] [--config <datei>] <wav…>");
    process.exit(values.help ? 0 : 1);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs braucht eine ganze Zahl ≥ 1');
  const engine = values.engine as ProbeEngine;
  if (engine !== undefined && engine !== 'local' && engine !== 'cloud') throw new Error('--engine ist local oder cloud');
  setLogLevel(values.verbose ? 'debug' : 'warn');
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env */
  }
  const config = loadConfig(values.config ?? 'qbhost.config.json');
  const v = probeVoice(config.voice, engine);
  if (v.stt === 'deepgram' && !process.env[v.deepgram.keyEnv]?.trim()) {
    console.error(`❌ Deepgram-Schlüssel fehlt: ${v.deepgram.keyEnv} in .env setzen (oder --engine local)`);
    process.exit(1);
  }
  const clips = positionals.map((file) => ({ file, pcm: decodeWav(readFileSync(file)) }));
  let routes: SttRoutes | null = null;
  try {
    routes = createSttRoutes(v);
    const stt = routes.stt;
    console.log(`Route answer: ${stt.engine ?? 'unbekannt'}${v.stt === 'deepgram' ? ` (Rückfall: ${v.cloudFallback})` : ''}, ${runs} Läufe + 1 Aufwärmlauf je Datei${values.prompt ? ', mit Prompt' : ''}\n`);
    const rows: ProbeRow[] = [];
    for (const { file, pcm } of clips) {
      await probeOnce(stt, pcm, values.prompt); // warm-up: model load, connection
      const measured: ProbeRun[] = [];
      for (let i = 0; i < runs; i++) measured.push(await probeOnce(stt, pcm, values.prompt));
      rows.push(summarizeRuns(path.basename(file), durationMs(pcm), measured));
    }
    console.log(formatProbe(rows));
  } finally {
    await Promise.all(routes?.all.map((s) => s.close()) ?? []);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
