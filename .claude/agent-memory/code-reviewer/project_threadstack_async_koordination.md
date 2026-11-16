---
name: threadstack-async-koordination
description: Wiederkehrende Strukturfunde in MainActor-Koordinatoren/Sync-Motoren der iOS-App (Task-Sharing, Pausen-Zustand, Renewal-Kopien), ab Offline-Paket P3 2026-11
metadata:
  type: project
---

Muster, auf die bei Koordinator-/Engine-Klassen (OfflineCoordinator, OfflineSyncEngine,
GraphPositionSync, KnowledgeSaveCoordinator) gezielt geprueft wird.

**Why:** Diese Klassen teilen laufende Tasks, haben Generation-Zaehler gegen Logout und
mehrere Fehlerpfade (401/Renewal/Nutzerwechsel). Entwickler schreiben die Pfade pro
Aufrufstelle neu; Tests decken das Teilen, aber selten das Neu-Starten nach Abbruch ab.

**How to apply:**
- Task-Sharing `if let t = task { await t.value }; task = Task{}; await; task = nil`:
  wird `task` extern (tearDown/cancel) auf nil gesetzt und neu gestartet, loescht der
  alte Aufrufer nach dem await die NEUE Task. Pruefen auf Identitaetsvergleich vor dem Nil-Setzen.
- Zwei Schreiber auf denselben Status (`status.activity` direkt im Koordinator UND per
  Engine-Callback): Pausen ohne Engine-Zustand werden vom naechsten Lauf (`.idle`) ueberschrieben.
- 401 -> renewSession -> userId-Vergleich wird gern 3x kopiert (Create-Pfad, Follow-up,
  Abruf); auf einen Helfer pruefen.
- `SyncCallResult<T>` -> internes Outcome je Payload-Art als identischer 5-Fall-switch kopiert.
- Inline-Fehlertexte statt `PendingFailureReason`/`OfflineError`/`OfflineTexts` (siehe
  [[threadstack-offline-gating]]); `ISO8601DateFormatter()` pro Aufruf statt statisch gecacht
  (`OfflineDateText` ist das Vorbild).
- Testmuster `settle { cond }` + `for _ in 0..<20 { await Task.yield() }` fuer
  Abwesenheitsbehauptungen ist schwach, aber Projektstandard — nur Niedrig melden.
- Integrations-Paket (AppState-Fassade, P7 2026-11): Konsumenten bauen Outbox-Logik nach, die P2/P3 schon
  haben. Gezielt greppen: eigene PendingRef-Aufloesung (`case .local(let parentId)` ausserhalb
  `OfflineOutbox.resolve`) -> divergiert bei Alias nach reconcile/Tombstone; Spiegel-Arrays der Outbox in
  AppState (`offlineChanges`) neben `intents.payload` und `status.items` = drei Lesewege; UUID-Parsing aus
  `local-`-IDs per `dropFirst` mehrfach. Vorbild fuer korrekte Nutzung: `PendingEditTarget.make` (P4).
- AppState-Fassade: `var id = id; if isLocal { guard offline; switch resolveRef ... }` wird pro
  update/delete-Methode kopiert; "Sitzung uebernehmen" (userDidAuthenticate + currentUser + activate)
  je Boot-/Unlock-/Login-Pfad mit unterschiedlicher Fehlerpolitik (`try?` vs. throw).
- Toast-Tests, die `contains(A) || contains(B)` akzeptieren, belegen den Abschluss-Toast nicht.
Siehe auch [[threadstack-ios-konventionen]].
