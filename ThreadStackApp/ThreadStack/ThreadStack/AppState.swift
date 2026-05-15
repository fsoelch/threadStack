import Foundation
import SwiftUI
import Combine

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidURL, network, unauthorized, server(String)
    var errorDescription: String? {
        switch self {
        case .invalidURL:    return "Ungültige Server-URL. Bitte in Einstellungen prüfen."
        case .network:       return "Netzwerkfehler. Server erreichbar?"
        case .unauthorized:  return "Sitzung abgelaufen — bitte neu anmelden."
        case .server(let m): return m
        }
    }
}

// MARK: - AppState

@MainActor
final class AppState: ObservableObject {

    @Published var currentUser: AppUser?
    @Published var meetings:    [Meeting]  = []
    @Published var todos:       [TodoItem] = []
    @Published var themes:      [Theme]    = []
    @Published var isLoading = false

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }

    private let session: URLSession
    private let decoder = JSONDecoder()

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: cfg)
    }

    // MARK: - Core request
    // Body values: use NSNull() to send JSON null; nil entries are excluded.

    private func url(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.hasSuffix("/") { base = String(base.dropLast()) }
        guard !base.isEmpty, let u = URL(string: base + "/api" + path) else { throw APIError.invalidURL }
        return u
    }

    func request<T: Decodable>(_ method: String, _ path: String,
                               body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        if let body, !body.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode >= 400 {
            let msg = (try? decoder.decode([String: String].self, from: data))?["error"]
                      ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
        return try decoder.decode(T.self, from: data)
    }

    private func requestOK(_ method: String, _ path: String,
                           body: [String: Any]? = nil) async throws {
        let _: OKResponse = try await request(method, path, body: body)
    }

    // Convenience: builds a body dict and encodes String? as NSNull for JSON null.
    private static func nullable(_ s: String?) -> Any { s ?? NSNull() }

    // MARK: - Auth

    func checkSession() async throws {
        currentUser = try await request("GET", "/me")
    }

    func login(username: String, password: String) async throws {
        currentUser = try await request("POST", "/login",
                                        body: ["username": username, "password": password])
    }

    func logout() async throws {
        try await requestOK("POST", "/logout")
        currentUser = nil; meetings = []; todos = []; themes = []
    }

    func changePassword(old: String, new newPW: String) async throws {
        try await requestOK("PUT", "/password", body: ["current": old, "next": newPW])
    }

    // MARK: - Load all

    func loadAll() async throws {
        async let m: [Meeting]  = request("GET", "/meetings")
        async let t: [TodoItem] = request("GET", "/todos")
        async let th: [Theme]   = request("GET", "/themes")
        meetings = try await m; todos = try await t; themes = try await th
    }

    // MARK: - Meetings

    func createMeeting(title: String, description: String, participants: [String],
                       color: String, nextDate: String,
                       isRecurring: Bool, recurrencePattern: String) async throws {
        let m: Meeting = try await request("POST", "/meetings", body: [
            "title": title, "description": description, "participants": participants,
            "color": color, "nextDate": nextDate,
            "isRecurring": isRecurring, "recurrencePattern": recurrencePattern
        ])
        meetings.append(m)
    }

    func updateMeeting(id: String, title: String, description: String, participants: [String],
                       color: String, nextDate: String,
                       isRecurring: Bool, recurrencePattern: String) async throws {
        try await requestOK("PUT", "/meetings/\(id)", body: [
            "title": title, "description": description, "participants": participants,
            "color": color, "nextDate": nextDate,
            "isRecurring": isRecurring, "recurrencePattern": recurrencePattern
        ])
        if let i = meetings.firstIndex(where: { $0.id == id }) {
            meetings[i].title = title; meetings[i].description = description
            meetings[i].participants = participants; meetings[i].color = color
            meetings[i].nextDate = nextDate; meetings[i].isRecurring = isRecurring
            meetings[i].recurrencePattern = recurrencePattern
        }
    }

    func deleteMeeting(_ id: String) async throws {
        try await requestOK("DELETE", "/meetings/\(id)")
        meetings.removeAll { $0.id == id }
    }

    func advanceDate(_ id: String) async throws {
        guard let m = meetings.first(where: { $0.id == id }),
              let d = m.nextDateParsed else { return }
        var next = d
        switch m.recurrencePattern {
        case "weekly":   next = Calendar.current.date(byAdding: .day,   value: 7,  to: d)!
        case "biweekly": next = Calendar.current.date(byAdding: .day,   value: 14, to: d)!
        case "monthly":  next = Calendar.current.date(byAdding: .month, value: 1,  to: d)!
        default: break
        }
        let s = toAPIDate(next)
        try await requestOK("PUT", "/meetings/\(id)", body: ["nextDate": s])
        if let i = meetings.firstIndex(where: { $0.id == id }) { meetings[i].nextDate = s }
    }

    // MARK: - Topics

    func createTopic(meetingId: String, title: String, description: String,
                     isTodo: Bool = false, snoozedUntil: String? = nil) async throws {
        var body: [String: Any] = ["title": title, "description": description, "isTodo": isTodo]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        let t: Topic = try await request("POST", "/meetings/\(meetingId)/topics", body: body)
        if let i = meetings.firstIndex(where: { $0.id == meetingId }) { meetings[i].topics.append(t) }
    }

    func updateTopic(meetingId: String, id: String,
                     title: String, description: String,
                     done: Bool, result: String, resultDate: String,
                     isTodo: Bool, snoozedUntil: String?) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: [
            "title": title, "description": description, "done": done,
            "result": result, "resultDate": resultDate,
            "isTodo": isTodo, "snoozedUntil": Self.nullable(snoozedUntil)
        ])
        updateTopicInState(meetingId: meetingId, id: id) { t in
            t.title = title; t.description = description; t.done = done
            t.result = result; t.resultDate = resultDate
            t.isTodo = isTodo; t.snoozedUntil = snoozedUntil
        }
    }

    func deleteTopic(meetingId: String, id: String) async throws {
        try await requestOK("DELETE", "/meetings/\(meetingId)/topics/\(id)")
        let fresh: [Meeting] = try await request("GET", "/meetings")
        meetings = fresh
    }

    func completeTopic(meetingId: String, id: String, result: String, resultDate: String) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: [
            "done": true, "result": result, "resultDate": resultDate
        ])
        updateTopicInState(meetingId: meetingId, id: id) { t in
            t.done = true; t.result = result; t.resultDate = resultDate
        }
    }

    func reopenTopic(meetingId: String, id: String) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: ["done": false])
        updateTopicInState(meetingId: meetingId, id: id) { $0.done = false }
    }

    func shareTopic(meetingId: String, id: String, targetMeetingId: String) async throws {
        try await requestOK("POST", "/meetings/\(meetingId)/topics/\(id)/share",
                            body: ["targetMeetingId": targetMeetingId])
        let fresh: [Meeting] = try await request("GET", "/meetings")
        meetings = fresh
    }

    func moveTopic(meetingId: String, id: String, targetMeetingId: String?) async throws {
        var body: [String: Any] = [:]
        if let t = targetMeetingId { body["targetMeetingId"] = t }
        try await requestOK("POST", "/meetings/\(meetingId)/topics/\(id)/move", body: body)
        async let m: [Meeting]  = request("GET", "/meetings")
        async let t: [TodoItem] = request("GET", "/todos")
        meetings = try await m; todos = try await t
    }

    func toggleTopicTodo(meetingId: String, id: String) async throws {
        guard let t = getTopic(meetingId: meetingId, id: id) else { return }
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)", body: ["isTodo": !t.isTodo])
        updateTopicInState(meetingId: meetingId, id: id) { $0.isTodo = !$0.isTodo }
    }

    func snoozeTopic(meetingId: String, id: String, until: String?) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/\(id)",
                            body: ["snoozedUntil": Self.nullable(until)])
        updateTopicInState(meetingId: meetingId, id: id) { $0.snoozedUntil = until }
    }

    func reorderTopics(meetingId: String, ids: [String]) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/reorder", body: ["ids": ids])
    }

    // MARK: - Todos

    func createTodo(title: String, description: String, snoozedUntil: String? = nil) async throws {
        var body: [String: Any] = ["title": title, "description": description]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        let t: TodoItem = try await request("POST", "/todos", body: body)
        todos.append(t)
    }

    func updateTodo(id: String, title: String, description: String,
                    done: Bool, result: String, resultDate: String,
                    snoozedUntil: String?) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: [
            "title": title, "description": description, "done": done,
            "result": result, "resultDate": resultDate,
            "snoozedUntil": Self.nullable(snoozedUntil)
        ])
        if let i = todos.firstIndex(where: { $0.id == id }) {
            todos[i].title = title; todos[i].description = description
            todos[i].done = done; todos[i].result = result
            todos[i].resultDate = resultDate; todos[i].snoozedUntil = snoozedUntil
        }
    }

    func completeTodo(id: String, result: String, resultDate: String) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: [
            "done": true, "result": result, "resultDate": resultDate
        ])
        if let i = todos.firstIndex(where: { $0.id == id }) {
            todos[i].done = true; todos[i].result = result; todos[i].resultDate = resultDate
        }
    }

    func reopenTodo(id: String) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: ["done": false])
        if let i = todos.firstIndex(where: { $0.id == id }) { todos[i].done = false }
    }

    func deleteTodo(id: String) async throws {
        try await requestOK("DELETE", "/todos/\(id)")
        todos.removeAll { $0.id == id }
    }

    func moveTodo(id: String, targetMeetingId: String) async throws {
        try await requestOK("POST", "/todos/\(id)/move", body: ["targetMeetingId": targetMeetingId])
        async let m: [Meeting]  = request("GET", "/meetings")
        async let t: [TodoItem] = request("GET", "/todos")
        meetings = try await m; todos = try await t
    }

    func snoozeTodo(id: String, until: String?) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: ["snoozedUntil": Self.nullable(until)])
        if let i = todos.firstIndex(where: { $0.id == id }) { todos[i].snoozedUntil = until }
    }

    func reorderTodos(ids: [String]) async throws {
        try await requestOK("PUT", "/todos/reorder", body: ["ids": ids])
    }

    // MARK: - Themes

    func createTheme(title: String, description: String) async throws {
        let th: Theme = try await request("POST", "/themes",
                                          body: ["title": title, "description": description])
        themes.append(th)
    }

    func updateTheme(id: String, title: String, description: String) async throws {
        try await requestOK("PUT", "/themes/\(id)",
                            body: ["title": title, "description": description])
        if let i = themes.firstIndex(where: { $0.id == id }) {
            themes[i].title = title; themes[i].description = description
        }
    }

    func deleteTheme(id: String) async throws {
        try await requestOK("DELETE", "/themes/\(id)")
        themes.removeAll { $0.id == id }
    }

    func addThemeLink(themeId: String, refType: String, refId: String) async throws {
        let link: ThemeLink = try await request("POST", "/themes/\(themeId)/links",
                                                body: ["refType": refType, "refId": refId])
        if let i = themes.firstIndex(where: { $0.id == themeId }) { themes[i].links.append(link) }
    }

    func removeThemeLink(id linkId: String) async throws {
        guard let idx = themes.firstIndex(where: { $0.links.contains(where: { $0.id == linkId }) })
        else { return }
        let themeId = themes[idx].id
        try await requestOK("DELETE", "/themes/\(themeId)/links/\(linkId)")
        themes[idx].links.removeAll { $0.id == linkId }
    }

    func themeLinks(for refId: String) -> [(theme: Theme, link: ThemeLink)] {
        themes.flatMap { th in th.links.filter { $0.refId == refId }.map { (th, $0) } }
    }

    func themeLinksForTheme(themeId: String) -> [(type: String, title: String, meetingId: String?)] {
        guard let theme = themes.first(where: { $0.id == themeId }) else { return [] }
        return theme.links.compactMap { link in
            if link.refType == "topic" {
                for m in meetings {
                    if let t = m.topics.first(where: { $0.id == link.refId }) {
                        return (type: "topic", title: t.title, meetingId: m.id)
                    }
                }
            } else if link.refType == "todo" {
                if let t = todos.first(where: { $0.id == link.refId }) {
                    return (type: "todo", title: t.title, meetingId: nil)
                }
            }
            return nil
        }
    }

    // MARK: - Admin

    func fetchUsers() async throws -> [AdminUser] {
        try await request("GET", "/users")
    }

    func createUser(username: String, password: String, isAdmin: Bool) async throws {
        try await requestOK("POST", "/users", body: [
            "username": username, "password": password,
            "role": isAdmin ? "admin" : "user"
        ])
    }

    func deleteUser(id: String) async throws {
        try await requestOK("DELETE", "/users/\(id)")
    }

    // MARK: - Helpers

    func getTopic(meetingId: String, id: String) -> Topic? {
        meetings.first(where: { $0.id == meetingId })?.topics.first(where: { $0.id == id })
    }

    private func updateTopicInState(meetingId: String, id: String, update: (inout Topic) -> Void) {
        guard let mi = meetings.firstIndex(where: { $0.id == meetingId }),
              let ti = meetings[mi].topics.firstIndex(where: { $0.id == id }) else { return }
        update(&meetings[mi].topics[ti])
    }

    var openTodoCount: Int {
        let personal     = todos.filter { !$0.done && !$0.isSnoozed }.count
        let fromMeetings = meetings.flatMap(\.topics)
                                   .filter { $0.isTodo && !$0.done && !$0.isSnoozed }.count
        return personal + fromMeetings
    }
}
