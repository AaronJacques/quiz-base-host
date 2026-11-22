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

Der Bot muss auf einem Rechner laufen, der während des Spiels an ist (er steuert einen Browser, der die Host-Ansicht auf quiz-base öffnet). Standard ist ein sichtbarer Chromium. Auf einem Server oder wenn das Fenster stört, `"browser": { "headless": true }` in `qbhost.config.json` setzen. Zum Zuschauen in Orca: `--driver orca --page <id>`.

### Optional: auf bestimmte Channels beschränken

In `qbhost.config.json`:

```json
{ "discord": { "channelIds": ["123456789012345678"], "prefix": "!quiz" } }
```

- Der Bot reagiert **nur in diesen Channels**, mit Präfix (`!quiz neu`) oder @Erwähnung (`@Quiz-Host neu`). Woanders ignoriert er alles, auch Erwähnungen.
- Ist die Liste leer, funktioniert er in jedem Channel, den er sehen kann.

Channel-ID: In Discord unter Einstellungen → Erweitert den Entwicklermodus aktivieren, dann Rechtsklick auf den Channel → „Kanal-ID kopieren“.

### quiz-base-Anmeldung: Status und DM

Für eigene Boards ist der Bot bei quiz-base angemeldet ([DEPLOY.md](DEPLOY.md#anmeldung-hält)). Er prüft die Anmeldung im Leerlauf (kein Spiel, keine Board-Anlage, nicht im Voice-Channel), 120 s nach dem Start, 60 s nach jedem Spiel und alle 6 h; nach einem unklaren Ergebnis noch einmal nach 15 bzw. 30 min. Ein Spiel, eine Board-Anlage oder der Beitritt in einen Voice-Channel unterbricht eine laufende Prüfung sofort, der Prüf-Browser schließt dann in wenigen Sekunden (Spiel und Board warten höchstens 30 s auf das Profil). Solange der Bot im Voice-Channel ist, prüft er nicht (Spracherkennung und Browser zusammen wären auf kleinen Servern zu viel). Ohne Spiel verlässt er den Voice-Channel nach 20 min Stille von selbst, danach läuft der Wächter wieder.

- **`!quiz status`** ohne laufendes Spiel zeigt zusätzlich eine Zeile `🔐 quiz-base-Anmeldung: …` (angemeldet / abgemeldet seit … → Befehl zum Neuanmelden / noch nicht geprüft). Während eines Spiels bleibt `!quiz status` wie bisher (Lobby bzw. Punktestand).
- **DM bei Verlust:** Geht die Anmeldung verloren, bekommen die Besitzer des Bots **eine** DM mit Zeit, Quelle, dem Befehl zum Neuanmelden (`account.loginCommand`) und, falls bekannt, dem Fehlercode der Seite. Sie enthält nie Fragen, Lösungen, Board-Namen oder Links. Eine Verlust-DM gibt es einmal je Verlust, auch über Neustarts hinweg (`notifiedLostAt` in der Status-Datei). Ist die Anmeldung danach wieder da, kommt eine kurze DM „✅ quiz-base-Anmeldung wieder da“, aber nur, wenn vorher die Verlust-DM angekommen ist. „Wieder angemeldet“ gilt erst nach einer Bestätigung: Prüfung des Benutzermenüs, Lobby mit eigenem Board, gespeichertes Board oder Anmeldung mit Passwort. Eine bloße Sitzungserneuerung der Seite in einem Spiel-Browser (das kann auch eine anonyme Sitzung sein) ändert nichts. So wechseln Verlust- und „wieder da“-DMs nicht hin und her.
- **Empfänger:** `discord.ownerIds` in `qbhost.config.json`, sonst der Besitzer der Discord-App aus dem Developer Portal (bei einem Team alle Mitglieder). Ohne Empfänger steht einmal `Keine Besitzer-ID für Betriebsmeldungen – discord.ownerIds setzen` im Log.
  ```json
  { "discord": { "ownerIds": ["123456789012345678"] } }
  ```
  Die eigene ID: Entwicklermodus an, Rechtsklick auf den eigenen Namen → „Benutzer-ID kopieren“.
- **DM kommt nicht an** (z.B. DMs gesperrt): Der Bot läuft normal weiter. Der Verlust steht im Log (Warnung), in `!quiz status` und in `qbhost doctor`. Der Bot versucht die DM bis zu dreimal im Abstand von 60 min und dann beim nächsten Start noch einmal, solange die Anmeldung verloren ist und noch keine Verlust-DM ankam.
- Mit einem eigenen Board bei verlorener Anmeldung (`!quiz neu <eigenes Board>`) sagt der Bot das vorher und versucht es trotzdem. Zeigt quiz-base dann kein „Eigenes Board verwenden“, entscheidet das Benutzermenü: Steht dort „abgemeldet“, kommt „⚠️ Lobby konnte nicht erstellt werden: … nicht bei quiz-base angemeldet. Neu anmelden: …“ mit dem Befehl (und, falls noch nicht geschehen, die DM). Steht dort „angemeldet“ oder ist es unklar, kommt „⚠️ Lobby konnte nicht erstellt werden: „Eigenes Board verwenden“ fehlt, … Gleich noch einmal versuchen.“ ohne Login-Hinweis und ohne DM; der Anmeldestand bleibt unverändert.

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

Der Bot nimmt nie einfach irgendein Board. Eine Lobby öffnet nur `!quiz neu` (`!quiz erstellen` schreibt ein neues Board, siehe [Abschnitt 4](#4-eigene-boards-von-claude-schreiben-lassen)):

- `!quiz neu` ohne Namen → er **fragt**, welches Quiz ihr spielen wollt, und zeigt beliebte Boards mit Nummern. Die nächste Nachricht der fragenden Person ist die Antwort (Name, Teil des Namens oder Nummer; `abbrechen` bricht ab).
- `!quiz neu <Name>` → zuerst unter den Boards, die der Bot selbst angelegt hat (eigener quiz-base-Account), sonst mit der **Suche von quiz-base**, findet also auch Boards, die nicht in der Standardauswahl stehen:
  - genauer Titel oder genau ein Treffer → Lobby wird erstellt
  - mehrere Treffer → nummerierte Liste, Antwort mit der Nummer
  - kein Treffer → ähnliche Titel als Vorschlag („Meintest du …“), sonst neuer Versuch
- `!quiz boards <suche>` zeigt Treffer mit Nummern, danach geht `!quiz neu <Nr>`.

### Verknüpfung Discord ↔ quiz-base

- Automatisch, wenn dein Discord-Anzeigename oder Benutzername gleich deinem quiz-base-Namen ist und du im Channel etwas geschrieben hast.
- Sonst `!quiz ich <quiz-base-Name>`. Die Spielleitung kann mit `!quiz link @user <Name>` auch andere verknüpfen.
- Verknüpfungen werden pro Server gespeichert (`.qbhost/discord/`). Wer denselben Namen wieder benutzt, ist in der nächsten Runde sofort verknüpft.
- Das Spiel startet automatisch, sobald **alle** in quiz-base bereit **und** verknüpft sind (ab `game.minPlayers`, Standard 2). `!quiz los` erzwingt den Start, auch allein.

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

- **Multiple Choice:** Der Buchstabe reicht (`D`, `D)`, `Antwort D`), ebenso der Text der Option. Das wertet der Bot ohne LLM.
- **Formeln** dürfen in Tastatur-Schreibweise kommen: `a^2+b^2=c^2` für a² + b² = c², `E=mc^2`, `U=R*I`, `sqrt(2)` oder `Wurzel aus 2` für √2, `pi` für π, `1/2` für 0,5. Eine andere Formel (z.B. `v=t/s` statt v = s / t) zählt nicht.

### Regeln (Punkte) einstellen

```
!quiz regeln                      → aktuelle Regeln
!quiz regel plus 100%             → richtige Antwort = voller Fragewert
!quiz regel minus 50%             → falsche Antwort = halber Abzug  (0 = kein Abzug)
!quiz regel buzzerplus 50%        → richtige Buzzer-Antwort = halber Wert
!quiz regel buzzerminus 0         → falsche Buzzer-Antwort ohne Abzug
!quiz regel buzzer aus            → kein Buzzer nach falscher Antwort
!quiz regel zeit 30               → 30 s Antwortzeit (buzzerzeit, buzzerantwortzeit analog)
!quiz regel erinnerung 120        → erste Erinnerung „du bist dran“ nach 120 s (Standard 90, „aus“ = keine)
!quiz regel erinnerungstakt aus   → nur eine Erinnerung pro Zug (Standard: weitere alle 300 s, nur im Chat)
!quiz regel kartenhinweis aus     → kein „Welche Karte?“ bei gesprochener Kartenwahl
!quiz regel pause 2               → 2 s Pause nach richtiger Antwort, bis die Karte schließt (Standard 1,5; 0 bis 30, auch `1,5`)
!quiz regeln reset                → Standard (quiz-base-Klassik: +100 % / −50 %)
```

Werte: `50%`, `0.5`, `1/2`, `halb`, `2x`, `nichts`. Regeln gelten pro Server und bleiben gespeichert. Während eines Spiels darf nur die Spielleitung sie ändern; sie gelten ab der nächsten Frage, die Erinnerungszeiten (`erinnerung`, `erinnerungstakt`) auch im laufenden Zug nach spätestens 30 s. `regeln reset` setzt nur diese Punkte- und Zeitregeln zurück – Autostart und die Sprach-Zusatzzeit bleiben, wie der Bot sie für das Spiel gesetzt hat.

### Spielleitung

Wer die Lobby erstellt hat, und alle mit der Berechtigung „Server verwalten“ **auf dem Server, auf dem das Spiel läuft** (Admin-Rechte auf einem anderen Server zählen nicht):
`!quiz los` · `!quiz richtig` / `!quiz falsch` (Bewertung überstimmen) · `!quiz skip` · `!quiz nimm <Karte>` (für jemanden wählen) · `!quiz korrektur <Name> <±Punkte>` · `!quiz link @user <Name>` · `!quiz ende`.

**Überstimmen** mit `!quiz richtig` / `!quiz falsch`:
- während jemand antworten soll oder der Bot dich bei einer unsicheren Antwort fragt → ersetzt die Bewertung;
- nach der Bewertung, bis die nächste Karte gewählt ist (Buzzer-Runde, Auflösung, Kartenwahl) → **korrigiert die letzte Bewertung**: die Punkte werden über die normale Punktekorrektur angepasst (z.B. „zwölf“ falsch −50 → richtig: +150, also +100 insgesamt). Wird eine Antwort so richtig, endet eine laufende Buzzer-Runde;
- während der Bot noch bewertet, oder wenn es nichts zu überstimmen gibt, sagt er das, statt 👍 zu geben. Dann hilft `!quiz korrektur`.

`!quiz skip` überspringt die Frage ohne Punkte, solange eine Antwort erwartet wird, und beendet sonst eine laufende Buzzer-Runde (Lösung kommt sofort).

`!quiz ende` mitten in einer Frage beendet das Spiel ohne Bewertung der offenen Antwort: kein Abzug, keine Klicks mehr auf der Seite.

Ist die automatische Bewertung unsicher, fragt der Bot die Spielleitung. Die Lösung bekommt sie **per DM**, damit sie im Channel nicht vor der Buzzer-Runde verraten wird. Aus demselben Grund erscheinen Begründungen zu falschen Antworten erst mit der Auflösung.

## 4. Eigene Boards von Claude schreiben lassen

`!quiz erstellen <Thema> [Optionen]` lässt Claude (Standard: Sonnet) ein komplettes Tafelquiz schreiben und legt es auf quiz-base als **eigenes Board** an. Danach spielt ihr es wie jedes andere: `!quiz neu <Name>`.

**Einmalig:** Auf dem Rechner des Bots `npx qbhost login` ausführen. Es öffnet sich ein Browserfenster, du meldest dich selbst bei quiz-base an (eigene Boards brauchen einen Account). qbhost gibt nichts ein und liest nichts mit, das Profil bleibt gespeichert.

```
Admin: !quiz erstellen Star Wars 5x4 profi       → Bot zeigt Aufbau, Niveau und geschätzte Kosten
Admin: ja                                        → Claude schreibt das Board, eine Prüfrunde checkt die Fakten (1–3 Min.)
Bot:   📋 Star Wars für Kenner · 5 Kategorien × 4 Stufen (100–400) · Kategorien: …
       📬 Fragen und Lösungen hab ich dir per DM geschickt.
Admin: anlegen                                   → Bot trägt das Board im Board-Editor von quiz-base ein (ca. 1 Min.)
Bot:   ✅ Star Wars für Kenner ist auf quiz-base angelegt (privater Entwurf). Mit !quiz neu Star Wars für Kenner spielen.
       📬 Den Link hab ich dir per DM geschickt. Veröffentlichen kannst du selbst unter „Meine Boards“ auf quiz-base.
```

Boards landen auf quiz-base immer als **privater Entwurf** unter „Meine Boards“; quiz-base fragt beim Speichern keine Sichtbarkeit ab. Wer ein Board der Community zeigen will, klickt dort selbst auf „Veröffentlichen“ (quiz-base prüft es dann). Der Bot reicht nie etwas ein. Ein Board wieder löschen: dort „Löschen“ oder im Terminal `npx qbhost board-delete "<Name>"`.

**Optionen** (in beliebiger Reihenfolge, Rest = Thema):

| Option | Beispiel | Standard |
|---|---|---|
| Kategorien × Stufen | `5x4`, `6 kategorien`, `5 stufen` | 4 × 4 (100–400 Punkte), max. 8 × 10 |
| Punkteschritt | `schritt 200` (200, 400, …) | 100 |
| Zwei Boards | `2 boards` (jedes Board eigene Kategorien) | 1 |
| Niveau | `kinder` (8–10), `schule` (Klasse 5–7), `oberstufe`, `kneipe`, `profi` | `kneipe` |
| Sprache | `sprache en`, `englisch` | Deutsch |
| Multiple Choice | `mc 25%`, `mc` (= 25 %) | 0 % |
| Name | `; name: Krieg der Sterne` | Vorschlag von Claude |
| Themenbereiche | `; themen: Jedi, Raumschiffe, Planeten` (je einer pro Kategorie) | Claude wählt |
| Neuer Entwurf | `nochmal` | – |

**Wer darf?** Server-Admins („Server verwalten“) **auf dem Server, auf dem der Befehl geschrieben wird**, und die Discord-User-IDs in `boardgen.creatorIds`. Die Channel-Beschränkung `discord.channelIds` gilt auch hier. Bestätigen (`ja`, `anlegen`, `nochmal`, `abbrechen`) kann nur, wer gefragt hat.

**Geheimhaltung:** Im Channel stehen nur Name, Kategorien und Punkte. Fragen, Lösungen und den Link zum Board (der Editor von quiz-base zeigt die Lösungen) bekommt nur die anfragende Person **per DM** (DMs von Server-Mitgliedern müssen erlaubt sein). Erzeugte Boards liegen mit Lösungen lokal in `.qbhost/boards/`.

**Kosten:** Vor dem Erzeugen nennt der Bot die Schätzung, nach dem Anlegen die gemessenen Kosten. Über das Claude-Abo (`claude-cli`) fallen keine Zusatzkosten an; über die API kostet ein 4×4-Board ca. $0.10.

**Kein Board doppelt:** Kommt dieselbe Anfrage noch einmal, verweist der Bot auf das vorhandene Board (oder bietet den vorhandenen Entwurf ohne neue Kosten an). `nochmal` erzwingt einen neuen Entwurf. Doppeltes `anlegen` legt nur einmal an.

**Nicht während eines Spiels:** Spiel und Board-Editor nutzen dasselbe eingeloggte Browser-Profil. Während ein Spiel läuft, legt der Bot keine Boards an, und während er anlegt, startet `!quiz neu` keine Lobby.

Wie gut die Fragen werden: Claude hält sich an feste Regeln (eine eindeutige, kurze Lösung, keine sich ändernden Fakten, Schwierigkeit steigt mit den Punkten, keine Dubletten). qbhost prüft das zusätzlich im Code, und eine zweite Prüfrunde ersetzt falsche oder mehrdeutige Fragen. Lies die DM-Vorschau trotzdem kurz, bevor du `anlegen` schreibst. Im Spiel kann die Spielleitung wie immer mit `!quiz richtig`/`falsch` überstimmen.

## Sprache

Der Bot kann auch im Voice-Channel moderieren und zuhören: **[VOICE.md](VOICE.md)**. `!quiz voice` holt ihn in deinen Voice-Channel, `!quiz voice aus` (oder „Quizmaster, tschüss“) schickt ihn hinaus – während eines Spiels nur die Spielleitung, das Spiel läuft dann im Chat weiter. In einen anderen Voice-Channel holt ihn während eines Spiels ebenfalls nur die Spielleitung. Nach Spielende verabschiedet er sich und geht von selbst (`voice.leaveOnGameEnd`).

## Grenzen

- Ein Spiel gleichzeitig pro Bot-Instanz (ein Browser). Es gehört zum Server, auf dem es erstellt wurde: Andere Server sehen es nicht, können es nicht steuern, keine neue Lobby öffnen und den Bot nicht aus dessen Voice-Channel holen („Ich hoste gerade ein Spiel auf einem anderen Server“).
- Bei Gleichstand teilen sich Spieler den Platz in der Rangliste (zweimal 🥇).
- Buzzern passiert auf quiz-base oder per Zuruf im Voice-Channel (nicht per Text-Chat).
- Audio (YouTube) spielt quiz-base bei allen Spielern synchron ab. Musik-Boards brauchen bei jedem Spieler einmal „Sound aktivieren“.
