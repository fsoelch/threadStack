import Foundation

//  OfflineSnapshotStore.swift
//  Arbeitspaket P2, Schnittstelle S-9: letzter guter Serverstand (Cache, keine
//  Nutzereingabe), Session-Marker und Zwischenstand-Detail-Cache. Alles liegt
//  im geschuetzten `UserScopedFileStore` (Namespace "Offline").

struct OfflineSnapshotStore {
    static let snapshotFile = "snapshot"
    static let progressCacheFile = "progress_cache"
    static let markerFile = "session"
    static let maxProgressRefs = 300
    private static let schemaVersion = 1

    let store: UserScopedFileStore

    init(store: UserScopedFileStore) {
        self.store = store
    }

    // MARK: Marker (ohne Scope)

    func saveMarker(_ m: OfflineSessionMarker) throws {
        do { try store.writeUnscoped(try JSONEncoder().encode(m), fileName: Self.markerFile) }
        catch { throw OfflineStorageError.writeFailed }
    }

    /// Unlesbarer oder inkompatibler Marker -> nil (und entfernt: ohne gueltigen
    /// Marker gibt es keinen Offline-Zugang, es geht keine Nutzereingabe verloren).
    func loadMarker() -> OfflineSessionMarker? {
        guard let data = try? store.readUnscoped(fileName: Self.markerFile) else {
            store.removeUnscoped(fileName: Self.markerFile)
            return nil
        }
        guard let marker = try? JSONDecoder().decode(OfflineSessionMarker.self, from: data),
              marker.schemaVersion == Self.schemaVersion else {
            store.removeUnscoped(fileName: Self.markerFile)
            return nil
        }
        return marker
    }

    func clearMarker() {
        store.removeUnscoped(fileName: Self.markerFile)
    }

    // MARK: Snapshot

    /// Encoding auf dem Aufrufer-Actor, Datei-Schreiben ausserhalb des MainActors.
    func saveSnapshot(_ s: OfflineSnapshot, scope: OfflineScope) async throws {
        let data: Data
        do { data = try JSONEncoder().encode(s) }
        catch { throw OfflineStorageError.writeFailed }
        let store = self.store
        let key = scope.key
        let result: Result<Void, Error> = await Task.detached(priority: .utility) {
            Result { try store.write(data, scopeKey: key, fileName: OfflineSnapshotStore.snapshotFile) }
        }.value
        if case .failure = result { throw OfflineStorageError.writeFailed }
    }

    /// Korrupt/inkompatibel -> nil + Datei loeschen (Cache, keine Nutzereingabe).
    func loadSnapshot(scope: OfflineScope) -> OfflineSnapshot? {
        let data: Data?
        do { data = try store.read(scopeKey: scope.key, fileName: Self.snapshotFile) }
        catch {
            store.remove(scopeKey: scope.key, fileName: Self.snapshotFile)
            return nil
        }
        guard let data else { return nil }
        guard let snap = try? JSONDecoder().decode(OfflineSnapshot.self, from: data),
              snap.schemaVersion == Self.schemaVersion else {
            store.remove(scopeKey: scope.key, fileName: Self.snapshotFile)
            return nil
        }
        return snap
    }

    // MARK: Zwischenstand-Detail-Cache

    private struct ProgressCacheEntry: Codable {
        let key: String
        var usedAt: Date
        let detail: ProgressDetail
    }

    private struct ProgressCacheFile: Codable {
        var schemaVersion: Int = 1
        var entries: [ProgressCacheEntry]
    }

    private static func cacheKey(refType: String, refId: String) -> String? {
        guard refType == "todo" || refType == "topic", OfflineIds.isSafeServerId(refId) else { return nil }
        return refType + ":" + refId
    }

    private func loadCacheFile(scope: OfflineScope) -> ProgressCacheFile {
        guard let data = try? store.read(scopeKey: scope.key, fileName: Self.progressCacheFile),
              let file = try? JSONDecoder().decode(ProgressCacheFile.self, from: data),
              file.schemaVersion == Self.schemaVersion else {
            return ProgressCacheFile(entries: [])
        }
        return file
    }

    /// Best effort (Fehler werden geschluckt). LRU nach Speicherzeitpunkt, max. 300 Referenzen.
    func saveProgressDetail(_ d: ProgressDetail, refType: String, refId: String, scope: OfflineScope) {
        guard let key = Self.cacheKey(refType: refType, refId: refId) else { return }
        var file = loadCacheFile(scope: scope)
        file.entries.removeAll { $0.key == key }
        file.entries.append(ProgressCacheEntry(key: key, usedAt: Date(), detail: d))
        if file.entries.count > Self.maxProgressRefs {
            file.entries.sort { $0.usedAt < $1.usedAt }
            file.entries.removeFirst(file.entries.count - Self.maxProgressRefs)
        }
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? store.write(data, scopeKey: scope.key, fileName: Self.progressCacheFile)
    }

    func loadProgressDetail(refType: String, refId: String, scope: OfflineScope) -> ProgressDetail? {
        guard let key = Self.cacheKey(refType: refType, refId: refId) else { return nil }
        return loadCacheFile(scope: scope).entries.first { $0.key == key }?.detail
    }

    /// Namespace "Offline" komplett (alle Scopes, Marker, Quarantaene).
    func purgeAll() {
        store.removeAll()
    }
}
