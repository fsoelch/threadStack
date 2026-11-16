import Testing
import Foundation
@testable import ThreadStack

//  Paket P3, S-11: OfflineSyncEngine (Reihenfolge, Transient-Stopp, Abhaengige,
//  Follow-ups, Renewal/Nutzerwechsel, Budget, Backoff, Capabilities).

@MainActor
final class EngineRig {
    typealias T = OfflineTestSupport
    let clock = ClockBox()
    let store = T.makeStore()
    let http = FakeHTTP()
    let outbox: OfflineOutbox
    var engine: OfflineSyncEngine!
    var currentUser: String? = "u1"
    var renewResult: AppUser? = AppUser(id: "u1", username: "a", role: "user")
    var renewCalls = 0
    var activities: [OfflineSyncActivity] = []
    var acknowledged: [PendingChange] = []
    var completed: [PendingChange] = []
    private var counter = 0
    /// Skriptete Antworten je "METHOD path" (werden der Reihe nach verbraucht), danach Standardantwort.
    var scripted: [String: [FakeHTTP.Reply]] = [:]
    /// Hook, der vor der Antwort laeuft (z.B. Bearbeiten waehrend inFlight).
    var beforeReply: ((FakeHTTP.Request) -> Void)?

    init(budget: Int = 40, window: TimeInterval = 600) throws {
        clock.now = Date(timeIntervalSince1970: 1_800_000_000)
        let clockRef = clock
        outbox = try OfflineOutbox(scope: T.scope, store: store, now: { clockRef.now })
        http.handler = { [unowned self] req in
            beforeReply?(req)
            let key = req.method + " " + req.path
            if var q = scripted[key], !q.isEmpty {
                let r = q.removeFirst(); scripted[key] = q
                return r
            }
            return defaultReply(req)
        }
        engine = OfflineSyncEngine(
            outbox: outbox, api: OfflineSyncAPI(http: http.ops), scopeUserId: "u1",
            currentUserId: { [unowned self] in currentUser },
            renewSession: { [unowned self] in renewCalls += 1; return renewResult },
            now: { clockRef.now }, progressBudget: budget, progressWindow: window, jitter: { 0 })
        engine.onActivityChange = { [unowned self] in activities.append($0) }
        engine.onAcknowledged = { [unowned self] c, _ in acknowledged.append(c) }
        engine.onCompleted = { [unowned self] c in completed.append(c) }
    }

    deinit { store.removeAll() }

    func defaultReply(_ req: FakeHTTP.Request) -> FakeHTTP.Reply {
        counter += 1
        if req.method == "GET", req.path == "/sync/capabilities" {
            return .json(200, ["idempotentCreate": ["version": 1]])
        }
        if req.method == "POST", req.path == "/todos" {
            var j = FakeHTTP.todoJSON; j["id"] = "srv-t\(counter)"; return .json(201, j)
        }
        if req.method == "POST", req.path.hasSuffix("/topics") {
            return .json(201, FakeHTTP.topicJSON("srv-p\(counter)"))
        }
        if req.method == "POST", req.path.hasSuffix("/entries") {
            return .json(201, FakeHTTP.entryJSON("srv-e\(counter)"))
        }
        return .json(200, ["ok": true])
    }

    var paths: [String] { http.requests.filter { $0.path != "/sync/capabilities" }.map { $0.method + " " + $0.path } }

    func change(_ id: UUID) -> PendingChange? { outbox.changes.first { $0.id == id } }
}

@MainActor @Suite(.serialized)
struct OfflineSyncEngineTests {
    typealias T = OfflineTestSupport

    // MARK: Reihenfolge

    @Test func processesInSeqOrderAndResolvesLocalParent() async throws {
        let r = try EngineRig()
        let todo = try r.outbox.enqueueTodo(T.todo("A"))
        let topic = try r.outbox.enqueueTopic(T.topic("B", meeting: "m1"))
        let prog = try r.outbox.enqueueProgress(T.progress(ref: .local(changeId: todo.id)))
        r.scripted["POST /todos"] = [.json(201, { var j = FakeHTTP.todoJSON; j["id"] = "srv-a"; return j }())]
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: true))
        #expect(r.paths == ["POST /todos", "POST /meetings/m1/topics", "POST /progress/todo/srv-a/entries"])
        // Todo/Topic bleiben bis zum Reconcile quittiert, der Zwischenstand ist sofort abgeschlossen.
        #expect(r.outbox.changes.map(\.id) == [todo.id, topic.id])
        if case .acknowledged(let sid, _) = r.change(todo.id)?.state { #expect(sid == "srv-a") } else { Issue.record("ack") }
        #expect(r.outbox.alias(forLocalId: prog.localEntityId) != nil)
        #expect(r.acknowledged.count == 3)
        #expect(r.completed.map(\.id) == [prog.id])
    }

    @Test func nothingToDoWithoutActionableChangesAndNoRequests() async throws {
        let r = try EngineRig()
        #expect(await r.engine.runOnce() == .nothingToDo)
        #expect(r.http.requests.isEmpty)
        let c = try r.outbox.enqueueTodo(T.todo())
        try r.outbox.markFailed(id: c.id, reason: .rejected(message: nil))
        #expect(await r.engine.runOnce() == .nothingToDo)
        #expect(r.http.requests.isEmpty)
    }

    @Test func failedEntriesAreSkippedOthersProceed() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        let b = try r.outbox.enqueueTodo(T.todo("B"))
        r.scripted["POST /todos"] = [.json(400, ["error": "Titel erforderlich"])]
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: true))
        #expect(r.change(a.id)?.state == .failed(.validation(message: "Titel erforderlich")))
        if case .acknowledged = r.change(b.id)?.state {} else { Issue.record("B muss quittiert sein") }
        // Zweiter Lauf fasst das fehlgeschlagene A nicht an.
        r.http.requests.removeAll()
        #expect(await r.engine.runOnce() == .nothingToDo)
        #expect(r.http.requests.isEmpty)
    }

    // MARK: Transient

    @Test func transientStopsTheRunKeepingOrder() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        let b = try r.outbox.enqueueTodo(T.todo("B"))
        r.scripted["POST /todos"] = [.json(503, ["error": "down"])]
        let outcome = await r.engine.runOnce()
        #expect(outcome == .stoppedTransient(retryAt: r.clock.now.addingTimeInterval(5)))
        #expect(r.paths == ["POST /todos"])   // B wurde NICHT uebersprungen gesendet
        #expect(r.change(a.id)?.state == .pending)
        #expect(r.change(a.id)?.attemptCount == 1)
        #expect(r.change(b.id)?.state == .pending)
        #expect(r.activities.last == .waitingRetry(until: r.clock.now.addingTimeInterval(5)))
    }

    @Test func captivePortalHtmlIsTransientNeverFailed() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["POST /todos"] = [.text(200, "<html>Portal</html>")]
        _ = await r.engine.runOnce()
        #expect(r.change(a.id)?.state == .pending)
    }

    @Test func backoffSequenceAndCap() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo())
        r.scripted["POST /todos"] = Array(repeating: .json(503, ["error": "x"]), count: 9)
        var delays: [TimeInterval] = []
        for _ in 0..<9 {
            if case .stoppedTransient(let at) = await r.engine.runOnce() { delays.append(at.timeIntervalSince(r.clock.now)); r.clock.now = at }
        }
        #expect(delays == [5, 10, 20, 40, 80, 160, 300, 300, 300])
    }

    @Test func backoffAppliesJitterWithinTwentyPercent() async throws {
        let r = try EngineRig()
        let jittered = OfflineSyncEngine(outbox: r.outbox, api: OfflineSyncAPI(http: r.http.ops), scopeUserId: "u1",
                                         currentUserId: { "u1" }, renewSession: { nil }, now: { r.clock.now }, jitter: { 0.2 })
        _ = try r.outbox.enqueueTodo(T.todo())
        r.scripted["POST /todos"] = [.json(503, ["error": "x"])]
        if case .stoppedTransient(let at) = await jittered.runOnce() { #expect(at.timeIntervalSince(r.clock.now) == 6) }
        else { Issue.record("transient erwartet") }
    }

    @Test func runIsHeldBackUntilRetryAtThenResetBackoffReleases() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo())
        r.scripted["POST /todos"] = [.json(503, ["error": "x"])]
        let first = await r.engine.runOnce()
        r.http.requests.removeAll()
        #expect(await r.engine.runOnce() == first)         // zu frueh: kein Request
        #expect(r.http.requests.isEmpty)
        r.engine.resetBackoff()                            // Verbindungswechsel
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
    }

    @Test func rateLimitUsesAtLeastSixtySeconds() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo())
        r.scripted["POST /todos"] = [.json(429, ["error": "x"], headers: ["Retry-After": "5"])]
        #expect(await r.engine.runOnce() == .stoppedTransient(retryAt: r.clock.now.addingTimeInterval(60)))
    }

    @Test func successfulRunResetsBackoff() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo())
        r.scripted["POST /todos"] = [.json(503, ["error": "x"])]
        if case .stoppedTransient(let at) = await r.engine.runOnce() { r.clock.now = at }
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
        _ = try r.outbox.enqueueTodo(T.todo("2"))
        r.scripted["POST /todos"] = [.json(503, ["error": "x"])]
        #expect(await r.engine.runOnce() == .stoppedTransient(retryAt: r.clock.now.addingTimeInterval(5)))
    }

    // MARK: Abhaengige

    @Test func dependentIsHeldBackWhenParentFailed() async throws {
        let r = try EngineRig()
        let todo = try r.outbox.enqueueTodo(T.todo("A"))
        let prog = try r.outbox.enqueueProgress(T.progress(ref: .local(changeId: todo.id)))
        r.scripted["POST /todos"] = [.json(400, ["error": "Titel erforderlich"])]
        _ = await r.engine.runOnce()
        #expect(r.paths == ["POST /todos"])
        #expect(r.change(prog.id)?.state == .pending)   // nicht gesendet, nicht verloren
    }

    @Test func parentGoneMarksDependentFailedRefGone() async throws {
        let r = try EngineRig()
        let todo = try r.outbox.enqueueTodo(T.todo("A"))
        let prog = try r.outbox.enqueueProgress(T.progress(ref: .local(changeId: todo.id)))
        _ = try r.outbox.discard(id: todo.id)   // verwirft auch das Kind -> neues Kind ohne Elternteil anlegen
        let orphan = try r.outbox.enqueueProgress(T.progress(ref: .local(changeId: UUID())))
        #expect(r.change(prog.id) == nil)
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: false))
        #expect(r.change(orphan.id)?.state == .failed(.refGone))
        #expect(r.paths.isEmpty)
    }

    @Test func progressOnServerRefRejectedAsRefDone() async throws {
        let r = try EngineRig()
        let p = try r.outbox.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "t1")))
        r.scripted["POST /progress/todo/t1/entries"] = [.json(409, ["code": "ref_done", "error": "x"])]
        _ = await r.engine.runOnce()
        #expect(r.change(p.id)?.state == .failed(.refDone))
    }

    // MARK: alreadyGone / rejected

    @Test func alreadyGoneOnCreateIsVisibleFailedNotSilentlyDropped() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["POST /todos"] = [.json(410, ["code": "CLIENT_TOKEN_TARGET_GONE", "error": "x"])]
        _ = await r.engine.runOnce()
        if case .failed(.rejected(let m))? = r.change(a.id)?.state { #expect(m?.isEmpty == false) } else { Issue.record("failed erwartet") }
    }

    @Test func rejectedCreateOfDiscardedInFlightEntryIsRemoved() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.beforeReply = { [unowned r] req in if req.method == "POST" { _ = try? r.outbox.discard(id: a.id) } }
        r.scripted["POST /todos"] = [.json(400, ["error": "x"])]
        _ = await r.engine.runOnce()
        #expect(r.outbox.changes.isEmpty)
    }

    // MARK: Follow-ups

    @Test func acknowledgedUpdateFollowUpIsSentThenCleared() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        _ = await r.engine.runOnce()
        try r.outbox.updatePayload(id: a.id, .todo(T.todo("A neu")))
        #expect(r.change(a.id)?.followUp == .update)
        r.http.requests.removeAll()
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: false))
        #expect(r.http.requests.count == 1 && r.http.requests[0].method == "PUT")
        #expect(r.http.requests[0].path.hasPrefix("/todos/srv-t"))
        #expect(r.http.requests[0].body?["title"] as? String == "A neu")
        #expect(r.change(a.id)?.followUp == PendingFollowUp.none)
    }

    @Test func acknowledgedDeleteFollowUpCompletesEntry() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTopic(T.topic("A", meeting: "m1"))
        _ = await r.engine.runOnce()
        _ = try r.outbox.discard(id: a.id)
        #expect(r.change(a.id)?.isTombstone == true)
        r.http.requests.removeAll()
        _ = await r.engine.runOnce()
        #expect(r.http.requests.map { $0.method + " " + $0.path }.first?.hasPrefix("DELETE /meetings/m1/topics/srv-p") == true)
        #expect(r.change(a.id) == nil)
        #expect(r.completed.last?.id == a.id)
    }

    @Test func editDuringInFlightIsDeliveredAsFollowUp() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("alt"))
        r.beforeReply = { [unowned r] req in
            if req.method == "POST" { try? r.outbox.updatePayload(id: a.id, .todo(T.todo("neu"))) }
        }
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: true))
        #expect(r.paths.count == 2)
        #expect(r.http.requests.last?.method == "PUT")
        #expect(r.http.requests.last?.body?["title"] as? String == "neu")
        #expect(r.change(a.id)?.followUp == PendingFollowUp.none)
    }

    @Test func discardDuringInFlightDeletesServerObject() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.beforeReply = { [unowned r] req in if req.method == "POST" { _ = try? r.outbox.discard(id: a.id) } }
        _ = await r.engine.runOnce()
        #expect(r.http.requests.last?.method == "DELETE")
        #expect(r.change(a.id) == nil)
        #expect(r.acknowledged.isEmpty)   // fuer die UI unsichtbarer Eintrag wird nicht in den Bestand getauscht
    }

    @Test func followUpRejectedDoesNotLoopAndDropsEdit() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        _ = await r.engine.runOnce()
        try r.outbox.updatePayload(id: a.id, .todo(T.todo("B")))
        r.http.handler = { _ in .json(400, ["error": "Titel zu lang"]) }
        _ = await r.engine.runOnce()
        #expect(r.change(a.id)?.followUp == PendingFollowUp.none)
        #expect(r.http.requests.filter { $0.method == "PUT" }.count == 1)
    }

    @Test func followUpNotFoundCompletesEntry() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        _ = await r.engine.runOnce()
        try r.outbox.updatePayload(id: a.id, .todo(T.todo("B")))
        r.http.handler = { _ in .json(404, ["error": "Nicht gefunden"]) }
        _ = await r.engine.runOnce()
        #expect(r.change(a.id) == nil)
    }

    @Test func progressEditedWhileInFlightIsUpdatedOnServer() async throws {
        let r = try EngineRig()
        let p = try r.outbox.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "t1"), body: "<p>alt</p>"))
        r.beforeReply = { [unowned r] req in
            if req.method == "POST" { try? r.outbox.updatePayload(id: p.id, .progress(T.progress(ref: .server(refType: "todo", refId: "t1"), body: "<p>neu</p>"))) }
        }
        _ = await r.engine.runOnce()
        #expect(r.http.requests.last?.method == "PUT")
        #expect(r.http.requests.last?.path.hasPrefix("/progress/entries/srv-e") == true)
        #expect(r.http.requests.last?.body?["body"] as? String == "<p>neu</p>")
        #expect(r.change(p.id) == nil)   // danach abgeschlossen
    }

    // MARK: 401 / Renewal / Nutzerwechsel

    @Test func unauthorizedRenewsOnceAndRetriesSameEntry() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["POST /todos"] = [.json(401, ["error": "x"])]
        let outcome = await r.engine.runOnce()
        #expect(outcome == .completed(acknowledgedAny: true))
        #expect(r.renewCalls == 1)
        #expect(r.paths == ["POST /todos", "POST /todos"])
        let tokens = r.http.requests.filter { $0.path == "/todos" }.map { $0.body?["clientToken"] as? String }
        #expect(tokens[0] == tokens[1] && tokens[0] == a.clientToken)
    }

    @Test func unauthorizedWithoutRenewalPausesNeedsReauthAndStaysPaused() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.renewResult = nil
        r.scripted["POST /todos"] = [.json(401, ["error": "x"])]
        #expect(await r.engine.runOnce() == .paused(.needsReauth))
        #expect(r.change(a.id)?.state == .pending)
        #expect(r.change(a.id)?.attemptCount == 0)         // kein verbrauchter Versuch
        #expect(r.activities.last == .paused(.needsReauth))
        r.http.requests.removeAll()
        #expect(await r.engine.runOnce() == .paused(.needsReauth))   // bleibt pausiert, kein Request
        #expect(r.http.requests.isEmpty)
        r.engine.resume()
        r.renewResult = AppUser(id: "u1", username: "a", role: "user")
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
    }

    @Test func unauthorizedWithForeignUserPausesUserMismatchAndSendsNothingMore() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.renewResult = AppUser(id: "other", username: "b", role: "user")
        r.scripted["POST /todos"] = [.json(401, ["error": "x"])]
        #expect(await r.engine.runOnce() == .paused(.userMismatch))
        #expect(r.paths == ["POST /todos"])   // nach dem Renewal wird NICHTS unter dem fremden Konto gesendet
        #expect(r.change(a.id)?.state == .pending)
    }

    @Test func secondConsecutiveUnauthorizedPausesInsteadOfLooping() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["POST /todos"] = [.json(401, ["error": "x"]), .json(401, ["error": "x"])]
        #expect(await r.engine.runOnce() == .paused(.needsReauth))
        #expect(r.renewCalls == 1)
    }

    @Test func preflightUserMismatchSendsNothing() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        r.currentUser = "someone-else"
        #expect(await r.engine.runOnce() == .paused(.userMismatch))
        #expect(r.http.requests.isEmpty)
        r.currentUser = nil
        #expect(await r.engine.runOnce() == .paused(.userMismatch))
        r.currentUser = "u1"
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))   // nicht klebrig
    }

    // MARK: Budget

    @Test func progressBudgetEndsRunAndRetryAtIsWindowFree() async throws {
        let r = try EngineRig(budget: 2, window: 600)
        for i in 0..<3 { _ = try r.outbox.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "t1"), body: "<p>\(i)</p>")) }
        let start = r.clock.now
        let outcome = await r.engine.runOnce()
        #expect(outcome == .stoppedTransient(retryAt: start.addingTimeInterval(600)))
        #expect(r.paths.count == 2)
        // Fenster wieder frei
        r.clock.now = start.addingTimeInterval(601)
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
        #expect(r.paths.count == 3)
        #expect(r.outbox.changes.isEmpty)
    }

    @Test func budgetDoesNotBlockTodosAndTopics() async throws {
        let r = try EngineRig(budget: 1, window: 600)
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        _ = try r.outbox.enqueueTodo(T.todo("B"))
        _ = try r.outbox.enqueueTopic(T.topic())
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
        #expect(r.paths.count == 3)
    }

    // MARK: Capabilities

    @Test func unsupportedServerPausesAndIsCachedTenMinutes() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["GET /sync/capabilities"] = [.json(404, ["error": "x"])]
        #expect(await r.engine.runOnce() == .paused(.serverUnsupported))
        #expect(r.http.requests.count == 1)
        r.http.requests.removeAll()
        r.clock.now.addTimeInterval(599)
        #expect(await r.engine.runOnce() == .paused(.serverUnsupported))
        #expect(r.http.requests.isEmpty)                    // gecacht
        r.clock.now.addTimeInterval(2)                      // > 10 min
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))   // Server inzwischen aktualisiert
        #expect(r.http.requests.first?.path == "/sync/capabilities")
        if case .acknowledged = r.change(a.id)?.state {} else { Issue.record("ack erwartet") }
    }

    @Test func unsupportedCacheIsClearedByConnectionChange() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["GET /sync/capabilities"] = [.json(404, ["error": "x"])]
        #expect(await r.engine.runOnce() == .paused(.serverUnsupported))
        r.engine.resetBackoff()
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
    }

    @Test func capabilitiesTransientStopsWithBackoffWithoutTouchingEntries() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["GET /sync/capabilities"] = [.text(200, "<html>Portal</html>")]
        #expect(await r.engine.runOnce() == .stoppedTransient(retryAt: r.clock.now.addingTimeInterval(5)))
        #expect(r.change(a.id)?.state == .pending)
        #expect(r.change(a.id)?.attemptCount == 0)
    }

    @Test func capabilitiesUnauthorizedRenewsThenContinues() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        r.scripted["GET /sync/capabilities"] = [.json(401, ["error": "x"])]
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
        #expect(r.renewCalls == 1)
    }

    // MARK: Nebenlaeufigkeit / Fehler

    @Test func concurrentRunsShareOneRun() async throws {
        let r = try EngineRig()
        _ = try r.outbox.enqueueTodo(T.todo("A"))
        async let first = r.engine.runOnce()
        async let second = r.engine.runOnce()
        let (a, b) = await (first, second)
        #expect(a == b)
        #expect(r.paths == ["POST /todos"])   // genau ein Request
    }

    @Test func activityReportsProgressCounts() async throws {
        let r = try EngineRig()
        for i in 0..<3 { _ = try r.outbox.enqueueTodo(T.todo("T\(i)")) }
        _ = await r.engine.runOnce()
        #expect(r.activities.contains(.syncing(done: 0, total: 3)))
        #expect(r.activities.contains(.syncing(done: 2, total: 3)))
        #expect(r.activities.last == .idle)
    }

    @Test func storageFailureDuringRunPausesStorageProblemAndKeepsRetryable() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        // Scope-Verzeichnis durch eine Datei ersetzen: jeder weitere Schreibvorgang scheitert.
        let dir = r.store.baseDirectory.appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: T.scope.key))
        try FileManager.default.removeItem(at: dir)
        try Data("x".utf8).write(to: dir)
        #expect(await r.engine.runOnce() == .paused(.storageProblem))
        #expect(r.change(a.id)?.state == .pending)   // Speicherzustand unveraendert -> spaeter erneut sendbar
        try FileManager.default.removeItem(at: dir)
        r.engine.resetBackoff()                      // z.B. Verbindungswechsel hebt technische Pause auf
        #expect(await r.engine.runOnce() == .completed(acknowledgedAny: true))
    }

    @Test func stoppedEngineNeverWritesAgain() async throws {
        let r = try EngineRig()
        let a = try r.outbox.enqueueTodo(T.todo("A"))
        r.beforeReply = { [unowned r] _ in r.engine.stop() }
        _ = await r.engine.runOnce()
        #expect(r.change(a.id)?.state == .pending)   // nichts wurde nach stop() geschrieben
        #expect(r.acknowledged.isEmpty)
    }
}
