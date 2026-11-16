import Testing
import Foundation
@testable import ThreadStack

//  Paket P7: Logout-Purge (Story 12), Graph-Cache im geschuetzten Scope, abgeleitetes GraphStore.isOffline,
//  In-Memory-Zustand nach dem Abmelden.

private func sampleGraph() throws -> GraphResponse {
    let json = """
    {"nodes":[{"type":"todo","id":"d1","title":"Erledigen","x":null,"y":null,"hasStoredPosition":false,"done":false,"meta":{}}],
     "edges":[],"schema":{"nodeTypes":["todo"],"edgeKinds":[],"compatibility":[]},
     "stats":{"nodeCount":1,"edgeCount":0,"truncated":false}}
    """.data(using: .utf8)!
    return try JSONDecoder().decode(GraphResponse.self, from: json)
}

@MainActor @Suite(.serialized)
struct OfflineLogoutTests {
    typealias T = OfflineTestSupport

    private func readyRig(pending: Bool) async throws -> P7Rig {
        let r = try P7Rig()
        r.serverTodos = [T.serverTodo("s1")]
        await r.coordinator.refresh(.manual)
        if pending {
            r.goOffline()
            _ = try await r.state.createTodoReturning(title: "Unsynchronisiert", description: "")
        }
        return r
    }

    @Test func logoutPurgesEverythingLocalAndEndsTheSession() async throws {
        let r = try await readyRig(pending: false)
        r.state.hasStoredCredentials = true
        #expect(r.snapshots.loadMarker() != nil && r.snapshots.loadSnapshot(scope: r.scope) != nil)
        r.state.offlineUnlockCredentials = StoredCredentials(username: "anna", password: "pw")
        r.state.reauthRequested = true

        try await r.state.logout()

        #expect(r.snapshots.loadMarker() == nil)
        #expect(r.snapshots.loadSnapshot(scope: r.scope) == nil)
        #expect((try? r.store.read(scopeKey: r.scope.key, fileName: OfflineOutbox.fileName)) == nil)
        #expect(r.coordinator.activeScope == nil)
        #expect(r.status.items.isEmpty && !r.status.isOffline && r.status.dataAsOf == nil)
        #expect(!r.status.isShowingCachedData && r.status.activity == .idle)
        #expect(r.state.currentUser == nil && r.state.todos.isEmpty && r.state.meetings.isEmpty)
        #expect(r.state.offlineUnlockCredentials == nil && !r.state.reauthRequested)
        #expect(r.state.offlineChanges.isEmpty && !r.state.hasCompletedInitialLoad)
        #expect(r.server.count(method: "POST", pathPrefix: "/logout") == 1)
    }

    @Test func logoutWithPendingChangesDropsThemAfterConfirmation() async throws {
        let r = try await readyRig(pending: true)
        #expect(r.status.unsyncedCount == 1)
        // Warnung im UI: Anzahl + Pflicht zur Bestaetigung (P4-Logik), danach loescht der Logout alles.
        #expect(LogoutConfirmationLogic.needsConfirmation(unsyncedCount: r.status.unsyncedCount))
        #expect(LogoutConfirmationLogic.message(unsyncedCount: r.status.unsyncedCount)
                == "1 Änderung ist noch nicht übertragen und geht verloren.")
        try await r.state.logout()
        #expect(r.status.items.isEmpty && r.state.todos.isEmpty)
        #expect((try? r.store.read(scopeKey: r.scope.key, fileName: OfflineOutbox.fileName)) == nil)
    }

    @Test func logoutOfflineIsFastAndSkipsTheServerCall() async throws {
        let r = try await readyRig(pending: true)
        r.server.clear()
        let started = Date()
        try await r.state.logout()
        #expect(Date().timeIntervalSince(started) < 3)
        #expect(r.server.requests.isEmpty)
        #expect(r.snapshots.loadMarker() == nil)
        #expect(r.status.items.isEmpty && !r.status.isOffline)   // Status zurueck auf Standard
    }

    @Test func logoutRemovesScopesOfAllAccounts() async throws {
        let r = try await readyRig(pending: false)
        let other = OfflineScope(serverURL: r.scope.serverURL, userId: "u-alt")
        try r.store.write(Data("{}".utf8), scopeKey: other.key, fileName: OfflineSnapshotStore.snapshotFile)
        try r.store.write(Data("{}".utf8), scopeKey: other.key, fileName: OfflineOutbox.fileName)
        try await r.state.logout()
        #expect((try? r.store.read(scopeKey: other.key, fileName: OfflineOutbox.fileName)) == nil)
        #expect((try? r.store.read(scopeKey: other.key, fileName: OfflineSnapshotStore.snapshotFile)) == nil)
    }

    @Test func logoutClearsProgressStoreAndCache() async throws {
        let r = try await readyRig(pending: false)
        r.override = { req in
            req.url?.path.hasPrefix("/api/progress/todo/t1") == true ? .json(200, rigDetailJSON()) : nil
        }
        await r.progress.load(refType: "todo", refId: "t1")
        #expect(r.progress.state(refType: "todo", refId: "t1").detail != nil)
        #expect(r.snapshots.loadProgressDetail(refType: "todo", refId: "t1", scope: r.scope) != nil)
        try await r.state.logout()
        #expect(r.progress.state(refType: "todo", refId: "t1") == .idle)
        #expect(r.snapshots.loadProgressDetail(refType: "todo", refId: "t1", scope: r.scope) == nil)
    }

    @Test func newUserAfterLogoutStartsWithAnEmptyStore() async throws {
        let r = try await readyRig(pending: true)
        try await r.state.logout()
        r.goOnline()
        r.loggedInUser = AppUser(id: "u2", username: "bob", role: "user")
        try await r.state.login(username: "bob", password: "pw")
        #expect(r.state.currentUser?.id == "u2" && r.status.items.isEmpty)
        #expect(r.snapshots.loadMarker()?.user.id == "u2")
        #expect(r.snapshots.loadSnapshot(scope: OfflineScope(serverURL: r.scope.serverURL, userId: "u1")) == nil)
    }

    @Test func logoutWithoutOfflineModeStillWorks() async throws {
        let host = "plain-\(UUID().uuidString.lowercased()).invalid"
        let server = RigServer()
        server.handler = { _ in .json(200, ["ok": true]) }
        OfflineRigURLProtocol.register(host: host, server: server)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [OfflineRigURLProtocol.self]
        let state = AppState(session: URLSession(configuration: cfg))
        state.serverURL = "https://\(host)"
        state.currentUser = P7Rig.user
        try await state.logout()
        #expect(state.currentUser == nil)
    }

    // MARK: Graph-Cache im geschuetzten Scope

    @Test func graphCacheLivesInTheScopedStoreAndIsSeparatedPerUser() throws {
        let store = T.makeStore()
        defer { store.removeAll() }
        let scopeA = OfflineScope(serverURL: "https://example.test", userId: "a")
        let scopeB = OfflineScope(serverURL: "https://example.test", userId: "b")
        GraphCache.save(try sampleGraph(), scope: scopeA, store: store)
        #expect(GraphCache.load(scope: scopeA, store: store)?.nodes.count == 1)
        #expect(GraphCache.load(scope: scopeB, store: store) == nil)       // anderer Nutzer sieht nichts
        #expect(GraphCache.load(scope: nil, store: store) == nil)          // ohne aktiven Scope kein Zugriff
        GraphCache.save(try sampleGraph(), scope: nil, store: store)       // ohne Scope: kein Schreiben
        GraphCache.clear(scope: scopeA, store: store)
        #expect(GraphCache.load(scope: scopeA, store: store) == nil)
    }

    @Test func graphCacheIsRemovedByNamespacePurge() throws {
        let store = T.makeStore()
        let scope = OfflineScope(serverURL: "https://example.test", userId: "a")
        GraphCache.save(try sampleGraph(), scope: scope, store: store)
        OfflineSnapshotStore(store: store).purgeAll()
        #expect(GraphCache.load(scope: scope, store: store) == nil)
    }

    @Test func graphCacheRemovesLegacyUnprotectedFile() throws {
        let dir = try #require(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
            .appendingPathComponent("ThreadStack", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let legacy = dir.appendingPathComponent("graph_cache.json")
        try Data("{}".utf8).write(to: legacy)
        GraphCache.clear()
        #expect(!FileManager.default.fileExists(atPath: legacy.path))
    }

    @Test func graphStoreIsOfflineFollowsGlobalStatusAndCache() async throws {
        let r = try P7Rig()
        let graph = GraphStore(appState: r.state)
        graph.bindOfflineStatus(r.status)
        #expect(!graph.isOffline)
        r.goOffline()
        #expect(graph.isOffline)
        r.status.connection = .online
        #expect(!graph.isOffline)
    }

    @Test func graphLoadFallsBackToScopedCacheWhenRequestFails() async throws {
        let r = try P7Rig()
        // Eigener Scope-Eintrag im produktiven Offline-Namespace (GraphStore nutzt `GraphCache.defaultStore`).
        guard GraphCache.defaultStore != nil else { return }
        GraphCache.save(try sampleGraph(), scope: r.scope)
        defer { GraphCache.clear(scope: r.scope) }
        let graph = GraphStore(appState: r.state)
        r.failTransport = true
        await graph.load()
        #expect(graph.nodes.count == 1 && graph.isShowingCache && graph.isOffline && graph.error == nil)
        graph.clearOnLogout()
        #expect(graph.nodes.isEmpty && !graph.isShowingCache)
        #expect(GraphCache.load(scope: r.scope) == nil)
    }

    @Test func graphLoadWithoutCacheReportsTheErrorInsteadOfEmptyState() async throws {
        let r = try P7Rig()
        let graph = GraphStore(appState: r.state)
        GraphCache.clear(scope: r.scope)
        r.failTransport = true
        await graph.load()
        #expect(graph.nodes.isEmpty && graph.error != nil && !graph.isShowingCache)
    }
}
