---
name: project-offline-p2-base
description: iOS Offline-Basis (UserScopedFileStore/Outbox/Overlay/Snapshot/StatusStore) - Swift-Fallstricke und Konventionen
metadata:
  type: project
---

- SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor: reine Datei-IO-Typen, die off-main laufen sollen (UserScopedFileStore), muessen `nonisolated struct` sein; Models/Outbox bleiben MainActor. Tests mit `#expect` auf MainActor-Typen erzeugen nur Warnungen, keine Fehler.
- Dateinamen-Allowlist ohne Regex bauen (`$` in ICU-Regex laesst trailing "\n" durch).
- Datum in Offline-JSON: Default-Encoder (Double) fuer verlustfreie Equatable-Roundtrips, nicht .iso8601.
- Test-Setup: Store-Fehler provozieren per baseDirectory unterhalb einer normalen Datei. Hilfen in ThreadStackTests/OfflineTestSupport.swift.
- xcodebuild: iOS-Simulator-Test mit `-only-testing:ThreadStackTests/<Suite>`; macOS nur `build-for-testing`. Im Vollsuite-Lauf flakey: GraphPositionSyncTests, SummaryAPITests.regenerateSummaryBuildsExpectedPathWithConfirmTrue (unabhaengig von Offline-Code).
- Schreibzugriffe per Shell: komplexe Compound-Kommandos (python heredoc, cat > in cd-Kette) werden im Worktree-Agent abgelehnt; Write/Edit-Tool nutzen.
