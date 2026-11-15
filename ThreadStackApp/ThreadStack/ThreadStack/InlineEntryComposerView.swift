//
//  InlineEntryComposerView.swift
//  ThreadStack
//
//  Arbeitspaket A3 ("App-UI Übersicht und Meeting-Detail"), Story 6:
//  Composer direkt in der Listenzeile (nicht erst nach Öffnen der
//  Bearbeiten-Ansicht). WIEDERVERWENDET die bestehende
//  `ProgressEntryComposerView`/`ProgressEntryComposer`-Logik aus Paket A2
//  unveraendert (kein zweiter Zustands-/Idempotenz-/Zeichenzähler-Mechanismus,
//  siehe CLAUDE.md "Wiederverwendung vor Neuentwicklung") — dieser Typ ist im
//  Wesentlichen ein Einbettungs-Wrapper, der die Karte um den bestehenden
//  Composer erweitert. Leer-Validierung, >5000-Zeichen-Ablehnung,
//  Offline-Erhalt der Eingabe: bereits vollständig in
//  `ProgressEntryComposer`/`ProgressEntryComposerView` vorhanden.
//
//  Ob der Composer überhaupt angeboten wird (kein Angebot bei erledigten
//  Todos/archivierten Meeting-Themen), entscheidet bewusst der Aufrufer
//  (`TodosView`/`MeetingDetailView`) — dieser Wrapper kennt "done"/"isReadOnly"
//  nicht selbst, um keine zweite Quelle der Wahrheit für diese Regel zu
//  schaffen.
//

import SwiftUI

struct InlineEntryComposerView: View {
    let refType: String
    let refId: String
    /// Siehe `ProgressEntrySource.derive(hasSnooze:)` — bestimmt den
    /// `source`-Wert des neuen Zwischenstands UND ob der dezente
    /// Snooze-Hinweis unten angezeigt wird.
    let hasSnooze: Bool
    @ObservedObject var store: ProgressStore

    @StateObject private var composer = ProgressEntryComposer()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if hasSnooze {
                Text("Hinweis: Dieses Vorhaben schläft aktuell — der Zwischenstand wird trotzdem gespeichert.")
                    .scaledFont(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Hinweis: Dieses Vorhaben schläft aktuell. Der Zwischenstand wird trotzdem gespeichert.")
            }
            ProgressEntryComposerView(composer: composer, isFocused: $focused, showsOfflineQueueHint: true) {
                Task { await composer.commit(store: store, refType: refType, refId: refId, hasSnooze: hasSnooze) }
            }
        }
    }
}
