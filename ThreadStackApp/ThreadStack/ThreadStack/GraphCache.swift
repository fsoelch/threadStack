import Foundation

/// Persists the last successfully loaded graph snapshot to disk so the Graph
/// view can show a "stale but useful" state when the device is offline.
///
/// Offline-Modus (Paket P7): Der Cache liegt jetzt im geschuetzten, je Server
/// und Nutzer getrennten Offline-Bestand (`UserScopedFileStore`, Namespace
/// "Offline", Datei `graph_cache`): `.completeFileProtection`, vom Backup
/// ausgeschlossen, gehasht je Scope. Beim Logout loescht
/// `OfflineCoordinator.deactivateAndPurgeAll()` den gesamten Namespace; zusaetzlich
/// raeumt `clear()` die alte, ungeschuetzte Datei (`ThreadStack/graph_cache.json`) ab.
/// Ohne aktiven Scope (nicht angemeldet) wird nichts gelesen oder geschrieben.
enum GraphCache {

    struct Snapshot: Codable {
        let savedAt: Date
        let nodes: [GraphNode]
        let edges: [GraphEdge]
        let schema: GraphSchema
        let stats: GraphStats
    }

    static let fileName = "graph_cache"

    /// Produktiver Speicher (Namespace "Offline"); Tests injizieren einen eigenen.
    static var defaultStore: UserScopedFileStore? { UserScopedFileStore.applicationSupport(namespace: "Offline") }

    /// Best-effort save. Failures are swallowed — the cache is a convenience,
    /// never a source of truth, and must not surface errors that would
    /// distract from the actual (successful) graph load it follows.
    static func save(_ response: GraphResponse, scope: OfflineScope?, store: UserScopedFileStore? = nil) {
        guard let scope, let store = store ?? defaultStore else { return }
        removeLegacyFile()
        let snapshot = Snapshot(savedAt: Date(), nodes: response.nodes, edges: response.edges,
                                 schema: response.schema, stats: response.stats)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? store.write(data, scopeKey: scope.key, fileName: fileName)
    }

    static func load(scope: OfflineScope?, store: UserScopedFileStore? = nil) -> Snapshot? {
        guard let scope, let store = store ?? defaultStore,
              let data = try? store.read(scopeKey: scope.key, fileName: fileName) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    /// Must be called on logout (security requirement): the cache holds
    /// content of the previously authenticated user and must not leak to a
    /// subsequent user of the same device.
    static func clear(scope: OfflineScope? = nil, store: UserScopedFileStore? = nil) {
        if let scope, let store = store ?? defaultStore {
            store.remove(scopeKey: scope.key, fileName: fileName)
        }
        removeLegacyFile()
    }

    /// Alte Ablage vor dem Offline-Modus (weder je Nutzer getrennt noch dateigeschuetzt): entfernen.
    static func removeLegacyFile() {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let url = dir.appendingPathComponent("ThreadStack", isDirectory: true).appendingPathComponent("graph_cache.json")
        try? FileManager.default.removeItem(at: url)
    }
}
