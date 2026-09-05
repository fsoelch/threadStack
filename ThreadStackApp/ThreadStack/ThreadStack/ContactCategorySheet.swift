//
//  ContactCategorySheet.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): Verwaltung der
//  frei erweiterbaren Rubriken für Kontakt-Infoblöcke. Liste aller Rubriken
//  (`AppState.contactCategories`), Umbenennen inline, Löschen mit
//  Bestätigung — Startrubriken (`isDefault == true`) sind nicht löschbar.
//
//  Löschbestätigung: `ContactCategory.usageCount` ist bereits Teil des
//  Server-Vertrags (siehe `GET /api/contact-categories`) — der
//  Bestätigungstext kann damit VOR dem eigentlichen Löschversuch aus dem
//  bereits geladenen Zustand abgeleitet werden (kein zusätzlicher
//  Server-Roundtrip nötig). Der eigentliche `DELETE`-Aufruf bleibt trotzdem
//  gegen einen `409 category_in_use` abgesichert (Wettlauf mit einem anderen
//  Gerät, siehe `AppState.deleteContactCategory`/`ContactCategoryInUseError`).
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
                Section("Rubriken") {
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
            .accessibilityLabel("\(cat.label) umbenennen")

            if cat.isDefault != true {
                Button(role: .destructive) {
                    requestDelete(cat)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(cat.label) löschen")
            }
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

    /// Startrubriken werden gar nicht erst zum Löschen angeboten (siehe
    /// `categoryRow`). Wird die Rubrik bereits laut lokal bekanntem
    /// `usageCount` verwendet, wird — statt eines destruktiven Bestätigungs-
    /// dialogs — direkt der blockierende Hinweistext gezeigt (kein Löschen
    /// möglich, siehe Vertrag `409 category_in_use`).
    private func requestDelete(_ cat: ContactCategory) {
        if let count = cat.usageCount, count > 0 {
            blockedDeleteMessage = ContactCategoryInUseError(usageCount: count).errorDescription
        } else {
            deleteCandidate = cat
        }
    }

    private func performDelete() {
        guard let cat = deleteCandidate else { return }
        deleteCandidate = nil
        deleting = true
        Task {
            do { try await state.deleteContactCategory(id: cat.id) }
            catch let inUse as ContactCategoryInUseError {
                blockedDeleteMessage = inUse.errorDescription
            } catch {
                self.error = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : error.localizedDescription
            }
            deleting = false
        }
    }
}
