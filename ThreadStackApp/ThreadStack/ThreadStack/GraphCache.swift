import Foundation

/// Persists the last successfully loaded graph snapshot to disk so the Graph
/// view can show a "stale but useful" state when the device is offline.
///
/// Deliberately uses the Application Support directory rather than
/// UserDefaults (not meant for larger structured content) or the Keychain
/// (reserved for credentials) — this cache holds ordinary user content
/// (titles, meta), not secrets.
enum GraphCache {

    struct Snapshot: Codable {
        let savedAt: Date
        let nodes: [GraphNode]
        let edges: [GraphEdge]
        let schema: GraphSchema
        let stats: GraphStats
    }

    private static var directoryURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                   in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent("ThreadStack", isDirectory: true)
    }

    private static var fileURL: URL? {
        guard let dir = directoryURL else { return nil }
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("graph_cache.json")
    }

    /// Best-effort save. Failures are swallowed — the cache is a convenience,
    /// never a source of truth, and must not surface errors that would
    /// distract from the actual (successful) graph load it follows.
    static func save(_ response: GraphResponse) {
        guard let url = fileURL else { return }
        let snapshot = Snapshot(savedAt: Date(), nodes: response.nodes, edges: response.edges,
                                 schema: response.schema, stats: response.stats)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load() -> Snapshot? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    /// Must be called on logout (security requirement): the cache holds
    /// content of the previously authenticated user and must not leak to a
    /// subsequent user of the same device.
    static func clear() {
        guard let url = fileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
