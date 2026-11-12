import readline from 'node:readline';
import type { EventBus } from '../core/events.ts';
import type { Channel } from './channel.ts';

const HELP = `Befehle:
  start                 Spiel starten (wenn alle bereit)
  r | richtig           aktuelle Antwort als richtig werten
  f | falsch            aktuelle Antwort als falsch werten
  skip                  Frage ohne Punkte schließen
  pick <spalte> <zeile> Frage für den Spieler am Zug öffnen (1-basiert)
  antwort <text>        Antwort für den aktuellen Spieler eingeben (z.B. per Voice gehört)
  punkte <name> <±n>    Punkte manuell korrigieren
  hilfe                 diese Hilfe`;

/** Operator console: the human (or a supervising Claude session) can always step in. */
export class TerminalChannel implements Channel {
  readonly name = 'terminal';
  private rl?: readline.Interface;

  async start(bus: EventBus): Promise<void> {
    bus.on('host:say', ({ text }) => this.print(text));
    bus.on('host:status', ({ message }) => this.print(`· ${message}`));
    bus.on('host:question', (q) => this.print(`\n❔ [${q.category} ${q.points}] ${q.text}${q.hasImage ? ' 🖼' : ''}${q.hasAudio ? ' 🎵' : ''}`));
    bus.on('host:game-over', () => this.print('\nSpiel beendet. Ctrl+C zum Beenden.'));
    // The operator console is private: questions to the game leader come with the solution.
    bus.on('host:notice', (n) => {
      if (n.kind === 'operator-needed' && n.detail) this.print(`❓ ${n.detail}`);
    });

    if (!process.stdin.isTTY && process.env.QBHOST_STDIN !== '1') return;
    this.rl = readline.createInterface({ input: process.stdin });
    this.rl.on('line', (line) => {
      const [cmd = '', ...args] = line.trim().split(/\s+/);
      const command = cmd.toLowerCase();
      if (!command) return;
      if (command === 'hilfe' || command === 'help') return this.print(HELP);
      if (command === 'pick' && args.length >= 2) {
        bus.emit('player:pick', { player: '@operator', col: Number(args[0]) - 1, row: Number(args[1]) - 1 });
        return;
      }
      if (command === 'antwort' || command === 'answer') {
        bus.emit('player:answer', { player: '@operator', answer: args.join(' ') });
        return;
      }
      bus.emit('operator:command', { command: command === 'richtig' ? 'r' : command === 'falsch' ? 'f' : command, args });
    });
    this.print('Operator-Konsole bereit – "hilfe" für Befehle.');
  }

  private print(s: string): void {
    process.stdout.write(s + '\n');
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
