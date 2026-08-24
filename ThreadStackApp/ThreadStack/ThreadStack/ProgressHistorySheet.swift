//
//  ProgressHistorySheet.swift
//  ThreadStack
//
//  Arbeitspaket A3 ("App-Integration Progress"): gemeinsame Sheet-Hülle für
//  den Fortschrittsverlauf-Zugriff aus Todo-Detail (`TodoFormView`) und
//  Topic-Detail (`TopicFormView`) — EINE Stelle statt zweier divergenter
//  Kopien (siehe CLAUDE.md "Wiederverwendung vor Neuentwicklung": ein
//  Editor/Dialog wird nie zweimal, leicht abweichend, gebaut).
//
//  Komponiert ausschließlich die bereits von Paket A2 gelieferten Bausteine
//  (`ProgressReentryCardView`, `ProgressTimelineView`) — erfindet keine neue
//  Verlaufsanzeige und keine neue Sichtbarkeitslogik für die
//  Wiedereinstiegskarte. Die Karte wird bewusst IMMER gemountet: sie
//  entscheidet ihre eigene Sichtbarkeit selbst über
//  `store.shouldShowReentry` (siehe `ProgressReentryCardView.swift`), das
//  bereits exakt die serverseitig berechnete `reentry.show`-Bedingung inkl.
//  Dismiss-Persistenz abbildet. Ein zusätzliches Gating auf Basis des
//  (potenziell veralteten) Listen-Snapshots `item.progress?.dormant` würde
//  diese Bedingung duplizieren und könnte divergieren (siehe
//  Abschlussbericht, Abschnitt "Abweichungen").
//

import SwiftUI

struct ProgressHistorySheet: View {
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationStack {
            // Kein äußeres ScrollView mehr: ProgressTimelineView scrollt jetzt
            // intern NUR seinen Verlaufsbereich, damit Zielbild/Nächster
            // Schritt (und diese Karte hier) fixiert sichtbar bleiben, statt
            // mit langen Verläufen aus dem Blick zu scrollen.
            VStack(alignment: .leading, spacing: 12) {
                ProgressReentryCardView(refType: refType, refId: refId, store: store)
                    .padding(.horizontal)
                    .padding(.top)
                ProgressTimelineView(refType: refType, refId: refId, store: store)
                    .padding(.horizontal)
            }
            .navigationTitle("Fortschritt")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Schließen") { dismiss() } }
            }
        }
    }
}
