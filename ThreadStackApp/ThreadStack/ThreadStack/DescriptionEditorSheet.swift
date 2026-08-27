//
//  DescriptionEditorSheet.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI Fortschritt und Bearbeiten"): Bearbeiten-Sheet für
//  die Beschreibung eines Todos/Themas (Rich Text). Nutzt AUSSCHLIESSLICH die
//  bestehende Editor-Komponentenfamilie — `KnowledgeEditorController` +
//  `KnowledgeEditorWebView` + `KnowledgeEditorToolbar` + `KnowledgeLinkInsertSheet`
//  — exakt wie `ProgressEntryEditorSheet.swift` (Referenzintegration laut
//  Vertrag, Schnittstelle 13). Kein neuer Editor, keine eigene WKWebView-
//  Bridge, kein Weiterbetrieb des früheren `stripHTML`-Klartextpfads
//  (das war die zentrale Bug-Behebung dieses Pakets, siehe `TodoFormView.swift`/
//  `TopicFormView.swift`: die Beschreibung wurde dort bislang als Klartext
//  editiert und bearbeitete Formatierung dabei still zerstört).
//
//  Anders als beim Zwischenstand sind Bilder für die Beschreibung NICHT
//  verboten (`KnowledgeEditorToolbar(showImageButton: true)`), und eine leere
//  Beschreibung ist ein gültiger, gewollter Zustand (Speichern bleibt bei
//  leerem Inhalt aktiviert — anders als beim Zwischenstand, der laut eigenem
//  Vertrag nie leer gespeichert werden darf).
//
//  `DescriptionRichTextEditor` unten kapselt den reinen Editor-Kern (Toolbar +
//  WebView + Link-Sheet, ohne Navigation-Chrome/Speichern) und wird sowohl von
//  diesem Sheet als auch INLINE beim Neuanlegen eines Todos/Themas
//  wiederverwendet (dort ist die Beschreibung sofort editierbar, kein
//  Stift-Klick nötig, siehe `TodoFormView`/`TopicFormView`) — verhindert eine
//  zweite, abweichende Editor-Integration für denselben Zweck (CLAUDE.md
//  "Wiederverwendung vor Neuentwicklung").
//

import SwiftUI

// MARK: - Reiner Editor-Kern (wiederverwendbar: Sheet + Inline-Neuanlage)

/// Toolbar + WebView + Link-Einfüge-Sheet für die Beschreibungs-Bearbeitung,
/// OHNE eigenen `NavigationStack`/Speichern-Button — der Aufrufer (dieses
/// Sheet ODER die Inline-Einbettung beim Neuanlegen) bestimmt den Rahmen.
struct DescriptionRichTextEditor: View {
    @ObservedObject var controller: KnowledgeEditorController

    @State private var showLinkSheet = false
    #if os(iOS)
    @State private var measuredEditorHeight: CGFloat = 200
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            KnowledgeEditorToolbar(
                controller: controller,
                onInsertLinkTapped: { showLinkSheet = true },
                onImagePicked: { result in
                    Task { try? await controller.insertImage(dataURL: result.dataURL, alt: result.alt) }
                },
                showImageButton: true
            )
            #if os(iOS)
            KnowledgeEditorWebView(controller: controller, measuredHeight: $measuredEditorHeight)
                .frame(height: max(160, measuredEditorHeight))
            #else
            KnowledgeEditorWebView(controller: controller)
                .frame(minHeight: 200)
            #endif
        }
        .sheet(isPresented: $showLinkSheet) {
            KnowledgeLinkInsertSheet(selectedText: controller.state.selectedText) { result in
                Task {
                    try? await controller.insertLink(
                        href: result.href, text: result.text, summaryParagraphs: result.summaryParagraphs
                    )
                }
            }
        }
    }
}

// MARK: - Sheet

struct DescriptionEditorSheet: View {
    let initialHTML: String
    let title: String
    var onSave: (String) async throws -> Void

    init(initialHTML: String, title: String, onSave: @escaping (String) async throws -> Void) {
        self.initialHTML = initialHTML
        self.title = title
        self.onSave = onSave
    }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var controller = KnowledgeEditorController()

    @State private var contentLoaded = false
    @State private var loading = false
    @State private var errorText: String?
    /// Wird `true`, sobald sich der Editor-Inhalt NACH dem initialen Laden
    /// ändert — steuert die Verwerfen-Rückfrage beim Schließen, analog zum
    /// bereits bestehenden Muster in `KnowledgeEditorView.swift`
    /// (`isDirty`/`.onChange(of: controller.contentLength)`).
    @State private var isDirty = false
    @State private var showDiscardConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DescriptionRichTextEditor(controller: controller)
                }
                if let errorText {
                    Section {
                        Text(errorText).scaledFont(.footnote).foregroundStyle(.red)
                            .accessibilityLabel(errorText)
                    }
                }
            }
            .navigationTitle(title)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { handleCancelTapped() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        performSave()
                    } label: {
                        if loading { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(loading)
                    .accessibilityLabel("Speichern")
                }
            }
            .onChange(of: controller.isReady) { _, ready in
                guard ready else { contentLoaded = false; return }
                Task {
                    await controller.setContent(initialHTML)
                    contentLoaded = true
                    // Fokus + Cursor ans Textende beim Öffnen (Story 5). Best
                    // effort: die geteilte JS-Bridge (`window.TSEditor.focus`,
                    // außerhalb der Eigentümerschaft dieses Pakets) fokussiert
                    // den Editor; die genaue Cursor-Position folgt dem
                    // Standardverhalten von `contentEditable.focus()` der
                    // WebView.
                    await controller.focus()
                }
            }
            .onChange(of: controller.contentLength) { _, _ in
                if contentLoaded { isDirty = true }
            }
        }
        .interactiveDismissDisabled(isDirty)
        .confirmationDialog(
            "Änderungen verwerfen? Deine Bearbeitung der Beschreibung ist noch nicht gespeichert.",
            isPresented: $showDiscardConfirm,
            titleVisibility: .visible
        ) {
            Button("Änderungen verwerfen", role: .destructive) { dismiss() }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
    }

    private func handleCancelTapped() {
        if isDirty {
            showDiscardConfirm = true
        } else {
            dismiss()
        }
    }

    private func performSave() {
        guard !loading else { return }
        errorText = nil
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
        do {
            html = try await controller.content()
        } catch {
            errorText = "Der Editor antwortet nicht. Bitte erneut versuchen."
            return
        }
        do {
            try await onSave(html)
            isDirty = false
            dismiss()
        } catch {
            // Inhalt bleibt im Editor erhalten (kein Datenverlust) — Fehler
            // inline, konsistent mit dem bestehenden Fehler-Muster in
            // `TodoFormView`/`TopicFormView` (`error.localizedDescription`),
            // keine internen Details wie Stacktraces (siehe Sicherheits-Baseline).
            errorText = error.localizedDescription
        }
    }
}
