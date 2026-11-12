import { estimateText, formatUsd, type CostEstimate } from './cost.ts';
import { languageName } from './prompts.ts';
import type { GeneratedBoard } from './schema.ts';
import { LEVELS, pointsList, totalCategories, totalQuestions, type BoardSpec } from './spec.ts';

/** Discord allows 2000 characters per message. */
const MAX_CHUNK = 1900;

export function pointsRange(spec: BoardSpec): string {
  const p = pointsList(spec);
  return p.length > 1 ? `${p[0]}–${p.at(-1)}` : `${p[0]}`;
}

/** The request as the bot/terminal confirms it before anything is generated. */
export function specLines(spec: BoardSpec, estimate: CostEstimate): string[] {
  const layout = `${spec.boards === 2 ? '2 Boards × ' : ''}${spec.categories} Kategorien × ${spec.rows} Stufen (${pointsRange(spec)} Punkte) = ${totalQuestions(spec)} Fragen`;
  return [
    `Thema: **${spec.topic}**${spec.themes.length ? ` · Themen: ${spec.themes.join(', ')}` : ''}`,
    `Aufbau: ${layout}`,
    `Niveau: ${LEVELS[spec.level].label} · Sprache: ${languageName(spec.language)} · Multiple Choice: ${Math.round(spec.mcShare * 100)} %`,
    `Name: ${spec.name ?? '(schlägt Claude vor)'} · wird als privater Entwurf gespeichert`,
    `Kosten: ${estimateText(estimate)}`,
  ];
}

/** Safe for a public channel: name, categories and points – no questions, no solutions. */
export function publicPreview(board: GeneratedBoard): string {
  const s = board.spec;
  const lines = [`📋 **${board.title}** · ${totalCategories(s)} Kategorien × ${s.rows} Stufen (${pointsRange(s)} Punkte) · ${LEVELS[s.level].label}`];
  for (const b of s.boards === 2 ? [1, 2] : [1]) {
    const cats = board.categories.filter((c) => c.board === b).map((c) => c.name);
    const label = s.boards === 2 ? `Board ${b}${board.supercategories[b - 1] ? ` (${board.supercategories[b - 1]})` : ''}` : board.supercategories[0] ?? 'Kategorien';
    lines.push(`**${label}:** ${cats.join(' · ')}`);
  }
  return lines.join('\n');
}

/** Everything including solutions – only for a DM to the creator or the terminal. Split into chat-sized chunks. */
export function fullPreview(board: GeneratedBoard): string[] {
  const lines: string[] = [`🔐 **${board.title}** – Vorschau mit Lösungen (nicht weitergeben)`];
  if (board.description) lines.push(`_${board.description}_`);
  for (const c of board.categories) {
    lines.push('', `**${c.name}**${board.spec.boards === 2 ? ` (Board ${c.board})` : ''}`);
    for (const q of c.questions) {
      lines.push(`${q.points} · ${q.question}`);
      if (q.options) lines.push(`   MC: ${q.options.map((o, i) => (i === q.correct ? `**${o}** ✓` : o)).join(' | ')}`);
      else lines.push(`   → **${q.answer}**${q.variants.length ? ` (auch: ${q.variants.join(', ')})` : ''}`);
    }
  }
  if (board.reviewed.length) lines.push('', `🔎 Prüfrunde: ${board.reviewed.length} Frage(n) korrigiert oder ersetzt.`);
  if (board.warnings.length) lines.push('', '⚠️ Noch offen (prüf diese Fragen selbst):', ...board.warnings.map((w) => `• ${w}`));
  lines.push('', `Erzeugt mit ${board.model}: ${board.calls} Aufrufe, ${formatUsd(board.costUsd)}.`);
  return chunk(lines, MAX_CHUNK);
}

export function chunk(lines: string[], max = MAX_CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
