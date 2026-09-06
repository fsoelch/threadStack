//
//  ContactCategorySheet.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): Verwaltung der
//  frei erweiterbaren Rubriken für Kontakt-Infoblöcke. Liste aller Rubriken
//  (`AppState.contactCategories`), Umbenennen inline, Löschen mit
//  Bestätigung.
//
//  Nachbesserung Feature-Paritäts-Fund (2026-09-06): der Löschen-Button wird
//  für ALLE Rubriken angezeigt (auch die vier Start-Rubriken), analog zum
//  Web-Client (`public/contacts.js`, `deleteCategory()`). NICHT
//  clientseitig anhand von `isDefault` einschränken — das würde
//  "Zuständigkeit"/"Wichtiges" fälschlich unlöschbar machen, obwohl nur
//  "Sonstiges" (Auffangrubrik) und "Privates" (Datenschutzfilter)
//  tatsächlich serverseitig geschützt sind. Stattdessen entscheidet der
//  Server per Fehlercode (`409 category_fallback_protected`/
//  `category_private_protected`, siehe `ContactCategoryProtectedError`).
//
//  Löschablauf (zweistufig, analog Web-Client): erster Löschversuch ohne
//  Bestätigung; meldet der Server `409 category_in_use` (Rubrik wird noch
//  von Infoblöcken verwendet), wird ein zweiter Bestätigungsdialog gezeigt
//  ("Trotzdem löschen? Blöcke werden nach „Sonstiges" umgehängt") und bei
//  Zustimmung erneut mit `confirm: true` gelöscht (siehe
//  `AppState.deleteContactCategory`).
//

import SwiftUI

struct ContactCategorySheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    @State private var newLabel = ""
    @State private var creating = false
    @State private var error: String?
    @State private var isOffline = false

    @State private var renamingCategory: ContactCategory?
    @State private var renameText = ""
    @State private var renaming = false

    @State private var deleteCandidate: ContactCategory?
    // Zweite Bestätigungsstufe, wenn der erste Löschversuch mit
    // `409 category_in_use` abgelehnt wurde (siehe Datei-Kommentar oben).
    @State private var forceDeleteCandidate: ContactCategory?
    @State private var forceDeleteUsageCount: Int = 0
    @State private var deleting = false
    @State private var blockedDeleteMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Neue Rubrik") {
                    HStack {
                        TextField("z. B. Interessen", text: $newLabel)
                            .autocorrectionDisabled()
                        Button("Anlegen") { createCategory() }
                            .disabled(newLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || creating)
                    }
                }
                Section(header: rubrikenHeader) {
                    if state.contactCategories.isEmpty {
                        Text("Noch keine Rubriken angelegt.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(state.contactCategories) { cat in
                            categoryRow(cat)
                        }
                    }
                }
                if let error {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(error).foregroundStyle(.red).font(.footnote)
                            if isOffline {
                                Button("Erneut versuchen") { createCategory() }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Rubriken verwalten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } }
            }
            .task { await state.loadContactCategories() }
            .alert("Rubrik umbenennen", isPresented: renamingBinding) {
                TextField("Name", text: $renameText)
                Button("Speichern") { commitRename() }
                Button("Abbrechen", role: .cancel) { renamingCategory = nil }
            }
            .confirmationDialog(
                deleteDialogTitle,
                isPresented: deleteCandidateBinding,
                titleVisibility: .visible
            ) {
                Button("Löschen", role: .destructive) { performDelete() }
                Button("Abbrechen", role: .cancel) { deleteCandidate = nil }
            }
            .confirmationDialog(
                "Rubrik wird verwendet",
                isPresented: forceDeleteCandidateBinding,
                titleVisibility: .visible
            ) {
                Button("Trotzdem löschen", role: .destructive) { performForceDelete() }
                Button("Abbrechen", role: .cancel) { forceDeleteCandidate = nil }
            } message: {
                Text(forceDeleteMessage)
            }
            .errorAlert($blockedDeleteMessage)
        }
    }

    private var renamingBinding: Binding<Bool> {
        Binding(get: { renamingCategory != nil }, set: { if !$0 { renamingCategory = nil } })
    }

    private var deleteCandidateBinding: Binding<Bool> {
        Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } })
    }

    private var deleteDialogTitle: String {
        guard let cat = deleteCandidate else { return "" }
        return "Rubrik „\(cat.label)“ löschen?"
    }

    private var forceDeleteCandidateBinding: Binding<Bool> {
        Binding(get: { forceDeleteCandidate != nil }, set: { if !$0 { forceDeleteCandidate = nil } })
    }

    private var forceDeleteMessage: String {
        guard let cat = forceDeleteCandidate else { return "" }
        let usageText = forceDeleteUsageCount == 1
            ? "einem Infoblock"
            : "\(forceDeleteUsageCount) Infoblöcken"
        return "Die Rubrik „\(cat.label)“ wird noch von \(usageText) verwendet. Diese werden stattdessen der Rubrik „Sonstiges“ zugeordnet. Trotzdem löschen?"
    }

    /// Zeigt einen `ProgressView`-Indikator, solange ein Umbenennen/Löschen
    /// noch läuft (Code-Review Fund 7: `renaming`/`deleting` wurden zuvor
    /// gesetzt, aber nirgends in der UI ausgewertet).
    @ViewBuilder
    private var rubrikenHeader: some View {
        HStack {
            Text("Rubriken")
            if renaming || deleting {
                Spacer()
                ProgressView().controlSize(.small)
            }
        }
    }

    private func categoryRow(_ cat: ContactCategory) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(cat.label)
                if cat.isDefault == true {
                    Text("Startrubrik").scaledFont(.caption2).foregroundStyle(.secondary)
                }
            }
            if let count = cat.usageCount, count > 0 {
                Text("· \(count)").scaledFont(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                renamingCategory = cat
                renameText = cat.label
            } label: {
                Image(systemName: "pencil")
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .disabled(renaming || deleting)
            .accessibilityLabel("\(cat.label) umbenennen")

            // Fund Feature-Parität (2026-09-06): Löschen-Button für ALLE
            // Rubriken anzeigen (nicht mehr per `isDefault != true`
            // ausblenden) — nur "Sonstiges"/"Privates" sind serverseitig
            // geschützt, der Server entscheidet per Fehlercode (siehe
            // Datei-Kommentar oben und `requestDelete`).
            Button(role: .destructive) {
                requestDelete(cat)
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.plain)
            .disabled(renaming || deleting)
            .accessibilityLabel("\(cat.label) löschen")
        }
    }

    private func createCategory() {
        let label = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }
        creating = true
        error = nil
        isOffline = false
        Task {
            do {
                _ = try await state.createContactCategory(label: label)
                newLabel = ""
            } catch {
                if isTransportFailure(error) {
                    isOffline = true
                    self.error = "Keine Verbindung — deine Eingabe bleibt erhalten. Bitte erneut versuchen, sobald du wieder online bist."
                } else {
                    self.error = error.localizedDescription
                }
            }
            creating = false
        }
    }

    private func commitRename() {
        guard let cat = renamingCategory else { return }
        let label = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingCategory = nil
        guard !label.isEmpty, label != cat.label else { return }
        renaming = true
        error = nil
        // Code-Review Fund 7: `isOffline` steuert den "Erneut versuchen"-
        // Button im `error`-Abschnitt, der IMMER `createCategory()` erneut
        // aufruft (siehe unten) — muss daher hier zurückgesetzt werden,
        // sonst würde ein späterer Umbenennen-Fehler fälschlich den
        // "Erneut versuchen"-Button für das (ggf. gar nicht mehr aktuelle)
        // Anlegen-Formular anzeigen.
        isOffline = false
        Task {
            do { _ = try await state.updateContactCategory(id: cat.id, label: label) }
            catch {
                self.error = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : error.localizedDescription
            }
            renaming = false
        }
    }

    /// Zeigt für JEDE Rubrik (auch Start-Rubriken) den ersten Löschen-
    /// Bestätigungsdialog — es gibt keine clientseitige `isDefault`-Sperre
    /// mehr (siehe Datei-Kommentar oben). Ob eine Rubrik tatsächlich
    /// geschützt ist ("Sonstiges"/"Privates") oder noch verwendet wird,
    /// entscheidet ausschließlich der Server beim eigentlichen `DELETE`-
    /// Aufruf (`performDelete`).
    private func requestDelete(_ cat: ContactCategory) {
        deleteCandidate = cat
    }

    private func performDelete() {
        guard let cat = deleteCandidate else { return }
        deleteCandidate = nil
        attemptDelete(cat, confirm: false)
    }

    /// Zweite Bestätigungsstufe (siehe Datei-Kommentar oben): wird nach
    /// Zustimmung im "Rubrik wird verwendet"-Dialog mit `confirm: true`
    /// erneut versucht.
    private func performForceDelete() {
        guard let cat = forceDeleteCandidate else { return }
        forceDeleteCandidate = nil
        attemptDelete(cat, confirm: true)
    }

    private func attemptDelete(_ cat: ContactCategory, confirm: Bool) {
        deleting = true
        error = nil
        // Siehe Kommentar in `commitRename()` (Code-Review Fund 7): verhindert,
        // dass ein stehen gebliebenes `isOffline == true` aus einem früheren
        // Anlegen-Fehlschlag den "Erneut versuchen"-Button hier fälschlich
        // erneut `createCategory()` statt des Löschversuchs aufrufen lässt.
        isOffline = false
        Task {
            do {
                try await state.deleteContactCategory(id: cat.id, confirm: confirm)
            } catch let inUse as ContactCategoryInUseError {
                if confirm {
                    // Sollte nach explizitem `confirm: true` nicht mehr
                    // auftreten — Fail-Safe für einen Wettlauf mit einem
                    // anderen Gerät (z.B. neuer Infoblock zwischen den
                    // beiden Aufrufen angelegt).
                    blockedDeleteMessage = inUse.errorDescription
                } else {
                    forceDeleteUsageCount = inUse.usageCount
                    forceDeleteCandidate = cat
                }
            } catch let protectedErr as ContactCategoryProtectedError {
                blockedDeleteMessage = protectedErr.errorDescription
            } catch {
                self.error = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : error.localizedDescription
            }
            deleting = false
        }
    }
}
