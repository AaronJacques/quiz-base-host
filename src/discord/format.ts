import { RULES, formatRuleValue, type GameRules } from '../modes/tafelquiz/rules.ts';

export function helpText(prefix: string): string {
  const p = prefix;
  return [
    '**🎙️ Quiz-Host – Befehle** (oder mich einfach @erwähnen)',
    '',
    '**Spiel**',
    `\`${p} neu\` – neue Lobby: ich frage, welches Quiz ihr spielen wollt, und poste den Link`,
    `\`${p} neu <Name|Nr>\` – direkt mit diesem Quiz (ich suche auf quiz-base und frage nach, wenn mehrere passen)`,
    `\`${p} boards [suche]\` – öffentliche Tafelquiz-Boards anzeigen / suchen`,
    `\`${p} ich <quiz-base-Name>\` – deinen Discord-Account mit deinem Namen in quiz-base verknüpfen`,
    `\`${p} lobby\` – wer ist drin, bereit, verknüpft`,
    `\`${p} brett\` · \`${p} stand\` – freie Karten · Punktestand`,
    '',
    '**Im Spiel**: Wer am Zug ist, schreibt einfach die Karte in den Chat, z.B. `Nintendo 200`, `nin 200` oder `2 200` (2. Spalte).',
    'Wirst du nach deiner Antwort gefragt, schreib sie einfach hier rein. Nachrichten mit `//` am Anfang ignoriere ich.',
    'Buzzern geht auf quiz-base.',
    '',
    '**Sprache** (Voice-Channel)',
    `\`${p} voice\` – ich komme in deinen Voice-Channel, moderiere mit Stimme und höre zu · \`${p} voice aus\` · \`${p} wiederholen\``,
    'Dort einfach sprechen: „Sport für 200“, Antworten, „Buzzer!“, „Quizmaster, Stand“ / „Quizmaster, Hilfe“.',
    '',
    '**Regeln**',
    `\`${p} regeln\` – anzeigen · \`${p} regel <name> <wert>\` – ändern, z.B. \`${p} regel minus 0\`, \`${p} regel plus 100%\`, \`${p} regel buzzer aus\`, \`${p} regel zeit 30\` · \`${p} regeln reset\``,
    '',
    '**Spielleitung** (wer die Lobby erstellt hat, oder Server-Admins)',
    `\`${p} los\` – Start erzwingen · \`${p} richtig\` / \`${p} falsch\` / \`${p} skip\` – Antwort überstimmen / Frage überspringen`,
    `\`${p} nimm <Karte>\` – Karte für den Spieler am Zug wählen · \`${p} korrektur <Name> <±Punkte>\` · \`${p} link @user <Name>\` · \`${p} ende\``,
  ].join('\n');
}

export function rulesText(rules: GameRules, prefix: string): string {
  const lines = RULES.map((r) => `• ${r.label}: **${formatRuleValue(rules, r)}**  \`${r.names[0]}\``);
  const bonus = rules.bonusTimeSec > 0 ? [`🎙️ Solange ich im Voice-Channel moderiere: **+${rules.bonusTimeSec} s** Antwort- und Buzzerzeit.`] : [];
  return ['**📏 Regeln** (Prozent vom Fragewert)', ...lines, ...bonus, '', `Ändern: \`${prefix} regel <name> <wert>\``].join('\n');
}

export function medal(i: number): string {
  return ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
}

/** "🥇 Anna — **300**" per player, best first. Equal scores share the place (a tie gets two 🥇, the next one 🥉). */
export function rankingLines(players: { name: string; score: number }[], label: (name: string) => string = (n) => `**${n}**`): string[] {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted.map((p) => `${medal(sorted.filter((o) => o.score > p.score).length)} ${label(p.name)} — **${p.score}**`);
}
