import Testing
import Foundation
@testable import ThreadStack

//  Gemeinsames Test-Geruest fuer AppState-Offline-Tests: gemockter Server (URLProtocol), echter
//  OfflineCoordinator auf einem Temp-Verzeichnis, `reusing:` simuliert einen erneuten App-Start.

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
final class OfflineAppRig {
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
    var loggedInUser = OfflineAppRig.user
    var failTransport = false
    /// NWPath-Zustand fuer den Boot-Ablauf.
    var pathOK = true
    /// Erlaubt Tests, einzelne Pfade gesondert zu beantworten (vor dem Standardverhalten).
    var override: ((URLRequest) -> RigReply?)?

    var scope: OfflineScope { OfflineScope(serverURL: OfflineScope.normalize(serverURL: "https://\(host)"), userId: "u1") }

    /// `reusing`: simuliert einen erneuten App-Start - gleicher Host/Dateispeicher, frische Objekte.
    init(activate: Bool = true, reusing other: OfflineAppRig? = nil) throws {
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

