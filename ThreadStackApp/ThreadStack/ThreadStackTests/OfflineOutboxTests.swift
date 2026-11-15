import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-7: OfflineOutbox (Regeln: Persistenz vor Rueckkehr, Quarantaene,
//  Zustandsuebergaenge, Aliasse).

@MainActor @Suite(.serialized)
struct OfflineOutboxTests {
    typealias T = OfflineTestSupport

    private func make(now: @escaping () -> Date = Date.init) throws -> (OfflineOutbox, UserScopedFileStore) {
        let store = T.makeStore()
        return (try OfflineOutbox(scope: T.scope, store: store, now: now), store)
    }

    private func reload(_ store: UserScopedFileStore) throws -> OfflineOutbox {
        try OfflineOutbox(scope: T.scope, store: store)
    }

    private func ack(_ ob: OfflineOutbox, _ c: PendingChange, serverId: String = "srv1") throws {
        _ = try ob.markInFlight(id: c.id)
        try ob.markAcknowledged(id: c.id, serverId: serverId, object: .todo(T.serverTodo(serverId)))
    }

    // MARK: Persistenz

    @Test func mutationIsPersistedBeforeReturning() throws {
        let (ob, store) = try make()
        defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo("A"))
        let reloaded = try reload(store)
        #expect(reloaded.changes == [c])
        try ob.updatePayload(id: c.id, .todo(T.todo("B")))
        #expect(try reload(store).changes == ob.changes)
    }

    @Test func writeFailureThrowsAndKeepsMemoryUnchanged() throws {
        let blocker = T.tempDir()
        try FileManager.default.createDirectory(at: blocker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let ob = try OfflineOutbox(scope: T.scope, store: UserScopedFileStore(baseDirectory: blocker.appendingPathComponent("s")))
        var notified = false
        ob.onChange = { notified = true }
        #expect(throws: OfflineStorageError.writeFailed) { try ob.enqueueTodo(T.todo()) }
        #expect(ob.changes.isEmpty)
        #expect(!notified)
    }

    @Test func corruptFileIsQuarantinedNeverSilentlyDeleted() throws {
        let store = T.makeStore()
        defer { store.removeAll() }
        try store.write(Data("{kaputt".utf8), scopeKey: T.scope.key, fileName: "outbox")
        #expect(throws: OfflineStorageError.corruptQuarantined) { try OfflineOutbox(scope: T.scope, store: store) }
        #expect(try store.read(scopeKey: T.scope.key, fileName: "outbox") == nil)
        let dir = store.baseDirectory.appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: T.scope.key))
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names.contains { $0.hasPrefix("outbox.corrupt-") })
        // Danach ist ein frischer Start moeglich.
        let fresh = try OfflineOutbox(scope: T.scope, store: store)
        #expect(fresh.changes.isEmpty)
    }

    @Test func futureSchemaIsRejectedAndFileStaysUntouched() throws {
        let store = T.makeStore()
        defer { store.removeAll() }
        let raw = Data("{\"schemaVersion\":99,\"zukunft\":true}".utf8)
        try store.write(raw, scopeKey: T.scope.key, fileName: "outbox")
        #expect(throws: OfflineStorageError.unsupportedFutureSchema) { try OfflineOutbox(scope: T.scope, store: store) }
        #expect(try store.read(scopeKey: T.scope.key, fileName: "outbox") == raw)
    }

    @Test func outboxesOfDifferentScopesAreIsolated() throws {
        let store = T.makeStore()
        defer { store.removeAll() }
        let a = try OfflineOutbox(scope: OfflineScope(serverURL: "https://a", userId: "u"), store: store)
        _ = try a.enqueueTodo(T.todo())
        let b = try OfflineOutbox(scope: OfflineScope(serverURL: "https://b", userId: "u"), store: store)
        #expect(b.changes.isEmpty)
    }

    @Test func inFlightIsResetToPendingAfterRestart() throws {
        let (ob, store) = try make()
        defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        let after = try reload(store)
        #expect(after.changes[0].state == .pending)
        #expect(after.changes[0].clientToken == c.clientToken)
    }

    // MARK: Zaehler / Token

    @Test func seqIsStrictlyIncreasingAndPersistedEvenAfterRemoval() throws {
        let (ob, store) = try make()
        defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo("a"))
        let b = try ob.enqueueTodo(T.todo("b"))
        #expect(b.seq > a.seq)
        try ob.discard(id: b.id)
        let again = try reload(store)
        let c = try again.enqueueTodo(T.todo("c"))
        #expect(c.seq > b.seq)
        #expect(again.changes.map(\.seq) == again.changes.map(\.seq).sorted())
    }

    @Test func clientTokenGeneratedOrTakenIfValidUUID() throws {
        let (ob, store) = try make()
        defer { store.removeAll() }
        let generated = try ob.enqueueTodo(T.todo())
        #expect(UUID(uuidString: generated.clientToken) != nil)
        let given = UUID().uuidString
        let c = try ob.enqueueTodo(T.todo(), clientToken: given)
        #expect(c.clientToken == given)
    }

    @Test func capturedAtUsesGivenOrNow() throws {
        let fixed = Date(timeIntervalSince1970: 1_700_000_000)
        let (ob, store) = try make(now: { fixed })
        defer { store.removeAll() }
        #expect(try ob.enqueueTodo(T.todo()).capturedAt == fixed)
        let earlier = Date(timeIntervalSince1970: 1_600_000_000)
        #expect(try ob.enqueueTodo(T.todo(), capturedAt: earlier).capturedAt == earlier)
    }

    @Test func enqueueRejectsUnsafeReferences() throws {
        let (ob, store) = try make()
        defer { store.removeAll() }
        #expect(throws: OfflineError.self) { try ob.enqueueTopic(T.topic(meeting: "local-abc")) }
        #expect(throws: OfflineError.self) { try ob.enqueueTopic(T.topic(meeting: "../x")) }
        #expect(throws: OfflineError.self) {
            try ob.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "a/b")))
        }
        #expect(throws: OfflineError.self) {
            try ob.enqueueProgress(T.progress(ref: .server(refType: "meeting", refId: "ok")))
        }
        #expect(ob.changes.isEmpty)
    }

    // MARK: updatePayload

    @Test func updatePayloadPendingBumpsRevision() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo("A"))
        try ob.updatePayload(id: c.id, .todo(T.todo("B")))
        let u = ob.changes[0]
        #expect(u.revision == c.revision + 1)
        #expect(u.state == .pending && u.followUp == .none)
        #expect(u.payload == .todo(T.todo("B")))
    }

    @Test func updatePayloadFailedBecomesPendingAgain() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .rejected(message: nil))
        try ob.updatePayload(id: c.id, .todo(T.todo("neu")))
        #expect(ob.changes[0].state == .pending)
        #expect(ob.changes[0].revision == c.revision + 1)
    }

    @Test func updatePayloadInFlightSetsFollowUpUpdate() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        let sent = try ob.markInFlight(id: c.id)
        try ob.updatePayload(id: c.id, .todo(T.todo("neu")))
        let u = ob.changes[0]
        #expect(u.followUp == .update)
        #expect(u.revision == sent + 1)
        #expect(u.state == .inFlight(sentRevision: sent))
    }

    @Test func updatePayloadAcknowledgedSetsFollowUpOnly() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        try ack(ob, c)
        try ob.updatePayload(id: c.id, .todo(T.todo("neu")))
        #expect(ob.changes[0].followUp == .update)
        if case .acknowledged = ob.changes[0].state {} else { Issue.record("sollte acknowledged bleiben") }
    }

    @Test func updatePayloadOnTombstoneThrowsPendingNotSynced() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.discard(id: c.id)
        #expect(throws: OfflineError.pendingNotSynced) { try ob.updatePayload(id: c.id, .todo(T.todo("x"))) }
    }

    @Test func updatePayloadRejectsKindChangeAndUnknownId() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        #expect(throws: OfflineOutboxError.invalidState) { try ob.updatePayload(id: c.id, .topic(T.topic())) }
        #expect(ob.changes[0].payload == .todo(T.todo()))
        #expect(throws: OfflineOutboxError.notFound) { try ob.updatePayload(id: UUID(), .todo(T.todo())) }
    }

    // MARK: discard

    @Test func discardPendingAndFailedRemovesImmediatelyWithDependents() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let parent = try ob.enqueueTodo(T.todo())
        let dep = try ob.enqueueProgress(T.progress(ref: .local(changeId: parent.id)))
        let other = try ob.enqueueTodo(T.todo("andere"))
        let removed = try ob.discard(id: parent.id)
        #expect(Set(removed.map(\.id)) == [parent.id, dep.id])
        #expect(ob.changes.map(\.id) == [other.id])
        #expect(try reload(store).changes.map(\.id) == [other.id])
    }

    @Test func discardFailedRemoves() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .refGone)
        try ob.discard(id: c.id)
        #expect(ob.changes.isEmpty)
    }

    @Test func discardInFlightBecomesTombstoneWithFollowUpDelete() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        let dep = try ob.enqueueProgress(T.progress(ref: .local(changeId: c.id)))
        _ = try ob.markInFlight(id: c.id)
        let affected = try ob.discard(id: c.id)
        #expect(affected.count == 2)
        let t = ob.changes.first { $0.id == c.id }!
        #expect(t.isTombstone && t.followUp == .delete)
        #expect(ob.changes.first { $0.id == dep.id } == nil) // pending Abhaengiger sofort weg
        #expect(ob.visibleChanges.isEmpty)
        #expect(ob.change(forLocalEntityId: c.localEntityId) == nil)
    }

    @Test func discardAcknowledgedBecomesTombstone() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        try ack(ob, c)
        try ob.discard(id: c.id)
        #expect(ob.changes[0].isTombstone && ob.changes[0].followUp == .delete)
    }

    @Test func tombstoneFailureIsRemovedInsteadOfShownAsFailed() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.discard(id: c.id)
        try ob.markFailed(id: c.id, reason: .rejected(message: "x"))
        #expect(ob.changes.isEmpty)
    }

    // MARK: retry / reassign / convert

    @Test func retryMovesFailedToPendingOnly() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        #expect(throws: OfflineOutboxError.invalidState) { try ob.retry(id: c.id) }
        try ob.markFailed(id: c.id, reason: .tokenConflict)
        try ob.retry(id: c.id)
        #expect(ob.changes[0].state == .pending)
    }

    @Test func reassignTopicWorksInPendingAndFailed() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTopic(T.topic())
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .meetingArchived)
        try ob.reassignTopic(id: c.id, toMeetingId: "m2")
        #expect(ob.changes[0].state == .pending)
        #expect(ob.changes[0].payload == .topic(T.topic(meeting: "m2")))
        #expect(ob.changes[0].revision == c.revision + 1)
    }

    @Test func reassignTopicRejectsWrongStateKindAndUnsafeId() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTopic(T.topic())
        let todo = try ob.enqueueTodo(T.todo())
        #expect(throws: OfflineOutboxError.invalidState) { try ob.reassignTopic(id: todo.id, toMeetingId: "m2") }
        #expect(throws: OfflineError.self) { try ob.reassignTopic(id: c.id, toMeetingId: "../x") }
        _ = try ob.markInFlight(id: c.id)
        #expect(throws: OfflineOutboxError.invalidState) { try ob.reassignTopic(id: c.id, toMeetingId: "m2") }
    }

    @Test func convertTopicToTodoCreatesNewTokenAndKeepsDependents() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTopic(PendingTopicPayload(meetingId: "m1", title: "T", descriptionHTML: "<p>d</p>",
                                                        isTodo: true, snoozedUntil: "2099-01-01"))
        let dep = try ob.enqueueProgress(T.progress(ref: .local(changeId: c.id)))
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .meetingGone)
        try ob.convertTopicToTodo(id: c.id)
        let u = ob.changes.first { $0.id == c.id }!
        #expect(u.kind == .createTodo)
        #expect(u.clientToken != c.clientToken && UUID(uuidString: u.clientToken) != nil)
        #expect(u.state == .pending)
        #expect(u.payload == .todo(PendingTodoPayload(title: "T", descriptionHTML: "<p>d</p>", snoozedUntil: "2099-01-01",
                                                      dueDate: nil, isPrivate: false)))
        #expect(ob.dependents(of: c.id).map(\.id) == [dep.id])
        #expect(ob.resolve(.local(changeId: c.id)) == .waitingForParent(c.id))
    }

    @Test func convertTopicToTodoRejectsInFlightAndTodos() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTopic(T.topic())
        let todo = try ob.enqueueTodo(T.todo())
        #expect(throws: OfflineOutboxError.invalidState) { try ob.convertTopicToTodo(id: todo.id) }
        _ = try ob.markInFlight(id: c.id)
        #expect(throws: OfflineOutboxError.invalidState) { try ob.convertTopicToTodo(id: c.id) }
    }

    // MARK: Sync-Uebergaenge

    @Test func markInFlightReturnsRevisionAndRejectsFailed() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        try ob.updatePayload(id: c.id, .todo(T.todo("v2")))
        #expect(try ob.markInFlight(id: c.id) == 2)
        try ob.markFailed(id: c.id, reason: .refDone)
        #expect(throws: OfflineOutboxError.invalidState) { _ = try ob.markInFlight(id: c.id) }
    }

    @Test func acknowledgeStoresServerIdObjectAndAlias() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        try ack(ob, c, serverId: "srv_1")
        let u = ob.changes[0]
        if case .acknowledged(let sid, _) = u.state { #expect(sid == "srv_1") } else { Issue.record("nicht acknowledged") }
        #expect(u.acknowledgedObject == .todo(T.serverTodo("srv_1")))
        #expect(ob.alias(forLocalId: c.localEntityId) == "srv_1")
        #expect(ob.visibleChanges.isEmpty)
        #expect(ob.alias(forLocalId: "local-unbekannt") == nil)
    }

    @Test func acknowledgeAfterEditDuringFlightRequestsFollowUp() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.updatePayload(id: c.id, .todo(T.todo("neu")))
        try ob.markAcknowledged(id: c.id, serverId: "s1", object: .todo(T.serverTodo("s1")))
        #expect(ob.changes[0].followUp == .update)
        try ob.clearFollowUp(id: c.id)
        #expect(ob.changes[0].followUp == .none)
    }

    @Test func acknowledgeRejectsUnsafeServerIds() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        for bad in ["", "local-x", "a/b", "../x"] {
            #expect(throws: OfflineError.self) {
                try ob.markAcknowledged(id: c.id, serverId: bad, object: .todo(T.serverTodo("x")))
            }
        }
    }

    @Test func markFailedStoresReasonAndClearsFollowUp() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.updatePayload(id: c.id, .todo(T.todo("neu")))
        try ob.markFailed(id: c.id, reason: .validation(message: "Titel zu lang"))
        #expect(ob.changes[0].state == .failed(.validation(message: "Titel zu lang")))
        #expect(ob.changes[0].followUp == .none)
        #expect(ob.visibleChanges.count == 1)
    }

    @Test func transientFailureReturnsToPendingAndCountsOnlyWhenAsked() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: c.id)
        try ob.markTransientFailure(id: c.id, countAttempt: false)
        #expect(ob.changes[0].state == .pending && ob.changes[0].attemptCount == 0)
        _ = try ob.markInFlight(id: c.id)
        try ob.markTransientFailure(id: c.id, countAttempt: true)
        #expect(ob.changes[0].state == .pending && ob.changes[0].attemptCount == 1)
        #expect(ob.changes[0].lastAttemptAt != nil)
    }

    @Test func completeRemovesAcknowledgedOnly() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        #expect(throws: OfflineOutboxError.invalidState) { try ob.complete(id: c.id) }
        try ack(ob, c)
        try ob.complete(id: c.id)
        #expect(ob.changes.isEmpty)
        #expect(ob.alias(forLocalId: c.localEntityId) == "srv1") // Alias bleibt
    }

    // MARK: resolve

    @Test func resolveCoversAllCases() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        #expect(ob.resolve(.server(refType: "todo", refId: "a")) == .server(refType: "todo", refId: "a"))
        let t = try ob.enqueueTodo(T.todo())
        #expect(ob.resolve(.local(changeId: t.id)) == .waitingForParent(t.id))
        _ = try ob.markInFlight(id: t.id)
        #expect(ob.resolve(.local(changeId: t.id)) == .waitingForParent(t.id))
        try ob.markFailed(id: t.id, reason: .rejected(message: nil))
        #expect(ob.resolve(.local(changeId: t.id)) == .parentFailed(t.id))
        try ob.retry(id: t.id)
        try ack(ob, ob.changes[0], serverId: "srvT")
        #expect(ob.resolve(.local(changeId: t.id)) == .server(refType: "todo", refId: "srvT"))
        try ob.complete(id: t.id)
        #expect(ob.resolve(.local(changeId: t.id)) == .server(refType: "todo", refId: "srvT")) // ueber Alias
        #expect(ob.resolve(.local(changeId: UUID())) == .parentGone)
        let topic = try ob.enqueueTopic(T.topic())
        try ack(ob, topic, serverId: "srvTopic")
        #expect(ob.resolve(.local(changeId: topic.id)) == .server(refType: "topic", refId: "srvTopic"))
    }

    @Test func resolveOfTombstonedParentIsGone() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let t = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: t.id)
        try ob.discard(id: t.id)
        #expect(ob.resolve(.local(changeId: t.id)) == .parentGone)
    }

    // MARK: reconcile

    /// Uhr: Quittierung bei t=1000, Abruf startet bei t=1500, "junge" Quittierung bei t=3000.
    private func reconcileFixture() throws -> (ob: OfflineOutbox, store: UserScopedFileStore, fetchStart: Date,
                                              setClock: (Double) -> Void) {
        let box = ClockBox()
        let (ob, store) = try make(now: { box.now })
        box.now = Date(timeIntervalSince1970: 1_000)
        return (ob, store, Date(timeIntervalSince1970: 1_500), { box.now = Date(timeIntervalSince1970: $0) })
    }

    @Test func reconcileRemovesOldAcknowledgedWithoutFollowUpRegardlessOfServerData() throws {
        let f = try reconcileFixture(); defer { f.store.removeAll() }
        let inData = try f.ob.enqueueTodo(T.todo("enthalten"))
        try ack(f.ob, inData, serverId: "s_in")
        let notInData = try f.ob.enqueueTodo(T.todo("fehlt"))
        try ack(f.ob, notInData, serverId: "s_gone")
        let pending = try f.ob.enqueueTodo(T.todo("pending"))
        f.setClock(3_000)
        let young = try f.ob.enqueueTodo(T.todo("jung"))
        try ack(f.ob, young, serverId: "s_young")

        try f.ob.reconcile(serverTodoIds: ["s_in"], serverTopicIds: [], fetchStartedAt: f.fetchStart)
        let ids = Set(f.ob.changes.map(\.id))
        #expect(!ids.contains(inData.id))
        #expect(!ids.contains(notInData.id))   // followUp none: egal ob in den Serverdaten
        #expect(ids.contains(pending.id))
        #expect(ids.contains(young.id))        // nach Abrufbeginn quittiert
        #expect(try reload(f.store).changes.map(\.id) == f.ob.changes.map(\.id))
    }

    @Test func reconcileKeepsFollowUpWhenServerIdIsPresent() throws {
        let f = try reconcileFixture(); defer { f.store.removeAll() }
        let todo = try f.ob.enqueueTodo(T.todo())
        try ack(f.ob, todo, serverId: "s_t")
        try f.ob.updatePayload(id: todo.id, .todo(T.todo("neu")))
        let topic = try f.ob.enqueueTopic(T.topic())
        _ = try f.ob.markInFlight(id: topic.id)
        try f.ob.markAcknowledged(id: topic.id, serverId: "s_tp", object: .topic(meetingId: "m1", T.serverTopic("s_tp", meeting: "m1")))
        try f.ob.discard(id: topic.id) // Tombstone, followUp delete
        try f.ob.reconcile(serverTodoIds: ["s_t"], serverTopicIds: ["s_tp"], fetchStartedAt: f.fetchStart)
        #expect(f.ob.changes.count == 2)
        #expect(f.ob.changes.first { $0.id == todo.id }?.followUp == .update)
        #expect(f.ob.changes.first { $0.id == topic.id }?.followUp == .delete)
    }

    @Test func reconcileRemovesDeleteFollowUpAndTombstonesWhoseTargetIsGone() throws {
        let f = try reconcileFixture(); defer { f.store.removeAll() }
        let todo = try f.ob.enqueueTodo(T.todo())
        try ack(f.ob, todo, serverId: "s_t")
        try f.ob.discard(id: todo.id)
        let topic = try f.ob.enqueueTopic(T.topic())
        _ = try f.ob.markInFlight(id: topic.id)
        try f.ob.markAcknowledged(id: topic.id, serverId: "s_tp", object: .topic(meetingId: "m1", T.serverTopic("s_tp", meeting: "m1")))
        try f.ob.discard(id: topic.id)
        try f.ob.reconcile(serverTodoIds: [], serverTopicIds: [], fetchStartedAt: f.fetchStart)
        #expect(f.ob.changes.isEmpty) // Ziel schon weg = Erfolg
    }

    @Test func reconcileMarksUpdateFollowUpAsRefGoneWhenTargetIsGone() throws {
        let f = try reconcileFixture(); defer { f.store.removeAll() }
        let todo = try f.ob.enqueueTodo(T.todo())
        try ack(f.ob, todo, serverId: "s_t")
        try f.ob.updatePayload(id: todo.id, .todo(T.todo("Text zum Kopieren")))
        try f.ob.reconcile(serverTodoIds: [], serverTopicIds: [], fetchStartedAt: f.fetchStart)
        let c = try #require(f.ob.changes.first)
        #expect(c.state == .failed(.refGone))
        #expect(c.followUp == .none)
        #expect(c.payload == .todo(T.todo("Text zum Kopieren"))) // Text bleibt erhalten
        #expect(f.ob.visibleChanges.count == 1)
    }

    @Test func reconcileDoesNotTouchFollowUpOfEntriesAcknowledgedAfterFetchStart() throws {
        let f = try reconcileFixture(); defer { f.store.removeAll() }
        f.setClock(3_000)
        let todo = try f.ob.enqueueTodo(T.todo())
        try ack(f.ob, todo, serverId: "s_t")
        try f.ob.updatePayload(id: todo.id, .todo(T.todo("neu")))
        try f.ob.reconcile(serverTodoIds: [], serverTopicIds: [], fetchStartedAt: f.fetchStart)
        #expect(f.ob.changes.first?.followUp == .update)
    }

    // MARK: Aliasse

    @Test func aliasesArePersistedAndCappedFIFO() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        var first: PendingChange?
        var last: PendingChange?
        for i in 0..<(OfflineOutbox.maxAliases + 5) {
            let c = try ob.enqueueTodo(T.todo("t\(i)"))
            if i == 0 { first = c }
            last = c
            try ack(ob, c, serverId: "s\(i)")
            try ob.complete(id: c.id)
        }
        #expect(ob.alias(forLocalId: first!.localEntityId) == nil)
        #expect(ob.alias(forLocalId: last!.localEntityId) == "s\(OfflineOutbox.maxAliases + 4)")
        let again = try reload(store)
        #expect(again.alias(forLocalId: last!.localEntityId) == "s\(OfflineOutbox.maxAliases + 4)")
        #expect(again.alias(forLocalId: first!.localEntityId) == nil)
    }

    @Test func deleteStorageRemovesFileAndAliases() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let c = try ob.enqueueTodo(T.todo())
        try ack(ob, c)
        ob.deleteStorage()
        #expect(ob.changes.isEmpty)
        #expect(ob.alias(forLocalId: c.localEntityId) == nil)
        #expect(try store.read(scopeKey: T.scope.key, fileName: "outbox") == nil)
        #expect(try reload(store).changes.isEmpty)
    }

    @Test func deleteStorageLeavesNeighbouringFilesOfTheScopeAlone() async throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let snapshots = OfflineSnapshotStore(store: store)
        let snap = OfflineSnapshot(savedAt: Date(), data: ServerDataSet(meetings: [], todos: [T.serverTodo("a")], themes: []))
        try await snapshots.saveSnapshot(snap, scope: T.scope)
        _ = try ob.enqueueTodo(T.todo())
        ob.deleteStorage()
        #expect(snapshots.loadSnapshot(scope: T.scope)?.data.todos.count == 1)
        // Scope-Loeschen (Nutzerwechsel) ist eine eigene Funktion des Snapshot-Stores.
        snapshots.removeScope(T.scope)
        #expect(snapshots.loadSnapshot(scope: T.scope) == nil)
    }

    @Test func kindRefTypeIsCentral() {
        #expect(PendingChangeKind.createTodo.refType == "todo")
        #expect(PendingChangeKind.createTopic.refType == "topic")
        #expect(PendingChangeKind.createProgressEntry.refType == "progress")
    }

    // MARK: Abfragen / Callbacks

    @Test func onChangeFiresPerMutation() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        var n = 0
        ob.onChange = { n += 1 }
        let c = try ob.enqueueTodo(T.todo())
        try ob.updatePayload(id: c.id, .todo(T.todo("x")))
        #expect(n == 2)
    }

    @Test func localEntityLookupAndLocalObjects() throws {
        let (ob, store) = try make(); defer { store.removeAll() }
        let t = try ob.enqueueTodo(PendingTodoPayload(title: "T", descriptionHTML: "<p>x</p>", snoozedUntil: "2099-01-01",
                                                      dueDate: "2099-02-02", isPrivate: true))
        #expect(ob.change(forLocalEntityId: t.localEntityId)?.id == t.id)
        #expect(OfflineIds.isLocal(t.localEntityId))
        let item = t.localTodoItem()!
        #expect(item.id == t.localEntityId && item.title == "T" && item.isPrivate && item.dueDate == "2099-02-02")
        #expect(t.localTopic() == nil)
        let tp = try ob.enqueueTopic(T.topic("Th"))
        #expect(tp.localTopic()?.meetingId == "m1")
        let pr = try ob.enqueueProgress(T.progress(ref: .local(changeId: t.id), body: "<p>Hallo &amp; Welt</p>"))
        let entry = pr.localProgressEntry(resolvedRef: (refType: "todo", refId: t.localEntityId))!
        #expect(entry.excerpt == "Hallo & Welt" && entry.refId == t.localEntityId && entry.editable)
    }
}
