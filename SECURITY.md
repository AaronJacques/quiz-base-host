# Sicherheit

## Sicherheitsproblem melden

Bitte melde Sicherheitsprobleme **nicht** in einem öffentlichen Issue. Nutze stattdessen das **Private Vulnerability Reporting** von GitHub:

1. Repo → **Security** → **Report a vulnerability**
2. Beschreibe das Problem, die Schritte zum Auslösen und die betroffene Version oder den Commit.

Das Projekt wird von einer Person in der Freizeit gepflegt. Bestätigte Probleme werden so bald wie möglich behoben. Nach der Korrektur kannst du auf Wunsch genannt werden.

Bitte veröffentliche Details erst, wenn eine Korrektur verfügbar ist.

## Was als Sicherheitsproblem zählt

Besonders wichtig sind:

- **Lösungs-Leaks:** Eine Lösung, Notiz, Bild-URL oder LLM-Begründung erscheint vor der Auflösung in einem öffentlichen Kanal (Discord-Channel, Voice-Channel, Spieler-Pult). Das ist ein Fehler in der Spielregel, den wir als Sicherheitsproblem behandeln.
- **Token-Leaks:** `DISCORD_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` oder ein anderes Zugangsgeheimnis landet in Logs, Antworten des Bots, Fehlermeldungen oder im Repo.
- **Unbefugter Zugriff:** Der Bot oder das Spieler-Pult lässt sich von Personen steuern, die dafür keine Berechtigung haben, z.B. Spielleitungs-Befehle ohne Rechte in Discord.
- **Ungewollte Netzwerk-Exposition:** Dienste wie das Spieler-Pult (Standard: `companion.host` = `0.0.0.0`) sind aus dem Netz erreichbar, obwohl der Nutzer das nicht wollte.
- **Abhängigkeiten:** Eine bekannte Schwachstelle in einer direkten Abhängigkeit, die qbhost tatsächlich nutzt.

Keine Sicherheitsprobleme im engeren Sinn, aber trotzdem willkommen als normales Issue: fehlende Rate-Limits gegen quiz-base selbst, Verhalten der Bewertung bei Fehlurteilen, Layout-Änderungen auf quiz-base.de.

## Eigene Sicherheit

- Secrets gehören nur in `.env` (gitignored). Nicht in `qbhost.config.json` und nicht in Issues oder Logs einfügen. Die Ausgabe von `npx qbhost doctor` ist ohne Token sicher zu teilen.
- Der Bot braucht im Discord-Developer-Portal nur die Rechte aus [docs/DISCORD.md](docs/DISCORD.md).
- Wer das Spieler-Pult oder den Bot aus einem öffentlichen Netz erreichbar macht, sollte `companion.host` auf `127.0.0.1` setzen oder die Port-Freigabe absichern.
