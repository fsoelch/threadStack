import SwiftUI

// MARK: - Baum-Hilfsstruktur für OutlineGroup

struct ThemeNode: Identifiable {
    let theme: Theme
    var children: [ThemeNode]?
    var id: String { theme.id }
}

@MainActor
private func themeNodes(_ state: AppState, parentId: String?) -> [ThemeNode] {
    state.themeChildren(of: parentId).map { t in
        let kids = themeNodes(state, parentId: t.id)
        return ThemeNode(theme: t, children: kids.isEmpty ? nil : kids)
    }
}

// MARK: - Geteiltes Zeilen-Layout für Wissen & Todos (Topic-Detail + globale Wissens-Ansicht)
// Beide Karten teilen sich Icon-links / Titel+Vorschau / Herkunfts-Badge-rechts, analog zum Web-Redesign.

// Farbe für Karten vererbter Einträge (aus Unter-Topics) — gedämpft statt Weiß.
let themeInheritedRowBg = Color(hex: "#F7F7F9")

func themeOriginBadge(_ topicName: String) -> some View {
    HStack(spacing: 4) {
        Image(systemName: "circle").font(.system(size: 7))
        Text("aus \(topicName)").font(.system(size: 11, weight: .semibold))
    }
    .padding(.horizontal, 8).padding(.vertical, 2)
    .background(DS.purple.opacity(0.12))
    .foregroundStyle(DS.purple)
    .clipShape(Capsule())
}

struct KnowledgeRowView: View {
    let page: KnowledgePage
    @EnvironmentObject var state: AppState

    private var paths: [String] {
        page.themeIds
            .map { state.themeAncestorsPath($0).map(\.title).joined(separator: " › ") }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "doc.text.fill").foregroundStyle(DS.purple).scaledFont(.subheadline)
            VStack(alignment: .leading, spacing: 3) {
                Text(page.title).scaledFont(.subheadline).fontWeight(.medium)
                    .foregroundStyle(page.originThemeTitle != nil ? .secondary : .primary)
                if !paths.isEmpty {
                    Text("🏷️ " + paths.joined(separator: "  ·  "))
                        .scaledFont(.caption2).foregroundStyle(DS.purple.opacity(0.85))
                }
                if !page.content.isEmpty {
                    Text(stripHTML(page.content)).scaledFont(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            if let ot = page.originThemeTitle { themeOriginBadge(ot) }
        }
        .padding(.vertical, 2)
        .listRowBackground(page.originThemeTitle != nil ? themeInheritedRowBg : nil)
    }
}

struct ThemeTodoRowView: View {
    let todo: TodoItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: todo.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(todo.done ? DS.green : .secondary).scaledFont(.subheadline)
            VStack(alignment: .leading, spacing: 3) {
                Text(todo.title).scaledFont(.subheadline).fontWeight(.medium)
                    .strikethrough(todo.done)
                    .foregroundStyle(todo.done ? .secondary : (todo.originThemeTitle != nil ? .secondary : .primary))
                if !todo.description.isEmpty {
                    Text(stripHTML(todo.description)).scaledFont(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            if let ot = todo.originThemeTitle { themeOriginBadge(ot) }
        }
        .padding(.vertical, 2)
        .listRowBackground(todo.originThemeTitle != nil ? themeInheritedRowBg : nil)
    }
}

// MARK: - ThemesView (Baum-Navigation)

struct ThemesView: View {
    @EnvironmentObject var state: AppState
    @State private var showNew = false
    @State private var newParentId: String? = nil
    @State private var selectedThemeId: String? = nil
    #if os(iOS)
    @State private var navPath = NavigationPath()
    #endif

    private func rowLabel(_ theme: Theme) -> some View {
        let hasChildren = !state.themeChildren(of: theme.id).isEmpty
        return HStack(spacing: 8) {
            Circle()
                .fill(DS.purple.opacity(hasChildren ? 0.15 : 1))
                .frame(width: hasChildren ? 22 : 6, height: hasChildren ? 22 : 6)
            Text(theme.title)
                .font(.system(size: 15.5, weight: hasChildren ? .semibold : .medium))
        }
    }

    private var emptyState: some View {
        Text("Noch keine Topics — tippe auf + um das erste hinzuzufügen.")
            .foregroundStyle(.secondary).font(.subheadline)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
    }

    var body: some View {
        #if os(iOS)
        NavigationStack(path: $navPath) {
            List {
                if state.themes.isEmpty {
                    emptyState
                } else {
                    OutlineGroup(themeNodes(state, parentId: nil), children: \.children) { node in
                        NavigationLink(value: node.theme.id) { rowLabel(node.theme) }
                    }
                }
            }
            .navigationTitle("Meine Topics")
            .navigationDestination(for: String.self) { id in
                ThemeDetailScreen(themeId: id, onNavigate: { navPath.append($0) })
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { newParentId = nil; showNew = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showNew) { ThemeFormView(parentId: newParentId) }
        }
        #else
        HStack(spacing: 0) {
            List(selection: $selectedThemeId) {
                Section {
                    Button { newParentId = nil; showNew = true } label: {
                        Label("Neues Topic", systemImage: "plus.circle").foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                if state.themes.isEmpty {
                    emptyState
                } else {
                    OutlineGroup(themeNodes(state, parentId: nil), children: \.children) { node in
                        rowLabel(node.theme).tag(node.theme.id)
                    }
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 220, maxWidth: 300)

            Divider()

            if let id = selectedThemeId {
                ThemeDetailScreen(themeId: id, onNavigate: { selectedThemeId = $0 })
                    .id(id)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "tag").font(.system(size: 36)).foregroundStyle(.tertiary)
                    Text("Topic auswählen").font(.headline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Meine Topics")
        .sheet(isPresented: $showNew) { ThemeFormView(parentId: newParentId) }
        #endif
    }
}

// MARK: - Topic-Detailbereich (Wissen + Todos, inkl. Vererbung)

struct ThemeDetailScreen: View {
    let themeId: String
    var onNavigate: (String) -> Void = { _ in }
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var showEdit = false
    @State private var showNewSub = false
    @State private var showMove = false
    @State private var showDeleteChoice = false
    @State private var deletePreview: ThemeDeletePreview?
    @State private var includeDescendants = true
    @State private var knowledge: [KnowledgePage] = []
    @State private var todosScoped: [TodoItem] = []
    @State private var loading = false
    @State private var error: String?

    private var theme: Theme? { state.themes.first(where: { $0.id == themeId }) }
    private var path: [Theme] { state.themeAncestorsPath(themeId) }
    private var children: [Theme] { state.themeChildren(of: themeId) }
    private var linkedMeetingTopics: [(type: String, title: String, meetingId: String?)] {
        state.themeLinksForTheme(themeId: themeId).filter { $0.type == "topic" }
    }

    var body: some View {
        Group {
            if let theme {
                content(theme)
            } else {
                ContentUnavailableView("Topic nicht gefunden", systemImage: "tag.slash")
            }
        }
        .task(id: "\(themeId)-\(includeDescendants)") { await load() }
    }

    @ViewBuilder
    private func content(_ theme: Theme) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if path.count > 1 {
                        HStack(spacing: 4) {
                            ForEach(Array(path.dropLast().enumerated()), id: \.element.id) { i, p in
                                if i > 0 { Text("›").foregroundStyle(.tertiary) }
                                Button(p.title) { onNavigate(p.id) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                    Text(theme.title).scaledFont(.title3).fontWeight(.bold)
                    if !theme.description.isEmpty {
                        Text(theme.description).scaledFont(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)

                if !children.isEmpty {
                    Toggle("Wissen & Todos aus Unter-Topics einbeziehen", isOn: $includeDescendants)
                        .scaledFont(.caption)
                }
            }

            if !children.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(children) { child in
                                Button { onNavigate(child.id) } label: {
                                    Label(child.title, systemImage: "tag.fill")
                                        .scaledFont(.caption).fontWeight(.medium)
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(DS.purple.opacity(0.1))
                                        .foregroundStyle(DS.purple)
                                        .clipShape(Capsule())
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                } header: { Text("🗂️ Unter-Topics (\(children.count))").scaledFont(.caption).fontWeight(.semibold) }
            }

            if !linkedMeetingTopics.isEmpty {
                Section {
                    ForEach(Array(linkedMeetingTopics.enumerated()), id: \.offset) { _, item in
                        HStack(spacing: 6) {
                            Text("📋").scaledFont(.caption2)
                            Text(item.title).scaledFont(.caption).lineLimit(1)
                            Spacer()
                            if let mid = item.meetingId, let m = state.meetings.first(where: { $0.id == mid }) {
                                Text(m.title).scaledFont(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                } header: { Text("Verknüpfte Meeting-Themen").scaledFont(.caption).fontWeight(.semibold) }
            }

            Section {
                if loading {
                    ProgressView()
                } else if knowledge.isEmpty {
                    Text("Noch kein Wissen hinterlegt.").foregroundStyle(.secondary).font(.footnote)
                } else {
                    ForEach(knowledge) { k in
                        NavigationLink { KnowledgeDetailView(page: k) } label: { KnowledgeRowView(page: k) }
                    }
                }
            } header: { Text("📚 Wissen").scaledFont(.caption).fontWeight(.semibold) }

            Section {
                if loading {
                    ProgressView()
                } else if todosScoped.isEmpty {
                    Text("Keine Todos verknüpft. Weisen Sie in der Todos-Ansicht über 🏷️ dieses Topic zu.")
                        .foregroundStyle(.secondary).font(.footnote)
                } else {
                    ForEach(todosScoped) { t in ThemeTodoRowView(todo: t) }
                }
            } header: { Text("✅ Todos").scaledFont(.caption).fontWeight(.semibold) }
        }
        #if os(macOS)
        .listStyle(.inset)
        #endif
        .navigationTitle(theme.title)
        .toolbar {
            ToolbarItem {
                Menu {
                    Button { showNewSub = true } label: { Label("Unter-Topic anlegen", systemImage: "plus") }
                    Button { showEdit = true } label: { Label("Bearbeiten", systemImage: "pencil") }
                    Button { showMove = true } label: { Label("Verschieben", systemImage: "arrow.up.arrow.down") }
                    Divider()
                    Button(role: .destructive) { confirmDelete(theme) } label: { Label("Löschen", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $showEdit)   { ThemeFormView(theme: theme) }
        .sheet(isPresented: $showNewSub) { ThemeFormView(parentId: theme.id) }
        .sheet(isPresented: $showMove)   { ThemeMoveView(themeId: theme.id) }
        .confirmationDialog(
            "Topic mit Unter-Topics löschen",
            isPresented: $showDeleteChoice,
            titleVisibility: .visible
        ) {
            Button("Unter-Topics eine Ebene hochstufen") { performDelete(theme, cascade: false) }
            Button("Alles löschen", role: .destructive) { performDelete(theme, cascade: true) }
            Button("Abbrechen", role: .cancel) {}
        } message: {
            if let p = deletePreview {
                Text("„\(theme.title)\u{201C} hat \(p.subTopicCount) Unter-Topic(s)"
                     + (p.knowledgePageCount > 0 ? " mit \(p.knowledgePageCount) Wissensseite(n)" : "")
                     + ".")
            }
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func load() async {
        loading = true
        async let k = state.themeKnowledge(id: themeId, includeDescendants: includeDescendants)
        async let t = state.themeTodos(id: themeId, includeDescendants: includeDescendants)
        knowledge = await k
        todosScoped = await t
        loading = false
    }

    private func confirmDelete(_ theme: Theme) {
        Task {
            let preview = await state.themeDeletePreview(id: theme.id)
            if preview.subTopicCount == 0 {
                do { try await state.deleteTheme(id: theme.id, cascade: true); dismiss() }
                catch { self.error = error.localizedDescription }
            } else {
                deletePreview = preview
                showDeleteChoice = true
            }
        }
    }

    private func performDelete(_ theme: Theme, cascade: Bool) {
        Task {
            do { try await state.deleteTheme(id: theme.id, cascade: cascade); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: - Topic verschieben

struct ThemeMoveView: View {
    let themeId: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var selectedParent: String? = nil
    @State private var loading = false
    @State private var error: String?

    private var theme: Theme? { state.themes.first(where: { $0.id == themeId }) }
    private var excluded: Set<String> {
        var s = Set(state.themeDescendantIds(themeId)); s.insert(themeId); return s
    }
    private var options: [Theme] {
        state.themes.filter { !excluded.contains($0.id) }
            .sorted {
                state.themeAncestorsPath($0.id).map(\.title).joined(separator: " › ") <
                state.themeAncestorsPath($1.id).map(\.title).joined(separator: " › ")
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Übergeordnetes Topic", selection: $selectedParent) {
                    Text("— Wurzel (kein Übertopic) —").tag(String?.none)
                    ForEach(options) { t in
                        Text(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › "))
                            .tag(Optional(t.id))
                    }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("Topic verschieben")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Verschieben") { save() }.disabled(loading)
                }
            }
            .onAppear { selectedParent = theme?.parentId }
        }
    }

    private func save() {
        loading = true
        Task {
            do { try await state.moveTheme(id: themeId, parentId: selectedParent); dismiss() }
            catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - Wissen: Detailansicht (read-only — Bearbeitung nur im Web)

struct KnowledgeDetailView: View {
    let page: KnowledgePage
    @EnvironmentObject var state: AppState

    private var themeTitles: [String] {
        page.themeIds.compactMap { id in state.themes.first(where: { $0.id == id })?.title }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        Text(page.title).font(.title2).fontWeight(.bold)
                        Spacer()
                        readOnlyBadge
                    }
                    if !themeTitles.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(themeTitles, id: \.self) { t in
                                    Text(t).scaledFont(.caption2)
                                        .padding(.horizontal, 8).padding(.vertical, 3)
                                        .background(DS.purple.opacity(0.12))
                                        .foregroundStyle(DS.purple)
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }
                }
                .padding()
                .background(.white)
                .clipShape(RoundedRectangle(cornerRadius: DS.cardRadius))
                .shadow(color: DS.cardShadow, radius: 2, y: 1)
                .padding(.bottom, 14)

                HTMLContentView(html: page.content)
                    .padding(.horizontal, 4)
            }
            .padding()
        }
        .background(DS.groupedBg)
        .navigationTitle(page.title)
        .inlineTitle()
    }

    private var readOnlyBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "eye").font(.system(size: 10))
            Text("Nur lesbar").font(.system(size: 11, weight: .semibold))
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(Color.gray.opacity(0.15))
        .foregroundStyle(.secondary)
        .clipShape(Capsule())
    }
}

// MARK: - Theme Form

struct ThemeFormView: View {
    var theme: Theme? = nil
    var parentId: String? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") { TextField("Topic-Name", text: $title) }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical).lineLimit(3...)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(theme == nil ? (parentId == nil ? "Neues Topic" : "Neues Unter-Topic") : "Topic bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }.disabled(title.isEmpty || loading)
                }
            }
            .onAppear {
                if let t = theme { title = t.title; description = stripHTML(t.description) }
            }
        }
    }

    private func save() {
        loading = true
        Task {
            do {
                if let t = theme {
                    try await state.updateTheme(id: t.id, title: title, description: description)
                } else {
                    try await state.createTheme(title: title, description: description, parentId: parentId)
                }
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
