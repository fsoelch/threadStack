# Requirements-Engineer Memory — personly / ThreadStack

## Verwirrende Domaenen-Begriffe (immer zuerst am Code pruefen, nicht raten)

- Es gibt ZWEI völlig unterschiedliche DB-Konzepte, deren UI-Label GENAU
  VERTAUSCHT zum naheliegenden Namen ist:
  - DB-Tabelle `topics` (Meeting-Tagesordnungspunkte) → UI-Label **"Thema"**
    (Plural "Themen"). Hat wie ein Todo einen eigenen Zwischenstand/
    Fortschrittsverlauf und kann auf den Stack gelegt werden.
  - DB-Tabelle `themes` (hierarchische Tag-/Ordner-Struktur zum Verschlagworten
    von Todos/Themen/Kontakten) → UI-Label **"Topic"**. Rein organisatorisch,
    hat KEINEN Zwischenstand und ist NICHT stack-faehig.
  - Wenn ein Mensch von "Themen" spricht, meint er (Plural von "Thema") fast
    immer die Meeting-Tagesordnungspunkte (`topics`-Tabelle), NICHT die
    "Topic"-Hierarchie (`themes`-Tabelle) — trotz der englischen Namensnähe
    von "Topic" zu "Thema". Im Zweifel am Code/an der UI-Beschriftung
    verifizieren, nicht am englischen Wortklang.
- "ToDos" und "Themen" (`topics`) sind die beiden gleichwertigen "Vorhaben"-
  Typen im Stack-/Fortschritts-Feature. Feature-Paritaet zwischen beiden ist
  ein wiederkehrendes Thema von Nutzeranfragen — bei "X existiert bei Todos,
  aber nicht bei Themen (oder umgekehrt)" immer BEIDE Implementierungen
  (renderPersonalTodoCard vs. renderTopicCard/renderMeetingTopicTodo,
  openTodoModal vs. openTopicModal) direkt vergleichen, bevor man eine
  Annahme trifft — Divergenz zwischen ihnen ist laut CLAUDE.md ein Bug.
- "Der Stack" ist ein voll ausgebautes Web-Feature (Tabelle `stack_frames`,
  `/api/stack/*`), nicht nur der Name der iOS-Begleit-App "ThreadStack".
- "Zwischenstand" = ein Fortschritts-Eintrag (`lib/progress/`, Tabelle
  `progress_entries`) an einem Todo oder Thema, ueber `TSProgress.
  mountInlineComposer` (public/progress.js) erfasst.

## Objekttyp-Steckbriefe

- [Kontakte / Ansprechpartner](domain_contacts.md) — minimales Datenmodell, kein Zwischenstand/Anhang/Stack, bekannte Web-vs-iOS-Divergenz
- [Zwischenstand-Mechanik](domain_progress_mechanik.md) — konkrete Limits/Paging/Ownership-Regeln fuer "gleiche Bedienung wie bei ToDos"; `topics` hat kein user_id
- [Momentum (Streak/Erledigt-Moment/Wochen-Rueckblick)](domain_momentum.md) — "Thema" bei Meilensteinen ist ein atomares `topics`-Objekt ohne Kind-Todos; Modulname bewusst `momentum` statt `progress` wegen Namenskollision
- [iOS-Offline/Sync-Fakten](domain_ios_offline.md) — keine "Idee"-Entitaet, kein lokaler Cache, fehlende Idempotenz/Konflikterkennung am Server, Lastenheft Kap. 6
- [DB-Backup/Restore (Admin)](domain_backup.md) — Abgrenzung zum bestehenden Pro-Nutzer-Export-Feature; Referenz-Scheduler-Muster aus ai/jobs.js fuer "zu Uhrzeit X automatisch"

## Lastenheft-Pflege

- [Lastenheft-Eintraege aktualisieren](workflow_lastenheft.md) — Eintrag ersetzen statt duplizieren, sichere Ersetzungsgrenzen

## Navigation ToDos (2026-09-17)
- Web-ToDos-Nav (`renderTodosNav()`, app.js) ist EINE flache Liste (Meine Todos,
  Tagesabschluss, Stack-Historie, Wochen-Digest, Fortschritt, Archiv). iOS/macOS
  hat dieselben fachlichen Punkte aber anders verteilt: Tagesabschluss/
  Stack-Historie stecken in einem eigenen, bereits selbst-einklappbaren
  `StackPanelView` (separat von der Sidebar), NICHT in `SidebarView.swift`. Bei
  "Navigation ist zu lang"-Anfragen immer zuerst pruefen, ob iOS/macOS die
  Web-Struktur wirklich 1:1 spiegelt, bevor man Web-Scope unveraendert auf iOS
  uebertraegt.

## Session-/Logout-Handling (2026-09-11)
- iOS: `tryServerReLogin()` (AppState.swift) existierte bereits vor diesem Feature,
  wurde aber NIRGENDS aufgerufen (dead code) - "automatische Sitzungserneuerung"
  war technisch schon vorbereitet, nur nicht verdrahtet. Vor jeder neuen
  Session-Anforderung erst pruefen, ob so ein ungenutzter Baustein existiert.
- Web: `.modal-overlay`-Dialoge (`index.html`) liegen als Geschwister NACH dem
  schliessenden `</div>` von `#app`, nicht darin verschachtelt - `showLogin()`
  (versteckt nur `#app`) schliesst sie NICHT automatisch. Bei jeder
  "Login-Screen soll sichtbar werden"-Anforderung diesen Fallstrick pruefen.
- Web-Session-Store ist `express-session` MemoryStore (kein Redis/DB-Store) -
  jeder Serverneustart invalidiert SOFORT alle Sitzungen unabhaengig vom
  12h-maxAge. Relevant als Kontext fuer Session-Timeout-Anforderungen, aber
  kein eigenstaendiges Anforderungsthema ohne expliziten Wunsch.
