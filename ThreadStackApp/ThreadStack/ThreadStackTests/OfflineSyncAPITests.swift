import Testing
import Foundation
@testable import ThreadStack

//  Paket P3, S-11: OfflineSyncAPI (Request-Aufbau, Klassifizierungstabelle, Capabilities).

/// Gefaelschte Transportschicht; gemeinsam genutzt von den Sync-Tests.
@MainActor
final class FakeHTTP {
    struct Request { let method: String; let path: String; let body: [String: Any]?; let timeout: TimeInterval }
    struct Reply {
        var status: Int
        var body: Data
        var headers: [String: String] = [:]
        static func json(_ status: Int, _ obj: Any, headers: [String: String] = [:]) -> Reply {
            Reply(status: status, body: (try? JSONSerialization.data(withJSONObject: obj)) ?? Data(), headers: headers)
        }
        static func text(_ status: Int, _ s: String) -> Reply { Reply(status: status, body: Data(s.utf8)) }
    }

    var requests: [Request] = []
    /// Antwort je Request; `throw` simuliert einen Transportfehler.
    var handler: (Request) throws -> Reply = { _ in .json(500, ["error": "x"]) }

    var ops: OfflineHTTPOperations {
        OfflineHTTPOperations(
            send: { [self] method, path, body, timeout in
                let req = Request(method: method, path: path, body: body, timeout: timeout)
                requests.append(req)
                let reply = try handler(req)
                let url = URL(string: "https://example.test/api" + path)!
                let resp = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
                return (reply.body, resp)
            },
            progressEntriesPath: { t, id in "/progress/\(t)/\(id)/entries" })
    }

    static let todoJSON: [String: Any] = [
        "id": "t1", "title": "T", "description": "", "done": false, "result": "", "resultDate": "",
        "isPrivate": false, "createdAt": "2026-01-01T00:00:00.000Z"]
    static func topicJSON(_ id: String = "p1", meeting: String = "m1") -> [String: Any] {
        ["id": id, "meetingId": meeting, "title": "Th", "description": "", "done": false, "result": "",
         "resultDate": "", "isTodo": false, "createdAt": "2026-01-01T00:00:00.000Z"]
    }
    static func entryJSON(_ id: String = "e1") -> [String: Any] {
        ["entry": ["id": id, "refType": "todo", "refId": "t1", "kind": "note", "source": "manual",
                   "bodyHtml": "<p>x</p>", "excerpt": "x", "createdAt": "2026-01-01T00:00:00.000Z",
                   "gapDaysBefore": 0, "showDormancyMarker": false, "editable": true]]
    }
}

struct TransportDown: Error {}

@MainActor @Suite(.serialized)
struct OfflineSyncAPITests {
    typealias T = OfflineTestSupport
    let date = Date(timeIntervalSince1970: 1_800_000_000)

    private func make(_ http: FakeHTTP) -> OfflineSyncAPI { OfflineSyncAPI(http: http.ops) }

    // MARK: Request-Aufbau

    @Test func createTodoBuildsBodyWithTokenAndCapturedAt() async {
        let http = FakeHTTP()
        http.handler = { _ in .json(201, FakeHTTP.todoJSON) }
        var p = T.todo("Titel"); p.snoozedUntil = "2026-12-01"; p.dueDate = "2026-12-24"; p.isPrivate = true
        let r = await make(http).createTodo(p, clientToken: "tok", capturedAt: date)
        guard case .success(let todo) = r else { Issue.record("kein Erfolg"); return }
        #expect(todo.id == "t1")
        let req = http.requests[0]
        #expect(req.method == "POST" && req.path == "/todos" && req.timeout == 15)
        #expect(req.body?["title"] as? String == "Titel")
        #expect(req.body?["description"] as? String == "<p>Beschreibung</p>")
        #expect(req.body?["isPrivate"] as? Bool == true)
        #expect(req.body?["snoozedUntil"] as? String == "2026-12-01")
        #expect(req.body?["dueDate"] as? String == "2026-12-24")
        #expect(req.body?["clientToken"] as? String == "tok")
        let cap = req.body?["capturedAt"] as? String
        #expect(cap == "2027-01-15T08:00:00Z")
        #expect(!(cap ?? "").contains("."))   // .withInternetDateTime: keine Millisekunden
    }

    @Test func createTodoOmitsNilOptionalFields() async {
        let http = FakeHTTP()
        http.handler = { _ in .json(201, FakeHTTP.todoJSON) }
        _ = await make(http).createTodo(T.todo(), clientToken: "tok", capturedAt: date)
        #expect(http.requests[0].body?["snoozedUntil"] == nil)
        #expect(http.requests[0].body?["dueDate"] == nil)
    }

    @Test func createTopicPostsToMeetingPath() async {
        let http = FakeHTTP()
        http.handler = { _ in .json(201, FakeHTTP.topicJSON()) }
        let r = await make(http).createTopic(T.topic(meeting: "m-7"), clientToken: "tok", capturedAt: date)
        guard case .success(let t) = r else { Issue.record("kein Erfolg"); return }
        #expect(t.id == "p1")
        #expect(http.requests[0].path == "/meetings/m-7/topics")
        #expect(http.requests[0].body?["isTodo"] as? Bool == false)
        #expect(http.requests[0].body?["clientToken"] as? String == "tok")
    }

    @Test func addProgressEntryUsesProvidedPathAndUnwrapsEntry() async {
        let http = FakeHTTP()
        http.handler = { _ in .json(201, FakeHTTP.entryJSON("e9")) }
        let r = await make(http).addProgressEntry(refType: "todo", refId: "t1", bodyHTML: "<p>x</p>", source: "manual", clientToken: "tok")
        guard case .success(let e) = r else { Issue.record("kein Erfolg"); return }
        #expect(e.id == "e9")
        #expect(http.requests[0].path == "/progress/todo/t1/entries")
        #expect(http.requests[0].body?["body"] as? String == "<p>x</p>")
        #expect(http.requests[0].body?["source"] as? String == "manual")
        #expect(http.requests[0].body?["clientToken"] as? String == "tok")
    }

    @Test func replayWith200IsSuccess() async {
        let http = FakeHTTP()
        var json = FakeHTTP.todoJSON; json["idempotent"] = true
        http.handler = { _ in .json(200, json) }
        let r = await make(http).createTodo(T.todo(), clientToken: "tok", capturedAt: date)
        if case .success = r {} else { Issue.record("Replay muss Erfolg sein") }
    }

    @Test func followUpRequestsAndNullableFields() async {
        let http = FakeHTTP()
        http.handler = { _ in .json(200, ["ok": true]) }
        let api = make(http)
        _ = await api.updateTodo(serverId: "t1", T.todo("Neu"))
        #expect(http.requests[0].method == "PUT" && http.requests[0].path == "/todos/t1")
        #expect(http.requests[0].body?["snoozedUntil"] is NSNull)
        #expect(http.requests[0].body?["dueDate"] is NSNull)
        _ = await api.updateTopic(meetingId: "m1", serverId: "p1", T.topic())
        #expect(http.requests[1].path == "/meetings/m1/topics/p1" && http.requests[1].method == "PUT")
        _ = await api.deleteTodo(serverId: "t1")
        #expect(http.requests[2].method == "DELETE" && http.requests[2].path == "/todos/t1")
        _ = await api.deleteTopic(meetingId: "m1", serverId: "p1")
        #expect(http.requests[3].method == "DELETE" && http.requests[3].path == "/meetings/m1/topics/p1")
        _ = await api.updateProgressEntry(entryId: "e1", bodyHTML: "<p>y</p>")
        #expect(http.requests[4].path == "/progress/entries/e1")
        _ = await api.deleteProgressEntry(entryId: "e1")
        #expect(http.requests[5].method == "DELETE")
    }

    // MARK: ID-Pruefung (Pfadinjektion)

    @Test func unsafeIdsAreRejectedWithoutRequest() async {
        let http = FakeHTTP()
        let api = make(http)
        let bad = ["../x", "a/b", "local-123", "", "a b", String(repeating: "a", count: 65), "a?b=1"]
        for id in bad {
            if case .rejected(let r) = await api.deleteTodo(serverId: id) { #expect(r == .rejected(message: nil)) }
            else { Issue.record("deleteTodo \(id)") }
            if case .rejected = await api.updateTodo(serverId: id, T.todo()) {} else { Issue.record("updateTodo \(id)") }
            if case .rejected = await api.deleteTopic(meetingId: "m1", serverId: id) {} else { Issue.record("deleteTopic \(id)") }
            if case .rejected = await api.updateTopic(meetingId: id, serverId: "p1", T.topic()) {} else { Issue.record("updateTopic \(id)") }
            if case .rejected = await api.createTopic(T.topic(meeting: id), clientToken: "t", capturedAt: date) {} else { Issue.record("createTopic \(id)") }
            if case .rejected = await api.addProgressEntry(refType: "todo", refId: id, bodyHTML: "x", source: "manual", clientToken: "t") {} else { Issue.record("progress \(id)") }
        }
        if case .rejected = await api.addProgressEntry(refType: "evil", refId: "t1", bodyHTML: "x", source: "manual", clientToken: "t") {} else { Issue.record("refType") }
        #expect(http.requests.isEmpty)
    }

    // MARK: Klassifizierungstabelle

    private func classifyTodo(_ reply: FakeHTTP.Reply) async -> SyncCallResult<TodoItem> {
        let http = FakeHTTP()
        http.handler = { _ in reply }
        return await make(http).createTodo(T.todo(), clientToken: "tok", capturedAt: date)
    }
    private func classifyTopic(_ reply: FakeHTTP.Reply) async -> SyncCallResult<Topic> {
        let http = FakeHTTP()
        http.handler = { _ in reply }
        return await make(http).createTopic(T.topic(), clientToken: "tok", capturedAt: date)
    }
    private func classifyProgress(_ reply: FakeHTTP.Reply) async -> SyncCallResult<ProgressEntry> {
        let http = FakeHTTP()
        http.handler = { _ in reply }
        return await make(http).addProgressEntry(refType: "todo", refId: "t1", bodyHTML: "x", source: "manual", clientToken: "tok")
    }
    private func classifyFollowUp(_ reply: FakeHTTP.Reply) async -> SyncCallResult<Void> {
        let http = FakeHTTP()
        http.handler = { _ in reply }
        return await make(http).deleteTodo(serverId: "t1")
    }

    private func reason<U>(_ r: SyncCallResult<U>) -> PendingFailureReason? {
        if case .rejected(let x) = r { return x }
        return nil
    }
    private func isTransient<U>(_ r: SyncCallResult<U>) -> Bool { if case .transient = r { return true }; return false }
    private func retryAfter<U>(_ r: SyncCallResult<U>) -> TimeInterval? { if case .transient(let a) = r { return a }; return nil }
    private func isUnauthorized<U>(_ r: SyncCallResult<U>) -> Bool { if case .unauthorized = r { return true }; return false }
    private func isGone<U>(_ r: SyncCallResult<U>) -> Bool { if case .alreadyGone = r { return true }; return false }

    @Test func twoXXUndecodableIsTransient() async {
        #expect(isTransient(await classifyTodo(.json(200, ["ok": true]))))
        #expect(isTransient(await classifyTodo(.text(200, "<html>Login</html>"))))
        #expect(isTransient(await classifyTodo(.text(204, ""))))
        #expect(isTransient(await classifyProgress(.json(201, ["nope": 1]))))
    }

    @Test func nonJsonErrorBodiesAreTransientCaptivePortal() async {
        let portal = "<html><body>Bitte im WLAN anmelden</body></html>"
        for status in [400, 401, 403, 404, 409, 410, 302] {
            #expect(isTransient(await classifyTodo(.text(status, portal))), "Status \(status)")
            #expect(isTransient(await classifyTopic(.text(status, portal))), "Status \(status)")
            #expect(isTransient(await classifyFollowUp(.text(status, portal))), "Status \(status)")
        }
        // Auch ein JSON-ARRAY ist kein JSON-Objekt unseres Servers.
        #expect(isTransient(await classifyTodo(.json(400, ["a", "b"]))))
        #expect(isTransient(await classifyTodo(.text(400, ""))))
    }

    @Test func followUpSuccessRequiresJsonObject() async {
        #expect(isTransient(await classifyFollowUp(.text(200, "<html>Portal</html>"))))
        if case .success = await classifyFollowUp(.json(200, ["ok": true])) {} else { Issue.record("Erfolg erwartet") }
    }

    @Test func transportFailureIsTransient() async {
        let http = FakeHTTP()
        http.handler = { _ in throw URLError(.notConnectedToInternet) }
        #expect(isTransient(await make(http).createTodo(T.todo(), clientToken: "t", capturedAt: date)))
        http.handler = { _ in throw URLError(.timedOut) }
        #expect(isTransient(await make(http).deleteTodo(serverId: "t1")))
        http.handler = { _ in throw CancellationError() }
        #expect(isTransient(await make(http).createTopic(T.topic(), clientToken: "t", capturedAt: date)))
        http.handler = { _ in throw TransportDown() }
        #expect(isTransient(await make(http).addProgressEntry(refType: "todo", refId: "t1", bodyHTML: "x", source: "manual", clientToken: "t")))
    }

    @Test func timeoutServerErrorsAreTransient() async {
        for status in [408, 500, 502, 503, 504] {
            #expect(isTransient(await classifyTodo(.json(status, ["error": "x"]))), "Status \(status)")
            #expect(isTransient(await classifyTodo(.text(status, "<html/>"))), "Status \(status)")
            #expect(retryAfter(await classifyTodo(.json(status, ["error": "x"]))) == nil)
        }
    }

    @Test func tooManyRequestsHonoursRetryAfterWithMinimum60() async {
        #expect(retryAfter(await classifyTodo(.json(429, ["error": "x"]))) == 60)
        #expect(retryAfter(await classifyTodo(.json(429, ["error": "x"], headers: ["Retry-After": "10"]))) == 60)
        #expect(retryAfter(await classifyTodo(.json(429, ["error": "x"], headers: ["Retry-After": "120"]))) == 120)
        #expect(retryAfter(await classifyTodo(.text(429, "<html/>"))) == 60)
        // absurd hoher Wert wird gedeckelt, Muell ignoriert
        #expect(retryAfter(await classifyTodo(.json(429, ["error": "x"], headers: ["Retry-After": "99999999"]))) == 3600)
        #expect(retryAfter(await classifyTodo(.json(429, ["error": "x"], headers: ["Retry-After": "bald"]))) == 60)
    }

    @Test func unauthorizedIs401WithJson() async {
        #expect(isUnauthorized(await classifyTodo(.json(401, ["error": "Nicht angemeldet"]))))
        #expect(isUnauthorized(await classifyFollowUp(.json(401, ["error": "x"]))))
        let http = FakeHTTP()
        http.handler = { _ in throw APIError.unauthorized }
        #expect(isUnauthorized(await make(http).createTodo(T.todo(), clientToken: "t", capturedAt: date)))
    }

    @Test func tokenTargetGoneIsAlreadyGone() async {
        #expect(isGone(await classifyTodo(.json(410, ["code": "CLIENT_TOKEN_TARGET_GONE", "error": "x"]))))
        #expect(isGone(await classifyTopic(.json(410, ["code": "CLIENT_TOKEN_TARGET_GONE", "error": "x"]))))
        // anderer 410 ist keine Erfolgsmeldung
        #expect(reason(await classifyTodo(.json(410, ["error": "weg"]))) == .rejected(message: "weg"))
    }

    @Test func notFoundDependsOnOperation() async {
        #expect(isGone(await classifyFollowUp(.json(404, ["error": "Nicht gefunden"]))))
        #expect(reason(await classifyTopic(.json(404, ["error": "Nicht gefunden"]))) == .meetingGone)
        #expect(reason(await classifyProgress(.json(404, ["code": "ref_not_found", "error": "Referenz nicht gefunden."]))) == .refGone)
        #expect(reason(await classifyTodo(.json(404, ["error": "Nicht gefunden"]))) == .rejected(message: nil))
    }

    @Test func conflictsAreMappedByCode() async {
        #expect(reason(await classifyTopic(.json(409, ["code": "ARCHIVED_READONLY", "error": "x"]))) == .meetingArchived)
        #expect(reason(await classifyProgress(.json(409, ["code": "ref_done", "error": "x"]))) == .refDone)
        #expect(reason(await classifyTodo(.json(409, ["code": "CLIENT_TOKEN_CONFLICT", "error": "x"]))) == .tokenConflict)
        #expect(reason(await classifyTodo(.json(409, ["error": "Konflikt"]))) == .rejected(message: "Konflikt"))
    }

    @Test func invalidClientTokenInBothSpellingsIsTokenConflict() async {
        #expect(reason(await classifyTodo(.json(400, ["code": "INVALID_CLIENT_TOKEN", "error": "x"]))) == .tokenConflict)
        #expect(reason(await classifyProgress(.json(400, ["code": "invalid_client_token", "error": "x"]))) == .tokenConflict)
    }

    @Test func otherBadRequestIsValidationWithServerText() async {
        #expect(reason(await classifyTodo(.json(400, ["error": "Titel erforderlich"]))) == .validation(message: "Titel erforderlich"))
        #expect(reason(await classifyTodo(.json(400, ["code": "INVALID_CAPTURED_AT", "error": "Ungültiges Erfassungsdatum."]))) == .validation(message: "Ungültiges Erfassungsdatum."))
        if case .validation(let m)? = reason(await classifyTodo(.json(400, ["foo": "bar"]))) { #expect(!m.isEmpty) }
        else { Issue.record("validation erwartet") }
    }

    @Test func otherClientErrorsAreRejected() async {
        #expect(reason(await classifyTodo(.json(403, ["error": "Verboten"]))) == .rejected(message: "Verboten"))
        #expect(reason(await classifyTodo(.json(422, ["foo": 1]))) == .rejected(message: nil))
    }

    // MARK: Capabilities

    private func caps(_ reply: FakeHTTP.Reply?, error: Error? = nil) async -> SyncCapabilityResult {
        let http = FakeHTTP()
        http.handler = { _ in if let error { throw error }; return reply! }
        let r = await make(http).capabilities()
        #expect(http.requests[0].path == "/sync/capabilities" && http.requests[0].method == "GET")
        return r
    }

    @Test func capabilitiesClassification() async {
        #expect(await caps(.json(200, ["idempotentCreate": ["version": 1, "refTypes": ["todo", "topic"]], "capturedAt": true])) == .supported)
        #expect(await caps(.json(200, ["idempotentCreate": ["version": 3]])) == .supported)
        #expect(await caps(.json(200, ["idempotentCreate": ["version": 0]])) == .unsupported)
        #expect(await caps(.json(200, ["other": 1])) == .unsupported)
        #expect(await caps(.json(404, ["error": "x"])) == .unsupported)
        #expect(await caps(.text(404, "Cannot GET /api/sync/capabilities")) == .unsupported)
        #expect(await caps(.text(200, "<html>Portal</html>")) == .transient)
        #expect(await caps(.json(500, ["error": "x"])) == .transient)
        #expect(await caps(nil, error: URLError(.notConnectedToInternet)) == .transient)
        #expect(await caps(.json(401, ["error": "x"])) == .unauthorized)
        #expect(await caps(.text(401, "<html/>")) == .transient)
    }
}
