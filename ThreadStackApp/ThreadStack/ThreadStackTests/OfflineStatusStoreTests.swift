import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-10: OfflineStatusStore (Statusmodell, Zusammenfassungen, Zaehlung).

@MainActor @Suite(.serialized)
struct OfflineStatusStoreTests {
    typealias T = OfflineTestSupport

    private func outbox() throws -> (OfflineOutbox, UserScopedFileStore) {
        let store = T.makeStore()
        return (try OfflineOutbox(scope: T.scope, store: store), store)
    }

    // MARK: Statusmodell

    @Test func defaultsAreOnlineIdleAndIntentsAreInert() async {
        let s = OfflineStatusStore()
        #expect(s.connection == .online && !s.isOffline)
        #expect(s.activity == .idle)
        #expect(s.items.isEmpty && s.unsyncedCount == 0 && s.failedCount == 0)
        #expect(s.dataAsOf == nil && !s.isShowingCachedData && s.storageProblemMessage == nil)
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.retry(UUID()) }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.discard(UUID()) }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.reassignTopic(UUID(), "m") }
        #expect(throws: OfflineError.notAvailableOffline) { try s.intents.convertTopicToTodo(UUID()) }
        #expect(s.intents.dependentsCount(UUID()) == 0)
        #expect(s.intents.payload(UUID()) == nil)
        await s.intents.syncNow()
        s.intents.requestReauth()
    }

    @Test func isOfflineFollowsConnection() {
        let s = OfflineStatusStore()
        s.connection = .offline(.noNetwork)
        #expect(s.isOffline)
        s.connection = .offline(.serverUnreachable)
        #expect(s.isOffline)
        s.connection = .online
        #expect(!s.isOffline)
    }

    @Test func refreshBuildsSortedSummariesAndCounts() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo("Erstes"))
        let b = try ob.enqueueTopic(T.topic("Thema", meeting: "m1"))
        let c = try ob.enqueueTodo(T.todo("Drittes"))
        _ = try ob.markInFlight(id: b.id)
        _ = try ob.markInFlight(id: c.id)
        try ob.markFailed(id: c.id, reason: .refGone)
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [T.meeting("m1", title: "Montag")], todos: [])
        #expect(s.items.map(\.id) == [a.id, b.id, c.id])
        #expect(s.items[0].status == .pending)
        #expect(s.items[1].status == .syncing && s.items[1].contextText == "Montag")
        #expect(s.items[2].status == .failed(message: PendingFailureReason.refGone.userMessage))
        #expect(s.unsyncedCount == 3 && s.failedCount == 1)
        #expect(s.summary(forEntityId: a.localEntityId)?.title == "Erstes")
        #expect(s.summary(forEntityId: "local-unbekannt") == nil)
    }

    @Test func acknowledgedAndTombstonedItemsAreNotListed() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: a.id)
        try ob.markAcknowledged(id: a.id, serverId: "s1", object: .todo(T.serverTodo("s1")))
        let b = try ob.enqueueTodo(T.todo())
        _ = try ob.markInFlight(id: b.id)
        try ob.discard(id: b.id)
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [])
        #expect(s.items.isEmpty)
    }

    @Test func progressItemsAreMatchedByRefAndWaitingOnParentIsBlocked() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let p = try ob.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "s1"), body: "<p>Direkt</p>"))
        let parent = try ob.enqueueTodo(T.todo("Neues Vorhaben"))
        let dep = try ob.enqueueProgress(T.progress(ref: .local(changeId: parent.id), body: "<p>Danach</p>"))
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [T.serverTodo("s1", title: "Altes Todo")])
        #expect(s.pendingProgress(refType: "todo", refId: "s1").map(\.id) == [p.id])
        #expect(s.pendingProgress(refType: "todo", refId: "s1").first?.contextText == "Altes Todo")
        let depItem = try #require(s.items.first { $0.id == dep.id })
        #expect(depItem.status == .blocked(message: "Wird nach dem Vorhaben übertragen."))
        #expect(s.pendingProgress(refType: "todo", refId: parent.localEntityId).map(\.id) == [dep.id])
        // Elternteil scheitert -> Hinweis nennt den Titel.
        _ = try ob.markInFlight(id: parent.id)
        try ob.markFailed(id: parent.id, reason: .rejected(message: nil))
        s.refresh(from: ob, meetings: [], todos: [])
        let after = try #require(s.items.first { $0.id == dep.id })
        #expect(after.status == .blocked(message: "Wartet auf 'Neues Vorhaben', der fehlgeschlagen ist."))
    }

    @Test func fullTextContainsTitleAndPlainDescription() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        _ = try ob.enqueueTodo(PendingTodoPayload(title: "T", descriptionHTML: "<p>Zeile <b>eins</b></p>",
                                                  snoozedUntil: nil, dueDate: nil, isPrivate: false))
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [])
        #expect(s.items[0].fullText == "T\n\nZeile eins")
    }

    @Test func outstandingCountExcludesFailed() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        _ = try ob.enqueueTodo(T.todo("a"))
        let b = try ob.enqueueTodo(T.todo("b"))
        _ = try ob.markInFlight(id: b.id)
        try ob.markFailed(id: b.id, reason: .refGone)
        let s = OfflineStatusStore()
        s.refresh(from: ob, meetings: [], todos: [])
        #expect(s.unsyncedCount == 2 && s.failedCount == 1 && s.outstandingCount == 1)
    }

    @Test func connectionReasonsExist() {
        let s = OfflineStatusStore()
        s.connection = .offline(OfflineReason.noNetwork)
        #expect(s.isOffline)
    }
}
