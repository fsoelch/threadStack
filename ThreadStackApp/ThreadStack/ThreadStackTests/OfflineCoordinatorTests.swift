import Testing
import Foundation
@testable import ThreadStack

//  Paket P3, S-11: OfflineCoordinator (activate/enterOffline, refresh-Ablauf und -Serialisierung,
//  Reconcile, Probe-Ausloeser, Nutzerwechsel, Logout, Fassade fuer lokale Neuanlagen).

@MainActor
final class CoordRig {
    typealias T = OfflineTestSupport
    let user = AppUser(id: "u1", username: "anna", role: "user")
    let status = OfflineStatusStore()
    let path = FakePathSource()
    let store = T.makeStore()
    let http = FakeHTTP()
    let clock = ClockBox()
    /// > 0: jeder Aufruf von `now` schreitet fort (damit `fetchStartedAt` > Quittierzeit).
    var tick: TimeInterval = 0
    let coordinator: OfflineCoordinator
    let snapshots: OfflineSnapshotStore

    // Host-Fake
    var hostUser: AppUser?
    var probeQueue: [SessionProbeResult] = []
    var defaultProbe: SessionProbeResult
    var renewResult: AppUser?
    var fetchData = ServerDataSet(meetings: [OfflineTestSupport.meeting("m1", title: "Meeting")], todos: [], themes: [])
    var fetchError: Error?
    var fetchGate: CheckedContinuation<Void, Never>?
    var gateFetch = false
    var log: [String] = []
    var applied: [(data: ServerDataSet, changes: [PendingChange], fromCache: Bool)] = []
    var acknowledged: [PendingChange] = []
    var discarded: [[PendingChange]] = []
    var pendingChanged = 0
    var fetchCount = 0
    var probeCount = 0

    // Schlaf-Seam (Probe-Schleife / Backoff-Timer)
    var sleepDurations: [TimeInterval] = []
    private var sleepWaiters: [CheckedContinuation<Void, Never>] = []

    init(activate: Bool = true) throws {
        clock.now = Date(timeIntervalSince1970: 1_800_000_000)
        hostUser = user
        defaultProbe = .valid(user)
        renewResult = user
        snapshots = OfflineSnapshotStore(store: store)
        let connectivity = ConnectivityMonitor(pathSource: path.source)
        var rigRef: CoordRig!
        coordinator = OfflineCoordinator(
            status: status, connectivity: connectivity, files: store, snapshots: snapshots,
            now: { rigRef.advanceAndNow() },
            sleep: { d in await rigRef.sleepGate(d) })
        rigRef = self
        coordinator.host = makeHost()
        if activate { try coordinator.activate(user: user, serverURL: "https://example.test/", biometricProtected: true) }
    }

    func advanceAndNow() -> Date {
        clock.now.addTimeInterval(tick)
        return clock.now
    }

    func sleepGate(_ d: TimeInterval) async {
        sleepDurations.append(d)
        await withCheckedContinuation { sleepWaiters.append($0) }
    }

    func releaseSleepers() {
        let w = sleepWaiters; sleepWaiters = []
        w.forEach { $0.resume() }
    }

    func makeHost() -> OfflineHostOperations {
        http.handler = { req in
            if req.method == "GET", req.path == "/sync/capabilities" { return .json(200, ["idempotentCreate": ["version": 1]]) }
            if req.method == "POST", req.path == "/todos" { var j = FakeHTTP.todoJSON; j["id"] = "srv-t1"; return .json(201, j) }
            if req.method == "POST", req.path.hasSuffix("/entries") { return .json(201, FakeHTTP.entryJSON("srv-e1")) }
            return .json(200, ["ok": true])
        }
        return OfflineHostOperations(
            currentUser: { [unowned self] in hostUser },
            probeSession: { [unowned self] _ in
                probeCount += 1; log.append("probe")
                return probeQueue.isEmpty ? defaultProbe : probeQueue.removeFirst()
            },
            renewSession: { [unowned self] in renewResult },
            fetchServerData: { [unowned self] in
                fetchCount += 1; log.append("fetch")
                if gateFetch { await withCheckedContinuation { fetchGate = $0 } }
                await Task.yield()
                if let fetchError { throw fetchError }
                return fetchData
            },
            applyData: { [unowned self] d, c, fromCache in log.append("apply"); applied.append((d, c, fromCache)) },
            afterDataApplied: { [unowned self] in log.append("after") },
            http: http.ops,
            onAcknowledged: { [unowned self] c, _ in acknowledged.append(c) },
            onDiscarded: { [unowned self] in discarded.append($0) },
            onPendingChanged: { [unowned self] _ in pendingChanged += 1 })
    }

    var outboxFileExists: Bool { (try? store.read(scopeKey: T.scope.key, fileName: "outbox")) != nil }

    func settle(_ cond: () -> Bool) async {
        for _ in 0..<500 { if cond() { return }; await Task.yield() }
    }

    deinit { store.removeAll() }
}

@MainActor @Suite(.serialized)
struct OfflineCoordinatorTests {
    typealias T = OfflineTestSupport

    // MARK: activate / Marker / Outbox

    @Test func activateWritesMarkerAndInstallsIntents() throws {
        let r = try CoordRig()
        let marker = r.snapshots.loadMarker()
        #expect(marker?.user == r.user)
        #expect(marker?.scope == T.scope)                 // "https://example.test/" -> normalisiert
        #expect(marker?.biometricProtected == true)
        #expect(r.coordinator.activeScope == T.scope)
        // Intents sind nicht mehr die wirfenden Defaults
        #expect(throws: OfflineOutboxError.notFound) { try r.status.intents.retry(UUID()) }   // nicht der wirfende Default
    }

    @Test func activateTwiceForSameScopeKeepsOutboxAndResumesEngine() throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        try r.coordinator.activate(user: r.user, serverURL: "https://example.test", biometricProtected: false)
        #expect(r.status.items.count == 1)
        #expect(r.snapshots.loadMarker()?.biometricProtected == false)
    }

    @Test func corruptOutboxIsQuarantinedWithHintAndStartsEmpty() throws {
        let r = try CoordRig(activate: false)
        try r.store.write(Data("{kaputt".utf8), scopeKey: T.scope.key, fileName: "outbox")
        try r.coordinator.activate(user: r.user, serverURL: "https://example.test", biometricProtected: false)
        #expect(r.status.storageProblemMessage != nil)
        let dir = r.store.baseDirectory.appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: T.scope.key))
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(names.contains { $0.hasPrefix("outbox.corrupt-") })
        #expect(r.status.items.isEmpty)
        _ = try r.coordinator.enqueueTodo(T.todo("neu"), clientToken: nil, capturedAt: nil)   // arbeitsfaehig
    }

    @Test func futureSchemaOutboxThrowsAndLeavesFileUntouched() throws {
        let r = try CoordRig(activate: false)
        let future = Data(#"{"schemaVersion":99,"nextSeq":1,"changes":[],"aliases":[]}"#.utf8)
        try r.store.write(future, scopeKey: T.scope.key, fileName: "outbox")
        #expect(throws: OfflineStorageError.unsupportedFutureSchema) {
            try r.coordinator.activate(user: r.user, serverURL: "https://example.test", biometricProtected: false)
        }
        #expect(try r.store.read(scopeKey: T.scope.key, fileName: "outbox") == future)
        #expect(r.status.storageProblemMessage != nil)
        #expect(throws: OfflineError.localStorageFailed) { try r.coordinator.enqueueTodo(T.todo(), clientToken: nil, capturedAt: nil) }
    }

    // MARK: Fassade

    @Test func enqueueTodoReturnsLocalItemAndUpdatesStatusAndHost() throws {
        let r = try CoordRig()
        let d = Date(timeIntervalSince1970: 1_700_000_000)
        let token = UUID().uuidString
        let item = try r.coordinator.enqueueTodo(T.todo("Offline"), clientToken: token, capturedAt: d)
        #expect(OfflineIds.isLocal(item.id) && item.title == "Offline")
        #expect(r.status.items.count == 1 && r.status.items[0].entityId == item.id)
        #expect(r.pendingChanged >= 1)
        let reloaded = try OfflineOutbox(scope: T.scope, store: r.store)
        #expect(reloaded.changes.first?.clientToken == token)
        #expect(reloaded.changes.first?.capturedAt == d)
    }

    @Test func enqueueTopicAndProgressUseLocalIds() throws {
        let r = try CoordRig()
        let todo = try r.coordinator.enqueueTodo(T.todo("T"), clientToken: nil, capturedAt: nil)
        let topic = try r.coordinator.enqueueTopic(T.topic("Th", meeting: "m1"), clientToken: nil, capturedAt: nil)
        #expect(OfflineIds.isLocal(topic.id) && topic.meetingId == "m1")
        let ref = r.coordinator.resolveRef(refType: "todo", refId: todo.id)
        let entry = try r.coordinator.enqueueProgress(T.progress(ref: ref), clientToken: nil)
        #expect(OfflineIds.isLocal(entry.id) && entry.refType == "todo" && entry.refId == todo.id)
        #expect(r.status.pendingProgress(refType: "todo", refId: todo.id).count == 1)
    }

    @Test func enqueueProgressOnVanishedLocalParentIsRejected() throws {
        let r = try CoordRig()
        #expect(throws: OfflineError.self) {
            try r.coordinator.enqueueProgress(T.progress(ref: .local(changeId: UUID())), clientToken: nil)
        }
        #expect(r.status.items.isEmpty)
    }

    @Test func enqueueWithoutActiveScopeThrowsLocalStorageFailed() throws {
        let r = try CoordRig(activate: false)
        #expect(throws: OfflineError.localStorageFailed) { try r.coordinator.enqueueTodo(T.todo(), clientToken: nil, capturedAt: nil) }
        #expect(throws: OfflineError.localStorageFailed) { try r.coordinator.enqueueTopic(T.topic(), clientToken: nil, capturedAt: nil) }
    }

    @Test func writeFailureIsMappedToLocalStorageFailedAndNothingIsQueued() throws {
        let r = try CoordRig()
        let dir = r.store.baseDirectory.appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: T.scope.key))
        try? FileManager.default.removeItem(at: dir)
        try Data("x".utf8).write(to: dir)
        #expect(throws: OfflineError.localStorageFailed) { try r.coordinator.enqueueTodo(T.todo(), clientToken: nil, capturedAt: nil) }
        #expect(r.status.items.isEmpty)
        #expect(r.status.storageProblemMessage != nil)
    }

    @Test func updateAndDiscardLocal() throws {
        let r = try CoordRig()
        let item = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        try r.coordinator.updateLocal(entityId: item.id, payload: .todo(T.todo("B")))
        #expect(r.status.items.first?.title == "B")
        let removed = try r.coordinator.discardLocal(entityId: item.id)
        #expect(removed.count == 1)
        #expect(r.discarded.count == 1 && r.discarded[0].count == 1)
        #expect(r.status.items.isEmpty)
        #expect(throws: OfflineOutboxError.notFound) { try r.coordinator.discardLocal(entityId: item.id) }
        #expect(throws: OfflineOutboxError.notFound) { try r.coordinator.updateLocal(entityId: "local-nope", payload: .todo(T.todo())) }
    }

    @Test func discardLocalTakesDependentsAndReportsThemToHost() throws {
        let r = try CoordRig()
        let todo = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        _ = try r.coordinator.enqueueProgress(T.progress(ref: r.coordinator.resolveRef(refType: "todo", refId: todo.id)), clientToken: nil)
        let removed = try r.coordinator.discardLocal(entityId: todo.id)
        #expect(removed.count == 2)
        #expect(r.discarded.first?.count == 2)
        #expect(r.status.items.isEmpty)
    }

    @Test func resolveRefLocalAliasAndServer() async throws {
        let r = try CoordRig()
        #expect(r.coordinator.resolveRef(refType: "todo", refId: "t-1") == .server(refType: "todo", refId: "t-1"))
        let item = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        let local = r.coordinator.resolveRef(refType: "todo", refId: item.id)
        if case .local = local {} else { Issue.record("local erwartet") }
        r.tick = 1
        r.fetchData.todos = [T.serverTodo("srv-t1")]
        await r.coordinator.refresh(.manual)    // quittiert als srv-t1, Reconcile entfernt den Eintrag, Alias bleibt
        #expect(r.coordinator.resolveRef(refType: "todo", refId: item.id) == .server(refType: "todo", refId: "srv-t1"))
        #expect(r.coordinator.resolveRef(refType: "todo", refId: "local-not-a-uuid") == .server(refType: "todo", refId: "local-not-a-uuid"))
        let ghost = UUID()
        #expect(r.coordinator.resolveRef(refType: "todo", refId: "local-" + ghost.uuidString.lowercased()) == .local(changeId: ghost))
    }

    // MARK: refresh

    @Test func onlineRefreshRunsEngineThenFetchReconcileApplySnapshotAfter() async throws {
        let r = try CoordRig()
        r.tick = 1
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        r.fetchData.todos = [T.serverTodo("srv-t1", title: "A")]
        await r.coordinator.refresh(.manual)
        #expect(r.http.requests.contains { $0.method == "POST" && $0.path == "/todos" })   // Sync VOR dem Abruf
        #expect(r.log == ["fetch", "apply", "after"])
        // Reconcile: quittierter Eintrag (at < fetchStartedAt) ist entfernt, nichts fehlt kurzzeitig
        #expect(r.applied.count == 1 && r.applied[0].fromCache == false)
        #expect(r.applied[0].changes.isEmpty)
        #expect(r.applied[0].data.todos.map(\.id) == ["srv-t1"])
        #expect(r.status.items.isEmpty)
        #expect(r.status.isShowingCachedData == false && r.status.dataAsOf != nil)
        let snap = r.snapshots.loadSnapshot(scope: T.scope)
        #expect(snap?.data.todos.map(\.id) == ["srv-t1"])
    }

    @Test func acknowledgedEntryNotYetInFetchStaysInOverlayChanges() async throws {
        let r = try CoordRig()   // feste Uhr: Quittierung == fetchStartedAt -> noch nicht reconciled
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        r.fetchData.todos = []   // Abruf kennt das neue Todo noch nicht (Replikationsverzug)
        await r.coordinator.refresh(.manual)
        #expect(r.applied.last?.changes.count == 1)
        if case .acknowledged? = r.applied.last?.changes.first?.state {} else { Issue.record("acknowledged erwartet") }
        #expect(r.acknowledged.count == 1)
    }

    @Test func transportFailureOnFetchGoesOfflineAndOverwritesNothing() async throws {
        let r = try CoordRig()
        let old = OfflineSnapshot(savedAt: Date(timeIntervalSince1970: 5), data: ServerDataSet(meetings: [], todos: [T.serverTodo("old")], themes: []))
        try await r.snapshots.saveSnapshot(old, scope: T.scope)
        r.fetchError = URLError(.notConnectedToInternet)
        await r.coordinator.refresh(.manual)
        #expect(r.status.connection == .offline(.serverUnreachable))
        #expect(r.applied.isEmpty)
        #expect(r.snapshots.loadSnapshot(scope: T.scope)?.data.todos.map(\.id) == ["old"])
        #expect(r.status.dataAsOf == nil)
        #expect(!r.log.contains("after"))
    }

    @Test func nonTransportFetchErrorKeepsStateAndDoesNotGoOffline() async throws {
        let r = try CoordRig()
        r.fetchError = APIError.server("kaputt")
        await r.coordinator.refresh(.manual)
        #expect(r.status.connection == .online)
        #expect(r.applied.isEmpty)
    }

    @Test func fetchUnauthorizedRenewsOnceAndRetries() async throws {
        let r = try CoordRig()
        r.fetchError = APIError.unauthorized
        r.renewResult = r.user
        // erster Abruf 401, danach Erfolg
        var calls = 0
        var host = r.makeHost()
        host.fetchServerData = { calls += 1; if calls == 1 { throw APIError.unauthorized }; return r.fetchData }
        r.coordinator.host = host
        await r.coordinator.refresh(.manual)
        #expect(calls == 2)
        #expect(r.applied.count == 1)
    }

    @Test func fetchUnauthorizedWithoutRenewalPausesNeedsReauthAndKeepsData() async throws {
        let r = try CoordRig()
        r.fetchError = APIError.unauthorized
        r.renewResult = nil
        await r.coordinator.refresh(.manual)
        #expect(r.status.activity == .paused(.needsReauth))
        #expect(r.applied.isEmpty)
    }

    @Test func fetchUnauthorizedWithForeignUserPausesUserMismatch() async throws {
        let r = try CoordRig()
        r.fetchError = APIError.unauthorized
        r.renewResult = AppUser(id: "other", username: "b", role: "user")
        await r.coordinator.refresh(.manual)
        #expect(r.status.activity == .paused(.userMismatch))
        #expect(r.applied.isEmpty)
    }

    @Test func concurrentRefreshesShareOneTask() async throws {
        let r = try CoordRig()
        async let a: Void = r.coordinator.refresh(.manual)
        async let b: Void = r.coordinator.refresh(.auto)
        _ = await (a, b)
        #expect(r.fetchCount == 1)
        #expect(r.applied.count == 1)
        await r.coordinator.refresh(.manual)    // danach wieder ein eigener Lauf
        #expect(r.fetchCount == 2)
    }

    @Test func syncErrorStillFetchesAndApplies() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        r.http.handler = { _ in .json(503, ["error": "x"]) }
        await r.coordinator.refresh(.manual)
        #expect(r.applied.count == 1)
        #expect(r.applied[0].changes.count == 1)    // lokaler Eintrag bleibt im Overlay
        #expect(r.status.items.count == 1)
    }

    @Test func mismatchedSessionUserNeverFetchesOrSavesOtherAccountsData() async throws {
        let r = try CoordRig()
        r.hostUser = AppUser(id: "other", username: "b", role: "user")
        await r.coordinator.refresh(.manual)
        #expect(r.fetchCount == 0 && r.applied.isEmpty)
        #expect(r.snapshots.loadSnapshot(scope: T.scope) == nil)
        #expect(r.status.activity == .paused(.userMismatch))
    }

    // MARK: Offline / Probe

    @Test func offlineRefreshOnlyProbesAndStaysOfflineWhenUnreachable() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.serverUnreachable)
        r.defaultProbe = .unreachable
        await r.coordinator.refresh(.manual)
        #expect(r.probeCount == 1 && r.fetchCount == 0)
        #expect(r.http.requests.isEmpty)
        #expect(r.status.connection == .offline(.serverUnreachable))
    }

    @Test func captivePortalProbeResultKeepsOffline() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.noNetwork)
        r.defaultProbe = .unreachable    // Host klassifiziert Nicht-JSON als unreachable
        await r.coordinator.refresh(.reconnect)
        #expect(r.status.isOffline && r.fetchCount == 0)
    }

    @Test func successfulProbeGoesOnlineAndContinuesWithFullRefresh() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.serverUnreachable)
        r.status.isShowingCachedData = true
        await r.coordinator.refresh(.reconnect)
        #expect(r.status.connection == .online)
        #expect(r.log == ["probe", "fetch", "apply", "after"])
        #expect(r.status.isShowingCachedData == false)
    }

    @Test func probeWithNoSessionCountsAsReachable() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.serverUnreachable)
        r.defaultProbe = .noSession
        await r.coordinator.refresh(.reconnect)
        #expect(r.status.connection == .online)
    }

    @Test func probeShowingForeignUserPausesWithoutFetching() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.serverUnreachable)
        r.defaultProbe = .valid(AppUser(id: "other", username: "b", role: "user"))
        await r.coordinator.refresh(.reconnect)
        #expect(r.status.activity == .paused(.userMismatch))
        #expect(r.fetchCount == 0)
    }

    @Test func autoRefreshIsSkippedWhileOffline() async throws {
        let r = try CoordRig()
        r.status.connection = .offline(.serverUnreachable)
        await r.coordinator.refresh(.auto)
        #expect(r.probeCount == 0 && r.fetchCount == 0)
    }

    @Test func pathUnsatisfiedGoesOfflineWithoutProbeAndSatisfiedProbesImmediately() async throws {
        let r = try CoordRig()
        r.coordinator.startMonitoring()
        r.path.onUpdate?(false)
        await r.settle { r.status.isOffline }
        #expect(r.status.connection == .offline(.noNetwork))
        #expect(r.probeCount == 0)
        r.path.onUpdate?(true)
        await r.settle { r.status.connection == .online && r.log.contains("after") }
        #expect(r.probeCount >= 1)
        #expect(r.status.connection == .online)
        #expect(r.log.contains("fetch"))
    }

    @Test func unsatisfiedPathExcludesProbeEvenWhenRefreshIsRequested() async throws {
        let r = try CoordRig()
        r.coordinator.startMonitoring()
        r.path.onUpdate?(false)
        await r.settle { r.status.isOffline }
        await r.coordinator.refresh(.manual)
        #expect(r.probeCount == 0 && r.fetchCount == 0)
    }

    @Test func probeLoopRunsEveryEightSecondsWhileOfflineAndActive() async throws {
        let r = try CoordRig()
        r.defaultProbe = .unreachable
        r.coordinator.reportTransport(success: false)
        #expect(r.status.connection == .offline(.serverUnreachable))
        await r.settle { r.sleepDurations.count == 1 }
        #expect(r.sleepDurations == [8])
        r.releaseSleepers()
        await r.settle { r.probeCount == 1 }
        #expect(r.probeCount == 1)
        await r.settle { r.sleepDurations.count == 2 }
        #expect(r.sleepDurations == [8, 8])
        // Verbindung kommt zurueck: naechster Tick stellt online her, Schleife endet
        r.defaultProbe = .valid(r.user)
        r.releaseSleepers()
        await r.settle { r.status.connection == .online && r.log.contains("after") }
        #expect(r.status.connection == .online)
        let sleepsAfterOnline = r.sleepDurations.count
        r.releaseSleepers()
        for _ in 0..<20 { await Task.yield() }
        #expect(r.sleepDurations.count == sleepsAfterOnline)
    }

    @Test func inactiveAppStopsProbeLoopAndForegroundRefreshes() async throws {
        let r = try CoordRig()
        r.defaultProbe = .unreachable
        r.coordinator.reportTransport(success: false)
        await r.settle { r.sleepDurations.count == 1 }
        r.coordinator.scenePhaseChanged(isActive: false)
        r.releaseSleepers()
        for _ in 0..<20 { await Task.yield() }
        #expect(r.probeCount == 0)           // inaktiv: keine Probe
        // inaktiv: weder Pfad noch Transportmeldung loesen etwas aus
        r.coordinator.reportTransport(success: true)
        for _ in 0..<20 { await Task.yield() }
        #expect(r.probeCount == 0)
        // Vordergrund: .foreground -> Probe (offline) und Refresh
        r.defaultProbe = .valid(r.user)
        r.coordinator.scenePhaseChanged(isActive: true)
        await r.settle { r.log.contains("after") }
        #expect(r.status.connection == .online)
        #expect(r.probeCount == 1)
    }

    @Test func reportTransportFailureGoesOfflineAndSuccessWhileOfflineReconnects() async throws {
        let r = try CoordRig()
        r.coordinator.reportTransport(success: true)         // online: kein Effekt
        #expect(r.status.connection == .online && r.probeCount == 0)
        r.coordinator.reportTransport(success: false)
        #expect(r.status.connection == .offline(.serverUnreachable))
        r.coordinator.reportTransport(success: true)         // Server antwortet wieder
        await r.settle { r.log.contains("after") }
        #expect(r.status.connection == .online)
    }

    @Test func transientSyncSchedulesBackoffTimerThatRetriesWithAuto() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        var attempts = 0
        r.http.handler = { req in
            if req.path == "/sync/capabilities" { return .json(200, ["idempotentCreate": ["version": 1]]) }
            attempts += 1
            if attempts == 1 { return .json(503, ["error": "x"]) }
            var j = FakeHTTP.todoJSON; j["id"] = "srv-t1"; return .json(201, j)
        }
        await r.coordinator.refresh(.manual)
        await r.settle { !r.sleepDurations.isEmpty }
        let d = try #require(r.sleepDurations.first)
        #expect(d >= 4 && d <= 6)             // 5 s +-20 %
        r.clock.now.addTimeInterval(10)
        r.releaseSleepers()
        await r.settle { attempts == 2 }
        #expect(attempts == 2)
    }

    // MARK: enterOffline

    @Test func enterOfflineAppliesSnapshotWithOverlayAndMarksCached() async throws {
        let r = try CoordRig()
        let saved = Date(timeIntervalSince1970: 1_799_000_000)
        let data = ServerDataSet(meetings: [T.meeting("m1")], todos: [T.serverTodo("s1")], themes: [])
        try await r.snapshots.saveSnapshot(OfflineSnapshot(savedAt: saved, data: data), scope: T.scope)
        _ = try r.coordinator.enqueueTodo(T.todo("lokal"), clientToken: nil, capturedAt: nil)
        let marker = try #require(r.snapshots.loadMarker())
        let had = try r.coordinator.enterOffline(marker: marker)
        #expect(had)
        #expect(r.status.isOffline && r.status.isShowingCachedData)
        #expect(r.status.dataAsOf == saved)
        #expect(r.applied.last?.fromCache == true)
        #expect(r.applied.last?.data.todos.map(\.id) == ["s1"])
        #expect(r.applied.last?.changes.count == 1)       // ausstehende Eintraege fuer das Overlay
        #expect(r.status.items.first?.title == "lokal")
    }

    @Test func enterOfflineWithoutSnapshotReturnsFalse() throws {
        let r = try CoordRig(activate: false)
        let marker = OfflineSessionMarker(user: r.user, serverURL: "https://example.test", biometricProtected: false, savedAt: Date())
        #expect(try r.coordinator.enterOffline(marker: marker) == false)
        #expect(r.status.isOffline)
        #expect(r.applied.isEmpty)
    }

    @Test func enterOfflineLoadsOutboxOfMarkerScope() throws {
        let r = try CoordRig(activate: false)
        let ob = try OfflineOutbox(scope: T.scope, store: r.store)
        _ = try ob.enqueueTodo(T.todo("vorhanden"))
        let marker = OfflineSessionMarker(user: r.user, serverURL: "https://example.test", biometricProtected: false, savedAt: Date())
        _ = try r.coordinator.enterOffline(marker: marker)
        #expect(r.status.items.first?.title == "vorhanden")
        #expect(r.coordinator.activeScope == T.scope)
    }

    // MARK: Nutzerwechsel / Logout

    @Test func otherAccountWithPendingChangesIsRefusedWithoutConfirmation() throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("wichtig"), clientToken: nil, capturedAt: nil)
        let other = AppUser(id: "u2", username: "b", role: "user")
        #expect(throws: OfflineError.scopeMismatch) { try r.coordinator.userDidAuthenticate(other, discardPreviousScopeConfirmed: false) }
        #expect(r.outboxFileExists)                           // nichts geloescht
        #expect(r.snapshots.loadMarker()?.user == r.user)
        #expect(r.coordinator.activeScope == T.scope)
    }

    @Test func otherAccountConfirmedDiscardsPreviousScopeCompletely() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("weg"), clientToken: nil, capturedAt: nil)
        try await r.snapshots.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: ServerDataSet(meetings: [], todos: [], themes: [])), scope: T.scope)
        let other = AppUser(id: "u2", username: "b", role: "user")
        try r.coordinator.userDidAuthenticate(other, discardPreviousScopeConfirmed: true)
        #expect(!r.outboxFileExists)
        #expect(r.snapshots.loadSnapshot(scope: T.scope) == nil)
        #expect(r.snapshots.loadMarker() == nil)
        #expect(r.status.items.isEmpty)
        #expect(r.coordinator.activeScope == nil)
        // Neues Konto kann danach normal aktiviert werden
        try r.coordinator.activate(user: other, serverURL: "https://example.test", biometricProtected: false)
        #expect(r.coordinator.activeScope == OfflineScope(serverURL: "https://example.test", userId: "u2"))
        #expect(r.status.items.isEmpty)
    }

    @Test func otherAccountWithoutPendingChangesSwitchesSilently() throws {
        let r = try CoordRig()
        let other = AppUser(id: "u2", username: "b", role: "user")
        try r.coordinator.userDidAuthenticate(other, discardPreviousScopeConfirmed: false)
        #expect(r.snapshots.loadMarker() == nil)
    }

    @Test func sameAccountReauthKeepsEverythingAndResumesSync() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("bleibt"), clientToken: nil, capturedAt: nil)
        r.renewResult = nil
        r.http.handler = { req in req.path == "/sync/capabilities" ? .json(200, ["idempotentCreate": ["version": 1]]) : .json(401, ["error": "x"]) }
        await r.coordinator.refresh(.manual)
        #expect(r.status.activity == .paused(.needsReauth))
        r.http.handler = { req in
            if req.path == "/sync/capabilities" { return .json(200, ["idempotentCreate": ["version": 1]]) }
            var j = FakeHTTP.todoJSON; j["id"] = "srv-t1"; return .json(201, j)
        }
        try r.coordinator.userDidAuthenticate(r.user, discardPreviousScopeConfirmed: false)
        await r.coordinator.refresh(.afterLogin)
        #expect(r.acknowledged.count == 1)
        #expect(r.status.activity == .idle)
    }

    @Test func logoutPurgesEverythingAndResetsStatus() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("x"), clientToken: nil, capturedAt: nil)
        try await r.snapshots.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: ServerDataSet(meetings: [], todos: [], themes: [])), scope: T.scope)
        r.coordinator.deactivateAndPurgeAll()
        #expect(!FileManager.default.fileExists(atPath: r.store.baseDirectory.path))
        #expect(r.snapshots.loadMarker() == nil)
        #expect(r.status.items.isEmpty && r.status.dataAsOf == nil && r.status.connection == .online)
        #expect(r.status.activity == .idle && !r.status.isShowingCachedData)
        #expect(r.coordinator.activeScope == nil)
        #expect(throws: OfflineError.localStorageFailed) { try r.coordinator.enqueueTodo(T.todo(), clientToken: nil, capturedAt: nil) }
        // Intents sind wieder die sicheren Defaults
        #expect(throws: OfflineError.notAvailableOffline) { try r.status.intents.discard(UUID()) }
    }

    @Test func logoutDuringRunningRefreshDiscardsItsResult() async throws {
        let r = try CoordRig()
        r.gateFetch = true
        let task = Task { await r.coordinator.refresh(.manual) }
        await r.settle { r.fetchGate != nil }
        r.coordinator.deactivateAndPurgeAll()
        r.gateFetch = false
        r.fetchGate?.resume()
        await task.value
        #expect(r.applied.isEmpty)                            // Daten des alten Kontos werden nie angewendet
        #expect(!r.log.contains("after"))
        #expect(!FileManager.default.fileExists(atPath: r.store.baseDirectory.path))   // und nichts neu geschrieben
    }

    // MARK: Intents

    @Test func intentsDiscardRetryDependentsAndPayload() throws {
        let r = try CoordRig()
        let todo = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        _ = try r.coordinator.enqueueProgress(T.progress(ref: r.coordinator.resolveRef(refType: "todo", refId: todo.id)), clientToken: nil)
        let id = try #require(r.status.items.first?.id)
        #expect(r.status.intents.dependentsCount(id) == 1)
        #expect(r.status.intents.payload(id) == .todo(T.todo("A")))
        try r.status.intents.discard(id)
        #expect(r.status.items.isEmpty)
        #expect(r.discarded.last?.count == 2)
    }

    @Test func intentsSyncNowTriggersManualRefresh() async throws {
        let r = try CoordRig()
        await r.status.intents.syncNow()
        #expect(r.fetchCount == 1)
    }

    @Test func intentsReassignAndConvertOperateOnOutbox() async throws {
        let r = try CoordRig()
        let topic = try r.coordinator.enqueueTopic(T.topic("T", meeting: "m1"), clientToken: nil, capturedAt: nil)
        let id = try #require(r.status.items.first?.id)
        try r.status.intents.reassignTopic(id, "m2")
        #expect(r.status.intents.payload(id) == .topic(PendingTopicPayload(meetingId: "m2", title: "T", descriptionHTML: "", isTodo: false, snoozedUntil: nil)))
        try r.status.intents.convertTopicToTodo(id)
        if case .todo? = r.status.intents.payload(id) {} else { Issue.record("todo erwartet") }
        _ = topic
        await r.settle { r.log.contains("after") }   // die Intents stossen einen Sync an
    }

    @Test func requestReauthIntentCallsHostCallback() throws {
        let r = try CoordRig()
        var called = 0
        r.coordinator.onRequestReauth = { called += 1 }
        r.status.intents.requestReauth()
        #expect(called == 1)
    }

    @Test func pausedSyncStatusIsExposedToViews() async throws {
        let r = try CoordRig()
        _ = try r.coordinator.enqueueTodo(T.todo("A"), clientToken: nil, capturedAt: nil)
        r.http.handler = { _ in .json(404, ["error": "x"]) }    // Server ohne Sync-Unterstuetzung
        await r.coordinator.refresh(.manual)
        #expect(r.status.activity == .paused(.serverUnsupported))
        #expect(r.status.items.count == 1)                      // Aenderung bleibt gespeichert
    }
}
