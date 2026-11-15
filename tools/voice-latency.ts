// Evaluates the bot's `⏱` latency lines (see docs/VOICE.md "Latenz messen"):
//   npx tsx tools/voice-latency.ts < .qbhost/voice-e2e.log
//   ssh quizmaster-vps 'docker compose -f /opt/quizmaster/app/deploy/compose.yml logs --no-color bot' | npx tsx tools/voice-latency.ts
// Prints p50/p90 per step and engine. Other log lines (and `⏱ bilanz`) are ignored.
import { pathToFileURL } from 'node:url';
import { percentile } from '../src/voice/latency.ts';

/** One `⏱` line: its kind (erkennung, ansage, reaktion) and its key=value fields. */
export interface LatencySample {
  kind: string;
  fields: Record<string, string>;
}

export interface LatencyRow {
  /** e.g. `erkennung.stt`, `reaktion.gesamt`. */
  step: string;
  engine: string;
  n: number;
  p50: number;
  p90: number;
}

/** Fields that are durations in ms, per kind – in this order in the table. */
const STEPS: Record<string, string[]> = {
  erkennung: ['audio', 'stt'],
  ansage: ['tts', 'warte'],
  reaktion: ['gesamt', 'pause', 'stt', 'logik', 'tts', 'start'],
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function parseLatency(text: string): LatencySample[] {
  const out: LatencySample[] = [];
  for (const raw of text.split('\n')) {
    // Bound to the logger's format ("12:00:00 [voice] ⏱ …", maybe behind a `docker compose logs` prefix), CRLF tolerated.
    const m = raw.replace(ANSI, '').replace(/\r$/, '').match(/(?:^|\s)\d{1,2}:\d{2}:\d{2} \[voice\] ⏱ (\w+) (.*)$/);
    if (!m || !STEPS[m[1]!]) continue;
    const fields: Record<string, string> = {};
    for (const kv of m[2]!.trim().split(/\s+/)) {
      const i = kv.indexOf('=');
      if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ kind: m[1]!, fields });
  }
  return out;
}

/** "412ms" or "412" → 412; anything else → NaN. */
function msValue(v: string | undefined): number {
  const m = v?.match(/^(\d+(?:\.\d+)?)(ms)?$/);
  return m ? Number(m[1]) : NaN;
}

export function summarize(samples: LatencySample[]): LatencyRow[] {
  const groups = new Map<string, { step: string; engine: string; values: number[] }>();
  for (const s of samples) {
    const engine = s.fields.engine ?? 'alle';
    for (const f of STEPS[s.kind] ?? []) {
      const v = msValue(s.fields[f]);
      if (Number.isNaN(v)) continue;
      const step = `${s.kind}.${f}`;
      const key = `${step}\u0000${engine}`;
      const g = groups.get(key) ?? { step, engine, values: [] };
      g.values.push(v);
      groups.set(key, g);
    }
  }
  const order = Object.entries(STEPS).flatMap(([k, fs]) => fs.map((f) => `${k}.${f}`));
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step) || a.engine.localeCompare(b.engine))
    .map((g) => ({ step: g.step, engine: g.engine, n: g.values.length, p50: percentile(g.values, 50), p90: percentile(g.values, 90) }));
}

export function formatReport(samples: LatencySample[]): string {
  const rows = summarize(samples);
  if (!rows.length) return 'Keine ⏱-Zeilen gefunden (voice.latencyLog an? Log-Ebene mindestens info?).';
  const table = [['Schritt', 'Engine', 'n', 'p50', 'p90'], ...rows.map((r) => [r.step, r.engine, String(r.n), `${Math.round(r.p50)} ms`, `${Math.round(r.p90)} ms`])];
  const width = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  const lines = table.map((r) => r.map((c, i) => (i >= 2 ? c.padStart(width[i]!) : c.padEnd(width[i]!))).join('  ').trimEnd());
  lines.splice(1, 0, width.map((w) => '-'.repeat(w)).join('  '));
  const count = (kind: string, field: string) => samples.filter((s) => s.kind === kind && s.fields[field] === 'ja').length;
  lines.push('', `Rückfälle: ${count('erkennung', 'rueckfall')}, TTS aus dem Cache: ${count('ansage', 'cache')}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  process.stdout.write(formatReport(parseLatency(Buffer.concat(chunks).toString('utf8'))) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
