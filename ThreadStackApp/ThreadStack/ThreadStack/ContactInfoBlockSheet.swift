//
//  ContactInfoBlockSheet.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): Sheet zum
//  Anlegen/Bearbeiten eines benannten Infoblocks (Rubrik + Rich-Text) eines
//  Ansprechpartners. Wiederverwendet AUSSCHLIESSLICH die bestehende
//  Editor-Komponentenfamilie (`DescriptionRichTextEditor`, siehe
//  `DescriptionEditorSheet.swift`) — kein neuer Editor, keine eigene
//  WKWebView-Bridge (CLAUDE.md "Wiederverwendung vor Neuentwicklung").
//
//  Rubrik-Auswahl: natives `Menu` (Picker-Ersatz, da ein zusätzlicher
//  Menüpunkt "Neue Rubrik anlegen …" benötigt wird) über die global
//  gehaltenen `AppState.contactCategories`. Eine neue Rubrik wird inline per
//  `.alert` mit Textfeld angelegt (`AppState.createContactCategory`) und
//  direkt ausgewählt — kein Sprung in ein separates Verwaltungs-Sheet nötig.
//
//  Konflikt-Handling (Vertrag: `409 block_conflict` bei abweichendem
//  `expectedUpdatedAt`): eine dauerhaft sichtbare Inline-Sektion (bewusst
//  KEIN `.confirmationDialog`, dessen `isPresented`-Binding beim Schließen
//  den Konfliktzustand sonst unkontrolliert zurücksetzen würde) bietet die
//  drei geforderten Optionen "Anderen Stand ansehen" / "Meine Version
//  speichern" / "Verwerfen und neu laden".
//
//  Offline-/Fehlerfall (Story 14): Eingabe bleibt bei Fehlschlag im Editor
//  erhalten, Inline-Fehlermeldung mit "Erneut versuchen"-Button bei
//  Verbindungsfehlern (siehe `isTransportFailure` in `ContactsView.swift`) —
//  kein automatischer Verwurf, kein stiller Retry-Loop.
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Ob der "Speichern"-Button aktiv sein darf — braucht mindestens eine
/// ausgewählte Rubrik (der Editor selbst darf laut Vertrag auch leer
/// gespeichert werden können, analog zur Beschreibung in `TodoFormView`).
enum ContactInfoBlockSaveLogic {
    static func isSaveDisabled(categoryId: String, loading: Bool) -> Bool {
        loading || categoryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - View

struct ContactInfoBlockSheet: View {
    let contactId: String
    var block: ContactInfoBlock? = nil
    /// Aufgerufen nach erfolgreichem Speichern, bevor das Sheet schließt —
    /// der Aufrufer (`ContactDetailView`) nutzt das zum Neuladen der
    /// Infoblock-Liste.
    var onSaved: (() -> Void)? = nil

    init(contactId: String, block: ContactInfoBlock? = nil, onSaved: (() -> Void)? = nil) {
        self.contactId = contactId
        self.block = block
        self.onSaved = onSaved
    }

    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var controller = KnowledgeEditorController()

    @State private var categoryId = ""
    @State private var categoryLabel = ""
    @State private var expectedUpdatedAt = ""
    @State private var contentLoaded = false
    @State private var loading = false
    @State private var errorText: String?
    @State private var isOffline = false
    @State private var showNewCategoryPrompt = false
    @State private var newCategoryName = ""
    @State private var conflict: ContactInfoBlockConflictError?
    @State private var showConflictOtherVersion = false

    private var isNew: Bool { block == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section("Rubrik") {
                    categoryMenu
                }
                Section("Inhalt") {
                    DescriptionRichTextEditor(controller: controller)
                }
                if let conflict {
                    conflictSection(conflict)
                }
                if let errorText {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(errorText).scaledFont(.footnote).foregroundStyle(.red)
                                .accessibilityLabel(errorText)
                            if isOffline {
                                Button("Erneut versuchen") { performSave() }
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .navigationTitle(isNew ? "Neuer Infoblock" : "Infoblock bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        performSave()
                    } label: {
                        if loading { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(ContactInfoBlockSaveLogic.isSaveDisabled(categoryId: categoryId, loading: loading))
                    .accessibilityLabel("Speichern")
                }
            }
            .task { await state.loadContactCategories() }
            .onAppear { populate() }
            .onChange(of: controller.isReady) { _, ready in
                guard ready else { contentLoaded = false; return }
                Task {
                    await controller.setContent(block?.bodyHtml ?? "")
                    contentLoaded = true
                }
            }
            .alert("Neue Rubrik", isPresented: $showNewCategoryPrompt) {
                TextField("Name der Rubrik", text: $newCategoryName)
                Button("Anlegen") { createCategory() }
                Button("Abbrechen", role: .cancel) { newCategoryName = "" }
            }
            .sheet(isPresented: $showConflictOtherVersion) {
                NavigationStack {
                    Form {
                        Section {
                            HTMLContentView(html: conflict?.currentBlock.bodyHtml ?? "")
                        }
                    }
                    .navigationTitle("Anderer Stand")
                    .inlineTitle()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Schließen") { showConflictOtherVersion = false }
                        }
                    }
                }
            }
        }
    }

    private var categoryMenu: some View {
        Menu {
            ForEach(state.contactCategories) { cat in
                Button {
                    categoryId = cat.id
                    categoryLabel = cat.label
                } label: {
                    if categoryId == cat.id {
                        Label(cat.label, systemImage: "checkmark")
                    } else {
                        Text(cat.label)
                    }
                }
            }
            Divider()
            Button {
                newCategoryName = ""
                showNewCategoryPrompt = true
            } label: {
                Label("Neue Rubrik anlegen …", systemImage: "plus")
            }
        } label: {
            HStack {
                Text(categoryLabel.isEmpty ? "Rubrik wählen" : categoryLabel)
                    .foregroundStyle(categoryLabel.isEmpty ? .secondary : .primary)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Rubrik: \(categoryLabel.isEmpty ? "keine ausgewählt" : categoryLabel)")
        .accessibilityHint("Öffnet die Rubrik-Auswahl.")
    }

    @ViewBuilder
    private func conflictSection(_ conflict: ContactInfoBlockConflictError) -> some View {
        Section("Konflikt") {
            Text(conflict.errorDescription ?? "")
                .scaledFont(.footnote).foregroundStyle(.orange)
            Button("Anderen Stand ansehen") { showConflictOtherVersion = true }
            Button("Meine Version speichern") { Task { await forceSaveOverConflict(conflict) } }
            Button("Verwerfen und neu laden", role: .destructive) { Task { await discardAndReload(conflict) } }
        }
    }

    private func populate() {
        if let block {
            categoryId = block.categoryId
            categoryLabel = block.categoryLabel
            expectedUpdatedAt = block.updatedAt
        } else if categoryId.isEmpty, let first = state.contactCategories.first {
            categoryId = first.id
            categoryLabel = first.label
        }
    }

    private func createCategory() {
        let label = newCategoryName.trimmingCharacters(in: .whitespacesAndNewlines)
        newCategoryName = ""
        guard !label.isEmpty else { return }
        Task {
            do {
                let created = try await state.createContactCategory(label: label)
                categoryId = created.id
                categoryLabel = created.label
            } catch {
                errorText = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : error.localizedDescription
            }
        }
    }

    private func performSave() {
        guard !loading else { return }
        errorText = nil
        isOffline = false
        loading = true
        Task { await doSave() }
    }

    @MainActor
    private func doSave() async {
        defer { loading = false }
        guard controller.isReady, contentLoaded else {
            errorText = "Der Editor antwortet nicht. Bitte erneut versuchen."
            return
        }
        let html: String
        do { html = try await controller.content() }
        catch {
            errorText = "Der Editor antwortet nicht. Bitte erneut versuchen."
            return
        }
        do {
            if let block {
                _ = try await state.updateContactInfoBlock(
                    contactId: contactId, blockId: block.id,
                    categoryId: categoryId, categoryLabel: categoryLabel,
                    bodyHtml: html, expectedUpdatedAt: expectedUpdatedAt
                )
            } else {
                _ = try await state.createContactInfoBlock(
                    contactId: contactId, categoryId: categoryId,
                    categoryLabel: categoryLabel, bodyHtml: html
                )
            }
            onSaved?()
            dismiss()
        } catch let conflictError as ContactInfoBlockConflictError {
            conflict = conflictError
        } catch {
            handleSaveFailure(error)
        }
    }

    private func handleSaveFailure(_ error: Error) {
        if isTransportFailure(error) {
            isOffline = true
            errorText = "Keine Verbindung — deine Eingabe bleibt erhalten. Bitte erneut versuchen, sobald du wieder online bist."
        } else {
            errorText = error.localizedDescription
        }
    }

    private func forceSaveOverConflict(_ conflict: ContactInfoBlockConflictError) async {
        guard let block else { return }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            let html = (try? await controller.content()) ?? ""
            _ = try await state.updateContactInfoBlock(
                contactId: contactId, blockId: block.id,
                categoryId: categoryId, categoryLabel: categoryLabel,
                bodyHtml: html, expectedUpdatedAt: conflict.currentBlock.updatedAt
            )
            self.conflict = nil
            onSaved?()
            dismiss()
        } catch let newConflict as ContactInfoBlockConflictError {
            self.conflict = newConflict
        } catch {
            handleSaveFailure(error)
        }
    }

    private func discardAndReload(_ conflict: ContactInfoBlockConflictError) async {
        let fresh = conflict.currentBlock
        categoryId = fresh.categoryId
        categoryLabel = fresh.categoryLabel
        expectedUpdatedAt = fresh.updatedAt
        await controller.setContent(fresh.bodyHtml)
        self.conflict = nil
    }
}
