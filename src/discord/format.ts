import { RULES, formatRuleValue, type GameRules } from '../modes/tafelquiz/rules.ts';

export function helpText(prefix: string): string {
  const p = prefix;
  return [
    '**🎙️ Quiz-Host – Befehle** (oder mich einfach @erwähnen)',
    '',
    '**Spiel**',
    `\`${p} boards [suche]\` – öffentliche Tafelquiz-Boards anzeigen`,
    `\`${p} neu <Nr|Titel>\` – neue Lobby erstellen, ich poste den Link`,
    `\`${p} ich <quiz-base-Name>\` – deinen Discord-Account mit deinem Namen in quiz-base verknüpfen`,
    `\`${p} lobby\` – wer ist drin, bereit, verknüpft`,
    `\`${p} brett\` · \`${p} stand\` – freie Karten · Punktestand`,
    '',
    '**Im Spiel**: Wer am Zug ist, schreibt einfach die Karte in den Chat, z.B. `Nintendo 200`, `nin 200` oder `2 200` (2. Spalte).',
    'Wirst du nach deiner Antwort gefragt, schreib sie einfach hier rein. Nachrichten mit `//` am Anfang ignoriere ich.',
    'Buzzern geht auf quiz-base.',
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
  return ['**📏 Regeln** (Prozent vom Fragewert)', ...lines, '', `Ändern: \`${prefix} regel <name> <wert>\``].join('\n');
}

export function medal(i: number): string {
  return ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
}
