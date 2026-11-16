---
name: threadstack-ios-konventionen
description: Konventionen und wiederkehrende Stolperfallen beim Review der nativen SwiftUI-App unter ThreadStackApp/ThreadStack
metadata:
  type: project
---

Referenzwissen fuer Reviews von iOS/macOS-Arbeitspaketen (`ThreadStackApp/ThreadStack`).

**Why:** Die SwiftUI-App ist ueber viele Arbeitspakete gewachsen und hat einen
klaren Satz geteilter Bausteine. Ein gruener `xcodebuild` beweist bei SwiftUI
besonders wenig, weil ganze Feature-Zweige (Drag-Reorder, Sheet-Praesentation)
fehlerfrei kompilieren und trotzdem zur Laufzeit tot sind.

**How to apply:**

- **Bestehende Bausteine, gegen die auf Wiederverwendung geprueft wird:**
  `DescriptionRichTextEditor`/`DescriptionEditorSheet` (Rich-Text, nie `TextEditor`
  fuer Beschreibungen), `DescriptionReadView` (Lese-/Stift-Zeile),
  `HTMLContentView` (HTML-Rendering), `ProgressTimelineView` +
  `ProgressEntryComposerView` + `ProgressReentryCardView` (Zwischenstand),
  `ThemeLinkSheet` (HelperViews.swift, Topic-Zuordnung ueber refType/refId),
  `KnowledgeTopicPickerSheet` (Mehrfachauswahl-Vorbild), `errorAlert(_:)`,
  `stripHTML` (Extensions.swift), `KnowledgeMockURLProtocol` (Test-Netzmock).
  Netzwerk laeuft AUSSCHLIESSLICH ueber `AppState.request/requestOK/performRequest`.
  Offline-Modus (ab Paket P2, 2026-11): `UserScopedFileStore` (EINZIGE Stelle fuer
  gehashte Nutzer-/Scope-Verzeichnisse, Dateischutz, Backup-Ausschluss,
  `isSafeFileStem`; KnowledgeDraftStore laeuft darauf), `OfflineOutbox`,
  `OfflineOverlay`, `OfflineSnapshotStore`, `OfflineStatusStore`,
  `OfflineLocalValidation.plainText(fromHTML:)`, `PendingSyncBadge`,
  `OfflineUnavailableView`, `.disabledWhenOffline`. Capsule-Badges (dueBadge,
  ProgressBadgeView, PendingSyncBadge) sind dreifach kopiert — vierte Kopie melden.
  Wiederkehrend: das Mapping `PendingChangeKind` -> refType "todo"/"topic" wird
  pro Aufrufer neu als `switch` geschrieben; auf eine zentrale Property pruefen.
  Weitere Bestandsloesungen, die Offline-Pakete gern nachbauen: Zwischenablage
  "lokal + 5-min-Ablauf" (`KnowledgeEditorView.copyContentToClipboard`, ab P4 als
  `PendingClipboard` kopiert -> generischer Helper faellig), Einzelauswahl-Meetingliste
  (`MoveItemSheet` in HelperViews.swift: Farbpunkt + Checkmark), `state.showToast`,
  `.errorAlert`. Praedikat "status ist .failed" existiert mehrfach inline — auf
  `PendingItemStatus.isFailed` draengen.

- **"Eintrag verschwunden"-Beobachter (`onChange(of: item == nil)`) plus Flag**
  (`didRetry`) fuer einen Erfolgs-Toast: das Flag wird nie zurueckgesetzt, und das
  Verschwinden hat mehrere Ursachen (Sync-Erfolg, Verwerfen, Konvertieren) ->
  falscher Toast. Ursache am Aktionsort entscheiden, nicht am Beobachter.

- **`confirmationDialog` mit abgeleitetem `isPresented`-Binding (`get: flag && bedingung`)**:
  kippt die Bedingung, waehrend der Dialog offen ist, bleibt das Quell-Flag `true`
  haengen und der naechste Ausloeser (`flag = true`) feuert kein `onChange` mehr.

- **`.onMove` ist die haeufigste tote Feature-Behauptung.** Es funktioniert nur,
  wenn das `ForEach` DIREKTES Kind einer `Section`/`List` ist UND ein `EditButton()`
  im Toolbar steckt (Vorbild: `MeetingDetailView` "Offen"-Section +
  `ContactsView`-Toolbar). Sobald das `ForEach` in einem `VStack`,
  `DisclosureGroup` o.ae. verpackt wird, kompiliert `.onMove` sauber und ist zur
  Laufzeit wirkungslos. Bei jedem neuen Reorder-Feature beide Bedingungen pruefen.

- **`.task`/`.onAppear` wandert bei einer View-Extraktion aus dem Formular-Root
  in eine Listenzeile — und wird damit lazy.** Wenn ein Refactoring einen Block
  aus `TodoFormView`/`TopicFormView` in eine eigene `View` auslagert und der
  Lade-`.task` mit umzieht, haengt er danach an einer Zeile INNERHALB von
  `Form`/`List`. SwiftUI realisiert Zeilen erst beim Sichtbarwerden, d.h. der
  Ladevorgang laeuft nicht, wenn der Abschnitt unterhalb des Falzes liegt. Toedlich,
  wenn `save()` den geladenen Zustand danach als VOLLE Ersatzliste zurueckschreibt
  (`setAssignments`/`setTodoThemes`): dann loescht ein Speichern ohne Scrollen die
  Serverdaten. Bei jeder View-Extraktion pruefen, ob ein `.task` die Ebene
  gewechselt hat, und ob `save()` gegen "nie geladen" abgesichert ist.

- **Ein "geladen?"-Flag als Schutz vor Voll-Ersatz-Requests ist nur so sicher wie
  SEIN SCHWAECHSTER SETZ-PFAD.** Uebliche Nachbesserung nach obigem `.task`-Fund:
  ein `xLoaded`-Flag, das `save()` gegen `setAssignments`/`setTodoThemes` mit einer
  nie geladenen Menge absichert. Der Guard selbst ist dann korrekt — die Luecke
  sitzt woanders: das Picker-Sheet setzt das Flag beim "Fertig"-Tap ebenfalls auf
  `true`. Oeffnet der Nutzer den Picker, WAEHREND das Laden noch laeuft oder
  fehlgeschlagen ist, sieht er `initialSelection: []` (faelschlich "keine
  Zuordnung"), bestaetigt, und der Voll-Ersatz-Request loescht doch. Spiegelbildlich
  ueberschreibt ein spaet zurueckkehrendes `.task` die eben getroffene
  Nutzerauswahl. Immer ALLE Stellen greppen, die das Flag auf `true` setzen, und
  pruefen, ob der Auswahl-Einstieg bis zum bekannten Serverstand gesperrt ist
  (`.disabled(refId != nil && !loaded)`).
  Die vollstaendige Absicherung besteht aus DREI Teilen, alle drei einzeln
  greppen: (1) Commit-Guard in `save()`, (2) `.disabled` am Auswahl-Einstieg,
  (3) ein `userConfirmed`-Flag, das eine verspaetete Ladeantwort das lokale Set
  nicht ueberschreiben laesst. Abschliessender Kontrolltest: ALLE Schreibstellen
  des Auswahl-`Set`s greppen — es darf ausser dem geschuetzten Ladepfad und dem
  `onDone`-Callback keine dritte geben.

- **Ein `@Binding` auf ein reines Lese-Flag ist nach so einem Fix ein Fund.**
  Wird das Guard-Flag (`loaded`) an die Unter-View nur zum Lesen gereicht,
  aber weiterhin als `@Binding` deklariert, bleibt der geschlossene
  Datenverlustweg strukturell offen — die naechste Aenderung kann dort wieder
  `loaded = true` schreiben. `let loaded: Bool` verlangen (konsistent zum
  danebenliegenden `let loadError: String?`).

- **`SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` bei `SWIFT_VERSION = 5.0`.** Jeder
  neue `struct X: Error` (implizit @MainActor), der eine `Equatable`-Conformance
  erbt/synthetisiert, erzeugt "main actor-isolated conformance ... cannot be used
  in nonisolated context; this is an error in the Swift 6 language mode". Der
  Build bleibt gruen, Swift 6 waere gebrochen. Nach `grep "warning:"` im Build-Log
  suchen und pruefen, ob die `Equatable`-Conformance ueberhaupt genutzt wird —
  meist ist sie ueberfluessiges Beiwerk.
  Im TESTtarget gilt die Default-Isolation NICHT: neue `async`-Suites ohne
  `@MainActor` erzeugen dutzende Swift-6-Warnungen ("main actor-isolated
  initializer ... cannot be called from outside of the actor"). Vorbestehend in
  vielen Altsuites, bei neuen Suites aber als Niedrig-Fund melden.

- **Formulare/Sheets: Projektkonvention ist `.onAppear { populate() }`**
  (TodoFormView/TopicFormView). Das ist kein Fund. Ein Fund ist dagegen, wenn
  `populate()` von einem parallel per `.task` geladenen `@Published`-Zustand
  abhaengt (z.B. Default-Vorauswahl aus einer noch leeren Liste) — die Reihenfolge
  ist dann rennabhaengig und wird nie nachgeholt.

- **Tests laufen mit Swift Testing (`@Test`/`#expect`), Ziel `ThreadStackTests`.**
  `xcodebuild test -scheme ThreadStack -only-testing:ThreadStackTests` auf
  "iPhone 17 Pro". Baseline (Stand 2026-09): `** TEST SUCCEEDED **` / Exit 0,
  aber das xcresult meldet 1 `failedTests` unter "Issues recorded without an
  associated test or suite" aus `SummaryStoreTests.swift:276` — vorbestehend,
  nicht neuen Paketen anlasten. Echte Zaehlungen nur ueber
  `xcrun xcresulttool get test-results summary|tests --path <...>.xcresult`.
  Stand 2026-11-15 (Simulator jetzt "iPhone 18 Pro", "iPhone 17 Pro" fehlt):
  `SummaryAPITests/regenerateSummaryBuildsExpectedPathWithConfirmTrue` schlaegt
  DETERMINISTISCH auch isoliert auf der Basis fehl (dieselbe Zeile 276, Exit 65).
  `GraphPositionSyncTests` (retries.../mergesRepeated...) sind isoliert gruen und
  fallen nur im Volllauf unter Last (Polling `waitUntil` mit 3-s-Timeout) — Flake.
  Gegenprobe: temporaeren Worktree der Basis im Scratchpad + `-only-testing:` mit
  eigenem `-derivedDataPath` (erster Build ~6 min).

- **`#expect` innerhalb eines `KnowledgeMockURLProtocol`-Handler-Closures ist
  wertlos, wenn der Handler nicht aufgerufen wird** — die Erwartung laeuft dann
  nie und der Test besteht leer. Genau daher stammt auch der Baseline-Fehler
  oben. Zusaetzlich pruefen Handler typischerweise nur `httpMethod`/`url.path`
  und NIE `req.httpBody`; Testnamen wie `...SendsExpectedBody` sind dann
  irrefuehrend. Immer die Testnamen gegen die tatsaechlichen Assertions halten.
  Bewaehrte Nachbesserung (Muster fuer kuenftige Reviews): eine Box-Klasse
  ausserhalb des Closures (`wasCalled`), die NACH dem `await` mit `#expect`
  geprueft wird, plus ein `requestBodyJSON(_:)`-Helper, der `httpBody` UND
  `httpBodyStream` abdeckt (URLProtocol bekommt den Body meist nur als Stream).

- **Vom developer berichtete Testzahlen stimmen nicht.** Beispiel: "68 Tests" bei
  tatsaechlich 37 `@Test`-Faellen. Immer `grep -c "@Test"` plus xcresult-Zaehlung.

- **Ueber mehrere Nachbesserungsrunden veralten die Kommentare schneller als
  der Code.** developer-Agenten schreiben den behobenen Fund als Prosa in den
  Produktivcode ("Hoch-Fund (Code-Review): ...", "Blocker-Fix: ..."). Nach 3
  Runden bestand `ContactAssignmentPickerSheet.swift` zu 38% aus Kommentar, und
  5 Stellen beschrieben noch den in Runde 3 ENTFERNTEN Mechanismus als geltend.
  Das ist gefaehrlicher als fehlende Doku, weil die naechste Wartung dem
  Kommentar folgt und den Bug wiederherstellt. In jeder Folgerunde gezielt nach
  dem entfernten Mechanismus greppen (Stichwort aus dem alten Verhalten, z.B.
  "bestaetigt hat") und Review-Historie als Fund melden — sie gehoert in die
  Commit-Message, nicht in den Code.

- **`project.pbxproj` nutzt `PBXFileSystemSynchronizedRootGroup`** fuer
  `ThreadStack`, `ThreadStackTests`, `ThreadStackUITests` (nur 5
  `PBXFileReference`-Eintraege im ganzen File, keiner fuer `AppState.swift`).
  Neue Swift-Dateien brauchen daher KEINE pbxproj-Aenderung — diese
  Entwickler-Behauptung ist korrekt und kein Vorwand.

- **Parallel gebaute Feature-View-Pakete (Offline P5/P6, 2026-11) erzeugen je ein
  eigenes `OfflineFeatureXLogic`-Enum am Ende einer beliebigen View-Datei**
  (TodosView.swift, StackViews.swift) mit ueberlappenden Gating-Regeln,
  Text-Kopien ("Offline nicht verfügbar", notAvailableOffline-Wortlaut) und
  Doppel-Gating geteilter Komponenten (AISummaryCardView aussen UND innen
  deaktiviert). Bei jedem Paar paralleler View-Pakete gezielt nach `enum *Logic`
  am Dateiende, String-Literalen statt `OfflineTexts`/`OfflineError` und nach
  Modifiern auf geteilten Komponenten an der Aufrufstelle greppen. Ursache fuer
  selbstgebaute Hinweis-Captions: P2s `DisabledWhenOfflineModifier` zeigt immer
  den festen Text statt `hint` -> Pakete umgehen ihn. Fix gehoert in den
  geteilten Modifier, nicht in jede View. `PendingChange.localProgressEntry`
  wurde als `pendingProgressEntry` nachgebaut (Excerpt-280-Logik) — darauf achten.

Siehe auch [[threadstack-review-konventionen]] und [[threadstack-testmuster]].
