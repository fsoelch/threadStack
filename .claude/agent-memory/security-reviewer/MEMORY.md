# Security-Reviewer Memory — personly / ThreadStack

## Wiederkehrende, bereits etablierte sichere Muster (als Referenz fuer neue Endpunkte)

- **Topic-Zuordnungs-Endpunkte** (`PUT /api/knowledge/:id/themes`,
  `PUT /api/todos/:id/themes`): einheitliches Muster - Ownership-Check auf
  der Ressource selbst (`WHERE id=? AND user_id=?`), dann Filtern der
  angefragten `themeIds` gegen `themes WHERE user_id=?` (fremde/geloeschte
  IDs werden stillschweigend verworfen, `droppedCount` statt Fehlermeldung
  mit Existenz-Auskunft). Neue "Owner setzt Many-to-Many-Zuordnung"-
  Endpunkte sollten dieses Muster wiederverwenden statt neu zu erfinden.
- Alle SQL-Statements im Projekt nutzen durchgehend parametrisierte
  Queries (`?`-Platzhalter, IN-Klauseln ueber
  `ids.map(()=>'?').join(',')` + Spread der Werte) - kein String-
  Interpolieren von Nutzereingaben in SQL beobachtet.
- iOS `APIError.server(String)` transportiert nur die vom Server selbst
  gesetzten, bereits nutzerverstaendlichen deutschen Fehlermeldungen
  (z.B. "Nicht gefunden") - keine Stacktraces/interne Pfade. Beim
  Hinzufuegen neuer `.errorAlert($error)`-Anzeigen ist das unkritisch,
  SOLANGE der Server weiterhin nur solche Meldungen liefert.

## Ein bereits bekanntes Muster, das bei neuen AppState-Netzwerkmethoden zu pruefen ist

- Frueher swallowten `themeKnowledge`/`themeTodos` in AppState.swift JEDEN
  Fehler (inkl. 401) per `try? ... ?? []` und liessen ihn wie einen leeren
  Datensatz aussehen (kein Sicherheitsfund im engeren Sinne, aber ein
  Fehlerbehandlungs-Antipattern, das reale Bugs verschleiert hat). Bei
  neuen `async -> [T]`-Helpers mit `try?`-Fallback in AppState.swift
  gezielt nachfragen, ob ein Fehler wirklich unterschlagen werden darf.
