//
//  KnowledgeEditorView.swift
//  ThreadStack
//
//  Arbeitspaket 6 ("knowledge-editor-view"): Integrations-Screen für den
//  nativen Rich-Text-Editor für Wissen. Führt die Bausteine der Pakete 1-5
//  zusammen (API/Draft-Store, Bridge/Toolbar-Controller, Link-Sheet,
//  Bild-Picker, Topic-/Verwandtes-Wissen-Picker). Wird vom Aufrufer
//  (Paket 7) als `.sheet { KnowledgeEditorView(mode: ...) }` präsentiert.
//
//  Sicherheits-Baseline: kein Wissensinhalt in Logs; HTML wird ausschließlich
//  über die bestehenden Bridge-Methoden (`controller.insertLink`/`insertImage`,
//  Paket 2 — escapen intern) eingefügt, hier wird selbst kein HTML gebaut.
//  Entwürfe werden strikt über `KnowledgeDraftStore` mit der eingeloggten
//  `AppState.currentUser.id` isoliert.
//

import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct KnowledgeEditorView: View {

    enum Mode: Equatable {
        case create(presetThemeId: String?)
        case edit(KnowledgePage)
    }

    let mode: Mode
    var onSaved: ((KnowledgePage) -> Void)? = nil

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var controller = KnowledgeEditorController()
    private let coordinator: KnowledgeSaveCoordinator

    // MARK: - Editable state

    @State private var internalMode: Mode
    @State private var title: String
    @State private var themeIds: Set<String>
    @State private var relatedPageIds: Set<String>
    @State private var contentToLoad: String
    @State private var baseUpdatedAt: String?
    @State private var currentPageId: String?

    @State private var isDirty = false
    @State private var contentLoaded = false

    #if os(iOS)
    @State private var measuredEditorHeight: CGFloat = 320
    #endif

    // MARK: - Save state

    @State private var isSaving = false
    @State private var saveTask: Task<Void, Never>?
    @State private var titleErrorText: String?
    @State private var errorBanner: ErrorBanner?
    @State private var partialFailureBanner: PartialFailureBanner?

    // MARK: - Draft state

    @State private var pendingDraft: KnowledgeDraft?
    @State private var showDraftBanner = false

    // MARK: - Sheets

    @State private var showTopicPicker = false
    @State private var showRelatedPicker = false
    @State private var showLinkSheet = false
    @State private var showDiscardConfirm = false

    // MARK: - Init

    init(mode: Mode, onSaved: ((KnowledgePage) -> Void)? = nil) {
        self.mode = mode
        self.onSaved = onSaved
        _internalMode = State(initialValue: mode)

        switch mode {
        case .create(let presetThemeId):
            let themes: Set<String> = presetThemeId.map { [$0] } ?? []
            _title = State(initialValue: "")
            _themeIds = State(initialValue: themes)
            _relatedPageIds = State(initialValue: [])
            _contentToLoad = State(initialValue: "")
            _baseUpdatedAt = State(initialValue: nil)
            _currentPageId = State(initialValue: nil)
            coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: themes, initialLinks: [])

        case .edit(let page):
            let themes = Set(page.themeIds)
            _title = State(initialValue: page.title)
            _themeIds = State(initialValue: themes)
            _relatedPageIds = State(initialValue: Set(page.relatedPageIds))
            _contentToLoad = State(initialValue: page.content)
            _baseUpdatedAt = State(initialValue: page.updatedAt)
            _currentPageId = State(initialValue: page.id)
            coordinator = KnowledgeSaveCoordinator(pageId: page.id, initialThemeIds: themes, initialLinks: [])
        }
    }

    // MARK: - Derived

    private var userId: String { appState.currentUser?.id ?? "" }

    private var navigationTitleText: String {
        switch internalMode {
        case .create: return "Neues Wissen"
        case .edit: return "Wissen bearbeiten"
        }
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var saveDisabled: Bool { trimmedTitle.isEmpty || isSaving }

    private var draftLookupPageId: String? {
        switch mode {
        case .create: return nil
        case .edit(let page): return page.id
        }
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            Form {
                if showDraftBanner {
                    draftBannerSection
                }
                if let errorBanner {
                    errorBannerSection(errorBanner)
                }
                if let partialFailureBanner {
                    partialFailureSection(partialFailureBanner)
                }

                Section {
                    TextField("Überschrift", text: $title)
                        .onChange(of: title) { _, _ in
                            isDirty = true
                            if !trimmedTitle.isEmpty { titleErrorText = nil }
                        }
                    if let titleErrorText {
                        Text(titleErrorText)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityLabel(titleErrorText)
                    }
                }

                Section {
                    KnowledgeEditorToolbar(
                        controller: controller,
                        onInsertLinkTapped: { showLinkSheet = true },
                        onImagePicked: { result in
                            Task {
                                try? await controller.insertImage(dataURL: result.dataURL, alt: result.alt)
                                isDirty = true
                            }
                        }
                    )
                    #if os(iOS)
                    KnowledgeEditorWebView(controller: controller, measuredHeight: $measuredEditorHeight)
                        .frame(height: max(200, measuredEditorHeight))
                    #else
                    KnowledgeEditorWebView(controller: controller)
                        .frame(minHeight: 320)
                    #endif
                }

                topicsSection
                relatedSection
            }
            .navigationTitle(navigationTitleText)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { handleCancelTapped() }
                        .accessibilityLabel("Abbrechen")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        performSave()
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Speichern")
                        }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel("Speichern")
                }
            }
        }
        .interactiveDismissDisabled(isDirty)
        .confirmationDialog(
            "Änderungen verwerfen? Deine Bearbeitung ist noch nicht gespeichert.",
            isPresented: $showDiscardConfirm,
            titleVisibility: .visible
        ) {
            Button("Änderungen verwerfen", role: .destructive) { dismiss() }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
        .sheet(isPresented: $showLinkSheet) {
            KnowledgeLinkInsertSheet(selectedText: controller.state.selectedText) { result in
                Task {
                    try? await controller.insertLink(
                        href: result.href, text: result.text, summaryParagraphs: result.summaryParagraphs
                    )
                    isDirty = true
                }
            }
        }
        .sheet(isPresented: $showTopicPicker) {
            KnowledgeTopicPickerSheet(initialSelection: themeIds) { selection in
                themeIds = selection
                isDirty = true
            }
        }
        .sheet(isPresented: $showRelatedPicker) {
            KnowledgeRelatedPickerSheet(currentPageId: currentPageId, alreadyLinked: relatedPageIds) { hit in
                relatedPageIds.insert(hit.id)
                isDirty = true
            }
        }
        .task { await onAppear() }
        .task { await autoSaveDraftLoop() }
        .onChange(of: controller.isReady) { _, ready in
            // Feuert nicht nur beim ersten Laden, sondern auch erneut nach
            // einem Web-Content-Prozess-Crash (handleWebContentProcessTerminated()
            // setzt isReady zurueck, der automatische Reload setzt es wieder auf
            // true) — in dem Fall MUSS der zuletzt bekannte Inhalt erneut
            // injiziert werden, sonst bliebe der Editor nach dem Crash leer.
            // `contentToLoad` wird dafuer bei jedem erfolgreichen content()-Lesen
            // (Autosave/Speichern) aktuell gehalten, siehe unten.
            guard ready else { return }
            Task {
                await controller.setContent(contentToLoad)
                contentLoaded = true
            }
        }
        .onChange(of: controller.contentLength) { _, _ in
            if contentLoaded { isDirty = true }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase != .active else { return }
            Task { await autoSaveDraftNow() }
        }
    }

    // MARK: - Sections

    private var topicsSection: some View {
        Section("Zugehörige Topics") {
            Button {
                showTopicPicker = true
            } label: {
                HStack {
                    Text(topicsSummaryText)
                        .foregroundStyle(themeIds.isEmpty ? .secondary : .primary)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                }
            }
            .accessibilityLabel("Zugehörige Topics: \(topicsSummaryText)")
            .accessibilityHint("Öffnet die Topic-Auswahl.")
        }
    }

    private var topicsSummaryText: String {
        guard !themeIds.isEmpty else { return "Keine Topics ausgewählt" }
        let titles = themeIds.compactMap { id in appState.themes.first(where: { $0.id == id })?.title }
        return titles.isEmpty ? "\(themeIds.count) Topic(s)" : titles.joined(separator: ", ")
    }

    private var relatedSection: some View {
        Section("Verwandtes Wissen") {
            if currentPageId == nil {
                Text("Verknüpfen erst nach dem ersten Speichern möglich.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                if !relatedPageIds.isEmpty {
                    ForEach(Array(relatedPageIds).sorted(), id: \.self) { id in
                        HStack {
                            Text(relatedTitle(for: id))
                            Spacer()
                            Button {
                                relatedPageIds.remove(id)
                                isDirty = true
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(relatedTitle(for: id)) entfernen")
                        }
                    }
                }
                Button {
                    showRelatedPicker = true
                } label: {
                    Label("Wissen verknüpfen", systemImage: "link.badge.plus")
                }
                .accessibilityLabel("Wissen verknüpfen")
            }
        }
    }

    private func relatedTitle(for id: String) -> String {
        appState.knowledgePages.first(where: { $0.id == id })?.title ?? id
    }

    @ViewBuilder
    private var draftBannerSection: some View {
        Section {
            Text("Ungespeicherter Entwurf gefunden – möchtest du weiterschreiben?")
                .font(.footnote)
            HStack {
                Button("Wiederherstellen") { restoreDraft() }
                Spacer()
                Button("Verwerfen", role: .destructive) { discardDraftBanner() }
            }
        }
    }

    @ViewBuilder
    private func errorBannerSection(_ banner: ErrorBanner) -> some View {
        Section {
            Text(banner.message)
                .font(.footnote)
                .foregroundStyle(.red)
                .accessibilityLabel(banner.message)
            if case .pageGone = banner {
                HStack {
                    Button("Text kopieren") { Task { await copyContentToClipboard() } }
                    Spacer()
                    Button("Als neue Seite anlegen") { convertToNewPage() }
                }
            }
        }
    }

    @ViewBuilder
    private func partialFailureSection(_ banner: PartialFailureBanner) -> some View {
        Section {
            Text(banner.message)
                .font(.footnote)
                .foregroundStyle(.orange)
                .accessibilityLabel(banner.message)
            Button("Erneut versuchen") { performSave() }
                .disabled(isSaving)
        }
    }

    // MARK: - Appear / draft

    private func onAppear() async {
        if let draft = KnowledgeDraftStore.load(pageId: draftLookupPageId, userId: userId) {
            pendingDraft = draft
            showDraftBanner = true
        }
        if case .edit(let page) = mode {
            if let links = try? await appState.knowledgeLinks(pageId: page.id) {
                coordinator.setInitialLinks(links.map {
                    KnowledgeSaveCoordinator.LinkRef(linkId: $0.linkId, targetPageId: $0.page.id)
                })
            }
        }
    }

    private func restoreDraft() {
        guard let pendingDraft else { return }
        title = pendingDraft.title
        themeIds = Set(pendingDraft.themeIds)
        relatedPageIds = Set(pendingDraft.relatedPageIds)
        contentToLoad = pendingDraft.contentHTML
        isDirty = true
        showDraftBanner = false
        if controller.isReady {
            Task {
                await controller.setContent(contentToLoad)
                contentLoaded = true
            }
        }
    }

    private func discardDraftBanner() {
        KnowledgeDraftStore.delete(pageId: draftLookupPageId, userId: userId)
        pendingDraft = nil
        showDraftBanner = false
    }

    // MARK: - Autosave

    private func autoSaveDraftLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if Task.isCancelled { break }
            await autoSaveDraftNow()
        }
    }

    private func autoSaveDraftNow() async {
        guard isDirty, !isSaving, controller.isReady else { return }
        guard let contentHTML = try? await controller.content() else { return }
        contentToLoad = contentHTML
        let draft = KnowledgeDraft(
            pageId: currentPageId,
            title: title,
            contentHTML: contentHTML,
            themeIds: Array(themeIds),
            relatedPageIds: Array(relatedPageIds),
            baseUpdatedAt: baseUpdatedAt,
            savedAt: Date()
        )
        try? KnowledgeDraftStore.save(draft, userId: userId)
    }

    // MARK: - Cancel

    private func handleCancelTapped() {
        if isDirty {
            showDiscardConfirm = true
        } else {
            dismiss()
        }
    }

    // MARK: - Save

    private func performSave() {
        guard !isSaving else { return }
        guard !trimmedTitle.isEmpty else {
            titleErrorText = "Überschrift erforderlich"
            return
        }
        titleErrorText = nil
        partialFailureBanner = nil
        saveTask?.cancel()
        saveTask = Task { await doSave() }
    }

    @MainActor
    private func doSave() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        errorBanner = nil

        // Nach einer Terminierung des Web-Content-Prozesses laedt die WebView
        // still neu und ist dann kurzzeitig nicht "ready" (siehe
        // handleWebContentProcessTerminated()) — content() selbst prueft nur,
        // ob ueberhaupt eine WebView existiert, wuerde in diesem Fenster also
        // erfolgreich einen LEEREN String liefern. Ohne diese Pruefung wuerde
        // ein Speichern-Aufruf in genau diesem Moment den Editorinhalt still
        // durch nichts ersetzen.
        guard controller.isReady else {
            errorBanner = .bridgeUnavailable
            return
        }

        let contentHTML: String
        do {
            contentHTML = try await controller.content()
            contentToLoad = contentHTML
        } catch {
            errorBanner = .bridgeUnavailable
            return
        }

        // Der Autosave-Schluessel folgt currentPageId, das sich durch
        // convertToNewPage() (KNOWLEDGE_PAGE_GONE-Fluss) vom unveraenderlichen
        // draftLookupPageId (folgt `mode`) loesen kann — vor der Mutation
        // unten sichern, damit nach Erfolg wirklich der Schluessel geloescht
        // wird, unter dem zuletzt tatsaechlich autosaved wurde.
        let draftKeyBeforeSave = currentPageId

        do {
            let outcome = try await coordinator.save(
                title: title,
                content: contentHTML,
                themeIds: Array(themeIds),
                relatedPageIds: Array(relatedPageIds),
                operations: appState.asKnowledgeSaveCoordinatorOperations()
            )
            currentPageId = outcome.pageId

            if outcome.themesFailed || outcome.linksFailed {
                partialFailureBanner = PartialFailureBanner(themesFailed: outcome.themesFailed, linksFailed: outcome.linksFailed)
                return
            }

            partialFailureBanner = nil
            if let page = await appState.reloadKnowledgePage(id: outcome.pageId) {
                // Drei moegliche Autosave-Schluessel raeumen: der urspruengliche
                // (draftLookupPageId, aus `mode` abgeleitet), der zuletzt aktive
                // vor diesem Save (draftKeyBeforeSave, kann durch
                // convertToNewPage() abweichen) und der neue Server-Schluessel —
                // sonst bleibt ein Entwurf mit vollem Inhalt liegen und wird der
                // naechsten neuen Seite faelschlich als wiederherstellbar
                // angeboten.
                KnowledgeDraftStore.delete(pageId: draftLookupPageId, userId: userId)
                KnowledgeDraftStore.delete(pageId: draftKeyBeforeSave, userId: userId)
                KnowledgeDraftStore.delete(pageId: outcome.pageId, userId: userId)
                isDirty = false
                onSaved?(page)
                dismiss()
            } else {
                // Konnte die eben gespeicherte Seite nicht neu laden (Netzwerk
                // oder — selten — Löschung durch ein anderes Gerät im selben
                // Moment). Kein Datenverlust: der Server hat den Inhalt bereits,
                // ein erneuter "Speichern"-Tap wiederholt (idempotent) PUT +
                // Reload.
                errorBanner = .unknown
            }
        } catch let e as KnowledgeAPIError {
            handleKnowledgeAPIError(e, contentHTML: contentHTML)
        } catch APIError.unauthorized {
            await persistDraftBestEffort(contentHTML: contentHTML)
            errorBanner = .unauthorized
        } catch APIError.network {
            errorBanner = .network
        } catch is KnowledgeEditorError {
            errorBanner = .bridgeUnavailable
        } catch {
            errorBanner = .unknown
        }
    }

    private func handleKnowledgeAPIError(_ error: KnowledgeAPIError, contentHTML: String) {
        switch error.code {
        case KnowledgeErrorCode.titleRequired:
            titleErrorText = "Überschrift erforderlich"
        case KnowledgeErrorCode.titleTooLong:
            errorBanner = .custom("Überschrift darf höchstens 300 Zeichen lang sein.")
        case KnowledgeErrorCode.contentTooLong:
            errorBanner = .custom("Inhalt zu lang. Bitte kürze den Text, damit er gespeichert werden kann.")
        default:
            if error.isGone {
                errorBanner = .pageGone
            } else {
                errorBanner = .unknown
            }
        }
    }

    private func persistDraftBestEffort(contentHTML: String) async {
        let draft = KnowledgeDraft(
            pageId: currentPageId,
            title: title,
            contentHTML: contentHTML,
            themeIds: Array(themeIds),
            relatedPageIds: Array(relatedPageIds),
            baseUpdatedAt: baseUpdatedAt,
            savedAt: Date()
        )
        try? KnowledgeDraftStore.save(draft, userId: userId)
    }

    // MARK: - KNOWLEDGE_PAGE_GONE-Aktionen

    @MainActor
    private func copyContentToClipboard() async {
        // Der aktuelle Editorinhalt (nicht der beim Öffnen geladene Stand) ist
        // die eigentliche Rettungsaktion hier — fällt der Bridge-Aufruf aus,
        // wird ersatzweise der zuletzt geladene/wiederhergestellte Stand
        // verwendet, statt gar nichts zu kopieren.
        let liveContent = try? await controller.content()
        let plainText = title + "\n\n" + stripHTML(liveContent ?? contentToLoad)
        #if os(macOS)
        // .currentHostOnly haelt den Wissensinhalt vom geraeteuebergreifenden
        // Universal-Clipboard fern (analog .localOnly auf iOS).
        NSPasteboard.general.prepareForNewContents(with: .currentHostOnly)
        NSPasteboard.general.setString(plainText, forType: .string)
        #else
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: plainText]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]
        )
        #endif
    }

    private func convertToNewPage() {
        internalMode = .create(presetThemeId: nil)
        currentPageId = nil
        coordinator.resetForNewPage(themeIds: themeIds)
        errorBanner = nil
    }
}

// MARK: - Banner-Typen (reine UI-Textbausteine, exakte deutsche Texte gemäß UX-Vorgabe)

private enum ErrorBanner: Equatable {
    case custom(String)
    case pageGone
    case network
    case unauthorized
    case unknown
    case bridgeUnavailable

    var message: String {
        switch self {
        case .custom(let m): return m
        case .pageGone: return "Diese Wissensseite existiert nicht mehr."
        case .network: return "Netzwerkfehler. Server erreichbar?"
        case .unauthorized: return "Sitzung abgelaufen — bitte neu anmelden."
        case .unknown: return "Etwas ist schiefgelaufen. Bitte versuche es erneut."
        case .bridgeUnavailable: return "Der Editor antwortet nicht. Bitte erneut versuchen."
        }
    }
}

private struct PartialFailureBanner: Equatable {
    let themesFailed: Bool
    let linksFailed: Bool

    var message: String {
        switch (themesFailed, linksFailed) {
        case (true, true):
            return "Der Inhalt wurde gespeichert, die Topic-Zuordnung und die Verknüpfungen aber nicht übernommen."
        case (true, false):
            return "Der Inhalt wurde gespeichert, die Topic-Zuordnung aber nicht übernommen."
        case (false, true):
            return "Der Inhalt wurde gespeichert, die Verknüpfungen aber nicht übernommen."
        case (false, false):
            return ""
        }
    }
}
