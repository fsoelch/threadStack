import Foundation

//  OfflineOverlay.swift
//  Arbeitspaket P2, Schnittstelle S-8: fuehrt Serverdaten und lokal
//  ausstehende Neuanlagen zusammen (reine Funktion, keine Seiteneffekte).
//  Duplikatpruefung ueber Set-Lookups (O(1)), damit grosse Bestaende schnell bleiben.

enum OfflineOverlay {
    static func merge(serverTodos: [TodoItem], serverMeetings: [Meeting], changes: [PendingChange])
        -> (todos: [TodoItem], meetings: [Meeting]) {
        var todos = serverTodos
        var meetings = serverMeetings
        var todoIds = Set(serverTodos.map(\.id))
        var topicIds = Set<String>()
        for m in serverMeetings { for t in m.topics { topicIds.insert(t.id) } }
        var meetingIndex: [String: Int] = [:]
        for (i, m) in meetings.enumerated() { meetingIndex[m.id] = i }

        for change in changes.sorted(by: { $0.seq < $1.seq }) where !change.isTombstone {
            var todoToAdd: TodoItem?
            var topicToAdd: (meetingId: String, topic: Topic)?

            switch change.state {
            case .pending, .inFlight, .failed:
                if let t = change.localTodoItem() { todoToAdd = t }
                else if let t = change.localTopic(), let mid = t.meetingId { topicToAdd = (mid, t) }
            case .acknowledged(let serverId, _):
                switch change.acknowledgedObject {
                case .todo(let t)?:
                    if !todoIds.contains(serverId) && !todoIds.contains(t.id) { todoToAdd = t }
                case .topic(let mid, let t)?:
                    if !topicIds.contains(serverId) && !topicIds.contains(t.id) { topicToAdd = (mid, t) }
                default: break
                }
            }

            if let t = todoToAdd, todoIds.insert(t.id).inserted { todos.append(t) }
            // Existiert das Meeting nicht (mehr), erscheint das Thema nur in der Pending-Liste.
            if let (mid, t) = topicToAdd, let i = meetingIndex[mid], topicIds.insert(t.id).inserted {
                meetings[i].topics.append(t)
            }
        }
        return (todos, meetings)
    }
}
