---
name: project-momentum-module
description: Kernentscheidungen des Backend-Moduls lib/momentum (Sichtbarer Fortschritt) fuer nachfolgende Arbeitspakete (Wiring, Web, iOS) und kuenftige aehnliche Erweiterungen
metadata:
  type: project
---

`lib/momentum/` (Arbeitspaket M1) liefert Streak/Erledigt-Moment/Wochen-
Rueckblick rein additiv:

- `schema.js`: `ALTER TABLE todos/topics ADD COLUMN completed_at` (leerer
  String = "nicht abgeschlossen", Konvention wie bei allen anderen `*_at`-
  Spalten im Projekt) + drei neue Tabellen (`momentum_settings`,
  `momentum_pause_days`, `momentum_milestones`).
- `completion.js` ist die EINZIGE Schreibstelle für `completed_at` und die
  Meilenstein-Erkennung. Der Aufrufer (server.js, Paket M2) MUSS das
  `done`-Flag selbst SCHON GESETZT haben, bevor er `applyTodoDoneChange`/
  `applyTopicDoneChange` aufruft - die Funktionen lesen das aktuelle
  `done` der VERKNÜPFTEN Kontakte, nicht des eigenen Todos/Themas selbst.
  Ownership-Check läuft nur für Todos (`WHERE id=? AND user_id=?`) - bei
  Themen (`topics`, kein `user_id`) verlässt sich der Hook vollständig auf
  die bereits erfolgte Ownership-Prüfung des Aufrufers.
- **Kein Vorher/Nachher-Vergleich für Kontakt-Meilensteine nötig**: da der
  Hook NACH dem `done=1`-Update aufgerufen wird, bedeutet "aktuell keine
  offenen zugewiesenen Todos/Themen mehr" automatisch "dieser Aufruf war
  der letzte, der es geschlossen hat" - siehe `fullyCompletedContactsFor()`.
- Modulname bewusst `momentum`, nicht `progress` (Namenskollision mit dem
  bestehenden Zwischenstand-Mechanismus).
- Zeitzone kommt IMMER vom Client (`utcOffsetMinutes`, Minuten, -1440..1440),
  nie serverseitig gespeichert - `queries.localDateStr()` ist die einzige
  Umrechnungsstelle.
- Wochen-Rückblick-Fensterzählung (`weekCounts`) vergleicht bewusst nur das
  UTC-Datumspräfix (`substr(created_at,1,10)`), NICHT den echten
  Client-Offset - für die grobe Wochenzuordnung ausreichend, spart einen
  vollständigen Tabellenscan mit JS-seitiger Offset-Umrechnung. Der exakte
  "aktiver Tag" für die Serie (`computeStreak`) nutzt dagegen echte
  Offset-Umrechnung je Zeitstempel, weil dort Grenzfälle (Mitternacht)
  tatsächlich sichtbar wären.
- Serie/Wochenzähler benötigen KEINEN Cron-Job/Scheduler: alles wird bei
  jedem `GET /overview` frisch aus den Rohdaten berechnet (kein
  gespeichertes wöchentliches Snapshot) - bewusst schlank gehalten, siehe
  Konzept-Vorgabe "kein KI-Text nötig, rein zahlenbasierte Aggregation".

## Web (M3/M4) und iOS (M5) - Integrationsdetails

- Web: `public/momentum.js` (`window.TSMomentum`) folgt exakt dem
  `TSProgress`-Muster (DI ueber `window.TSHost`, `module.exports` fuer
  node-testbare reine Funktionen). Sidebar-Badge wird NICHT dauerhaft
  gemountet, sondern bei jedem `render()` als String neu in den bestehenden
  Nav-Item-Aufbau eingebettet (`fetchStreakBadge()` liefert nur die Zahl).
- `PUT /todos/:id`/`PUT /meetings/:mid/topics/:tid` bekommen ein additives
  `utcOffsetMinutes`-Body-Feld NUR wenn `window.TSMomentum` geladen ist
  (Web) bzw. immer (iOS, da Kernbestandteil von `completeTodo`/
  `completeTopic`) - alte Aufrufer ohne dieses Feld bleiben unveraendert
  funktionsfaehig (Server nimmt Default 0/UTC).
- iOS hatte VORHER **keine** wiederverwendbare Toast-/Snackbar-Komponente
  (nur `.errorAlert`, ein dauerhafter Alert) - neu geschaffen in
  `ToastOverlay.swift` + `AppState.toastQueue`/`showToast`/
  `dismissCurrentToast`. Sequentielle Warteschlange (nicht parallel/
  gestapelt), da mehrere Meilensteine in einer Aktion (Thema + Kontakt)
  sonst overlappen wuerden.
- iOS-Modulname bewusst `Momentum*` (nicht `Progress*`) - die App hat
  bereits `ProgressAPI.swift`/`ProgressModels.swift`/`ProgressStore.swift`
  fuer den bestehenden Zwischenstand-Mechanismus.
- `completeTodo`/`completeTopic` in AppState.swift geben nicht mehr nichts
  zurueck, sondern rufen intern `presentMomentumToasts()` auf - das
  `momentum`-Feld der Serverantwort ist rein additiv-optional
  (`CompleteMutationResponse.momentum: MomentumCompletionResult?`), alte
  Server/Fixtures ohne dieses Feld loesen bewusst KEINEN Toast aus statt zu
  crashen.
- Xcodebuild in dieser Sandbox: Standard-DerivedData-Pfad
  (`~/Library/Developer/Xcode/DerivedData`) ist nicht beschreibbar
  ("Couldn't create workspace arena folder") - `-derivedDataPath /tmp/...`
  explizit setzen. `xcresulttool` schlaegt in dieser Sandbox mit
  "permission"-Fehlern fehl (auch mit `--output-path`); Testergebnisse
  daher nur aus der `xcodebuild test`-Konsolenausgabe lesen
  (`Test case '...' passed/failed on ...`), nicht aus dem `.xcresult`-Bundle.
- Stolperstein bei synthetisiertem `Decodable` UND einem non-optional
  Property mit Default-Wert (`var isPrivate: Bool = false`, siehe
  `TodoItem`): der Default-Wert wirkt NUR fuer den memberwise Initializer,
  NICHT fuer `init(from: Decoder)` - ein Test-Fixture-JSON ohne dieses Feld
  wirft beim Decodieren `keyNotFound`, obwohl das Feld im Server IMMER
  einen Default hat. Bei neuen Fixtures fuer bestehende Modelle IMMER alle
  non-optionalen Felder mitgeben, auch wenn sie serverseitig einen Default
  haben.
