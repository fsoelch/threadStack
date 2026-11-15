import Testing
import Foundation
@testable import ThreadStack

//  Paket P2, S-8: OfflineOverlay.merge (reine Funktion).

@Suite(.serialized)
struct OfflineOverlayTests {
    typealias T = OfflineTestSupport

    private func outbox() throws -> (OfflineOutbox, UserScopedFileStore) {
        let store = T.makeStore()
        return (try OfflineOutbox(scope: T.scope, store: store), store)
    }

    @Test func appendsLocalTodosAndTopicsInSeqOrder() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let t1 = try ob.enqueueTodo(T.todo("eins"))
        let tp = try ob.enqueueTopic(T.topic("Thema", meeting: "m1"))
        let t2 = try ob.enqueueTodo(T.todo("zwei"))
        let r = OfflineOverlay.merge(serverTodos: [T.serverTodo("s1")],
                                     serverMeetings: [T.meeting("m1", topics: [T.serverTopic("tp1", meeting: "m1")])],
                                     changes: ob.changes.reversed())
        #expect(r.todos.map(\.id) == ["s1", t1.localEntityId, t2.localEntityId])
        #expect(r.meetings[0].topics.map(\.id) == ["tp1", tp.localEntityId])
    }

    @Test func includesInFlightAndFailedButNotTombstones() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo("a"))
        let b = try ob.enqueueTodo(T.todo("b"))
        let c = try ob.enqueueTodo(T.todo("c"))
        _ = try ob.markInFlight(id: a.id)
        _ = try ob.markInFlight(id: b.id)
        try ob.markFailed(id: b.id, reason: .refGone)
        _ = try ob.markInFlight(id: c.id)
        try ob.discard(id: c.id) // Tombstone
        let r = OfflineOverlay.merge(serverTodos: [], serverMeetings: [], changes: ob.changes)
        #expect(r.todos.map(\.id) == [a.localEntityId, b.localEntityId])
    }

    @Test func topicOfMissingMeetingIsNotShown() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        _ = try ob.enqueueTopic(T.topic(meeting: "weg"))
        let r = OfflineOverlay.merge(serverTodos: [], serverMeetings: [T.meeting("m1")], changes: ob.changes)
        #expect(r.meetings[0].topics.isEmpty)
        #expect(r.meetings.count == 1)
    }

    @Test func acknowledgedInsertsObjectOnlyIfServerLacksIt() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        let a = try ob.enqueueTodo(T.todo("a"))
        let b = try ob.enqueueTodo(T.todo("b"))
        let tp = try ob.enqueueTopic(T.topic(meeting: "m1"))
        for (c, sid, obj) in [(a, "sa", AcknowledgedObject.todo(T.serverTodo("sa"))),
                              (b, "sb", AcknowledgedObject.todo(T.serverTodo("sb"))),
                              (tp, "stp", AcknowledgedObject.topic(meetingId: "m1", T.serverTopic("stp", meeting: "m1")))] {
            _ = try ob.markInFlight(id: c.id)
            try ob.markAcknowledged(id: c.id, serverId: sid, object: obj)
        }
        // Server kennt "sa" bereits, "sb" und das Thema noch nicht.
        let r = OfflineOverlay.merge(serverTodos: [T.serverTodo("sa")],
                                     serverMeetings: [T.meeting("m1")], changes: ob.changes)
        #expect(r.todos.map(\.id) == ["sa", "sb"])
        #expect(r.meetings[0].topics.map(\.id) == ["stp"])
        // Kennt der Server auch das Thema, wird nichts eingefuegt (kein Duplikat).
        let r2 = OfflineOverlay.merge(serverTodos: [], serverMeetings: [T.meeting("m1", topics: [T.serverTopic("stp", meeting: "m1")])],
                                      changes: ob.changes)
        #expect(r2.meetings[0].topics.map(\.id) == ["stp"])
    }

    @Test func progressChangesDoNotAffectTodosOrMeetings() throws {
        let (ob, store) = try outbox(); defer { store.removeAll() }
        _ = try ob.enqueueProgress(T.progress(ref: .server(refType: "todo", refId: "s1")))
        let r = OfflineOverlay.merge(serverTodos: [T.serverTodo("s1")], serverMeetings: [], changes: ob.changes)
        #expect(r.todos.count == 1)
    }

    @Test func emptyChangesReturnServerDataUnchanged() {
        let todos = [T.serverTodo("a")]
        let meetings = [T.meeting("m")]
        let r = OfflineOverlay.merge(serverTodos: todos, serverMeetings: meetings, changes: [])
        #expect(r.todos == todos && r.meetings == meetings)
    }
}
