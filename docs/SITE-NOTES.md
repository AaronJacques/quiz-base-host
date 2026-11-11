# quiz-base.de – DOM-Notizen (Stand: 11.11.2026)

Live erkundet mit Host + 2 Testspielern. Diese Datei dokumentiert, worauf `src/site/tafelquiz/probe.browser.js` sich verlässt. Ändert quiz-base das Layout: `npx qbhost probe` ausführen, mit dieser Datei vergleichen, Probe anpassen.

## Allgemein

- Next.js (App Router, Turbopack), Tailwind; Klassen sind lesbar (`from-btn-primary-from`, …), aber wir nutzen sie nur, wo es nicht anders geht.
- Backend: Supabase `brlqinfdkbeagvxmfoju.supabase.co` (REST für Boards, Realtime für Spielzustand); anonyme Auth per Cookie `sb-…-auth-token`.
- Kein Chat im Spiel. Spieler kommunizieren mit dem Host per Voice (Discord).
- Robuste Anker: `aria-label`s, `title`, `data-testid`, sichtbare Button-Texte.

## Lobby erstellen (`/create-lobby`, Client-State ohne URL-Wechsel)

1. Format-Buttons enthalten `h3` mit `Tafelquiz`, `Eagle Eye`, `Punktejagd`, `Auktion`, `Blind Ranking`.
2. `h1` = Formatname → Buttons `Öffentliches Board verwenden` / `Neues Board erstellen`.
3. Board-Liste: Karten mit `h3`-Titel, klickbarer Vorfahre (`cursor: pointer`) → Auswahl → Button `Board verwenden →`.
4. `h1` = `Board Vorschau` → Button `Lobby erstellen` (Achtung: gleicher Text im Header-Nav-Link → nur in `main` suchen).
5. URL wird `/lobby?host=true`, `h1` = `Lobby Warteraum`.

## Warteraum (Host)

- Code: `button[aria-label="Lobby-Code kopieren"]` zeigt `••••••`, bis `button[aria-label="Lobby-Code anzeigen"]` geklickt wird.
- Spieler: `button[aria-label="<Name> kicken"]`; Zeile enthält `Wartet...` bzw. Bereit-Status.
- Start-Button: Text `Warte auf Spieler (x/y bereit)` (disabled) → `Spiel starten!`.
- Spieler-Seite: `/join` → Code → Name (`input[placeholder="Dein Name"]`) → `Beitreten` → `Ich bin bereit!`.

## Spiel (Host, URL `/host`)

- Bei Musikfragen-Boards erst ein Gate: Button `Sound aktivieren` (auch bei jedem Spieler).
- Header: `aria-label`s `Punkte` (manueller Dialog), `Reihenfolge mischen`, `Spiel beenden`; bei 2 Boards Buttons `Board 1`/`Board 2` (aktiv: Klasse `from-btn-primary-from`).
- Raster: Spalten = Container, deren erstes Kind die Kategorie ist, danach `button` mit Punktetext. Beantwortet: `title="Frage wieder öffnen"`. DOM-Reihenfolge = Spalte für Spalte.
- Spielerliste: `ul[aria-label=Spieler] button` → `span[title=<Name>]`, `[data-testid=animated-score]`, Text `Am Zug` bzw. `Buzzer`.

### Offene Frage

- `section[aria-label="Aktive Frage"]`: `span` „`<n> Punkte`“, erstes `p` = Fragetext, `img` (oft `/_next/image?url=…`, manchmal `data:`-URI, manchmal kaputt), `p` „Richtige Antwort (Notiz):“ + nächstes `p` = Notiz oder „Keine Notiz hinterlegt“.
- Audio: `p` „Audio für diese Frage“, Button `Abspielen` (→ `Pause` während Wiedergabe), `Stop`, YouTube-`iframe[title]` (Titel verrät oft die Lösung), „wird für alle Spieler synchronisiert“.
- `section[aria-label=Timer]`: Zahl-Input, `Start` (läuft: `Stopp`), Presets `10 s`/`20 s`/`30 s`/`60 s`.
- `section[aria-label=Buzzer]` `p`: „<Name> ist dran, Buzzer gesperrt“ | „Warten auf Buzzer...“ (offen) | „<Name> hat gebuzzert!“ (`role=status`). Buttons `Buzzer freigeben` / `Buzzer zurücksetzen`.
- `section[aria-label="Punkte vergeben"]`: `strong` = Zielspieler (springt automatisch auf Buzzernden). Buttons `aria-label`: „`<n> Punkte an <Name>`“ (voll + halb) und „`<n/2> Punkte von <Name> abziehen`“. Anderen Spieler durch Klick in der Spielerliste wählen.
- `section[aria-label="Animation für alle"]`: `Richtig` / `Falsch` – **nur Animation, keine Punkte**.
- `Frage schließen → Nächster Spieler` – gibt den Zug automatisch weiter.

### Dialoge

- Manuelle Punkte (`[role=dialog]`): `input[aria-label="Punkte für <Name>"]`, Buttons `Hinzufügen`/`Abziehen`, `aria-label=Schließen`.
- Spiel beenden: „Spiel wirklich beenden?“ → `Abbrechen` / `Ja, beenden`.
- Ergebnis: `SPIEL VORBEI!`, `CHAMPION!`, Buttons `Nochmal spielen`, `Ergebnisse teilen`.

## Spieler-Ansicht (Tafelquiz)

- Sieht Frage + Bild, aber nie die Notiz. Buzzer: Button `BUZZER! (Leertaste)` nur wenn freigegeben, sonst „Buzzer deaktiviert“.

## Punktejagd (für später)

- Host nach Start: „Warte auf Spieler – x von y bereit – Gäste aktivieren am Handy den Ton“ → `Spiel starten`.
- Frage: `Antworten: x/y`, `Frage n/32`, Buttons `A aufdecken` … `D aufdecken`, `Auflösen` (disabled bis Antworten da), Spielerliste mit Jokern (`½`, `S`, `x2`).
- Spieler klicken Antworten selbst → Host-Aufgabe ist rein mechanisch (aufdecken, auflösen, weiter): **komplett ohne LLM automatisierbar**.
