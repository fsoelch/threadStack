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

    /// Reine Merge-Logik für `persistReorder` (optimistisches lokales
    /// Reordering nach einem `.onMove`/"Nach oben"/"Nach unten"): ersetzt
    /// innerhalb von `infoBlocks` NUR die Positionen der Rubrik `categoryId`
    /// durch die neue Reihenfolge `orderedIds` — alle Einträge anderer
    /// Rubriken bleiben unverändert an ihrer bisherigen Stelle
    /// (Rubrik-Isolation, kein versehentliches Vermischen der Reihenfolgen
    /// verschiedener Rubriken).
    ///
    /// Defensiv gegen einen Längen-/Mengen-Mismatch zwischen `orderedIds` und
    /// den tatsächlich zu dieser Rubrik gehörenden Blöcken (z.B. ein Block
    /// wurde zwischenzeitlich durch ein anderes Gerät gelöscht/umkategorisiert,
    /// bevor die Reorder-Geste committed wurde): in diesem Fall wird
    /// `infoBlocks` UNVERÄNDERT zurückgegeben statt Blöcke stillschweigend zu
    /// verlieren oder zu duplizieren.
    static func applyReorder(infoBlocks: [ContactInfoBlock], categoryId: String, orderedIds: [String]) -> [ContactInfoBlock] {
        let categoryBlockIds = Set(infoBlocks.filter { $0.categoryId == categoryId }.map(\.id))
        guard orderedIds.count == categoryBlockIds.count, Set(orderedIds) == categoryBlockIds else {
            return infoBlocks
        }
        var remaining = orderedIds.compactMap { id in infoBlocks.first(where: { $0.id == id }) }
        var reordered: [ContactInfoBlock] = []
        reordered.reserveCapacity(infoBlocks.count)
        for existing in infoBlocks {
            if existing.categoryId == categoryId {
                reordered.append(remaining.removeFirst())
            } else {
                reordered.append(existing)
            }
        }
        return reordered
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
    @EnvironmentObject var offline: OfflineStatusStore
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
    // Offline-Zustand der Zusatzinformationen/Zuständigkeiten: nie geladen -> OfflineUnavailableView
    @State private var infoBlocksLoaded = false
    @State private var infoBlocksFailedOffline = false
    @State private var assignmentsLoaded = false
    @State private var assignmentsFailedOffline = false

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
                Section(header: infoBlocksSectionHeader) { infoBlocksStatusSection }
                infoBlockCategorySections
                Section("Notizen") { notesSection }
                Section("Zugeordnete Topics") { topicsSection }
                Section("Ist zuständig für") { assignmentsSection }
                if let basicsError {
                    Section {
                        Text(basicsError).scaledFont(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(contact.name.isEmpty ? "Ansprechpartner" : contact.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                // Code-Review Fund 1: zwingend für funktionierendes `.onMove`
                // (siehe `blocksList(_:categoryId:attachOnMove:)`) — ohne
                // `EditButton()` bietet SwiftUI im Formular gar keinen
                // Editier-Modus an, in dem Drag-Handles erscheinen könnten
                // (analog zu `MeetingDetailView`/`ContactsView`).
                #if os(iOS)
                ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
                #endif
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saveBasicsAndClose()
                    } label: {
                        if savingBasics { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || savingBasics)
                    .disabledWhenOfflineCompact(offline.isOffline)
                }
            }
            .onAppear { populateBasics() }
            .task { await loadInfoBlocks() }
            .task { await loadAssignments() }
            // Verbindung zurueck: nie geladene Bereiche ohne Neustart nachladen.
            .reloadWhenBackOnline(hasContent: infoBlocksLoaded) { Task { await loadInfoBlocks() } }
            .reloadWhenBackOnline(hasContent: assignmentsLoaded) { Task { await loadAssignments() } }
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
            if offline.isOffline {
                OfflineUnavailableHint()
            }
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
            .disabledWhenOfflineCompact(offline.isOffline)
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
        guard !offline.isOffline else { basicsError = OfflineGating.notAvailableMessage; return }
        savingBasics = true
        basicsError = nil
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
                    basicsError = OfflineGating.notAvailableMessage
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
            .disabledWhenOfflineCompact(offline.isOffline)
            .accessibilityLabel("Infoblock hinzufügen")
            Button { showCategorySheet = true } label: {
                Image(systemName: "tag")
            }
            .buttonStyle(.plain)
            .disabledWhenOfflineCompact(offline.isOffline)
            .accessibilityLabel("Rubriken verwalten")
        }
    }

    private var groupedInfoBlocks: [(category: ContactCategory, blocks: [ContactInfoBlock])] {
        ContactDetailLogic.grouped(infoBlocks: infoBlocks, categories: contact.categories ?? [])
    }

    private var ungroupedInfoBlocks: [ContactInfoBlock] {
        ContactDetailLogic.ungrouped(infoBlocks: infoBlocks, categories: contact.categories ?? [])
    }

    /// Nur Lade-/Fehler-/Leerzustand der Zusatzinformationen — die eigentlichen
    /// Rubrik-Gruppen werden NICHT hier, sondern in `infoBlockCategorySections`
    /// gerendert (siehe dortiger Kommentar: Code-Review Fund 1, `.onMove`
    /// braucht ein `ForEach` als DIREKTES Kind einer `Section`, nicht
    /// verschachtelt in einem `VStack` innerhalb dieser Section).
    @ViewBuilder
    private var infoBlocksStatusSection: some View {
        if OfflineGating.showsUnavailable(isOffline: offline.isOffline,
                                                 hasContent: infoBlocksLoaded,
                                                 loadFailedOffline: infoBlocksFailedOffline) {
            // Infoblöcke werden nicht zwischengespeichert (UX S1, Screen 8).
            OfflineUnavailableView(reason: .notLoadedYet) { Task { await loadInfoBlocks() } }
                .frame(minHeight: 200)
        } else if infoBlocksLoading {
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
        }
    }

    /// EIN `Section` PRO Rubrik (plus ggf. eine Sammel-`Section` "Weitere") —
    /// zwingend nötig, damit `.onMove` in `blocksList` tatsächlich ein
    /// funktionierendes Drag-Handle liefert (SwiftUI-Bedingung: `ForEach` mit
    /// `.onMove` muss DIREKTES Kind einer `Section`/`List` sein). Vorher
    /// steckten alle Rubriken in EINER gemeinsamen Section, verschachtelt in
    /// einem `VStack`/`DisclosureGroup` — dort war `.onMove` zur Laufzeit
    /// wirkungslos (Code-Review Fund 1, "tote Feature-Behauptung").
    @ViewBuilder
    private var infoBlockCategorySections: some View {
        if !infoBlocksLoading && infoBlocksError == nil && !infoBlocks.isEmpty && infoBlocksLoaded {
            ForEach(groupedInfoBlocks, id: \.category.id) { group in
                categorySection(group.category, group.blocks)
            }
            if !ungroupedInfoBlocks.isEmpty {
                // Sammelgruppe für nicht (mehr) bekannte Rubriken: kein
                // wohldefiniertes Reorder-Ziel (keine echte Rubrik zum
                // Persistieren) — `attachOnMove: false`, siehe `blocksList`.
                Section(header: Text("Weitere").scaledFont(.subheadline).fontWeight(.semibold)) {
                    blocksList(ungroupedInfoBlocks, categoryId: nil, attachOnMove: false)
                }
            }
        }
    }

    @ViewBuilder
    private func categorySection(_ category: ContactCategory, _ blocks: [ContactInfoBlock]) -> some View {
        if ContactDetailLogic.isPrivateCategory(category.label) {
            // "Privates" bleibt bewusst eingeklappt (Datenschutz-Rücksicht,
            // siehe `ContactDetailLogic.isPrivateCategory`) — das dafür
            // nötige `DisclosureGroup` verschachtelt sein `ForEach` aber
            // zwangsläufig NICHT als direktes Kind der `Section` (sondern
            // eine Ebene tiefer im `DisclosureGroup`-Inhalt), wodurch
            // SwiftUI dort kein funktionierendes `.onMove`-Drag-Handle
            // anbietet (Code-Review Fund 1, dokumentierter Fallback statt
            // eines nur scheinbar funktionierenden Handles): NUR die
            // Kontextmenü-Variante ("Nach oben"/"Nach unten") bleibt hier als
            // Sortier-Weg, `attachOnMove: false`.
            Section {
                DisclosureGroup(isExpanded: $privateExpanded) {
                    blocksList(blocks, categoryId: category.id, attachOnMove: false)
                } label: {
                    Label(category.label, systemImage: "lock").scaledFont(.subheadline).fontWeight(.semibold)
                }
            }
        } else {
            Section(header: Text(category.label).scaledFont(.subheadline).fontWeight(.semibold)) {
                blocksList(blocks, categoryId: category.id, attachOnMove: true)
            }
        }
    }

    /// `categoryId == nil` (Sammelgruppe für nicht (mehr) bekannte Rubriken,
    /// siehe `ungroupedInfoBlocks`): Reorder/"Nach oben"/"Nach unten" ergeben
    /// dort keinen wohldefinierten Sinn (keine echte Rubrik zum Persistieren)
    /// und werden für diesen Randfall nicht angeboten.
    ///
    /// `attachOnMove` steuert NUR das SwiftUI-Drag-Handle (`.onMove`):
    /// `false` für die "Weitere"-Sammelgruppe (`categoryId == nil`, s.o.) UND
    /// für die "Privates"-Rubrik (dort bricht das umschließende
    /// `DisclosureGroup` die "direktes Kind einer Section"-Bedingung, siehe
    /// `categorySection`). Der Modifier wird in diesen Fällen GAR NICHT
    /// angehängt statt nur intern zu einem No-op zu führen — ein angehängtes,
    /// aber wirkungsloses `.onMove` würde sonst ein Drag-Handle zeigen, das
    /// beim Loslassen kommentarlos auf die alte Position zurückspringt.
    @ViewBuilder
    private func blocksList(_ blocks: [ContactInfoBlock], categoryId: String?, attachOnMove: Bool) -> some View {
        let rows = ForEach(blocks) { block in
            infoBlockRow(block)
                .contextMenu {
                    Button { editingBlock = block } label: { Label("Bearbeiten", systemImage: "pencil") }
                        .disabledWhenOfflineCompact(offline.isOffline)
                    if let categoryId {
                        Button {
                            moveBlock(block, in: blocks, direction: -1, categoryId: categoryId)
                        } label: { Label("Nach oben", systemImage: "arrow.up") }
                        .disabled(blocks.first?.id == block.id)
                        .disabledWhenOfflineCompact(offline.isOffline)
                        Button {
                            moveBlock(block, in: blocks, direction: 1, categoryId: categoryId)
                        } label: { Label("Nach unten", systemImage: "arrow.down") }
                        .disabled(blocks.last?.id == block.id)
                        .disabledWhenOfflineCompact(offline.isOffline)
                    }
                    Button(role: .destructive) { deleteBlock(block) } label: { Label("Löschen", systemImage: "trash") }
                        .disabledWhenOfflineCompact(offline.isOffline)
                }
                .moveDisabled(offline.isOffline)
        }
        if attachOnMove, let categoryId {
            rows.onMove { indices, newOffset in
                var arr = blocks
                arr.move(fromOffsets: indices, toOffset: newOffset)
                Task { await persistReorder(categoryId: categoryId, orderedIds: arr.map(\.id)) }
            }
        } else {
            rows
        }
    }

    private func infoBlockRow(_ block: ContactInfoBlock) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Spacer()
                Button { editingBlock = block } label: { Image(systemName: "pencil") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .disabledWhenOfflineCompact(offline.isOffline)
                    .accessibilityLabel("Infoblock bearbeiten")
            }
            HTMLContentView(html: block.bodyHtml)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: DS.radiusM).fill(DS.cardBg))
    }

    private func loadInfoBlocks() async {
        guard !offline.isOffline else { return }
        infoBlocksLoading = true
        infoBlocksError = nil
        infoBlocksFailedOffline = false
        do { infoBlocks = try await state.loadContactInfoBlocks(contactId: contactId); infoBlocksLoaded = true }
        catch {
            if isTransportFailure(error) {
                infoBlocksFailedOffline = true   // Platzhalter statt Fehlertext
            } else {
                infoBlocksError = "Zusatzinformationen konnten nicht geladen werden."
            }
        }
        infoBlocksLoading = false
    }

    private func refreshAfterInfoBlockChange() async {
        await loadInfoBlocks()
        await state.reloadContact(id: contactId)
    }

    private func deleteBlock(_ block: ContactInfoBlock) {
        guard !offline.isOffline else { state.showToast(OfflineTexts.unavailableTitle); return }
        Task {
            do {
                try await state.deleteContactInfoBlock(contactId: contactId, blockId: block.id)
                infoBlocks.removeAll { $0.id == block.id }
                await state.reloadContact(id: contactId)
            } catch {
                infoBlocksError = OfflineGating.message(for: error, fallback: "Löschen fehlgeschlagen. Bitte erneut versuchen.")
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

    /// Optimistisches lokales Reordering (reine Merge-Logik in
    /// `ContactDetailLogic.applyReorder`, dort testbar isoliert). Bei einem
    /// Fehler wird der vorherige Stand wiederhergestellt (kein stiller
    /// Datenverlust der Sortierung).
    private func persistReorder(categoryId: String, orderedIds: [String]) async {
        guard !offline.isOffline else { state.showToast(OfflineTexts.unavailableTitle); return }
        let previous = infoBlocks
        infoBlocks = ContactDetailLogic.applyReorder(infoBlocks: infoBlocks, categoryId: categoryId, orderedIds: orderedIds)
        do {
            try await state.reorderContactInfoBlocks(contactId: contactId, categoryId: categoryId, orderedIds: orderedIds)
        } catch {
            infoBlocks = previous
            infoBlocksError = OfflineGating.message(for: error, fallback: "Sortieren fehlgeschlagen. Bitte erneut versuchen.")
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
        .disabledWhenOffline(offline.isOffline)
    }

    // MARK: - Ist zuständig für

    @ViewBuilder
    private var assignmentsSection: some View {
        if OfflineGating.showsUnavailable(isOffline: offline.isOffline,
                                                 hasContent: assignmentsLoaded,
                                                 loadFailedOffline: assignmentsFailedOffline) {
            OfflineUnavailableView(reason: .notLoadedYet) { Task { await loadAssignments() } }
                .frame(minHeight: 200)
        } else if assignmentsLoading {
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
            .disabledWhenOfflineCompact(offline.isOffline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet \(target.refType == "todo" ? "das Todo" : "das Thema").")
    }

    private func loadAssignments() async {
        guard !offline.isOffline else { return }
        assignmentsLoading = true
        assignmentsError = nil
        assignmentsFailedOffline = false
        do { assignmentTargets = try await state.loadContactAssignments(contactId: contactId); assignmentsLoaded = true }
        catch {
            if isTransportFailure(error) {
                assignmentsFailedOffline = true   // Platzhalter statt Fehlertext
            } else {
                assignmentsError = "Zuständigkeiten konnten nicht geladen werden."
            }
        }
        assignmentsLoading = false
    }

    private func removeAssignment(_ target: AssignmentTarget) {
        guard !offline.isOffline else { state.showToast(OfflineTexts.unavailableTitle); return }
        Task {
            do {
                try await state.removeContactAssignment(contactId: contactId, refType: target.refType, refId: target.refId)
                assignmentTargets.removeAll { $0.id == target.id }
            } catch {
                assignmentsError = OfflineGating.message(for: error, fallback: "Entfernen fehlgeschlagen. Bitte erneut versuchen.")
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
