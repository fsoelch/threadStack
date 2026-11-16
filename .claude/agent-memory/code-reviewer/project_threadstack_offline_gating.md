---
name: threadstack-offline-gating
description: Wiederkehrende Qualitaetsfunde beim Offline-Gating der SwiftUI-Views (View-Pakete des Offline-Modus, ab 2026-11)
metadata:
  type: project
---

Beim Gating vieler Views in parallelen Paketen entstehen dieselben Muster.

**Why:** Parallele developer-Agenten sehen nur ihre Eigentuemerliste. Jeder baut sich
ein eigenes `OfflineFeature<X>Logic`-Enum (P5 in TodosView.swift, P6 in
StackViews.swift) plus eigene Hinweis-Zeilen, obwohl P2 `OfflineTexts`,
`OfflineError`, `.disabledWhenOffline(Compact)` und `OfflineUnavailableView` liefert.

**How to apply:** Bei jedem Gating-Paket greppen auf:
- Text-Kopien: Literale "Offline nicht verfügbar" / "Keine Verbindung – dein Inhalt..."
  statt `OfflineTexts.unavailableTitle` / `OfflineError.notAvailableOffline.errorDescription`.
- Paketbenannte Logik-Typen (`...ALogic`, `...BLogic`) in fremden View-Dateien -> eigene
  Datei, fachlicher Name, mit Schwesterpaket zusammenfuehren.
- Doppelt kodiertes Offline: `.disabled(!canSave(isOffline:...))` + `.disabledWhenOfflineCompact`.
- Triviale Wrapper (`shouldPerformRequest = !isOffline`) und Tests, die nur Bool-Operatoren pruefen.
- Handgebaute Hinweiszeilen `if offline.isOffline { Text(...caption2) }` in mehreren
  Stilvarianten (`.font` vs `.scaledFont`, Text vs Label) und Formular-Kopfhinweise.
- Ungleiche Reaktion im Guard (Toast / Dialogtext / stilles return / gar kein Guard).
- Retry-Buttons, die nur offline sichtbar UND dort dauerhaft disabled sind (tot).
- `.onChange(of: offline.isOffline)`-Nachladeblock pro View kopiert -> ViewModifier.
- Konsolidierungs-Nachpruefung: neue "gemeinsame" Bausteine gegen bereits auf main
  vorhandene Statusbaum-Bausteine pruefen (P4 `PendingChangesLogic`/`PendingDetailLogic`,
  `pendingDiscardConfirmation`). Re-Review P5/P6 fand einen zweiten Verwerfen-Dialog
  (`offlineDiscardDialog`) samt doppelten Texten (`OfflineTexts.discardTitle`/`pendingNote`).
- `.disabledWhenOffline` (nicht Compact) hatte auf main keine Aufrufer -> Aenderungen
  am Modifier dort risikoarm; Compact-Variante wird von PendingChangesSheet genutzt.
Siehe auch [[threadstack-ios-konventionen]].
