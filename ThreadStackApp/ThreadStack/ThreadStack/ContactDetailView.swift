//
//  ContactDetailView.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept", Story 14):
//  zentrale Bearbeiten-/Detailansicht eines BESTEHENDEN Ansprechpartners —
//  analog zur Informationsarchitektur von `TodoFormView`/`TopicFormView`
//  (Stammdaten direkt im Formular editierbar, Beschreibung inline per
//  Stift-Symbol über den bestehenden `DescriptionEditorSheet`). Ersetzt für
//  bestehende Kontakte den früheren `ContactFormView`-Bearbeiten-Modus (siehe
//  dortiger Datei-Kopfkommentar) — EINE Bearbeiten-Stelle für die
//  Basisfelder statt zwei divergierender Formulare.
//
//  Abschnittsreihenfolge (Vertrag): Stammdaten → Zusatzinformationen
//  (Infoblöcke, gruppiert nach der vom Server gelieferten `categories`-
//  Reihenfolge — NICHT selbst neu sortiert) → Notizen (bestehender
//  Zwischenstand-Mechanismus, `ProgressTimelineView` mit `refType: "contact"`)
//  → Zugeordnete Topics (`ThemeLinkSheet`) → Ist zuständig für
//  (`AssignmentTarget`-Liste).
//
//  Wiederverwendet ausschließlich bestehende Bausteine: `DescriptionReadView`/
//  `DescriptionEditorSheet` (Beschreibung), `HTMLContentView` (Infoblock-
//  Inhalt), `ProgressTimelineView`/`ProgressEntryComposerView`/
//  `ProgressReentryCardView` (Notizen), `ThemeLinkSheet` (Topic-Zuordnung),
//  `errorAlert` — kein neuer Editor/Dialog/Renderer.
//

import SwiftUI

// MARK: - Reine Logik (testbar)

enum ContactDetailLogic {
    /// "Privates" wird dezent/eingeklappt dargestellt (Datenschutz-Rücksicht,
    /// analog zum Web) — Erkennung über das Label, case-/whitespace-
    /// insensitiv, da Rubriken frei benennbar sind und es keine feste ID für
    /// diese eine besondere Rubrik gibt.
    static func isPrivateCategory(_ label: String) -> Bool {
        label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "privates"
    }

    /// Gruppiert Infoblöcke nach der vom Server gelieferten Rubrik-Reihenfolge
    /// (`categories`), OHNE selbst neu zu sortieren — nur die Zuordnung
    /// Rubrik → ihre Blöcke (in der bestehenden Array-Reihenfolge von
    /// `infoBlocks`) wird hier gebildet. Rubriken ohne (noch) sichtbaren Block
    /// werden übersprungen (keine leere Rubrik-Überschrift ohne Inhalt).
    static func grouped(infoBlocks: [ContactInfoBlock], categories: [ContactCategory]) -> [(category: ContactCategory, blocks: [ContactInfoBlock])] {
        categories.compactMap { cat in
            let blocks = infoBlocks.filter { $0.categoryId == cat.id }
            return blocks.isEmpty ? nil : (cat, blocks)
        }
    }

    /// Infoblöcke, deren `categoryId` in `categories` (noch) nicht vorkommt
    /// (z.B. kurz nach dem Anlegen einer neuen Rubrik, bevor der Kontakt neu
    /// geladen wurde) — dürfen nicht kommentarlos verschwinden.
    static func ungrouped(infoBlocks: [ContactInfoBlock], categories: [ContactCategory]) -> [ContactInfoBlock] {
        let known = Set(categories.map(\.id))
        return infoBlocks.filter { !known.contains($0.categoryId) }
    }
}

// MARK: - View

struct ContactDetailView: View {
    let contactId: String
    private let initialContact: Contact

    init(contact: Contact) {
        self.contactId = contact.id
        self.initialContact = contact
    }

    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore
    @Environment(\.dismiss) private var dismiss

    /// Immer der aktuelle Stand aus `state.contacts`, mit dem ursprünglich
    /// übergebenen Kontakt als Fallback (z.B. bevor der erste Reload
    /// abgeschlossen ist).
    private var contact: Contact {
        state.contacts.first(where: { $0.id == contactId }) ?? initialContact
    }

    // Stammdaten
    @State private var name = ""
    @State private var role = ""
    @State private var email = ""
    @State private var description = ""
    @State private var showDescriptionEditor = false
    @State private var savingBasics = false
    @State private var basicsError: String?
    @State private var basicsOffline = false

    // Zusatzinformationen (Infoblöcke)
    @State private var infoBlocks: [ContactInfoBlock] = []
    @State private var infoBlocksLoading = false
    @State private var infoBlocksError: String?
    @State private var showNewInfoBlock = false
    @State private var editingBlock: ContactInfoBlock?
    @State private var showCategorySheet = false
    @State private var privateExpanded = false

    // Zugeordnete Topics
    @State private var showTopicLinkSheet = false

    // Ist zuständig für
    @State private var assignmentTargets: [AssignmentTarget] = []
    @State private var assignmentsLoading = false
    @State private var assignmentsError: String?
    @State private var navigationTarget: AssignmentNavigationTarget?

    private enum AssignmentNavigationTarget: Identifiable {
        case todo(TodoItem)
        case topic(meetingId: String, topic: Topic)

        var id: String {
            switch self {
            case .todo(let t): return "todo:\(t.id)"
            case .topic(let mid, let t): return "topic:\(mid):\(t.id)"
            }
        }
    }

    private var isBasicsDirty: Bool {
        name.trimmingCharacters(in: .whitespaces) != contact.name ||
        role.trimmingCharacters(in: .whitespaces) != contact.role ||
        email.trimmingCharacters(in: .whitespaces) != contact.email ||
        description != contact.description
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Stammdaten") { stammdatenSection }
                Section(header: infoBlocksSectionHeader) { infoBlocksSection }
                Section("Notizen") { notesSection }
                Section("Zugeordnete Topics") { topicsSection }
                Section("Ist zuständig für") { assignmentsSection }
                if let basicsError {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(basicsError).scaledFont(.footnote).foregroundStyle(.red)
                            if basicsOffline {
                                Button("Erneut versuchen") { saveBasics() }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .navigationTitle(contact.name.isEmpty ? "Ansprechpartner" : contact.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saveBasicsAndClose()
                    } label: {
                        if savingBasics { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(savingBasics || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { populateBasics() }
            .task { await loadInfoBlocks() }
            .task { await loadAssignments() }
            .sheet(isPresented: $showDescriptionEditor) {
                DescriptionEditorSheet(initialHTML: description, title: "Beschreibung bearbeiten") { newHTML in
                    description = newHTML
                }
            }
            .sheet(isPresented: $showNewInfoBlock) {
                ContactInfoBlockSheet(contactId: contactId) {
                    Task { await refreshAfterInfoBlockChange() }
                }
            }
            .sheet(item: $editingBlock) { block in
                ContactInfoBlockSheet(contactId: contactId, block: block) {
                    Task { await refreshAfterInfoBlockChange() }
                }
            }
            .sheet(isPresented: $showCategorySheet) { ContactCategorySheet() }
            .sheet(isPresented: $showTopicLinkSheet) {
                ThemeLinkSheet(refType: "contact", refId: contactId, title: contact.name)
            }
            .sheet(item: $navigationTarget) { target in
                switch target {
                case .todo(let t): TodoFormView(todo: t)
                case .topic(let mid, let t): TopicFormView(meetingId: mid, topic: t)
                }
            }
        }
    }

    // MARK: - Stammdaten

    private var stammdatenSection: some View {
        Group {
            TextField("Name", text: $name).autocorrectionDisabled()
            TextField("Rolle / Funktion", text: $role)
            TextField("E-Mail", text: $email)
                .autocorrectionDisabled()
                .noAutocapitalize()
                #if os(iOS)
                .keyboardType(.emailAddress)
                #endif
            DescriptionReadView(html: description) { showDescriptionEditor = true }
        }
    }

    private func populateBasics() {
        name = contact.name
        role = contact.role
        email = contact.email
        description = contact.description
    }

    private func saveBasicsAndClose() {
        guard isBasicsDirty else { dismiss(); return }
        saveBasics()
    }

    private func saveBasics() {
        savingBasics = true
        basicsError = nil
        basicsOffline = false
        let cleanName  = name.trimmingCharacters(in: .whitespaces)
        let cleanRole  = role.trimmingCharacters(in: .whitespaces)
        let cleanEmail = email.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await state.updateContact(id: contactId, name: cleanName, role: cleanRole,
                                              email: cleanEmail, description: description)
                dismiss()
            } catch {
                if isTransportFailure(error) {
                    basicsOffline = true
                    basicsError = "Keine Verbindung — deine Eingabe bleibt erhalten. Bitte erneut versuchen, sobald du wieder online bist."
                } else {
                    basicsError = error.localizedDescription
                }
                savingBasics = false
            }
        }
    }

    // MARK: - Zusatzinformationen (Infoblöcke)

    private var infoBlocksSectionHeader: some View {
        HStack {
            Text("Zusatzinformationen")
            Spacer()
            Button { showNewInfoBlock = true } label: {
                Image(systemName: "plus.circle")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Infoblock hinzufügen")
            Button { showCategorySheet = true } label: {
                Image(systemName: "tag")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Rubriken verwalten")
        }
    }

    private var groupedInfoBlocks: [(category: ContactCategory, blocks: [ContactInfoBlock])] {
        ContactDetailLogic.grouped(infoBlocks: infoBlocks, categories: contact.categories ?? [])
    }

    private var ungroupedInfoBlocks: [ContactInfoBlock] {
        ContactDetailLogic.ungrouped(infoBlocks: infoBlocks, categories: contact.categories ?? [])
    }

    @ViewBuilder
    private var infoBlocksSection: some View {
        if infoBlocksLoading {
            ProgressView("Lädt Zusatzinformationen…").frame(maxWidth: .infinity).padding()
        } else if let infoBlocksError {
            VStack(spacing: 8) {
                Text(infoBlocksError).scaledFont(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Erneut versuchen") { Task { await loadInfoBlocks() } }.buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity).padding()
        } else if infoBlocks.isEmpty {
            Text("Noch keine Zusatzinformationen — tippe oben auf „+“, um die erste hinzuzufügen.")
                .scaledFont(.subheadline).foregroundStyle(.secondary)
        } else {
            ForEach(groupedInfoBlocks, id: \.category.id) { group in
                categoryGroup(group.category, group.blocks)
            }
            if !ungroupedInfoBlocks.isEmpty {
                categoryGroupPlain(label: "Weitere", blocks: ungroupedInfoBlocks, categoryId: nil)
            }
        }
    }

    @ViewBuilder
    private func categoryGroup(_ category: ContactCategory, _ blocks: [ContactInfoBlock]) -> some View {
        if ContactDetailLogic.isPrivateCategory(category.label) {
            DisclosureGroup(isExpanded: $privateExpanded) {
                blocksList(blocks, categoryId: category.id)
            } label: {
                Label(category.label, systemImage: "lock").scaledFont(.subheadline).fontWeight(.semibold)
            }
        } else {
            categoryGroupPlain(label: category.label, blocks: blocks, categoryId: category.id)
        }
    }

    private func categoryGroupPlain(label: String, blocks: [ContactInfoBlock], categoryId: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).scaledFont(.subheadline).fontWeight(.semibold)
            blocksList(blocks, categoryId: categoryId)
        }
    }

    /// `categoryId == nil` (Sammelgruppe für nicht (mehr) bekannte Rubriken,
    /// siehe `ungroupedInfoBlocks`): Reorder/"Nach oben"/"Nach unten" ergeben
    /// dort keinen wohldefinierten Sinn (keine echte Rubrik zum Persistieren)
    /// und werden für diesen Randfall nicht angeboten.
    private func blocksList(_ blocks: [ContactInfoBlock], categoryId: String?) -> some View {
        ForEach(blocks) { block in
            infoBlockRow(block)
                .contextMenu {
                    Button { editingBlock = block } label: { Label("Bearbeiten", systemImage: "pencil") }
                    if let categoryId {
                        Button {
                            moveBlock(block, in: blocks, direction: -1, categoryId: categoryId)
                        } label: { Label("Nach oben", systemImage: "arrow.up") }
                        .disabled(blocks.first?.id == block.id)
                        Button {
                            moveBlock(block, in: blocks, direction: 1, categoryId: categoryId)
                        } label: { Label("Nach unten", systemImage: "arrow.down") }
                        .disabled(blocks.last?.id == block.id)
                    }
                    Button(role: .destructive) { deleteBlock(block) } label: { Label("Löschen", systemImage: "trash") }
                }
        }
        .onMove { indices, newOffset in
            guard let categoryId else { return }
            var arr = blocks
            arr.move(fromOffsets: indices, toOffset: newOffset)
            Task { await persistReorder(categoryId: categoryId, orderedIds: arr.map(\.id)) }
        }
    }

    private func infoBlockRow(_ block: ContactInfoBlock) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Spacer()
                Button { editingBlock = block } label: { Image(systemName: "pencil") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Infoblock bearbeiten")
            }
            HTMLContentView(html: block.bodyHtml)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: DS.radiusM).fill(DS.cardBg))
    }

    private func loadInfoBlocks() async {
        infoBlocksLoading = true
        infoBlocksError = nil
        do { infoBlocks = try await state.loadContactInfoBlocks(contactId: contactId) }
        catch {
            infoBlocksError = isTransportFailure(error)
                ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                : "Zusatzinformationen konnten nicht geladen werden."
        }
        infoBlocksLoading = false
    }

    private func refreshAfterInfoBlockChange() async {
        await loadInfoBlocks()
        await state.reloadContact(id: contactId)
    }

    private func deleteBlock(_ block: ContactInfoBlock) {
        Task {
            do {
                try await state.deleteContactInfoBlock(contactId: contactId, blockId: block.id)
                infoBlocks.removeAll { $0.id == block.id }
                await state.reloadContact(id: contactId)
            } catch {
                infoBlocksError = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : "Löschen fehlgeschlagen. Bitte erneut versuchen."
            }
        }
    }

    private func moveBlock(_ block: ContactInfoBlock, in blocks: [ContactInfoBlock], direction: Int, categoryId: String) {
        guard let idx = blocks.firstIndex(where: { $0.id == block.id }) else { return }
        let newIdx = idx + direction
        guard blocks.indices.contains(newIdx) else { return }
        var arr = blocks
        arr.swapAt(idx, newIdx)
        Task { await persistReorder(categoryId: categoryId, orderedIds: arr.map(\.id)) }
    }

    /// Optimistisches lokales Reordering: ersetzt innerhalb von `infoBlocks`
    /// NUR die Positionen der betroffenen Rubrik durch die neue Reihenfolge
    /// (1:1, gleiche Anzahl Positionen) — alle anderen Einträge bleiben
    /// unverändert an ihrer Stelle. Bei einem Fehler wird der vorherige Stand
    /// wiederhergestellt (kein stiller Datenverlust der Sortierung).
    private func persistReorder(categoryId: String, orderedIds: [String]) async {
        let previous = infoBlocks
        var remaining = orderedIds.compactMap { id in infoBlocks.first(where: { $0.id == id }) }
        var reordered: [ContactInfoBlock] = []
        reordered.reserveCapacity(infoBlocks.count)
        for existing in infoBlocks {
            if existing.categoryId == categoryId {
                if !remaining.isEmpty { reordered.append(remaining.removeFirst()) }
            } else {
                reordered.append(existing)
            }
        }
        infoBlocks = reordered
        do {
            try await state.reorderContactInfoBlocks(contactId: contactId, categoryId: categoryId, orderedIds: orderedIds)
        } catch {
            infoBlocks = previous
            infoBlocksError = isTransportFailure(error)
                ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                : "Sortieren fehlgeschlagen. Bitte erneut versuchen."
        }
    }

    // MARK: - Notizen (Zwischenstand)

    @StateObject private var progressComposer = ProgressEntryComposer()
    @FocusState private var progressComposerFocused: Bool

    private var notesSection: some View {
        ProgressTimelineView(refType: "contact", refId: contactId, store: progressStore, showNextStep: false) {
            ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused) {
                Task { await progressComposer.commit(store: progressStore, refType: "contact", refId: contactId, hasSnooze: false) }
            }
        } reentry: {
            ProgressReentryCardView(refType: "contact", refId: contactId, store: progressStore) {
                progressComposerFocused = true
            }
        }
    }

    // MARK: - Zugeordnete Topics

    @ViewBuilder
    private var topicsSection: some View {
        let links = state.themeLinks(for: contactId)
        if links.isEmpty {
            Text("Noch keine Topics zugeordnet.").scaledFont(.subheadline).foregroundStyle(.secondary)
        } else {
            ForEach(links, id: \.link.id) { tl in
                Text(tl.theme.title)
            }
        }
        Button { showTopicLinkSheet = true } label: {
            Label("Topics zuordnen", systemImage: "tag")
        }
    }

    // MARK: - Ist zuständig für

    @ViewBuilder
    private var assignmentsSection: some View {
        if assignmentsLoading {
            ProgressView("Lädt Zuständigkeiten…").frame(maxWidth: .infinity).padding()
        } else if let assignmentsError {
            VStack(spacing: 8) {
                Text(assignmentsError).scaledFont(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Erneut versuchen") { Task { await loadAssignments() } }.buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity).padding()
        } else if assignmentTargets.isEmpty {
            Text("Dieser Ansprechpartner ist aktuell für kein Todo/Thema zuständig.")
                .scaledFont(.subheadline).foregroundStyle(.secondary)
        } else {
            ForEach(assignmentTargets) { target in
                assignmentRow(target)
            }
        }
    }

    private func assignmentRow(_ target: AssignmentTarget) -> some View {
        HStack {
            Image(systemName: target.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(target.done ? DS.green : DS.neutralRing)
            VStack(alignment: .leading, spacing: 2) {
                Text(target.title)
                    .strikethrough(target.done)
                    .foregroundStyle(target.done ? .secondary : .primary)
                if let meetingTitle = target.meetingTitle {
                    Text(meetingTitle).scaledFont(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").scaledFont(.caption2).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { openAssignment(target) }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { removeAssignment(target) } label: {
                Label("Entfernen", systemImage: "minus.circle")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet \(target.refType == "todo" ? "das Todo" : "das Thema").")
    }

    private func loadAssignments() async {
        assignmentsLoading = true
        assignmentsError = nil
        do { assignmentTargets = try await state.loadContactAssignments(contactId: contactId) }
        catch {
            assignmentsError = isTransportFailure(error)
                ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                : "Zuständigkeiten konnten nicht geladen werden."
        }
        assignmentsLoading = false
    }

    private func removeAssignment(_ target: AssignmentTarget) {
        Task {
            do {
                try await state.removeContactAssignment(contactId: contactId, refType: target.refType, refId: target.refId)
                assignmentTargets.removeAll { $0.id == target.id }
            } catch {
                assignmentsError = isTransportFailure(error)
                    ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
                    : "Entfernen fehlgeschlagen. Bitte erneut versuchen."
            }
        }
    }

    /// Löst `AssignmentTarget` in das lokal bereits geladene Todo/Thema auf
    /// und öffnet es als Sheet — die dafür nötigen `TodoFormView`/
    /// `TopicFormView` sind bereits bestehende, wiederverwendete Bausteine.
    /// Nicht (mehr) lokal auffindbar (z.B. gelöscht, oder Meeting nicht
    /// geladen): Inline-Fehlermeldung statt eines stillen No-ops.
    private func openAssignment(_ target: AssignmentTarget) {
        switch target.refType {
        case "todo":
            if let todo = state.todos.first(where: { $0.id == target.refId }) {
                navigationTarget = .todo(todo)
            } else {
                assignmentsError = "Dieses Todo konnte nicht gefunden werden."
            }
        case "topic":
            if let meetingId = target.meetingId,
               let topic = state.meetings.first(where: { $0.id == meetingId })?.topics.first(where: { $0.id == target.refId }) {
                navigationTarget = .topic(meetingId: meetingId, topic: topic)
            } else {
                assignmentsError = "Dieses Thema konnte nicht gefunden werden."
            }
        default:
            assignmentsError = "Konnte nicht geöffnet werden."
        }
    }
}
