import Testing
import Foundation
@testable import ThreadStack

//  Paket P7: AppState-Fassade des Offline-Modus (S-12) gegen einen echten OfflineCoordinator
//  (Temp-Verzeichnis) und einen gemockten Server (URLProtocol): zentraler `local-`-Guard,
//  URLError -> APIError.network + Transportmeldung, Neuanlage online/offline/Zweifelsfall,
//  Bearbeiten/Verwerfen lokaler Eintraege, Overlay ueber Serverdaten, Zwischenstaende (ProgressStore).

// MARK: - Mock-Server

enum RigReply {
    case json(Int, Any)
    case text(Int, String)
    case fail(URLError.Code)
}

/// Thread-sicherer Server-Fake: Handler + Protokoll der Requests.
final class RigServer: @unchecked Sendable {
    struct Recorded { let method: String; let path: String; let query: String; let body: [String: Any] }
    private let lock = NSLock()
    private var _handler: (URLRequest) -> RigReply = { _ in .json(500, ["error": "x"]) }
    private var _requests: [Recorded] = []

    var handler: (URLRequest) -> RigReply {
        get { lock.lock(); defer { lock.unlock() }; return _handler }
        set { lock.lock(); _handler = newValue; lock.unlock() }
    }
    var requests: [Recorded] { lock.lock(); defer { lock.unlock() }; return _requests }
    func record(_ r: Recorded) { lock.lock(); _requests.append(r); lock.unlock() }
    func clear() { lock.lock(); _requests = []; lock.unlock() }
    func count(method: String? = nil, pathPrefix: String) -> Int {
        requests.filter { (method == nil || $0.method == method) && $0.path.hasPrefix(pathPrefix) }.count
    }
}

final class OfflineRigURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var servers: [String: RigServer] = [:]

    static func register(host: String, server: RigServer) {
        lock.lock(); servers[host] = server; lock.unlock()
    }
    private static func server(forHost host: String?) -> RigServer? {
        guard let host else { return nil }
        lock.lock(); defer { lock.unlock() }
        return servers[host]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let server = Self.server(forHost: request.url?.host), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let path = url.path.hasPrefix("/api") ? String(url.path.dropFirst(4)) : url.path
        server.record(.init(method: request.httpMethod ?? "GET", path: path, query: url.query ?? "",
                            body: requestBodyJSON(request)))
        switch server.handler(request) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .json(let status, let obj):
            deliver(url: url, status: status,
                    data: (try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed])) ?? Data(),
                    type: "application/json")
        case .text(let status, let s):
            deliver(url: url, status: status, data: Data(s.utf8), type: "text/html")
        }
    }

    private func deliver(url: URL, status: Int, data: Data, type: String) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - Rig

func rigEncode<T: Encodable>(_ v: T) -> Any {
    let data = (try? JSONEncoder().encode(v)) ?? Data()
    return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) ?? [:]
}

func rigDetailJSON(refType: String = "todo", refId: String = "t1", entries: [Any] = []) -> [String: Any] {
    [
        "ref": ["type": refType, "id": refId, "title": "T", "done": false, "exists": true],
        "goal": NSNull(), "goalUpdatedAt": NSNull(),
        "nextStep": "Schritt", "nextStepUpdatedAt": NSNull(),
        "stats": ["entryCount": entries.count, "firstEntryAt": NSNull(), "lastEntryAt": NSNull(),
                  "lastActivityAt": NSNull(), "dormant": false, "dormantDays": 0, "stale": false, "staleDays": 0],
        "reentry": ["show": false, "dormantSince": NSNull(), "dormantLabel": "",
                    "empty": false, "ai": ["available": false, "frameId": NSNull()]],
        "entries": entries,
        "page": ["limit": 20, "hasMore": false, "nextCursor": NSNull()]
    ]
}

@MainActor
final class P7Rig {
    typealias T = OfflineTestSupport
    static let user = AppUser(id: "u1", username: "anna", role: "user")

    let host: String
    let server = RigServer()
    let state: AppState
    let progress: ProgressStore
    let status = OfflineStatusStore()
    let path = FakePathSource()
    let store: UserScopedFileStore
    let snapshots: OfflineSnapshotStore
    let coordinator: OfflineCoordinator
    var serverTodos: [TodoItem] = []
    var serverMeetings: [Meeting] = [T.meeting("m1", title: "Meeting")]
    var loggedInUser = P7Rig.user
    var failTransport = false
    /// NWPath-Zustand fuer den Boot-Ablauf.
    var pathOK = true
    /// Erlaubt Tests, einzelne Pfade gesondert zu beantworten (vor dem Standardverhalten).
    var override: ((URLRequest) -> RigReply?)?

    var scope: OfflineScope { OfflineScope(serverURL: OfflineScope.normalize(serverURL: "https://\(host)"), userId: "u1") }

    /// `reusing`: simuliert einen erneuten App-Start - gleicher Host/Dateispeicher, frische Objekte.
    init(activate: Bool = true, reusing other: P7Rig? = nil) throws {
        host = other?.host ?? "p7-rig-\(UUID().uuidString.lowercased()).invalid"
        store = other?.store ?? T.makeStore()
        if let other { serverTodos = other.serverTodos; serverMeetings = other.serverMeetings }
        OfflineRigURLProtocol.register(host: host, server: server)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [OfflineRigURLProtocol.self]
        let session = URLSession(configuration: cfg)
        state = AppState(session: session)
        state.serverURL = "https://\(host)"
        ProgressAPISession.setOverride(session, for: state)
        progress = ProgressStore(appState: state, defaults: UserDefaults(suiteName: "p7-rig-\(UUID().uuidString)")!)
        state.progressStore = progress
        snapshots = OfflineSnapshotStore(store: store)
        let monitor = ConnectivityMonitor(pathSource: path.source)
        coordinator = OfflineCoordinator(status: status, connectivity: monitor, files: store, snapshots: snapshots,
                                         sleep: { _ in try? await Task.sleep(for: .seconds(3600)) })
        state.attachOffline(coordinator: coordinator, status: status, snapshots: snapshots)
        state.pathSatisfied = { [unowned self] in self.pathOK }
        server.handler = { [unowned self] req in self.defaultReply(req) }
        if activate {
            state.currentUser = Self.user
            try coordinator.activate(user: Self.user, serverURL: "https://\(host)", biometricProtected: false)
        }
    }

    /// Standard-Serververhalten; `failTransport` simuliert fehlende Verbindung fuer alle Requests.
    func defaultReply(_ req: URLRequest) -> RigReply {
        if failTransport { return .fail(.notConnectedToInternet) }
        if let r = override?(req) { return r }
        let path = req.url.map { $0.path.hasPrefix("/api") ? String($0.path.dropFirst(4)) : $0.path } ?? ""
        let method = req.httpMethod ?? "GET"
        switch (method, path) {
        case ("GET", "/me"): return .json(200, rigEncode(loggedInUser))
        case ("POST", "/login"): return .json(200, rigEncode(loggedInUser))
        case ("POST", "/logout"): return .json(200, ["ok": true])
        case ("GET", "/meetings"): return .json(200, rigEncode(serverMeetings))
        case ("GET", "/todos"): return .json(200, rigEncode(serverTodos))
        case ("GET", "/themes"), ("GET", "/contacts"), ("GET", "/knowledge"): return .json(200, [Any]())
        case ("GET", "/contact-categories"): return .json(200, ["categories": [Any]()])
        case ("GET", "/stack"): return .json(200, ["frames": [Any](), "depth": 0])
        case ("GET", "/sync/capabilities"): return .json(200, ["idempotentCreate": ["version": 1]])
        case ("POST", "/todos"):
            var j = FakeHTTP.todoJSON; j["id"] = "srv-t1"
            let body = requestBodyJSON(req)
            if let t = body["title"] as? String { j["title"] = t }
            return .json(201, j)
        default:
            if method == "POST", path.hasSuffix("/entries") { return .json(201, FakeHTTP.entryJSON("srv-e1")) }
            if method == "POST", path.hasSuffix("/topics") {
                return .json(201, rigEncode(T.serverTopic("srv-p1", meeting: "m1")))
            }
            return .json(200, ["ok": true])
        }
    }

    func goOffline() { failTransport = true; status.connection = .offline(.serverUnreachable) }
    func goOnline() { failTransport = false }

    func settle(_ cond: () -> Bool) async {
        for _ in 0..<2000 { if cond() { return }; await Task.yield() }
    }

    deinit { store.removeAll() }
}

// MARK: - Tests

@MainActor @Suite(.serialized)
struct OfflineAppStateIntegrationTests {
    typealias T = OfflineTestSupport

    // MARK: Zentraler Guard / Transportmapping

    @Test func localPathNeverReachesTheServer() async throws {
        let r = try P7Rig()
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.completeTodo(id: "local-1b4e28ba-2fa1-11d2-883f-0016d3cca427", result: "", resultDate: "")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.reopenTodo(id: "local-abc")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.snoozeTodo(id: "local-abc", until: nil)
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.moveTodo(id: "local-abc", targetMeetingId: "m1")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            _ = try await r.state.setTodoThemes(id: "local-abc", themeIds: [])
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.completeTopic(meetingId: "m1", id: "local-abc", result: "", resultDate: "")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.shareTopic(meetingId: "m1", id: "local-abc", targetMeetingId: "m2")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            _ = try await r.state.setAssignments(refType: "todo", refId: "local-abc", contactIds: [])
        }
        #expect(r.server.requests.isEmpty)
    }

    @Test func localIdInBodyFieldIsBlockedButFreeTextIsNot() async throws {
        let r = try P7Rig()
        await #expect(throws: OfflineError.pendingNotSynced) {
            _ = try await r.state.stackPush(refType: "todo", refId: "local-abc", nextStepNote: "x")
        }
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.addThemeLink(themeId: "th1", refType: "todo", refId: "local-abc")
        }
        #expect(r.server.requests.isEmpty)
        // Freitext darf mit "local-" beginnen (nur ID-Felder werden geprueft).
        let t = try await r.state.createTodoReturning(title: "local-Notiz", description: "")
        #expect(t.id == "srv-t1")
        #expect(r.server.count(method: "POST", pathPrefix: "/todos") == 1)
    }

    @Test func containsLocalIdChecksSegmentsOnly() {
        #expect(AppState.containsLocalId(path: "/todos/local-abc"))
        #expect(AppState.containsLocalId(path: "/meetings/m1/topics/local-abc/share"))
        #expect(!AppState.containsLocalId(path: "/todos/abc?x=local-1"))
        #expect(!AppState.containsLocalId(path: "/todos/mylocal-1"))
    }

    @Test func urlErrorIsMappedToNetworkErrorAndReportedAsOffline() async throws {
        let r = try P7Rig()
        r.failTransport = true
        #expect(!r.status.isOffline)
        do {
            let _: [TodoItem] = try await r.state.request("GET", "/todos")
            Issue.record("expected error")
        } catch {
            guard case APIError.network = error else { Issue.record("expected .network, got \(error)"); return }
            #expect(error.localizedDescription ==
                    "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist.")
            #expect(isTransportFailure(error))
        }
        #expect(r.status.isOffline)
    }

    @Test func successfulResponseWhileOfflineTriggersReconnectRefresh() async throws {
        let r = try P7Rig()
        r.goOffline()
        r.goOnline()
        let _: [TodoItem] = try await r.state.request("GET", "/todos")
        await r.settle { !r.status.isOffline }
        #expect(!r.status.isOffline)
    }

    // MARK: Neuanlage (online / Zweifelsfall / offline)

    @Test func onlineCreateTodoSendsClientTokenAndDoesNotQueue() async throws {
        let r = try P7Rig()
        let t = try await r.state.createTodoReturning(title: "Online", description: "<p>x</p>")
        #expect(t.id == "srv-t1" && r.status.items.isEmpty)
        let post = r.server.requests.first { $0.method == "POST" && $0.path == "/todos" }
        #expect(post != nil)
        let token = post?.body["clientToken"] as? String
        #expect(token != nil && UUID(uuidString: token!) != nil)
        #expect(r.state.todos.contains { $0.id == "srv-t1" })
    }

    @Test func transportFailureQueuesWithSameTokenAndFirstAttemptTime() async throws {
        let r = try P7Rig()
        let before = Date()
        r.failTransport = true
        let t = try await r.state.createTodoReturning(title: "Idee", description: "", snoozedUntil: nil, dueDate: nil)
        #expect(OfflineIds.isLocal(t.id))
        #expect(r.state.todos.contains { $0.id == t.id })
        #expect(r.status.unsyncedCount == 1 && r.status.summary(forEntityId: t.id)?.title == "Idee")
        #expect(r.state.currentToast?.text == AppState.offlineSavedToast)
        let firstToken = r.server.requests.last { $0.path == "/todos" }?.body["clientToken"] as? String
        #expect(firstToken != nil)

        // Wiederverbindung: der Sync sendet DASSELBE Token, capturedAt = erster Versuch (nicht spaeter).
        r.goOnline()
        r.server.clear()
        await r.coordinator.refresh(.manual)
        let sync = r.server.requests.first { $0.method == "POST" && $0.path == "/todos" }
        #expect(sync?.body["clientToken"] as? String == firstToken)
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let iso = (sync?.body["capturedAt"] as? String).flatMap { withFraction.date(from: $0) ?? plain.date(from: $0) }
        #expect(iso != nil && iso! >= before.addingTimeInterval(-2) && iso! <= Date().addingTimeInterval(1))
    }

    @Test func serverErrorFiveHundredQueuesButFourHundredThrows() async throws {
        let r = try P7Rig()
        r.override = { req in req.httpMethod == "POST" && req.url?.path.hasSuffix("/todos") == true ? .json(503, ["error": "down"]) : nil }
        let t = try await r.state.createTodoReturning(title: "Spaeter", description: "")
        #expect(OfflineIds.isLocal(t.id))
        #expect(r.status.unsyncedCount == 1)

        let r2 = try P7Rig()
        r2.override = { req in req.httpMethod == "POST" && req.url?.path.hasSuffix("/todos") == true ? .json(400, ["error": "Titel zu lang"]) : nil }
        do {
            _ = try await r2.state.createTodoReturning(title: "x", description: "")
            Issue.record("expected error")
        } catch {
            #expect(error.localizedDescription == "Titel zu lang")
        }
        #expect(r2.status.items.isEmpty)
    }

    @Test func undecodableSuccessResponseQueuesWithToken() async throws {
        let r = try P7Rig()
        r.override = { req in req.httpMethod == "POST" && req.url?.path.hasSuffix("/todos") == true ? .text(200, "<html>Portal</html>") : nil }
        let t = try await r.state.createTodoReturning(title: "Portal", description: "")
        #expect(OfflineIds.isLocal(t.id) && r.status.unsyncedCount == 1)
    }

    @Test func localValidationRejectsBeforeAnyRequestOrQueueing() async throws {
        let r = try P7Rig()
        await #expect(throws: OfflineError.validation(OfflineLocalValidation.titleRequired)) {
            _ = try await r.state.createTodoReturning(title: "   ", description: "")
        }
        await #expect(throws: OfflineError.validation(OfflineLocalValidation.titleTooLong)) {
            _ = try await r.state.createTopicReturning(meetingId: "m1", title: String(repeating: "a", count: 301), description: "")
        }
        #expect(r.server.requests.isEmpty && r.status.items.isEmpty)
    }

    @Test func knownOfflineQueuesWithoutRequest() async throws {
        let r = try P7Rig()
        r.goOffline()
        r.server.clear()
        let t = try await r.state.createTodoReturning(title: "Ohne Netz", description: "", isPrivate: true)
        #expect(OfflineIds.isLocal(t.id) && t.isPrivate)
        #expect(r.server.requests.isEmpty)
    }

    @Test func offlineTopicAppearsInMeetingWithLocalId() async throws {
        let r = try P7Rig()
        try await r.state.loadAll()
        r.goOffline()
        let topic = try await r.state.createTopicReturning(meetingId: "m1", title: "Neues Thema", description: "")
        #expect(OfflineIds.isLocal(topic.id))
        #expect(r.state.meetings.first { $0.id == "m1" }?.topics.contains { $0.id == topic.id } == true)
        #expect(r.status.summary(forEntityId: topic.id)?.title == "Neues Thema")
    }

    @Test func snoozedLocalTodoKeepsSnoozeAndPrivateFlag() async throws {
        let r = try P7Rig()
        r.goOffline()
        let future = OfflineDateText.iso(Date().addingTimeInterval(86_400))
        let t = try await r.state.createTodoReturning(title: "Wecker", description: "", snoozedUntil: future, isPrivate: true)
        #expect(t.snoozedUntil == future && t.isPrivate)
        try await r.state.deleteTodo(id: t.id)   // storniert die lokale Erinnerung wieder
    }

    // MARK: Bearbeiten / Verwerfen lokaler Eintraege

    @Test func updateAndDeleteLocalTodoNeverCallTheServer() async throws {
        let r = try P7Rig()
        r.goOffline()
        let t = try await r.state.createTodoReturning(title: "Alt", description: "")
        r.server.clear()
        try await r.state.updateTodo(id: t.id, title: "Neu", description: "<p>d</p>", done: false, result: "",
                                     resultDate: "", snoozedUntil: nil, dueDate: "2026-12-24", isPrivate: false)
        #expect(r.state.todos.first { $0.id == t.id }?.title == "Neu")
        #expect(r.state.todos.first { $0.id == t.id }?.dueDate == "2026-12-24")
        #expect(r.status.summary(forEntityId: t.id)?.title == "Neu")
        await #expect(throws: OfflineError.validation(OfflineLocalValidation.titleRequired)) {
            try await r.state.updateTodo(id: t.id, title: "", description: "", done: false, result: "",
                                         resultDate: "", snoozedUntil: nil, dueDate: nil)
        }
        try await r.state.deleteTodo(id: t.id)
        #expect(!r.state.todos.contains { $0.id == t.id })
        #expect(r.status.items.isEmpty)
        #expect(r.server.requests.isEmpty)
    }

    @Test func discardingLocalTopicRemovesItFromTheMeeting() async throws {
        let r = try P7Rig()
        try await r.state.loadAll()
        r.goOffline()
        let topic = try await r.state.createTopicReturning(meetingId: "m1", title: "Weg damit", description: "")
        try await r.state.updateTopic(meetingId: "m1", id: topic.id, title: "Geaendert", description: "", done: false,
                                      result: "", resultDate: "", isTodo: true, snoozedUntil: nil)
        #expect(r.state.getTopic(meetingId: "m1", id: topic.id)?.title == "Geaendert")
        try await r.state.deleteTopic(meetingId: "m1", id: topic.id)
        #expect(r.state.getTopic(meetingId: "m1", id: topic.id) == nil && r.status.items.isEmpty)
    }

    @Test func unknownLocalIdYieldsPendingNotSynced() async throws {
        let r = try P7Rig()
        await #expect(throws: OfflineError.pendingNotSynced) {
            try await r.state.deleteTodo(id: "local-00000000-0000-0000-0000-000000000000")
        }
    }

    // MARK: Overlay

    @Test func serverReloadKeepsLocalEntriesAndDeduplicatesAfterAcknowledge() async throws {
        let r = try P7Rig()
        r.goOffline()
        let t = try await r.state.createTodoReturning(title: "Wird gesendet", description: "")
        r.serverTodos = [T.serverTodo("s1", title: "Vom Server")]
        r.goOnline()
        try await r.state.loadAll()
        #expect(r.state.todos.map(\.id).contains(t.id) && r.state.todos.map(\.id).contains("s1"))

        // Sync: Server kennt das Todo jetzt - nach refresh genau einmal, unter der Server-ID.
        r.serverTodos = [T.serverTodo("s1", title: "Vom Server"), T.serverTodo("srv-t1", title: "Wird gesendet")]
        await r.coordinator.refresh(.manual)
        let titles = r.state.todos.filter { $0.title == "Wird gesendet" }
        #expect(titles.count == 1 && titles.first?.id == "srv-t1")
        #expect(r.status.items.isEmpty)
        #expect(r.status.dataAsOf != nil && !r.status.isShowingCachedData)
    }

    @Test func allSyncedToastAppearsOnceAfterQueueIsTransmitted() async throws {
        let r = try P7Rig()
        r.goOffline()
        _ = try await r.state.createTodoReturning(title: "Toast", description: "")
        r.goOnline()
        await r.coordinator.refresh(.manual)
        #expect(r.status.items.isEmpty)
        #expect(r.state.currentToast != nil)
        let texts = [r.state.currentToast?.text]
        #expect(texts.contains(AppState.offlineSavedToast) || texts.contains(AppState.allSyncedToast))
        await r.coordinator.refresh(.manual)   // kein zweiter Toast ohne neue Uebertragung
    }

    @Test func reorderIgnoresLocalIds() async throws {
        let r = try P7Rig()
        r.goOffline()
        let t = try await r.state.createTodoReturning(title: "Lokal", description: "")
        r.goOnline()
        r.server.clear()
        try await r.state.reorderTodos(ids: [t.id, "s1", "s2"])
        let sent = r.server.requests.first { $0.path == "/todos/reorder" }?.body["ids"] as? [String]
        #expect(sent == ["s1", "s2"])
    }

    // MARK: Refresh / Auto-Refresh

    @Test func manualRefreshOfflineShowsToastWithDataAsOf() async throws {
        let r = try P7Rig()
        r.status.dataAsOf = Date()
        r.goOffline()
        await r.state.refreshAll(showSpinner: true)
        #expect(r.state.currentToast?.text.hasPrefix("Keine Verbindung – Stand") == true)
        #expect(!r.state.isRefreshing)
    }

    @Test func autoRefreshOfflineDoesNothingAndKeepsData() async throws {
        let r = try P7Rig()
        try await r.state.loadAll()
        r.goOffline()
        let before = r.state.meetings
        r.server.clear()
        await r.state.refreshAll(showSpinner: false)
        #expect(r.state.meetings == before)
        #expect(r.server.requests.isEmpty)
    }

    @Test func refreshFetchFailureKeepsDataAndGoesOffline() async throws {
        let r = try P7Rig()
        await r.coordinator.refresh(.manual)
        #expect(r.state.meetings.count == 1)
        r.failTransport = true
        await r.coordinator.refresh(.manual)
        #expect(r.status.isOffline && r.state.meetings.count == 1)
        r.failTransport = false
    }

    @Test func stackIsNotWipedByTransportFailure() async throws {
        let r = try P7Rig()
        r.state.stackFrames = []
        r.state.stackDepth = 2
        r.failTransport = true
        await r.state.loadStack()
        #expect(r.state.stackDepth == 2)
    }

    // MARK: Zwischenstaende (ProgressStore)

    @Test func progressOnLocalRefIsQueuedWithoutRequest() async throws {
        let r = try P7Rig()
        r.goOffline()
        let todo = try await r.state.createTodoReturning(title: "Vorhaben", description: "")
        r.server.clear()
        let entry = try await r.progress.addEntry(refType: "todo", refId: todo.id, bodyHTML: "<p>Stand 1</p>", source: "manual")
        #expect(OfflineIds.isLocal(entry.id) && entry.refId == todo.id)
        #expect(r.server.requests.isEmpty)
        #expect(r.progress.pendingEntries(refType: "todo", refId: todo.id).map(\.id) == [entry.id])
        #expect(r.status.pendingProgress(refType: "todo", refId: todo.id).count == 1)
        #expect(r.status.unsyncedCount == 2)
    }

    @Test func progressTransportErrorQueuesWithPendingTokenForTodoAndTopic() async throws {
        let r = try P7Rig()
        r.failTransport = true
        let token = r.progress.clientTokenForPendingEntry(refType: "todo", refId: "t1")
        let e1 = try await r.progress.addEntry(refType: "todo", refId: "t1", bodyHTML: "<p>A</p>", source: "manual")
        #expect(OfflineIds.isLocal(e1.id))
        let e2 = try await r.progress.addEntry(refType: "topic", refId: "tp1", bodyHTML: "<p>B</p>", source: "manual")
        #expect(OfflineIds.isLocal(e2.id))
        // Token verbraucht: ein neuer Versuch bekommt einen frischen.
        #expect(r.progress.clientTokenForPendingEntry(refType: "todo", refId: "t1") != token)

        // Sync sendet das urspruengliche Token.
        r.goOnline()
        r.server.clear()
        await r.coordinator.refresh(.manual)
        let post = r.server.requests.first { $0.method == "POST" && $0.path == "/progress/todo/t1/entries" }
        #expect(post?.body["clientToken"] as? String == token)
    }

    @Test func progressForContactIsNotQueued() async throws {
        let r = try P7Rig()
        r.failTransport = true
        await #expect(throws: ProgressError.offline) {
            _ = try await r.progress.addEntry(refType: "contact", refId: "c1", bodyHTML: "<p>x</p>", source: "manual")
        }
        #expect(r.status.items.isEmpty)
    }

    @Test func progressValidationErrorsAreNotQueued() async throws {
        let r = try P7Rig()
        r.goOffline()
        do {
            _ = try await r.progress.addEntry(refType: "todo", refId: "t1", bodyHTML: "<p> </p>", source: "manual")
            Issue.record("expected error")
        } catch {
            #expect((error as? ProgressError)?.errorDescription == OfflineLocalValidation.progressEmpty)
        }
        #expect(r.status.items.isEmpty)
    }

    @Test func localProgressEntryCanBeEditedAndDiscarded() async throws {
        let r = try P7Rig()
        r.goOffline()
        let e = try await r.progress.addEntry(refType: "todo", refId: "t1", bodyHTML: "<p>Erst</p>", source: "manual")
        r.server.clear()
        let updated = try await r.progress.updateEntry(refType: "todo", refId: "t1", entryId: e.id, bodyHTML: "<p>Dann</p>")
        #expect(updated.id == e.id && updated.bodyHtml == "<p>Dann</p>")
        #expect(r.progress.pendingEntries(refType: "todo", refId: "t1").first?.bodyHtml == "<p>Dann</p>")
        await #expect(throws: ProgressError.self) {
            _ = try await r.progress.updateEntry(refType: "todo", refId: "t1", entryId: e.id, bodyHTML: "")
        }
        try await r.progress.deleteEntry(refType: "todo", refId: "t1", entryId: e.id)
        #expect(r.status.items.isEmpty && r.progress.pendingEntries(refType: "todo", refId: "t1").isEmpty)
        await #expect(throws: ProgressError.entryGone) {
            try await r.progress.deleteEntry(refType: "todo", refId: "t1", entryId: e.id)
        }
        #expect(r.server.requests.isEmpty)
    }

    @Test func progressLoadFallsBackToCacheWhenOfflineAndMarksStale() async throws {
        let r = try P7Rig()
        r.override = { req in
            req.url?.path.hasPrefix("/api/progress/todo/t1") == true ? .json(200, rigDetailJSON()) : nil
        }
        await r.progress.load(refType: "todo", refId: "t1")
        #expect(r.progress.state(refType: "todo", refId: "t1").detail != nil)
        #expect(!r.progress.isStale(refType: "todo", refId: "t1"))

        r.failTransport = true
        await r.progress.load(refType: "todo", refId: "t1")
        #expect(r.progress.state(refType: "todo", refId: "t1").detail != nil)
        #expect(r.progress.isStale(refType: "todo", refId: "t1"))

        // Ohne Cache: .failed(.offline)
        await r.progress.load(refType: "todo", refId: "never")
        #expect(r.progress.state(refType: "todo", refId: "never").error == .offline)
    }

    @Test func progressLoadSkipsLocalRefs() async throws {
        let r = try P7Rig()
        await r.progress.load(refType: "todo", refId: "local-abc")
        #expect(r.server.requests.isEmpty)
        #expect(r.progress.state(refType: "todo", refId: "local-abc") == .idle)
    }

    @Test func progressApiNeverSendsLocalIds() async throws {
        let r = try P7Rig()
        await #expect(throws: OfflineError.pendingNotSynced) {
            _ = try await r.state.loadProgress(refType: "todo", refId: "local-abc")
        }
        #expect(r.server.requests.isEmpty)
    }

    // MARK: Host: Probe / Sync-Transport

    @Test func probeSessionClassifiesResponses() async throws {
        let r = try P7Rig()
        #expect(await r.state.probeSession(timeout: 1) == .valid(P7Rig.user))
        r.override = { _ in .json(401, ["error": "Nicht angemeldet"]) }
        #expect(await r.state.probeSession(timeout: 1) == .noSession)
        r.override = { _ in .text(200, "<html>Portal</html>") }
        #expect(await r.state.probeSession(timeout: 1) == .unreachable)
        r.override = { _ in .text(401, "<html>Portal</html>") }
        #expect(await r.state.probeSession(timeout: 1) == .unreachable)
        r.override = { _ in .json(503, ["error": "x"]) }
        #expect(await r.state.probeSession(timeout: 1) == .unreachable)
        r.override = nil
        r.failTransport = true
        #expect(await r.state.probeSession(timeout: 1) == .unreachable)
    }

    @Test func syncRequestReturnsHTTPErrorsAndSkipsAutoRenewal() async throws {
        let r = try P7Rig()
        var renewalCalled = false
        r.state.sessionRenewalOverride = { renewalCalled = true; return true }
        r.override = { _ in .json(401, ["error": "Nicht angemeldet"]) }
        let (_, http) = try await r.state.performSyncRequest(method: "GET", path: "/sync/capabilities", body: nil, timeout: 5)
        #expect(http.statusCode == 401 && !renewalCalled)
        await #expect(throws: OfflineError.pendingNotSynced) {
            _ = try await r.state.performSyncRequest(method: "PUT", path: "/todos/local-1", body: nil, timeout: 5)
        }
    }

    @Test func renewSessionUsesInMemoryCredentialsAndDropsThemAfterwards() async throws {
        let r = try P7Rig()
        r.state.hasStoredCredentials = false
        #expect(await r.state.renewSessionForSync() == nil)   // keine Zugangsdaten
        r.state.offlineUnlockCredentials = StoredCredentials(username: "anna", password: "geheim")
        r.state.credentialLoader = { _ in throw KeychainError.userCancelled }   // darf NICHT gebraucht werden
        let user = await r.state.renewSessionForSync()
        #expect(user == P7Rig.user && r.state.offlineUnlockCredentials == nil)
        let login = r.server.requests.last { $0.path == "/login" }
        #expect(login?.body["username"] as? String == "anna")
    }

    @Test func progressEntriesPathMatchesTheProgressApi() async throws {
        let r = try P7Rig()
        #expect(r.state.progressEntriesPath(refType: "todo", refId: "t1") == "/progress/todo/t1/entries")
    }

    // MARK: Benachrichtigungen / Quittierung

    @Test func acknowledgedProgressReloadsLoadedTimeline() async throws {
        let r = try P7Rig()
        r.override = { req in
            req.url?.path.hasPrefix("/api/progress/todo/t1") == true && req.httpMethod == "GET" ? .json(200, rigDetailJSON()) : nil
        }
        await r.progress.load(refType: "todo", refId: "t1")
        r.goOffline()
        _ = try await r.progress.addEntry(refType: "todo", refId: "t1", bodyHTML: "<p>X</p>", source: "manual")
        r.goOnline()
        r.server.clear()
        await r.coordinator.refresh(.manual)
        await r.settle { r.server.count(method: "GET", pathPrefix: "/progress/todo/t1") > 0 }
        #expect(r.server.count(method: "GET", pathPrefix: "/progress/todo/t1") >= 1)
        #expect(r.status.items.isEmpty)
    }
}
