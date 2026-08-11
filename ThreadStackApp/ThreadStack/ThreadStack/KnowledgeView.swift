import SwiftUI

enum KnowledgeBrowseMode: String, CaseIterable {
    case byTopic = "Nach Topics"
    case all = "Alle"
}

/// Zielort beim Durchstöbern von Wissen nach Topics: entweder ein konkretes
/// Topic (inkl. Unter-Topics) oder der Sammelbereich für Wissen ohne
/// Topic-Zuordnung.
enum KnowledgeTopicDestination: Hashable {
    case theme(String)
    case unassigned
}

// Globale Wissens-Ansicht — Wissen kann direkt in der App angelegt, bearbeitet
// (nativer Rich-Text-Editor, siehe KnowledgeEditorView) und gelöscht werden.
// Navigation erfolgt standardmäßig über die Topic-Struktur (analog zu
// ThemesView); über den Umschalter oben lässt sich auf eine flache Liste
// allen Wissens wechseln.
struct KnowledgeView: View {
    @EnvironmentObject var state: AppState
    @State private var browseMode: KnowledgeBrowseMode = .byTopic
    @State private var showNew = false

    var body: some View {
        Group {
            switch browseMode {
            case .byTopic: KnowledgeTopicTreeView()
            case .all: KnowledgeAllListView()
            }
        }
        .navigationTitle("Wissen")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Ansicht", selection: $browseMode) {
                    ForEach(KnowledgeBrowseMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
                .accessibilityLabel("Ansicht wählen: Nach Topics oder Alle")
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Neues Wissen")
            }
        }
        .sheet(isPresented: $showNew) {
            KnowledgeEditorView(mode: .create(presetThemeId: nil))
        }
    }
}

// MARK: - Nach Topics durchstöbern

struct KnowledgeTopicTreeView: View {
    @EnvironmentObject var state: AppState
    #if os(macOS)
    @State private var selectedDestination: KnowledgeTopicDestination?
    #endif

    private var unassignedCount: Int {
        state.knowledgePages.filter { $0.themeIds.isEmpty }.count
    }

    private func knowledgeCount(themeId: String) -> Int {
        let ids = Set([themeId] + state.themeDescendantIds(themeId))
        return state.knowledgePages.filter { !Set($0.themeIds).isDisjoint(with: ids) }.count
    }

    private func rowLabel(_ theme: Theme) -> some View {
        let hasChildren = !state.themeChildren(of: theme.id).isEmpty
        let count = knowledgeCount(themeId: theme.id)
        return HStack(spacing: 8) {
            Circle()
                .fill(DS.purple.opacity(hasChildren ? 0.15 : 1))
                .frame(width: hasChildren ? 22 : 6, height: hasChildren ? 22 : 6)
            Text(theme.title)
                .font(.system(size: 15.5, weight: hasChildren ? .semibold : .medium))
            Spacer()
            if count > 0 {
                Text("\(count)").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var unassignedRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.folder").foregroundStyle(.secondary)
            Text("Ohne Topic")
            Spacer()
            Text("\(unassignedCount)").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var emptyState: some View {
        Text("Noch keine Topics angelegt.")
            .foregroundStyle(.secondary).font(.subheadline)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
    }

    #if os(iOS)
    var body: some View {
        List {
            if state.themes.isEmpty && unassignedCount == 0 {
                emptyState
            } else {
                if unassignedCount > 0 {
                    NavigationLink(value: KnowledgeTopicDestination.unassigned) { unassignedRow }
                }
                OutlineGroup(themeNodes(state, parentId: nil), children: \.children) { node in
                    NavigationLink(value: KnowledgeTopicDestination.theme(node.theme.id)) { rowLabel(node.theme) }
                }
            }
        }
        .navigationDestination(for: KnowledgeTopicDestination.self) { dest in
            KnowledgeTopicScopedListView(destination: dest)
        }
    }
    #else
    var body: some View {
        HStack(spacing: 0) {
            List(selection: $selectedDestination) {
                if unassignedCount > 0 {
                    unassignedRow.tag(KnowledgeTopicDestination.unassigned)
                }
                if state.themes.isEmpty {
                    emptyState
                } else {
                    OutlineGroup(themeNodes(state, parentId: nil), children: \.children) { node in
                        rowLabel(node.theme).tag(KnowledgeTopicDestination.theme(node.theme.id))
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 220, maxWidth: 300)

            Divider()

            if let dest = selectedDestination {
                KnowledgeTopicScopedListView(destination: dest)
                    .id(dest)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "tag").font(.system(size: 36)).foregroundStyle(.tertiary)
                    Text("Topic auswählen").font(.headline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
    #endif
}

/// Wissen zu einem Topic (inkl. Unter-Topics) bzw. ohne Topic-Zuordnung.
struct KnowledgeTopicScopedListView: View {
    let destination: KnowledgeTopicDestination
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var showNew = false
    @State private var deleteCandidate: KnowledgePage?
    @State private var error: String?

    private var presetThemeId: String? {
        if case .theme(let id) = destination { return id }
        return nil
    }

    private var title: String {
        switch destination {
        case .unassigned: return "Ohne Topic"
        case .theme(let id): return state.themes.first(where: { $0.id == id })?.title ?? "Topic"
        }
    }

    private var scoped: [KnowledgePage] {
        switch destination {
        case .unassigned:
            return state.knowledgePages.filter { $0.themeIds.isEmpty }
        case .theme(let id):
            let ids = Set([id] + state.themeDescendantIds(id))
            return state.knowledgePages.filter { !Set($0.themeIds).isDisjoint(with: ids) }
        }
    }

    private var filtered: [KnowledgePage] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return scoped }
        return scoped.filter {
            $0.title.localizedCaseInsensitiveContains(q) ||
            stripHTML($0.content).localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("In diesem Topic suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            #endif

            if scoped.isEmpty {
                Section {
                    VStack(spacing: 10) {
                        Text("Noch kein Wissen in diesem Bereich.")
                            .foregroundStyle(.secondary).font(.subheadline)
                            .multilineTextAlignment(.center)
                        Button { showNew = true } label: {
                            Label("Wissen hinzufügen", systemImage: "plus.circle")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            } else if filtered.isEmpty {
                Section {
                    Text("Keine Treffer.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filtered) { k in
                    NavigationLink { KnowledgeDetailView(page: k) } label: { KnowledgeRowView(page: k) }
                }
                #if os(iOS)
                .onDelete { offsets in
                    if let first = offsets.first { deleteCandidate = filtered[first] }
                }
                #endif
            }

            #if os(macOS)
            if !scoped.isEmpty {
                Section {
                    Button { showNew = true } label: {
                        Label("Wissen hinzufügen", systemImage: "plus.circle").foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
            }
            #endif
        }
        .navigationTitle(title)
        #if os(iOS)
        .searchable(text: $search, prompt: "In diesem Topic suchen")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Wissen hinzufügen")
            }
        }
        #endif
        .sheet(isPresented: $showNew) {
            KnowledgeEditorView(mode: .create(presetThemeId: presetThemeId))
        }
        .confirmationDialog(
            "Wissensseite löschen?",
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Löschen", role: .destructive) { performDelete() }
            Button("Abbrechen", role: .cancel) { deleteCandidate = nil }
        } message: {
            if let c = deleteCandidate {
                Text("„\(c.title)\u{201C} wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.")
            }
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func performDelete() {
        guard let candidate = deleteCandidate else { return }
        deleteCandidate = nil
        Task {
            do {
                try await state.deleteKnowledgePage(id: candidate.id)
            } catch {
                self.error = "Löschen fehlgeschlagen. Bitte versuche es erneut."
            }
        }
    }
}

// MARK: - Flache Liste allen Wissens

struct KnowledgeAllListView: View {
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var themeFilter: String? = nil
    @State private var deleteCandidate: KnowledgePage?
    @State private var error: String?

    private var themeOptions: [Theme] {
        state.themes.sorted {
            state.themeAncestorsPath($0.id).map(\.title).joined(separator: " › ") <
            state.themeAncestorsPath($1.id).map(\.title).joined(separator: " › ")
        }
    }

    private var filtered: [KnowledgePage] {
        var list = state.knowledgePages
        if let themeFilter { list = list.filter { $0.themeIds.contains(themeFilter) } }
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return list }
        return list.filter {
            $0.title.localizedCaseInsensitiveContains(q) ||
            stripHTML($0.content).localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Wissen suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("Topic", selection: $themeFilter) {
                    Text("Alle Topics").tag(String?.none)
                    ForEach(themeOptions) { t in
                        Text(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › "))
                            .tag(Optional(t.id))
                    }
                }
            }
            #endif

            if state.knowledgePages.isEmpty {
                Section {
                    Text("Noch kein Wissen hinterlegt.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else if filtered.isEmpty {
                Section {
                    Text("Keine Treffer.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filtered) { k in
                    NavigationLink { KnowledgeDetailView(page: k) } label: { KnowledgeRowView(page: k) }
                }
                #if os(iOS)
                .onDelete { offsets in
                    if let first = offsets.first { deleteCandidate = filtered[first] }
                }
                #endif
            }
        }
        #if os(iOS)
        .searchable(text: $search, prompt: "Wissen suchen")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button("Alle Topics") { themeFilter = nil }
                    ForEach(themeOptions) { t in
                        Button(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › ")) {
                            themeFilter = t.id
                        }
                    }
                } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
            }
        }
        #endif
        .confirmationDialog(
            "Wissensseite löschen?",
            isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } }),
            titleVisibility: .visible
        ) {
            Button("Löschen", role: .destructive) { performDelete() }
            Button("Abbrechen", role: .cancel) { deleteCandidate = nil }
        } message: {
            if let c = deleteCandidate {
                Text("„\(c.title)\u{201C} wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.")
            }
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func performDelete() {
        guard let candidate = deleteCandidate else { return }
        deleteCandidate = nil
        Task {
            do {
                try await state.deleteKnowledgePage(id: candidate.id)
            } catch {
                self.error = "Löschen fehlgeschlagen. Bitte versuche es erneut."
            }
        }
    }
}
