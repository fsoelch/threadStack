import Testing
import Foundation
@testable import ThreadStack

//  Paket P2: Performance-Nachweise (NFR): Snapshot mit 5.000 Todos + 5.000 Themen,
//  Outbox mit 500 Eintraegen, Overlay-Merge mit 500 gemischten Changes.
//  Messwerte werden mit `print("PERF ...")` ausgegeben.

@MainActor @Suite(.serialized)
struct OfflinePerformanceTests {
    typealias T = OfflineTestSupport

    private func bigData() -> ServerDataSet {
        let todos = (0..<5000).map { T.serverTodo("td\($0)", title: "Todo Nummer \($0)") }
        let topics = (0..<5000).map { T.serverTopic("tp\($0)", meeting: "m1") }
        return ServerDataSet(meetings: [T.meeting("m1", topics: topics)], todos: todos, themes: [])
    }

    @Test func jsonEncodingOfBigSnapshotOnMainActor() throws {
        let snap = OfflineSnapshot(savedAt: Date(), data: bigData())
        let clock = ContinuousClock()
        var bytes = 0
        let t = try clock.measure { bytes = try JSONEncoder().encode(snap).count }
        print("PERF encode 5000+5000 on MainActor: \(t) (\(bytes) bytes)")
        #expect(bytes > 0)
        #expect(t < .seconds(1))
    }

    @Test func snapshotSaveAndLoadWith5000TodosAndTopics() async throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let data = bigData()
        let snapshots = OfflineSnapshotStore(store: store)
        let clock = ContinuousClock()
        let saveStart = clock.now
        try await snapshots.saveSnapshot(OfflineSnapshot(savedAt: Date(), data: data), scope: T.scope)
        let saveTime = clock.now - saveStart
        let loadStart = clock.now
        let loaded = snapshots.loadSnapshot(scope: T.scope)
        let loadTime = clock.now - loadStart
        print("PERF snapshot save(total incl. encode)=\(saveTime) load=\(loadTime)")
        #expect(loaded?.data.todos.count == 5000)
        #expect(loaded?.data.meetings.first?.topics.count == 5000)
        #expect(loadTime < .seconds(1))
        #expect(saveTime < .seconds(1))
    }

    @Test func overlayMergeWith500MixedChangesOver5000Base() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let ob = try OfflineOutbox(scope: T.scope, store: store)
        let data = bigData()
        for i in 0..<500 {
            switch i % 4 {
            case 0: _ = try ob.enqueueTodo(T.todo("p\(i)"))
            case 1: _ = try ob.enqueueTopic(T.topic("t\(i)", meeting: "m1"))
            case 2:
                let c = try ob.enqueueTodo(T.todo("a\(i)"))
                _ = try ob.markInFlight(id: c.id)
                try ob.markAcknowledged(id: c.id, serverId: "ack\(i)", object: .todo(T.serverTodo("ack\(i)")))
            default:
                let c = try ob.enqueueTopic(T.topic("f\(i)", meeting: "m1"))
                _ = try ob.markInFlight(id: c.id)
                try ob.markFailed(id: c.id, reason: .meetingArchived)
            }
        }
        let changes = ob.changes
        let clock = ContinuousClock()
        var result: (todos: [TodoItem], meetings: [Meeting])?
        let t = clock.measure {
            result = OfflineOverlay.merge(serverTodos: data.todos, serverMeetings: data.meetings, changes: changes)
        }
        print("PERF overlay merge 500 changes over 5000+5000: \(t)")
        #expect(result?.todos.count == 5000 + 125 + 125)
        #expect(result?.meetings[0].topics.count == 5000 + 250)
        #expect(t < .milliseconds(100))
    }

    @Test func outboxWithFiveHundredEntriesWritesAndLoadsFast() throws {
        let store = T.makeStore(); defer { store.removeAll() }
        let ob = try OfflineOutbox(scope: T.scope, store: store)
        for i in 0..<499 { _ = try ob.enqueueTodo(T.todo("Eintrag \(i)")) }
        let clock = ContinuousClock()
        var change: PendingChange?
        let writeTime = try clock.measure { change = try ob.enqueueTodo(T.todo("Eintrag 500")) }
        #expect(ob.changes.count == 500)
        var reloaded: OfflineOutbox?
        let loadTime = try clock.measure { reloaded = try OfflineOutbox(scope: T.scope, store: store) }
        print("PERF outbox 500 entries write=\(writeTime) load=\(loadTime)")
        #expect(reloaded?.changes.count == 500 && reloaded?.changes.last == change)
        #expect(writeTime < .milliseconds(300))
        #expect(loadTime < .milliseconds(300))
    }
}
