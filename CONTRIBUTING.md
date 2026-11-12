# Mitmachen

Danke, dass du qbhost verbessern willst! Kleine Fixes, Doku und Tests sind immer willkommen. Bei größeren Änderungen bitte vorher ein Issue aufmachen, damit wir die Richtung abstimmen können.

## Entwicklungsumgebung

Voraussetzung: **Node ≥ 22**.

```bash
git clone https://github.com/AaronJacques/quiz-base-host.git
cd quiz-base-host
npm ci
npx playwright install chromium   # nur für Läufe gegen quiz-base nötig, nicht für die Tests
```

Die Anleitung für Nutzer mit Discord, Claude und Sprache steht in [docs/INSTALL.md](docs/INSTALL.md).

## Pflichtchecks vor jedem Commit

```bash
npm run typecheck
npm test
```

Beide müssen grün sein. Die Tests laufen ohne Netzwerk, ohne Discord-Token und ohne Claude-Zugang. Die CI führt dieselben Schritte auf jedem Pull Request aus.

## Architektur und Regeln

Vor der ersten Änderung bitte lesen:

- [AGENTS.md](AGENTS.md): die Regeln für Änderungen. Die wichtigsten:
  - DOM-Selektoren nur in `src/site/**/probe.browser.js`.
  - Kanäle (Terminal, Web, Discord) sprechen nur über den EventBus.
  - Keine Lösung darf vor `host:reveal` in einen öffentlichen Kanal gelangen.
  - LLM-Aufrufe nur über den Judge, nie im Polling-Pfad.
  - Neue Einstellungen in `src/config.ts`, neue Spielregeln zusätzlich in `RULES`.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Schichten und Abhängigkeiten.
- [docs/SITE-NOTES.md](docs/SITE-NOTES.md): was wir über die Oberfläche von quiz-base wissen.

Neue Logik braucht Tests. Spielabläufe testest du gegen `FakeTafelquizPage` (`test/fake-page.ts`), Discord-Abläufe gegen das `FakeGateway`.

**Sprache:** UI, Logs, Doku und Discord-Texte sind auf Deutsch. Code, Bezeichner und Code-Kommentare sind auf Englisch. Pull Requests dürfen auf Deutsch oder Englisch beschrieben werden.

## Live-Tests gegen quiz-base.de

Live-Tests laufen auf einer echten, fremden Plattform. Bitte:

- **Schließe jede Test-Lobby** und beende jedes Spiel, das du gestartet hast.
- Nutze für jeden Testspieler einen **eigenen Browser-Kontext** (Playwright `browser.newContext()`), sonst teilen sie sich die anonyme Session.
- Keine direkten Aufrufe der Supabase-API. Wir bedienen nur die normale Oberfläche.
- Keine Secrets (Discord-Token, API-Keys) in Code, Beispielen, Logs oder Screenshots.

## Pull Requests

1. Branch von `main` anlegen.
2. Änderung mit Tests, Doku und Eintrag in `CHANGELOG.md` unter „Unreleased“.
3. Die Checkliste in der [PR-Vorlage](.github/PULL_REQUEST_TEMPLATE.md) abhaken.
4. Ein PR sollte ein Thema haben. Commit-Nachrichten kurz und auf Deutsch oder Englisch, z.B. `Voice: Antworten nur mit Schlüsselwort`.

## Sicherheitsprobleme

Sicherheitslücken bitte **nicht** als öffentliches Issue melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Verhaltensregeln

Es gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md).
