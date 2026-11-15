import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-9: OfflineSnapshotStore.

@Suite(.serialized)
struct OfflineSnapshotStoreTests {
    typealias T = OfflineTestSupport

    private func dataSet(todos: Int = 1) -> ServerDataSet {
        ServerDataSet(meetings: [T.meeting("m1", topics: [T.serverTopic("t1", meeting: "m1")])],
                      todos: (0..<todos).map { T.serverTodo("td\($0)") }, themes: [],
                      contacts: nil, knowledgePages: nil, contactCategories: nil, stackFrames: nil, stackDepth: 3)
    }

    private func detail(_ id: String) throws -> ProgressDetail {
        let json = """
        { "ref": { "type":"todo","id":"\(id)","title":"T","done":false,"exists":true },
          "goal":null,"goalUpdatedAt":null,"nextStep":"","nextStepUpdatedAt":null,
          "stats": { "entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                     "dormant":false,"dormantDays":null,"stale":false,"staleDays":null },
          "reentry": { "show":false,"dormantSince":null,"dormantLabel":null,"empty":true,
                       "ai": { "available":false,"frameId":null } },
          "entries":[], "page": { "limit":20,"hasMore":false,"nextCursor":null } }
        """
        return try JSONDecoder().decode(ProgressDetail.self, from: Data(json.utf8))
    }

    @Test func markerRoundTripAndClear() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        #expect(s.loadMarker() == nil)
        let m = OfflineSessionMarker(user: AppUser(id: "u1", username: "anna", role: "user"),
                                     serverURL: "https://x.test/", biometricProtected: true,
                                     savedAt: Date(timeIntervalSince1970: 1_700_000_000))
        try s.saveMarker(m)
        #expect(s.loadMarker() == m)
        #expect(m.scope == OfflineScope(serverURL: "https://x.test", userId: "u1"))
        s.clearMarker()
        #expect(s.loadMarker() == nil)
    }

    @Test func corruptOrFutureMarkerIsTreatedAsMissing() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        try store.writeUnscoped(Data("{nix".utf8), fileName: "session")
        #expect(s.loadMarker() == nil)
        #expect(try store.readUnscoped(fileName: "session") == nil)
    }

    @Test func snapshotRoundTrip() async throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        let snap = OfflineSnapshot(savedAt: Date(timeIntervalSince1970: 1_700_000_000), data: dataSet())
        try await s.saveSnapshot(snap, scope: T.scope)
        let loaded = try #require(s.loadSnapshot(scope: T.scope))
        #expect(loaded.data == snap.data)
        #expect(loaded.savedAt == snap.savedAt)
    }

    @Test func snapshotIsScopedPerServerAndUser() async throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        try await s.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: dataSet()), scope: T.scope)
        #expect(s.loadSnapshot(scope: OfflineScope(serverURL: "https://example.test", userId: "u2")) == nil)
        #expect(s.loadSnapshot(scope: OfflineScope(serverURL: "https://other.test", userId: "u1")) == nil)
    }

    @Test func corruptSnapshotYieldsNilAndFileIsDeleted() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        try store.write(Data("{kaputt".utf8), scopeKey: T.scope.key, fileName: "snapshot")
        #expect(s.loadSnapshot(scope: T.scope) == nil)
        #expect(try store.read(scopeKey: T.scope.key, fileName: "snapshot") == nil)
    }

    @Test func saveSnapshotFailureThrowsWriteFailed() async throws {
        let blocker = T.tempDir()
        try FileManager.default.createDirectory(at: blocker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let s = OfflineSnapshotStore(store: UserScopedFileStore(baseDirectory: blocker.appendingPathComponent("s")))
        await #expect(throws: OfflineStorageError.writeFailed) {
            try await s.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: dataSet()), scope: T.scope)
        }
    }

    @Test func progressDetailRoundTripAndValidation() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        let d = try detail("a1")
        s.saveProgressDetail(d, refType: "todo", refId: "a1", scope: T.scope)
        #expect(s.loadProgressDetail(refType: "todo", refId: "a1", scope: T.scope) == d)
        #expect(s.loadProgressDetail(refType: "topic", refId: "a1", scope: T.scope) == nil)
        // Unsichere Referenzen werden nicht gespeichert/gelesen.
        s.saveProgressDetail(d, refType: "todo", refId: "../x", scope: T.scope)
        s.saveProgressDetail(d, refType: "todo", refId: "local-abc", scope: T.scope)
        #expect(s.loadProgressDetail(refType: "todo", refId: "../x", scope: T.scope) == nil)
        #expect(s.loadProgressDetail(refType: "todo", refId: "local-abc", scope: T.scope) == nil)
    }

    @Test func progressCacheKeepsAtMost300RefsDroppingOldest() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        let d = try detail("x")
        for i in 0..<(OfflineSnapshotStore.maxProgressRefs + 3) {
            s.saveProgressDetail(d, refType: "todo", refId: "r\(i)", scope: T.scope)
        }
        #expect(s.loadProgressDetail(refType: "todo", refId: "r0", scope: T.scope) == nil)
        #expect(s.loadProgressDetail(refType: "todo", refId: "r2", scope: T.scope) == nil)
        #expect(s.loadProgressDetail(refType: "todo", refId: "r3", scope: T.scope) != nil)
        #expect(s.loadProgressDetail(refType: "todo", refId: "r302", scope: T.scope) != nil)
    }

    @Test func purgeAllRemovesEverythingIncludingMarkerAndQuarantine() async throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let s = OfflineSnapshotStore(store: store)
        try await s.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: dataSet()), scope: T.scope)
        try s.saveMarker(OfflineSessionMarker(user: AppUser(id: "u1", username: "a", role: "user"),
                                              serverURL: "https://x", biometricProtected: false, savedAt: Date()))
        try store.write(Data("x".utf8), scopeKey: T.scope.key, fileName: "outbox")
        try store.quarantine(scopeKey: T.scope.key, fileName: "outbox")
        s.purgeAll()
        #expect(s.loadSnapshot(scope: T.scope) == nil)
        #expect(s.loadMarker() == nil)
        #expect(!FileManager.default.fileExists(atPath: store.baseDirectory.path))
    }
}
