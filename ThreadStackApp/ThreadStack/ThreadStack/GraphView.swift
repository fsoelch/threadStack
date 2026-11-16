import SwiftUI

/// Story B9 — Graph-Ansicht.
///
/// Scope (verbindlich, siehe Architektur): Navigieren, Zoomen/Schwenken,
/// Filtern, Suchen, Knoten verschieben inkl. Positions-Persistenz,
/// Topic-Umhängen per Drag mit Zyklus-Schutz und Rollback. KEINE Kanten-
/// Erstellung/-Löschung im Graph selbst. Wissens-Knoten können über den
/// Knoten-Detail-Dialog im nativen Editor (`KnowledgeEditorView`, Paket 6)
/// bearbeitet werden (Paket 7 „knowledge-entrypoints“).
struct GraphView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var graphStore: GraphStore
    @EnvironmentObject var offline: OfflineStatusStore

    @State private var positions: [String: CGPoint] = [:]
    @State private var visibleTypes: Set<GraphNodeType> = GraphView.loadVisibleTypes()
    @State private var search = ""
    @State private var selectedNode: GraphNode?
    @State private var selectedEdge: GraphEdge?
    @State private var focusKey: String?
    @State private var reparentCandidate: ReparentCandidate?
    @State private var error: String?
    @State private var showLegendSheet = false
    @State private var lastNodeCount = 0
    @State private var editingKnowledgePage: KnowledgePage?

    private static let visibleTypesDefaultsKey = "graph.visibleTypes"

    struct ReparentCandidate: Identifiable {
        let id = UUID()
        let source: GraphNode
        let target: GraphNode
        let previousPoint: CGPoint
        let newPoint: CGPoint
    }

    private var nodesByKey: [String: GraphNode] {
        Dictionary(uniqueKeysWithValues: graphStore.nodes.map { ($0.key, $0) })
    }

    private var searchMatchKeys: Set<String> {
        guard !search.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        return Set(graphStore.nodes
            .filter { $0.title.localizedCaseInsensitiveContains(search) }
            .map(\.key))
    }

    /// `graphStore.isOffline` wird erst von P7 aus dem globalen Status abgeleitet und
    /// kann bis dahin nur nach einem fehlgeschlagenen Graph-Load gesetzt sein; der
    /// globale Status (`offline.isOffline`) kennt den Zustand frueher. Beide zaehlen.
    private var isEffectivelyOffline: Bool { offline.isOffline || graphStore.isOffline }

    var body: some View {
        content
            .navigationTitle("Graph")
            .task { await initialLoad() }
            .onChange(of: graphStore.nodes) { _, newNodes in syncPositions(for: newNodes) }
            .onChange(of: search) { _, _ in updateFocusFromSearch() }
            .onChange(of: visibleTypes) { _, newValue in GraphView.saveVisibleTypes(newValue) }
            .errorAlert($error)
            .confirmationDialog(reparentDialogTitle, isPresented: Binding(
                get: { reparentCandidate != nil }, set: { if !$0 { cancelReparent() } }
            ), titleVisibility: .visible) {
                Button("Verschieben") { confirmReparent() }
                Button("Abbrechen", role: .cancel) { cancelReparent() }
            }
            .sheet(item: $selectedNode) { node in
                GraphNodeDetailSheet(node: node) {
                    openNode(node)
                }
            }
            .sheet(item: $editingKnowledgePage) { page in
                KnowledgeEditorView(mode: .edit(page))
            }
            .popover(item: $selectedEdge) { edge in
                GraphEdgeInfoView(edge: edge, nodesByKey: nodesByKey)
                    .frame(minWidth: 220, minHeight: 90)
                    .padding()
            }
    }

    private var reparentDialogTitle: String {
        guard let c = reparentCandidate else { return "" }
        return "„\(c.source.title)\u{201C} unter „\(c.target.title)\u{201C} verschieben?"
    }

    // MARK: - Platform layout

    @ViewBuilder private var content: some View {
        #if os(macOS)
        HSplitView {
            sidebarPanel
                .frame(minWidth: 220, maxWidth: 300)
            canvasArea
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        #else
        canvasArea
            .searchable(text: $search, prompt: "Graph durchsuchen")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { filterMenu }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showLegendSheet = true } label: { Image(systemName: "questionmark.circle") }
                }
            }
            .sheet(isPresented: $showLegendSheet) { GraphLegendView() }
        #endif
    }

    #if os(macOS)
    private var sidebarPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField("Graph durchsuchen", text: $search)
                .textFieldStyle(.roundedBorder)
            Text("Filter").font(.subheadline).fontWeight(.semibold)
            ForEach(GraphNodeType.allCases, id: \.self) { type in
                Toggle(isOn: Binding(
                    get: { visibleTypes.contains(type) },
                    set: { on in
                        if on { visibleTypes.insert(type) } else { visibleTypes.remove(type) }
                    }
                )) {
                    Label(type.label, systemImage: type.symbolName)
                }
                .toggleStyle(.checkbox)
            }
            Divider()
            GraphLegendView()
            Spacer()
        }
        .padding()
    }
    #endif

    private var filterMenu: some View {
        Menu {
            ForEach(GraphNodeType.allCases, id: \.self) { type in
                Button {
                    if visibleTypes.contains(type) { visibleTypes.remove(type) } else { visibleTypes.insert(type) }
                } label: {
                    Label(type.label, systemImage: visibleTypes.contains(type) ? "checkmark.circle.fill" : "circle")
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
        }
    }

    @ViewBuilder private var canvasArea: some View {
        if OfflineGating.showsUnavailable(isOffline: isEffectivelyOffline,
                                                 hasContent: !graphStore.nodes.isEmpty,
                                                 loadFailedOffline: false) {
            // Nie geladen und offline: Platzhalter statt Leerzustand/Fehler (UX S1).
            OfflineUnavailableView(reason: .notLoadedYet) { Task { await graphStore.load() } }
        } else if graphStore.isLoading && graphStore.nodes.isEmpty {
            ProgressView("Graph wird geladen…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = graphStore.error, graphStore.nodes.isEmpty {
            errorState(err)
        } else if graphStore.nodes.isEmpty {
            emptyState
        } else {
            ZStack(alignment: .top) {
                GraphCanvas(
                    nodes: graphStore.nodes,
                    edges: graphStore.edges,
                    positions: $positions,
                    visibleTypes: visibleTypes,
                    searchMatchKeys: searchMatchKeys,
                    focusKey: focusKey,
                    editingEnabled: !isEffectivelyOffline,
                    onTapNode: { selectedNode = $0 },
                    onTapEdge: { selectedEdge = $0 },
                    onNodeDragEnded: handleNodeDragEnded
                )
                // Eigener Offline-Banner entfernt (UX Konsistenzentscheidung 3):
                // der globale OfflineStatusBanner in ContentView deckt Offline-Hinweis
                // und Stand ab; Bearbeiten bleibt ueber `editingEnabled` gesperrt.
                if graphStore.positionSaveError != nil {
                    positionSaveHint
                }
            }
        }
    }

    private var positionSaveHint: some View {
        VStack {
            Spacer()
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                Text("Position konnte nicht gespeichert werden — wird erneut versucht.")
                    .font(.caption2)
            }
            .padding(6)
            .background(.thinMaterial)
            .clipShape(Capsule())
            .padding(.bottom, 8)
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 40)).foregroundStyle(.secondary)
            Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Erneut versuchen") { Task { await graphStore.load() } }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                .font(.system(size: 40)).foregroundStyle(.secondary)
            Text("Noch keine Topics vorhanden — lege dein erstes Topic an, um den Graphen zu füllen.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Erneut versuchen") { Task { await graphStore.load() } }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Load / layout sync

    private func initialLoad() async {
        await graphStore.load()
        syncPositions(for: graphStore.nodes)
    }

    /// Recomputes default positions only for nodes that don't have one yet,
    /// preserving all currently known/dragged positions untouched.
    private func syncPositions(for nodes: [GraphNode]) {
        guard nodes.count != lastNodeCount || positions.count < nodes.count else {
            // Cheap guard against recomputation on every minor state change;
            // still recomputes on first load and whenever the node count changes.
            lastNodeCount = nodes.count
            return
        }
        lastNodeCount = nodes.count
        let computed = GraphLayout.computePositions(nodes: nodes, edges: graphStore.edges)
        for (key, point) in computed where positions[key] == nil {
            positions[key] = point
        }
        // Drop positions for nodes that no longer exist (deleted objects).
        let validKeys = Set(nodes.map(\.key))
        positions = positions.filter { validKeys.contains($0.key) }
    }

    private func updateFocusFromSearch() {
        guard let firstMatch = searchMatchKeys.sorted().first else { return }
        focusKey = firstMatch
    }

    // MARK: - Node open / navigation

    private func openNode(_ node: GraphNode) {
        selectedNode = nil
        switch node.nodeType {
        case .knowledge:
            if let page = state.knowledgePages.first(where: { $0.id == node.id }) {
                editingKnowledgePage = page
            } else {
                error = "Objekt existiert nicht mehr."
                Task { await graphStore.load() }
            }
        case .todo:
            graphStore.navigationRequest = .todos
        case .theme:
            graphStore.navigationRequest = .themes
        case .contact:
            graphStore.navigationRequest = .contacts
        case .topic:
            if let meetingId = node.meta?.meetingId {
                graphStore.navigationRequest = .meeting(meetingId: meetingId)
            } else {
                error = "Objekt existiert nicht mehr."
                Task { await graphStore.load() }
            }
        }
    }

    // MARK: - Drag handling (move / reparent)

    private func handleNodeDragEnded(_ node: GraphNode, previous: CGPoint, new: CGPoint, droppedOnKey: String?) {
        guard !isEffectivelyOffline else {
            // Editing is disabled while offline — revert visually.
            positions[node.key] = previous
            return
        }
        if let targetKey = droppedOnKey, targetKey != node.key,
           node.nodeType == .theme, let target = nodesByKey[targetKey], target.nodeType == .theme {
            positions[node.key] = new
            beginReparent(source: node, target: target, previous: previous, new: new)
            return
        }
        positions[node.key] = new
        graphStore.enqueuePositionSave(type: node.type, id: node.id, x: Double(new.x), y: Double(new.y))
    }

    private func beginReparent(source: GraphNode, target: GraphNode, previous: CGPoint, new: CGPoint) {
        if target.id == source.id {
            positions[source.key] = previous
            error = "Ein Topic kann nicht sein eigenes Elternteil sein"
            return
        }
        if themeDescendantIds(of: source.id).contains(target.id) {
            positions[source.key] = previous
            error = "Zyklus: Ziel ist ein Unter-Topic dieses Topics"
            return
        }
        reparentCandidate = ReparentCandidate(source: source, target: target, previousPoint: previous, newPoint: new)
    }

    private func confirmReparent() {
        guard let c = reparentCandidate else { return }
        reparentCandidate = nil
        Task { () async -> Void in
            do {
                try await state.moveTheme(id: c.source.id, parentId: c.target.id)
                // Conservative reconciliation: edge direction for `hierarchy`
                // isn't specified precisely enough to safely splice locally,
                // so we refresh from the server rather than guess.
                await graphStore.load()
                positions[c.source.key] = c.newPoint
                graphStore.enqueuePositionSave(type: c.source.type, id: c.source.id,
                                               x: Double(c.newPoint.x), y: Double(c.newPoint.y))
            } catch {
                positions[c.source.key] = c.previousPoint
                self.error = error.localizedDescription
            }
        }
    }

    private func cancelReparent() {
        guard let c = reparentCandidate else { return }
        positions[c.source.key] = c.previousPoint
        reparentCandidate = nil
    }

    /// All theme ids that are (transitive) children of `id`, based on
    /// `meta.parentId` as delivered by `/api/graph`.
    private func themeDescendantIds(of id: String) -> Set<String> {
        var childrenByParent: [String: [String]] = [:]
        for n in graphStore.nodes where n.nodeType == .theme {
            guard let parentId = n.meta?.parentId else { continue }
            childrenByParent[parentId, default: []].append(n.id)
        }
        var result: Set<String> = []
        var queue = childrenByParent[id] ?? []
        while let next = queue.popLast() {
            guard !result.contains(next) else { continue }
            result.insert(next)
            queue.append(contentsOf: childrenByParent[next] ?? [])
        }
        return result
    }

    // MARK: - Filter persistence (UserDefaults)

    private static func loadVisibleTypes() -> Set<GraphNodeType> {
        guard let raw = UserDefaults.standard.array(forKey: visibleTypesDefaultsKey) as? [String] else {
            return Set(GraphNodeType.allCases)
        }
        let types = raw.compactMap { GraphNodeType(rawValue: $0) }
        return types.isEmpty ? Set(GraphNodeType.allCases) : Set(types)
    }

    private static func saveVisibleTypes(_ types: Set<GraphNodeType>) {
        UserDefaults.standard.set(types.map(\.rawValue), forKey: visibleTypesDefaultsKey)
    }
}

// MARK: - Node detail sheet

private struct GraphNodeDetailSheet: View {
    let node: GraphNode
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                ZStack {
                    Circle().fill(node.nodeType.color.opacity(0.15)).frame(width: 44, height: 44)
                    Image(systemName: node.nodeType.symbolName).foregroundStyle(node.nodeType.color)
                }
                VStack(alignment: .leading) {
                    Text(node.title).font(.headline)
                    Text(node.nodeType.label).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }

            metaSection

            Button(node.nodeType == .knowledge ? "Bearbeiten" : "Öffnen", action: onOpen)
                .buttonStyle(.borderedProminent)
            Spacer()
        }
        .padding()
    }

    @ViewBuilder private var metaSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let done = node.done {
                Label(done ? "Erledigt" : "Offen", systemImage: done ? "checkmark.circle" : "circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let meta = node.meta {
                if let d = meta.descriptionText, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary)
                }
                if let due = meta.dueDate {
                    Label("Fällig: \(due)", systemImage: "calendar").font(.caption).foregroundStyle(.secondary)
                }
                if let updated = meta.updatedAt {
                    Label("Aktualisiert: \(updated)", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                }
                if let meetingTitle = meta.meetingTitle {
                    Label(meetingTitle, systemImage: "calendar.badge.clock").font(.caption).foregroundStyle(.secondary)
                }
                if let role = meta.role, !role.isEmpty {
                    Label(role, systemImage: "briefcase").font(.caption).foregroundStyle(.secondary)
                }
                if let count = meta.childCount {
                    Text("\(count) Unter-Topics").font(.caption2).foregroundStyle(.secondary)
                }
                if let count = meta.linkCount {
                    Text("\(count) Verknüpfungen").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Edge info popover

private struct GraphEdgeInfoView: View {
    let edge: GraphEdge
    let nodesByKey: [String: GraphNode]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Verbindung").font(.headline)
            HStack(spacing: 6) {
                Text(title(for: edge.source))
                Image(systemName: edge.edgeKind.isDashed ? "arrow.left.and.right" : "arrow.right")
                    .foregroundStyle(.secondary)
                Text(title(for: edge.target))
            }
            .font(.subheadline)
        }
    }

    private func title(for ref: GraphNodeRef) -> String {
        nodesByKey[ref.key]?.title ?? "Unbekannt"
    }
}
