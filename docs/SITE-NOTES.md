# quiz-base.de – DOM-Notizen (Stand: 12.11.2026)

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
   - Ohne Suche zeigt quiz-base nur eine **Auswahl (~40 Boards)**. Viele Boards (z.B. „Dragon Ball Quiz“, „One Piece v1.0“) erscheinen erst über das Suchfeld `input[placeholder="Nach Boards suchen..."]`: serverseitig, entprellt (~1–2 s), durchsucht auch Beschreibungen, liefert max. ~35 Treffer. Wert per React-Setter + `input`-Event setzen.
   - Sortier-Buttons `Neueste` / `Meist gespielt` / `Beste Bewertung`; die `Mehr anzeigen`-Buttons klappen nur Beschreibungen auf (keine Paginierung).
4. `h1` = `Board Vorschau` → Button `Lobby erstellen` (Achtung: gleicher Text im Header-Nav-Link → nur in `main` suchen).
5. URL wird `/lobby?host=true`, `h1` = `Lobby Warteraum`.

## Warteraum (Host)

- Code: `button[aria-label="Lobby-Code kopieren"]` zeigt `••••••`, bis `button[aria-label="Lobby-Code anzeigen"]` geklickt wird.
- Spieler: `button[aria-label="<Name> kicken"]`; Zeile enthält `Wartet...` bzw. Bereit-Status.
- Start-Button: Text `Warte auf Spieler (x/y bereit)` (disabled) → `Spiel starten!`.
- Spieler-Seite: `/join` → Code → Name (`input[placeholder="Dein Name"]`) → `Beitreten` → `Ich bin bereit!`.

## Spiel (Host, URL `/host`)

- Bei Musikfragen-Boards erst ein Gate: Button `Sound aktivieren` (auch bei jedem Spieler).
- „Am Zug“ bleibt nach „Frage schließen → Nächster Spieler“ **manchmal am vorherigen Spieler hängen** (bis zum Öffnen der nächsten Karte, teils noch kurz danach). Der Controller merkt sich deshalb die Reihenfolge (`rotation`) und verlässt sich nach 6 s darauf. Wer antwortet, bestimmt er aus seiner eigenen Kartenwahl (`lastPick`), nicht aus der Anzeige; nur eine von Hand im Browser geöffnete Karte nimmt „Am Zug“ der Seite.
- Punktestände aktualisieren sich erst ~0,5–2 s nach der Vergabe – vor Ansagen auf den neuen Wert warten.
- Header: `aria-label`s `Punkte` (manueller Dialog), `Reihenfolge mischen`, `Spiel beenden`; bei 2 Boards Buttons `Board 1`/`Board 2` (aktiv: Klasse `from-btn-primary-from`).
- Raster: Spalten = Container, deren erstes Kind die Kategorie ist, danach `button` mit Punktetext. Beantwortet: `title="Frage wieder öffnen"`. DOM-Reihenfolge = Spalte für Spalte.
- Spielerliste: `ul[aria-label=Spieler] button` → `span[title=<Name>]`, `[data-testid=animated-score]`, Text `Am Zug` bzw. `Buzzer`.

### Offene Frage

- `section[aria-label="Aktive Frage"]`: `span` „`<n> Punkte`“, erstes `p` = Fragetext, `img` (oft `/_next/image?url=…`, manchmal `data:`-URI, manchmal kaputt), `p` „Richtige Antwort (Notiz):“ + nächstes `p` = Notiz oder „Keine Notiz hinterlegt“.
- **Multiple Choice** (z.B. Board „Schulwissen 1. - 12. Klasse“, dann ohne Notiz): `ul > li` je Option = `span` Buchstabe (`A`–`D`) + `span` Text; die richtige Option hat zusätzlich die Klasse `border-success`, ein Häkchen-`svg` und `span.sr-only` „richtig“. **Achtung:** `innerText` des `li` enthält das versteckte „richtig“ („D klein richtig“). Der Probe liest Buchstabe, Text und Markierung getrennt. Vorher landete das „richtig“ im Chat und in der Sprachansage, also die Lösung vor der Auflösung. Leere Optionen kommen vor („D“ ohne Text).
- **Formeln** stehen als Unicode-Klartext im `p`: „3² + 4²“, „ln(eˣ) = 5“, „x = (−b ± √(b² − 4ac)) / 2a“, „f′(x) = 2x“, „1/x für x → ∞“, „U = R x I“. Kein KaTeX/MathJax, kein `<sup>`/`<sub>`. Der Probe liest solche Markup-Formeln trotzdem einmal und lesbar (`mathT`), falls ein Board sie hat. Spieler tippen die ASCII-Schreibweise (`x^2`, `sqrt(2)`, `pi`, `*`): `mathKey()`/`mathValue()` in `src/judge/normalize.ts` gleichen das ab.
- Audio: `p` „Audio für diese Frage“, Button `Abspielen` (→ `Pause` während Wiedergabe), `Stop`, YouTube-`iframe[title]` (Titel verrät oft die Lösung), „wird für alle Spieler synchronisiert“. Der Titel ist die Identität der Audiofrage für den Lösungs-Cache; ohne Titel (oder bei `data:`-Bildern, die der Probe als `data:` meldet) wird eine per LLM bestimmte Lösung nicht gecacht.
- `section[aria-label=Timer]`: Zahl-Input, `Start` (läuft: `Stopp`), Presets `10 s`/`20 s`/`30 s`/`60 s`.
- `section[aria-label=Buzzer]` `p`: „<Name> ist dran, Buzzer gesperrt“ | „Warten auf Buzzer...“ (offen) | „<Name> hat gebuzzert!“ (`role=status`). Buttons `Buzzer freigeben` / `Buzzer zurücksetzen`.
- `section[aria-label="Punkte vergeben"]`: `strong` = Zielspieler (springt automatisch auf Buzzernden). Buttons `aria-label`: „`<n> Punkte an <Name>`“ (voll + halb) und „`<n/2> Punkte von <Name> abziehen`“. Anderen Spieler durch Klick in der Spielerliste wählen.
- `section[aria-label="Animation für alle"]`: `Richtig` / `Falsch` – **nur Animation, keine Punkte**.
- `Frage schließen → Nächster Spieler` – gibt den Zug automatisch weiter.

### Dialoge

- Manuelle Punkte (`[role=dialog]`): `input[aria-label="Punkte für <Name>"]`, Buttons `Hinzufügen`/`Abziehen`, `aria-label=Schließen`.
- Spiel beenden: „Spiel wirklich beenden?“ → `Abbrechen` / `Ja, beenden`.
- Ergebnis: `SPIEL VORBEI!`, `CHAMPION!`, Buttons `Nochmal spielen`, `Ergebnisse teilen`. Ist selbst ein `[role=dialog]` (`aria-labelledby="endscreen-title"`); Name in `div[title]`, Punkte im nächsten Geschwister-`div`, auch bei Platz 2 („2. PLATZ“).

### Spielende und Board-Wechsel (live geprüft 12.11.2026)

- Nach dem Schließen der **letzten Frage des letzten Boards** zeigt quiz-base **von selbst** den Ergebnisbildschirm. „Spiel beenden“ ist dann nicht mehr da (`autoEnd` greift nur, wenn quiz-base das nicht tut).
- Ist ein Board durch, bleibt quiz-base auf diesem Board stehen. Der Controller wechselt mit `Board 2` weiter. Danach hat `Board 2` die Klasse `from-btn-primary-from`, `boards()` meldet `active: 2`. Die Buttons enthalten `span` „Board n“ (ab `sm`) und „Bn“ (mobil).
- „Spiel beenden“ geht auch bei offener Frage. Nach „Ja, beenden“ zeigt der Host nach ~0,5 s die Ergebnisse, die Spieler kurz danach. **Den Host-Browser erst danach schließen.** Wird er direkt nach dem Klick geschlossen, kommt das Ende nie an: Die Spieler sehen weiter die offene Frage mit laufendem Timer. `TafelquizPage.endGame()` wartet deshalb auf den Ergebnisbildschirm, `closeLobby()` darauf, dass der Warteraum weg ist (der Host landet auf `/`).
- Auch nach dem Spielende hält quiz-base die Lobby noch eine Weile (`/join?code=…` zeigt einen Warteraum, für „Nochmal spielen“). Weder „Zurück zur Startseite“ noch das Schließen des Browsers ändert das. Später meldet der Code „Lobby nicht gefunden“ (beobachtet: weniger als eine Stunde nach dem Ende). Die Host-Ansicht lässt sich nach dem Schließen des Browsers nicht wiederherstellen (`/host` leitet auf `/join` um).
- Allein spielen geht: quiz-base startet ab einem bereiten Spieler. „Am Zug“ bleibt immer bei derselben Person.
- Boards können pro Spalte lauter gleiche Punktwerte haben („Schulwissen“: 12 Spalten × 10 Karten à 100…1200). „1. Klasse 100“ nimmt dann die oberste freie Karte der Spalte.

## Spieler-Ansicht (Tafelquiz)

- Sieht Frage + Bild, aber nie die Notiz. Buzzer: Button `BUZZER! (Leertaste)` nur wenn freigegeben, sonst „Buzzer deaktiviert“.

## Account (Benutzermenü)

- Header: `button[aria-label="Benutzermenu"]` öffnet ein Menü. Abgemeldet enthält es das Login-Formular: `input[type=email]` (`deine@email.com`), `input[type=password]`, Button `Anmelden`, `Passwort vergessen?`, `Noch kein Account? Registrieren`. Nur E-Mail + Passwort, kein OAuth.
- Angemeldet (live 13.11.2026) enthält das Menü die Buttons `Profil`, `Postfach`, `Meine Boards`, `Frage einreichen`, `Meine Einreichungen`, `Premium`, `Abmelden`. Nach dem Anmelden **klappt quiz-base das Menü zu** – `qbhost login` öffnet es dann einmal kurz zum Prüfen.
- `src/site/editor/probe.browser.js` `account()` erkennt den Login nur an festen Menü-Beschriftungen und liest weder Namen noch E-Mail.
- `BoardEditorPage.loginState()` liest bis zu dreimal im Abstand von 2,5 s (Menü öffnen, bis zu 4 s auf das offene Menü warten, selbst geöffnetes Menü wieder schließen). „Abgemeldet“ gilt erst nach zwei solchen Blicken mindestens 2 s auseinander (`decideLogin`), ein unklares Ergebnis (`null`) nie als abgemeldet.
- „Eigenes Board verwenden“ erscheint im Lobby-Wizard nur angemeldet; `createLobbyWithOwnBoard` wartet bis zu 5 s darauf und wirft sonst `NotLoggedInError`.

### Anmeldung und Sitzung (Server-Diagnose 22.11.2026)

- Cookie `sb-<ref>-auth-token`, persistent, Laufzeit **400 Tage** ab dem Schreiben (Standard von `@supabase/ssr`), nicht in Stücke geteilt (~3 KB). Ein clientseitiger Cookie-Ablauf ist also nicht die Ursache verlorener Anmeldungen.
- Die Seite erneuert erst, wenn das Access-Token (1 h) abgelaufen ist: Während Board-Anlage und Spiel unter 1 h nach dem Login blieb das Cookie unverändert. Jeder Seitenaufruf mehr als 1 h nach der letzten Erneuerung löst eine aus.
- Die Seite spricht ihre Supabase-Anmeldung selbst an (`https://<ref>.supabase.co/auth/v1/…`):
  - `token?grant_type=refresh_token` = Erneuerung, `token?grant_type=password` = Anmelden, `signup` = (anonyme) Sitzung anlegen, `logout`, `user`.
  - qbhost ruft keinen dieser Endpunkte auf. Die Bot-Browser beobachten nur passiv Statuscode und bei Status ≥ 400 das Feld `error_code` (`src/site/auth.ts`, `readWatchedResponse` in `src/browser/driver.ts`); Antworten mit 2xx werden nie gelesen (sie enthalten Tokens).
  - Erwartete `error_code`s (Supabase-Standard, nicht live gesehen): `refresh_token_already_used` (Wiederverwendung nach Rotation), `session_expired` (Leerlauf- oder Zeitlimit), `session_not_found` / `refresh_token_not_found` (Sitzung gelöscht oder abgemeldet). Der Code setzt nichts davon voraus, er loggt nur.
- Ein frisches, leeres Profil auf der Startseite (live 22.11.2026): Das Benutzermenü zeigt das Login-Formular (zweimal im Abstand von 2,5 s gelesen → „abgemeldet“); dabei schickt die Startseite keine Anfrage an `auth/v1`.
- Die Probe klickt nur den Menü-Button (`toggleMenu`), nie „Abmelden“.

## Board-Editor Tafelquiz (`/configure-lobby?format=tafelquiz`, Stand 12.11.2026)

Weg: `/create-lobby` → `Tafelquiz` → `Neues Board erstellen`. Auch ohne Login erreichbar; ohne Login gibt es am Ende nur `Lobby erstellen` (Board wird nicht gespeichert). Text „Schritt n von 4“.

1. **Template:** `h3`-Karten (selbst klickbar) `Klassisches Spiel` (4 Kategorien), `Schnelles Spiel` (3), `Benutzerdefiniert` (0). qbhost nimmt `Benutzerdefiniert`.
2. **Board-Anzahl:** Buttons `1 Board` / `2 Boards`, dann `Weiter →` (`← Zurück`).
3. **Kategorien bearbeiten:**
   - `input[placeholder="Oberkategorie eingeben..."]` („wird in der Lobby angezeigt“), bei 2 Boards zwei Felder (Oberkategorie 1/2).
   - Pro Kategorie: `input[placeholder="Kategorienamen eingeben..."]`, Text „Fragen: n“ mit `aria-label="Frage entfernen"` / `"Frage hinzufügen"`, `aria-label="Kategorie löschen"`; bei 2 Boards ein Button `Board 1`, Klick schaltet auf `Board 2`.
   - `+ Kategorie hinzufügen`: neue Kategorie mit 1 Frage. **1–10 Fragen** pro Kategorie (Plus ist bei 10 gesperrt); 16 Kategorien gingen ohne Grenze.
   - `Weiter →` ohne Namen → Dialog „Kategorienamen fehlen“ (`data-testid=dialog-backdrop` fängt Klicks ab).
4. **Fragen** (`h2` „Fragen für: <Kategorie>“), Tabs `aria-label="Kategorie <n>"` (oben und unten):
   - Zeile: `input[placeholder="Frage eingeben..."]`, `span` „<n> Punkte“, `aria-label="Ausklappen"`/`"Einklappen"`, `Frage löschen`, Drag-Handle `aria-label="Frage verschieben"`. Punkte nach Zeile: 100, 200, … (Fragenanzahl aus Schritt 3); `+ Frage hinzufügen` startet bei 100.
   - Ausgeklappt: `Bild-URL (optional)` (`placeholder="https://beispiel.de/bild.jpg"`), `Audio-URL (optional)` (YouTube), Stepper `Punkte verringern`/`Punkte erhöhen` in **50er-Schritten** (min. 50), Checkbox **„Antwortmöglichkeiten anzeigen“** – im leeren Editor **an**:
     - an = Multiple Choice: `input[placeholder="Antwort 1"]` … `"Antwort 4"` + Radio `name="correct-q-<kat>-<zeile>"` für die richtige.
     - aus = `textarea[placeholder="Hier können Sie die richtige Antwort notieren..."]` („Notiz für die richtige Antwort (nur für Host sichtbar)“).
     - MC und Notiz schließen sich aus: MC-Fragen haben keine Host-Notiz.
   - Keine `maxLength` an den Feldern. Werte per React-Setter + `input`-Event setzen (wie überall).

### Speichern und „Meine Boards“ (mit Login, live 13.11.2026)

- Schritt 4 hat angemeldet zwei Buttons: `Lobby erstellen` und `Board speichern` (`title="Board für später speichern"`). qbhost klickt nie `Lobby erstellen` im Editor.
- `Board speichern` öffnet ein Modal „Board speichern“ (schließt nicht per Klick daneben): `input#save-board-name` (Pflicht, `placeholder="z.B. Allgemeinwissen Quiz"`), `textarea#save-board-description` (optional), Buttons `Abbrechen` / `Speichern` (gesperrt ohne Namen). **Keine Sichtbarkeit:** gespeicherte Boards sind immer `Entwurf` (privat).
- Erfolg: Toast „Board wurde erfolgreich gespeichert“, das Modal schließt, die Seite bleibt im Editor **ohne Board-ID in der URL** – ein zweiter Klick auf „Board speichern“ legt ein zweites Board an. Fehler: Toast „Fehler beim Speichern des Boards“, das Modal bleibt offen.
- **Meine Boards** (`/profil/boards`, Menü → `Meine Boards`): leer „Noch keine Quiz Boards erstellt“, sonst „n Board(s) gefunden“. Pro Board eine Karte: `h3` Name, Status-Badge `Entwurf` / `In Prüfung` / `Veröffentlicht` (dazu `Fork` bei Kopien), Beschreibung, „2 Kategorien · 1 Board · 4 Fragen“, Datum, Button `aria-label="Mehr Optionen"` (`aria-haspopup=menu`).
- Das Menü (`[role=menu]`, Einträge `[role=menuitem]`) eines Entwurfs: `Bearbeiten` (→ `/profil/boards/edit/<uuid>?format=tafelquiz`, der Editor-Link – **zeigt die Lösungen**), `Lobby erstellen` (→ `/configure-lobby?boardId=<uuid>&mode=lobby&format=tafelquiz`), `Umbenennen`, `Veröffentlichen`, `Duplizieren`, `Löschen`.
- `Veröffentlichen` reicht das Board bei quiz-base zur Prüfung ein (Status `In Prüfung`, danach `Veröffentlicht` und in der öffentlichen Suche). qbhost macht das nie selbst.
- `Löschen` fragt nach: `[role=alertdialog]` „Board löschen?“ („… kann nicht rückgängig gemacht werden“) mit `Abbrechen` / `Löschen`. Danach geht ein `DELETE` an die Seite, und **solange er läuft, zeigt die Liste keine Karten** (Ladezustand). Wer dann schon „Karte weg“ annimmt und den Browser schließt, bricht das Löschen ab – `deleteOwnBoard()` wartet deshalb auf die fertige Liste und prüft nach einem Neuladen.

### Lobby mit eigenem Board

- `/create-lobby` → `Tafelquiz` → angemeldet zusätzlich **`Eigenes Board verwenden`** (vor „Öffentliches Board verwenden“). Danach `h1` „Eigenes Board auswählen“, Suchfeld `Nach Boards suchen...` (filtert die eigenen Boards), dieselben Karten (`h3`) wie bei öffentlichen Boards, leer: „Keine eigenen Boards gefunden“.
- Karte anklicken → `Board verwenden →` → `Board Vorschau` → `Lobby erstellen` → `Lobby Warteraum`, genau wie bei öffentlichen Boards (`createLobbyWithOwnBoard` in `src/site/lobby.ts`, live 4 s).

## Punktejagd (für später)

- Host nach Start: „Warte auf Spieler – x von y bereit – Gäste aktivieren am Handy den Ton“ → `Spiel starten`.
- Frage: `Antworten: x/y`, `Frage n/32`, Buttons `A aufdecken` … `D aufdecken`, `Auflösen` (disabled bis Antworten da), Spielerliste mit Jokern (`½`, `S`, `x2`).
- Spieler klicken Antworten selbst → Host-Aufgabe ist rein mechanisch (aufdecken, auflösen, weiter): **komplett ohne LLM automatisierbar**.
