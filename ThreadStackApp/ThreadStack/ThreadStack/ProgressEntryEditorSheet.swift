//
//  ProgressEntryEditorSheet.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): Sheet zum Bearbeiten eines
//  BESTEHENDEN Zwischenstands (Rich Text). Nutzt AUSSCHLIESSLICH die
//  bestehende Editor-Komponentenfamilie aus dem Wissens-Editor
//  (`KnowledgeEditorController` + `KnowledgeEditorWebView` +
//  `KnowledgeEditorToolbar`, siehe `KnowledgeEditorView.swift` als
//  Referenzintegration) — kein neuer Editor, keine eigene WKWebView-Bridge.
//  Bilder sind für Zwischenstände serverseitig verboten, daher
//  `KnowledgeEditorToolbar(..., showImageButton: false)`.
//
//  Arbeitspaket A1 (UX-Nachbesserung "Zielbild und Fortschrittsverlauf"):
//  auf "nur Bearbeiten" verengt — das Neuanlegen eines Zwischenstands läuft
//  jetzt ausschließlich über den immer sichtbaren Composer
//  (`ProgressEntryComposerView.swift`), der bisherige `Mode.create`-Zweig
//  entfällt ersatzlos (siehe dortiger Datei-Kopfkommentar).
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Zeichenzähler-/Grenzwertlogik für den Zwischenstand-Inhalt, getrennt vom
/// View-Body. Grenze (5000, gemessen am reinen Textinhalt ohne HTML-Markup —
/// vgl. `KnowledgeEditorController.contentLength`) wird serverseitig final
/// durchgesetzt (`ProgressError.tooLong`); hier nur UX-Komfort.
enum ProgressEntryCharLimit {
    static let warnThreshold = 4500
    static let maxLength = 5000

    static func shouldShowCounter(length: Int) -> Bool {
        length >= warnThreshold
    }

    /// `true`, wenn die aktuelle Länge das serverseitige Limit überschreitet
    /// (exakt `maxLength` ist noch erlaubt, Randfall siehe Tests).
    static func isOverLimit(length: Int) -> Bool {
        length > maxLength
    }

    /// Speichern ist deaktiviert, solange der Editor leer ist oder das Limit
    /// überschritten wird. `contentLength` stammt aus
    /// `KnowledgeEditorController.contentLength` (vom JS-Editor gemeldete
    /// Textlänge).
    static func isSaveDisabled(contentLength: Int) -> Bool {
        contentLength <= 0 || isOverLimit(length: contentLength)
    }

    /// Zusätzliche, serverseitig-äquivalente Leer-/Whitespace-Prüfung direkt
    /// auf dem tatsächlich geladenen HTML-Inhalt — Fail-Safe für den Fall,
    /// dass der Editor eine nur aus Leerraum/leeren Absätzen bestehende
    /// Formatierung als `contentLength > 0` meldet (z.B. `<p>&nbsp;</p>`).
    /// Wird beim tatsächlichen Speichern zusätzlich zur Button-Deaktivierung
    /// geprüft (siehe `save()` unten).
    static func isEffectivelyEmpty(html: String) -> Bool {
        stripHTML(html).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - View

struct ProgressEntryEditorSheet: View {
    let entry: ProgressEntry
    let refType: String
    let refId: String
    @ObservedObject var store: ProgressStore
    /// Wird nach erfolgreichem Speichern aufgerufen, bevor das Sheet
    /// schließt — analog zu `KnowledgeEditorView.onSaved`.
    var onSaved: (() -> Void)? = nil

    init(entry: ProgressEntry, refType: String, refId: String, store: ProgressStore, onSaved: (() -> Void)? = nil) {
        self.entry = entry
        self.refType = refType
        self.refId = refId
        self.store = store
        self.onSaved = onSaved
    }

    @Environment(\.dismiss) private var dismiss
    @StateObject private var controller = KnowledgeEditorController()

    @State private var contentToLoad: String = ""
    @State private var contentLoaded = false
    @State private var loading = false
    @State private var errorText: String?
    /// Links sind (anders als Bilder) für Zwischenstände serverseitig NICHT
    /// verboten (siehe `lib/progress/sanitize.js`: nur `img`/`video`/`audio`/
    /// `source` werden entfernt, `a` bleibt über die geteilte Knowledge-
    /// Allowlist erlaubt) — daher wird das bestehende Link-Einfüge-Sheet
    /// (`KnowledgeLinkInsertSheet`, bereits für exakt diesen
    /// Controller/Bridge-Typ gebaut) unverändert wiederverwendet.
    @State private var showLinkSheet = false

    #if os(iOS)
    @State private var measuredEditorHeight: CGFloat = 240
    #endif

    private var navigationTitleText: String { "Zwischenstand bearbeiten" }

    private var goalExcerpt: String? {
        let goal = store.detail(refType: refType, refId: refId)?.goal.trimmingCharacters(in: .whitespacesAndNewlines)
        return (goal?.isEmpty ?? true) ? nil : goal
    }

    /// Letzter (vorhandener) Zwischenstand als Kontext-Auszug — der gerade
    /// bearbeitete Eintrag wird dabei selbst ausgeschlossen, damit der
    /// Kontext wirklich den VORHERIGEN Stand zeigt.
    private var previousEntryExcerpt: String? {
        let candidate = store.entries(refType: refType, refId: refId).first { $0.id != entry.id }
        guard let candidate, !candidate.excerpt.isEmpty else { return nil }
        return candidate.excerpt
    }

    private var saveDisabled: Bool {
        loading || ProgressEntryCharLimit.isSaveDisabled(contentLength: controller.contentLength)
    }

    var body: some View {
        NavigationStack {
            Form {
                if goalExcerpt != nil || previousEntryExcerpt != nil {
                    Section("Kontext") {
                        if let goalExcerpt {
                            Label(goalExcerpt, systemImage: "target")
                                .scaledFont(.footnote).foregroundStyle(.secondary)
                                .accessibilityLabel("Zielbild: \(goalExcerpt)")
                        }
                        if let previousEntryExcerpt {
                            Label(previousEntryExcerpt, systemImage: "clock.arrow.circlepath")
                                .scaledFont(.footnote).foregroundStyle(.secondary).lineLimit(3)
                                .accessibilityLabel("Letzter Zwischenstand: \(previousEntryExcerpt)")
                        }
                    }
                }

                Section("Zwischenstand") {
                    KnowledgeEditorToolbar(
                        controller: controller,
                        onInsertLinkTapped: { showLinkSheet = true },
                        onImagePicked: { _ in },
                        showImageButton: false
                    )
                    #if os(iOS)
                    KnowledgeEditorWebView(controller: controller, measuredHeight: $measuredEditorHeight)
                        .frame(height: max(160, measuredEditorHeight))
                    #else
                    KnowledgeEditorWebView(controller: controller)
                        .frame(minHeight: 240)
                    #endif
                    if ProgressEntryCharLimit.shouldShowCounter(length: controller.contentLength) {
                        Text("\(controller.contentLength) / \(ProgressEntryCharLimit.maxLength)")
                            .scaledFont(.caption)
                            .foregroundStyle(ProgressEntryCharLimit.isOverLimit(length: controller.contentLength) ? .red : .secondary)
                            .accessibilityLabel("\(controller.contentLength) von \(ProgressEntryCharLimit.maxLength) Zeichen")
                    }
                }

                if let errorText {
                    Section {
                        Text(errorText).scaledFont(.footnote).foregroundStyle(.red)
                            .accessibilityLabel(errorText)
                    }
                }
            }
            .navigationTitle(navigationTitleText)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        performSave()
                    } label: {
                        if loading { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel("Speichern")
                }
            }
            .task {
                contentToLoad = entry.bodyHtml
            }
            .onChange(of: controller.isReady) { _, ready in
                guard ready else { contentLoaded = false; return }
                Task {
                    await controller.setContent(contentToLoad)
                    contentLoaded = true
                }
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
        // Fail-Safe gegen "leer, aber contentLength > 0" (siehe Doku oben) —
        // Text bleibt im Editor erhalten, kein Datenverlust.
        guard !ProgressEntryCharLimit.isEffectivelyEmpty(html: html) else {
            errorText = ProgressError.empty.errorDescription
            return
        }
        do {
            _ = try await store.updateEntry(refType: refType, refId: refId, entryId: entry.id, bodyHTML: html)
            onSaved?()
            dismiss()
        } catch {
            // Inhalt bleibt im Editor (kein Datenverlust) — Fehler inline.
            errorText = (error as? ProgressError)?.errorDescription ?? error.localizedDescription
        }
    }
}
