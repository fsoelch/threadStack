# Code-Reviewer Memory

- [ThreadStack Review-Konventionen](project_threadstack_conventions.md) — Bestandsmuster fuer Fehler-Envelope, Helper-Injection, ref_type/ref_id-Tabellen, Rate-Limiting, ownsRef.
- [ThreadStack Web-Modul-Konventionen](project_threadstack_web_module_conventions.md) — public/*.js: TSHost.api statt fetch, BASE_PATH=/notes, Host-Modals, initRtToolbar, escJsAttr im onclick.
- [ThreadStack Testmuster](project_threadstack_testmuster.md) — eigener Harness pro Worktree; systematische blinde Flecken trotz gruenem Testlauf.
- [SQLite-Tabellen-Rebuild](project_threadstack_sqlite_table_rebuild.md) — DROP+RENAME: stille Trigger-/CASCADE-Verluste, IF-NOT-EXISTS-Indexfalle, Idempotenz per rootpage messen.
- [Polymorphe refType-Erweiterungen](project_threadstack_reftype_erweiterung.md) — neuer ref_type in geteilter Komponente: verstreute `=== 'x'`-Sonderfaelle und untestete Exportflaeche.
- [Aggregierte Snippets vs. Vertraulichkeit](project_threadstack_aggregierte_snippets.md) — server-konkatenierte Textauszuege ueber gemischte Rubriken; clientseitige Guards tragen dort strukturell nicht.
- [ThreadStack iOS/SwiftUI-Konventionen](project_threadstack_ios_konventionen.md) — geteilte SwiftUI-Bausteine, totes `.onMove`, MainActor-Equatable-Warnung, xcresult-Baseline, pbxproj-Sync-Groups.
