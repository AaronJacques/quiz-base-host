## Was ändert dieser PR?

<!-- Kurz: Problem und Lösung. Bei Verhaltensänderungen auch, was Nutzer merken. -->

## Art der Änderung

- [ ] Fehlerbehebung
- [ ] Neue Funktion
- [ ] Doku
- [ ] Refactoring ohne Verhaltensänderung

## Checkliste

- [ ] `npm run typecheck` ist grün
- [ ] `npm test` ist grün
- [ ] Neue Logik hat Tests (Spielablauf: `FakeTafelquizPage`, Discord: `FakeGateway`)
- [ ] DOM-Selektoren nur in `src/site/**/probe.browser.js` (falls betroffen)
- [ ] Neue Einstellungen stehen in `src/config.ts` und in `docs/CONFIG.md` (falls betroffen)
- [ ] Keine Lösung kann vor `host:reveal` in einen öffentlichen Kanal gelangen (falls betroffen)
- [ ] Keine Secrets, Discord-IDs oder persönlichen Pfade im Diff
- [ ] `CHANGELOG.md` unter „Unreleased“ ergänzt (bei sichtbaren Änderungen)
- [ ] Live-Tests (falls gemacht): alle Test-Lobbys geschlossen

## Live getestet?

<!-- Falls ja: Board, Kanal, Ergebnis. Falls nein: warum nicht. -->
