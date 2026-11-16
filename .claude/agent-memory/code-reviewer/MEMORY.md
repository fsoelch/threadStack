# Code-Reviewer Memory

- [ThreadStack Review-Konventionen](project_threadstack_conventions.md) — Fehler-Envelope, Helper-Injection, ref_type-Tabellen, Rate-Limiting, zwei Client-Token-Varianten, server.js-Kommentarbloecke.
- [ThreadStack Web-Modul-Konventionen](project_threadstack_web_module_conventions.md) — public/*.js: TSHost.api statt fetch, BASE_PATH=/notes, Host-Modals, initRtToolbar, escJsAttr im onclick.
- [ThreadStack Testmuster](project_threadstack_testmuster.md) — eigener Harness, blinde Flecken, Test-Baseline, veraltete Worktree-Basis (merge-base pruefen).
- [SQLite-Tabellen-Rebuild](project_threadstack_sqlite_table_rebuild.md) — DROP+RENAME: stille Trigger-/CASCADE-Verluste, IF-NOT-EXISTS-Indexfalle, Idempotenz per rootpage messen.
- [Polymorphe refType-Erweiterungen](project_threadstack_reftype_erweiterung.md) — neuer ref_type in geteilter Komponente: verstreute `=== 'x'`-Sonderfaelle und untestete Exportflaeche.
- [Aggregierte Snippets vs. Vertraulichkeit](project_threadstack_aggregierte_snippets.md) — server-konkatenierte Textauszuege ueber gemischte Rubriken; clientseitige Guards tragen dort strukturell nicht.
- [ThreadStack iOS/SwiftUI-Konventionen](project_threadstack_ios_konventionen.md) — geteilte SwiftUI-Bausteine, totes `.onMove`, MainActor-Equatable-Warnung, xcresult-Baseline, pbxproj-Sync-Groups.
- [Offline-Gating-Funde](project_threadstack_offline_gating.md) — Text-Kopien von OfflineTexts, paketbenannte Logic-Enums, doppeltes Offline-disabled, tote Retry-Buttons.
- [Async-Koordinatoren iOS](project_threadstack_async_koordination.md) — Task-Sharing-Nil-Falle, zwei Status-Schreiber, kopierte Renewal-Pfade, Inline-Texte, nachgebaute Outbox-Ref-Aufloesung in Fassaden.
