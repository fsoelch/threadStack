import Foundation
@testable import ThreadStack

//  Gemeinsame Test-Helfer fuer die Offline-Basis (Paket P2).

enum OfflineTestSupport {
    static func tempDir() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("offline-tests-\(UUID().uuidString)", isDirectory: true)
    }

    static func makeStore() -> UserScopedFileStore {
        UserScopedFileStore(baseDirectory: tempDir())
    }

    static let scope = OfflineScope(serverURL: "https://example.test", userId: "u1")

    static func todo(_ title: String = "Todo") -> PendingTodoPayload {
        PendingTodoPayload(title: title, descriptionHTML: "<p>Beschreibung</p>", snoozedUntil: nil,
                           dueDate: nil, isPrivate: false)
    }

    static func topic(_ title: String = "Thema", meeting: String = "m1") -> PendingTopicPayload {
        PendingTopicPayload(meetingId: meeting, title: title, descriptionHTML: "", isTodo: false, snoozedUntil: nil)
    }

    static func progress(ref: PendingRef, body: String = "<p>Stand</p>") -> PendingProgressPayload {
        PendingProgressPayload(ref: ref, bodyHTML: body, source: "manual")
    }

    static func serverTodo(_ id: String, title: String = "Server-Todo") -> TodoItem {
        TodoItem(id: id, title: title, description: "", done: false, result: "", resultDate: "",
                 snoozedUntil: nil, dueDate: nil, isPrivate: false, sortOrder: nil, createdAt: "2026-01-01T00:00:00.000Z")
    }

    static func serverTopic(_ id: String, meeting: String) -> Topic {
        Topic(id: id, meetingId: meeting, title: "Server-Thema", description: "", done: false, result: "",
              resultDate: "", groupId: nil, isTodo: false, snoozedUntil: nil, sortOrder: nil,
              createdAt: "2026-01-01T00:00:00.000Z")
    }

    static func meeting(_ id: String, title: String = "Meeting", topics: [Topic] = [], archived: Bool? = nil) -> Meeting {
        Meeting(id: id, title: title, description: "", participants: [], isRecurring: false,
                recurrencePattern: "", nextDate: "", color: "#4f46e5", sortOrder: nil,
                createdAt: "2026-01-01T00:00:00.000Z", topics: topics, archived: archived, archivedAt: nil)
    }
}
