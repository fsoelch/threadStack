//
//  GraphStore.swift
//  ThreadStack
//
//  Arbeit zur Lesbarkeit/Wartbarkeit: aus AppState.swift extrahiert (Story
//  B9 lebte dort ursprünglich vollständig inline). `AppState` war bereits
//  Vorbild für diese Aufteilung selbst — `ProgressStore`/`SummaryStore`
//  wurden analog schon vorher ausgelagert; Graph-Zustand ist der
//  eigenständigste/isolierteste Teil von `AppState` (eigener Cache, eigene
//  Debounce-Queue) und daher der naheliegendste erste Kandidat.
//
//  `AppState` wird direkt gehalten (wie bei `ProgressStore`/`SummaryStore`),
//  Netzwerk-Zugriffe laufen über `AppState.request(...)` (internal, nicht
//  `private`) statt einer eigenen Request-Fassade — es gibt keinen KI-/
//  Archiv-/Knowledge-spezifischen Fehler-Envelope für den Graphen, der
//  einen eigenen `graphRequest`-Helfer wie bei Progress/Summary/Archive/
//  Knowledge rechtfertigen würde.
//
//  Security-Anforderung (Story B9 / Offline-Cache) bleibt erhalten: der
//  Graph-Cache auf Platte gehört dem vorherigen Nutzer und darf einen
//  Logout nicht überleben. Da `AppState.logout()` aber kein Feld mehr
//  besitzt, das es selbst leeren könnte, hält `AppState` eine `weak`
//  Referenz auf den `GraphStore` (von der Kompositionswurzel gesetzt,
//  siehe `ThreadStackApp.swift`) und ruft darüber `clearOnLogout()` auf -
//  die Garantie gilt damit weiterhin für JEDEN Logout-Aufruf, unabhängig
//  davon, ob ein Aufrufer daran denkt, den Store separat zu leeren.
//

import Foundation
import Combine

@MainActor
final class GraphStore: ObservableObject {

    @Published var nodes: [GraphNode] = []
    @Published var edges: [GraphEdge] = []
    @Published var schema: GraphSchema = GraphSchema()
    @Published var stats: GraphStats = GraphStats()
    @Published var isLoading = false
    /// Set when the last load failed but a cached snapshot could be shown instead.
    @Published private(set) var isShowingCache = false
    /// Offline-Modus: einzige Wahrheitsquelle ist der globale Offline-Status; zusaetzlich gilt
    /// "Cache wird angezeigt" (ein einzelner Graph-Request kann scheitern, ohne dass der globale Status kippt).
    var isOffline: Bool { isShowingCache || (offlineStatus?.isOffline ?? false) }
    /// User-facing error text when neither a live load nor a cache was available.
    @Published var error: String?
    @Published var lastLoadedAt: Date?
    /// Dezenter Hinweis, dass die letzte Positions-Speicherung fehlgeschlagen ist
    /// (Position bleibt lokal sichtbar, Wiederholung folgt automatisch).
    @Published var positionSaveError: String?
    /// Set by the Graph view's node "Öffnen" action, consumed by `ContentView`
    /// to switch to the matching existing detail view.
    @Published var navigationRequest: GraphNavigationTarget?

    private let appState: AppState
    private weak var offlineStatus: OfflineStatusStore?
    private var offlineCancellable: AnyCancellable?

    private lazy var positionSync: GraphPositionSync = {
        let sync = GraphPositionSync()
        sync.onFlush = { [weak self] moves in
            try await self?.savePositions(moves)
        }
        sync.onError = { [weak self] error in
            self?.positionSaveError = error.localizedDescription
        }
        return sync
    }()

    init(appState: AppState) {
        self.appState = appState
    }

    /// Kompositionswurzel: leitet den globalen Offline-Status ab (`isOffline`) und stoesst bei Wiederverbindung
    /// das Nachsenden gepufferter Positionen an (`positionSync.flushNow()`).
    func bindOfflineStatus(_ status: OfflineStatusStore) {
        offlineStatus = status
        offlineCancellable = status.$connection
            .removeDuplicates()
            .sink { [weak self] connection in
                guard let self else { return }
                self.objectWillChange.send()
                if connection == .online {
                    Task { @MainActor in await self.positionSync.flushNow() }
                }
            }
    }

    private var cacheScope: OfflineScope? { appState.offline?.activeScope }

    /// Loads the full graph in a single round trip. Falls back to the last
    /// cached snapshot (see `GraphCache`) if the request fails, so the view
    /// still has something useful to show when offline.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let resp: GraphResponse = try await appState.request("GET", "/graph")
            nodes = resp.nodes
            edges = resp.edges
            schema = resp.schema
            stats = resp.stats
            isShowingCache = false
            error = nil
            lastLoadedAt = Date()
            GraphCache.save(resp, scope: cacheScope)
            // A reconnect might have brought back moves queued while offline.
            await positionSync.flushNow()
        } catch let loadError {
            if let cached = GraphCache.load(scope: cacheScope) {
                nodes = cached.nodes
                edges = cached.edges
                schema = cached.schema
                stats = cached.stats
                isShowingCache = true
                error = nil
            } else {
                nodes = []; edges = []
                isShowingCache = false
                error = loadError.localizedDescription
            }
        }
    }

    /// Queues a single node's new position for debounced (500ms), serialized
    /// persistence. Safe to call repeatedly during a drag; only the final
    /// position per node key survives to be sent.
    func enqueuePositionSave(type: String, id: String, x: Double, y: Double) {
        positionSaveError = nil
        positionSync.enqueue(type: type, id: id, x: x, y: y)
    }

    /// Direct save of a batch of positions. Called by `GraphPositionSync`;
    /// exposed for callers (e.g. tests) that want to bypass debouncing.
    /// Contract: `PATCH /api/graph/positions`, body `{positions: [...]}`, max 500 per request.
    func savePositions(_ moves: [GraphPositionSync.Move]) async throws {
        guard !moves.isEmpty else { return }
        var idx = 0
        while idx < moves.count {
            let end = min(idx + 500, moves.count)
            let chunk = moves[idx..<end]
            let payload: [[String: Any]] = chunk.map {
                ["type": $0.type, "id": $0.id, "x": $0.x, "y": $0.y]
            }
            let _: GraphPositionsSaveResponse = try await appState.request("PATCH", "/graph/positions",
                                                                   body: ["positions": payload])
            idx = end
        }
    }

    /// Security requirement (Story B9 / offline cache): the on-disk graph
    /// cache holds the previous user's content and must not survive logout.
    /// Called from `AppState.logout()` via the weak back-reference described
    /// in the file header comment.
    func clearOnLogout() {
        nodes = []; edges = []
        schema = GraphSchema(); stats = GraphStats()
        isShowingCache = false; error = nil; positionSaveError = nil
        lastLoadedAt = nil
        GraphCache.clear(scope: cacheScope)
    }
}
