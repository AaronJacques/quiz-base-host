# Discord-Bot einrichten

## 1. Bot im Developer Portal anlegen (einmalig, ~3 Minuten)

1. <https://discord.com/developers/applications> → **New Application** → Name z.B. „Quiz-Host“.
2. Links **Bot**:
   - **Reset Token** → Token kopieren → in `.env` als `DISCORD_TOKEN=…` eintragen (Vorlage: `.env.example`). Den Token niemals committen oder teilen.
   - Unter **Privileged Gateway Intents** **Message Content Intent** einschalten. Ohne ihn sieht der Bot keine Nachrichten und kann keine Karten oder Antworten lesen.
3. Links **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`, für Sprache zusätzlich `Connect` und `Speak`
   - Generierte URL öffnen → Server auswählen → autorisieren.

## 2. Starten

```bash
npm install
npx playwright install chromium     # einmalig
npm run doctor                      # prüft Token, Claude CLI, Browser
npx qbhost discord
```

Der Bot muss auf einem Rechner laufen, der während des Spiels an ist (er steuert einen Browser, der die Host-Ansicht auf quiz-base öffnet). Standard ist ein unsichtbarer Chromium (`"browser": { "headless": true }` in `qbhost.config.json`). Zum Zuschauen `false` setzen oder `--driver orca --page <id>` verwenden.

### Optional: auf bestimmte Channels beschränken

In `qbhost.config.json`:

```json
{ "discord": { "channelIds": ["123456789012345678"], "prefix": "!quiz" } }
```

- Der Bot reagiert **nur in diesen Channels**, mit Präfix (`!quiz neu`) oder @Erwähnung (`@Quiz-Host neu`). Woanders ignoriert er alles, auch Erwähnungen.
- Ist die Liste leer, funktioniert er in jedem Channel, den er sehen kann.

Channel-ID: In Discord unter Einstellungen → Erweitert den Entwicklermodus aktivieren, dann Rechtsklick auf den Channel → „Kanal-ID kopieren“.

## 3. Ablauf einer Runde

```
Anna:  !quiz neu                    → Bot fragt: „Welches Quiz wollt ihr spielen?“
Anna:  dragon ball                  → Bot sucht auf quiz-base; passt genau eins, erstellt er die Lobby,
                                      passen mehrere, fragt er mit Nummern nach („2“)
Bot:   🎮 Neue Lobby: Dragon Ball Quiz · 🔗 Beitrittslink
                                      (Anna ist ab jetzt Spielleitung)
Alle:  Link öffnen → Namen eingeben → „Ich bin bereit!“
Ben:   !quiz ich Benjamin           → verknüpft Discord-Ben mit „Benjamin“ in quiz-base
                                      (bei gleichem Namen passiert das automatisch)
Bot:   🚀 Los geht's!  🎯 @Anna ist am Zug … (Brett mit freien Karten)
Anna:  nintendo 200                 → Bot öffnet die Karte, ❌ wenn sie schon weg ist
Bot:   ❔ Nintendo · 200: Wie lautet Luigis voller Name?  ✍️ @Anna, deine Antwort?
Anna:  Luigi Mario                  → ✅ richtig +200, 💡 Lösung, 📊 Stand
       (falsch → Abzug, 🔔 Buzzer frei → wer auf quiz-base buzzert, antwortet im Chat)
Bot:   🏁 Spiel vorbei! 🥇 …
```

### Quiz auswählen

Der Bot nimmt nie einfach irgendein Board:

- `!quiz neu` ohne Namen → er **fragt**, welches Quiz ihr spielen wollt, und zeigt beliebte Boards mit Nummern. Die nächste Nachricht der fragenden Person ist die Antwort (Name, Teil des Namens oder Nummer; `abbrechen` bricht ab).
- `!quiz neu <Name>` → er sucht mit der **Suche von quiz-base**, findet also auch Boards, die nicht in der Standardauswahl stehen:
  - genauer Titel oder genau ein Treffer → Lobby wird erstellt
  - mehrere Treffer → nummerierte Liste, Antwort mit der Nummer
  - kein Treffer → ähnliche Titel als Vorschlag („Meintest du …“), sonst neuer Versuch
- `!quiz boards <suche>` zeigt Treffer mit Nummern, danach geht `!quiz neu <Nr>`.

### Verknüpfung Discord ↔ quiz-base

- Automatisch, wenn dein Discord-Anzeigename oder Benutzername gleich deinem quiz-base-Namen ist und du im Channel etwas geschrieben hast.
- Sonst `!quiz ich <quiz-base-Name>`. Die Spielleitung kann mit `!quiz link @user <Name>` auch andere verknüpfen.
- Verknüpfungen werden pro Server gespeichert (`.qbhost/discord/`). Wer denselben Namen wieder benutzt, ist in der nächsten Runde sofort verknüpft.
- Das Spiel startet automatisch, sobald **alle** in quiz-base bereit **und** verknüpft sind. `!quiz los` erzwingt den Start.

### Karten wählen

Wer am Zug ist, schreibt die Karte einfach in den Chat. Erkannt werden u.a.:
`Nintendo 200`, `nin 200`, `nintedno 200` (Tippfehler), `200 Nintendo`, `2 200` (2. Spalte), `ich nehme Filme für 300`.
Der Bot prüft gegen das aktuelle Brett:
- schon gespielt → „❌ Nintendo 200 ist schon weg. Noch frei: …“
- gibt es nicht → „In Nintendo gibt es keine 500. Frei: …“
- nur Punkte genannt → Rückfrage nach der Kategorie
- jemand anderes ist dran → Hinweis

### Antworten

Wenn der Bot dich fragt („✍️ @Anna, deine Antwort?“), ist deine **nächste Nachricht** die Antwort. Nachrichten mit `//` am Anfang ignoriert der Bot (für Zwischenrufe).

### Regeln (Punkte) einstellen

```
!quiz regeln                      → aktuelle Regeln
!quiz regel plus 100%             → richtige Antwort = voller Fragewert
!quiz regel minus 50%             → falsche Antwort = halber Abzug  (0 = kein Abzug)
!quiz regel buzzerplus 50%        → richtige Buzzer-Antwort = halber Wert
!quiz regel buzzerminus 0         → falsche Buzzer-Antwort ohne Abzug
!quiz regel buzzer aus            → kein Buzzer nach falscher Antwort
!quiz regel zeit 30               → 30 s Antwortzeit (buzzerzeit, buzzerantwortzeit analog)
!quiz regeln reset                → Standard (quiz-base-Klassik: +100 % / −50 %)
```

Werte: `50%`, `0.5`, `1/2`, `halb`, `2x`, `nichts`. Regeln gelten pro Server und bleiben gespeichert. Während eines Spiels darf nur die Spielleitung sie ändern; sie gelten ab der nächsten Frage.

### Spielleitung

Wer die Lobby erstellt hat, und alle mit der Berechtigung „Server verwalten“:
`!quiz los` · `!quiz richtig` / `!quiz falsch` (Bewertung überstimmen) · `!quiz skip` · `!quiz nimm <Karte>` (für jemanden wählen) · `!quiz korrektur <Name> <±Punkte>` · `!quiz link @user <Name>` · `!quiz ende`.

Ist die automatische Bewertung unsicher, fragt der Bot die Spielleitung. Die Lösung bekommt sie **per DM**, damit sie im Channel nicht vor der Buzzer-Runde verraten wird. Aus demselben Grund erscheinen Begründungen zu falschen Antworten erst mit der Auflösung.

## Sprache

Der Bot kann auch im Voice-Channel moderieren und zuhören: **[VOICE.md](VOICE.md)**.

## Grenzen

- Ein Spiel gleichzeitig pro Bot-Instanz (ein Browser).
- Buzzern passiert auf quiz-base oder per Zuruf im Voice-Channel (nicht per Text-Chat).
- Audio (YouTube) spielt quiz-base bei allen Spielern synchron ab. Musik-Boards brauchen bei jedem Spieler einmal „Sound aktivieren“.
