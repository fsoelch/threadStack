import Foundation

//  OfflineOverlay.swift
//  Arbeitspaket P2, Schnittstelle S-8: fuehrt Serverdaten und lokal
//  ausstehende Neuanlagen zusammen (reine Funktion, keine Seiteneffekte).

enum OfflineOverlay {
    static func merge(serverTodos: [TodoItem], serverMeetings: [Meeting], changes: [PendingChange])
        -> (todos: [TodoItem], meetings: [Meeting]) {
        var todos = serverTodos
        var meetings = serverMeetings
        let serverTodoIds = Set(serverTodos.map(\.id))
        var serverTopicIds = Set<String>()
        for m in serverMeetings { for t in m.topics { serverTopicIds.insert(t.id) } }
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
                    if !serverTodoIds.contains(serverId) && !serverTodoIds.contains(t.id) { todoToAdd = t }
                case .topic(let mid, let t)?:
                    if !serverTopicIds.contains(serverId) && !serverTopicIds.contains(t.id) { topicToAdd = (mid, t) }
                default: break
                }
            }

            if let t = todoToAdd, !todos.contains(where: { $0.id == t.id }) { todos.append(t) }
            // Existiert das Meeting nicht (mehr), erscheint das Thema nur in der Pending-Liste.
            if let (mid, t) = topicToAdd, let i = meetingIndex[mid],
               !meetings[i].topics.contains(where: { $0.id == t.id }) {
                meetings[i].topics.append(t)
            }
        }
        return (todos, meetings)
    }
}
