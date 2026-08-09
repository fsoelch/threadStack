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

// v1.1: structured AI error preserving HTTP status + code (402/409/422/428/503)
struct APIAIError: LocalizedError {
    let status:  Int
    let message: String
    let code:    String?
    let detail:  AIErrorDetail?
    var errorDescription: String? { message }
    var needsConfirmation: Bool { status == 428 || code == "confirmation_required" }
    var budgetExceeded:    Bool { status == 402 || code == "budget_exceeded" }
}

// MARK: - AppState

@MainActor
final class AppState: ObservableObject {

    @Published var currentUser: AppUser?
    @Published var meetings:    [Meeting]  = []
    @Published var todos:       [TodoItem] = []
    @Published var themes:      [Theme]    = []
    @Published var knowledgePages: [KnowledgePage] = []
    @Published var contacts:    [Contact]  = []
    @Published var isLoading = false

    // v1.1 Phase 2: Stack
    @Published var stackFrames: [StackFrame] = []
    @Published var stackDepth:  Int          = 0

    // v1.1 Phase 1+3: AI
    @Published var aiSettings:   AISettings?
    @Published var driftIds:     Set<String> = []
    @Published var cmiByMeeting: [String: CMIContent] = [:]

    // App-Lock (Face ID / Touch ID)
    @Published var isLocked: Bool = false
    @Published var hasStoredCredentials: Bool = Keychain.hasStoredCredentials

    // Refresh state
    @Published var isRefreshing: Bool = false
    @Published var lastRefreshAt: Date? = nil
    private var refreshTimer: Timer?
    private let autoRefreshInterval: TimeInterval = 60   // Sekunden

    // MARK: - Graph (Story B9)

    @Published var graphNodes: [GraphNode] = []
    @Published var graphEdges: [GraphEdge] = []
    @Published var graphSchema: GraphSchema = GraphSchema()
    @Published var graphStats: GraphStats = GraphStats()
    @Published var graphIsLoading = false
    /// Set when the last load failed but a cached snapshot could be shown instead.
    @Published var graphIsOffline = false
    /// User-facing error text when neither a live load nor a cache was available.
    @Published var graphError: String?
    @Published var graphLastLoadedAt: Date?

    private lazy var graphPositionSync: GraphPositionSync = {
        let sync = GraphPositionSync()
        sync.onFlush = { [weak self] moves in
            try await self?.savePositions(moves)
        }
        sync.onError = { [weak self] error in
            self?.graphPositionSaveError = error.localizedDescription
        }
        return sync
    }()
    /// Dezenter Hinweis, dass die letzte Positions-Speicherung fehlgeschlagen ist
    /// (Position bleibt lokal sichtbar, Wiederholung folgt automatisch).
    @Published var graphPositionSaveError: String?
    /// Set by the Graph view's node "Öffnen" action, consumed by `ContentView`
    /// to switch to the matching existing detail view.
    @Published var graphNavigationRequest: GraphNavigationTarget?

    var aiIsActive: Bool { aiSettings?.isActive ?? false }
    func aiFeatureEnabled(_ keyPath: KeyPath<AIFeatures, Bool>) -> Bool {
        guard aiIsActive, let f = aiSettings?.features_enabled else { return false }
        return f[keyPath: keyPath]
    }

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

    // v1.1: AI-aware request that surfaces 402/409/422/428/503 via APIAIError.
    func aiRequest<T: Decodable>(_ method: String, _ path: String,
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
            if let body = try? decoder.decode(AIErrorBody.self, from: data) {
                throw APIAIError(status: http.statusCode, message: body.error,
                                 code: body.code, detail: body.detail)
            }
            let msg = (try? decoder.decode([String: String].self, from: data))?["error"]
                      ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
        return try decoder.decode(T.self, from: data)
    }

    // Convenience: builds a body dict and encodes String? as NSNull for JSON null.
    private static func nullable(_ s: String?) -> Any { s ?? NSNull() }

    // MARK: - Auth

    func checkSession() async throws {
        currentUser = try await request("GET", "/me")
    }

    func login(username: String, password: String, rememberWithBiometry: Bool = false) async throws {
        currentUser = try await request("POST", "/login",
                                        body: ["username": username, "password": password])
        if rememberWithBiometry {
            do {
                try Keychain.save(username: username, password: password)
                hasStoredCredentials = true
            } catch {
                // Speichern fehlgeschlagen ist nicht fatal — Login selbst war erfolgreich
            }
        }
    }

    func logout() async throws {
        stopAutoRefresh()
        try await requestOK("POST", "/logout")
        currentUser = nil; meetings = []; todos = []; themes = []; knowledgePages = []; contacts = []
        stackFrames = []; stackDepth = 0
        driftIds = []; cmiByMeeting = [:]
        clearGraphStateOnLogout()
        // Beim manuellen Logout: stored credentials behalten wir bewusst — der nächste
        // App-Start fragt dann via Face ID nach.
    }

    /// Security requirement (Story B9 / offline cache): the on-disk graph
    /// cache holds the previous user's content and must not survive logout.
    private func clearGraphStateOnLogout() {
        graphNodes = []; graphEdges = []
        graphSchema = GraphSchema(); graphStats = GraphStats()
        graphIsOffline = false; graphError = nil; graphPositionSaveError = nil
        graphLastLoadedAt = nil
        GraphCache.clear()
    }

    /// Entsperrt die App via Biometrie und meldet sich automatisch am Server an.
    /// Wird vom Lock-Screen aufgerufen.
    func unlockAndAutoLogin() async throws {
        let creds = try Keychain.load(prompt: "ThreadStack mit \(Keychain.biometryTypeDescription) entsperren")
        // Erst checken ob Server-Cookie noch gültig ist (vermeidet unnötigen Re-Login)
        if (try? await request("GET", "/me") as AppUser) != nil {
            // Cookie noch da — kein Re-Login nötig
            currentUser = try await request("GET", "/me")
        } else {
            try await login(username: creds.username, password: creds.password)
        }
        isLocked = false
    }

    /// Direkter Server-Re-Login mit gespeicherten Credentials (ohne Biometrie-Prompt).
    /// Nur erfolgreich wenn Keychain seit dem letzten Unlock authentifiziert wurde — sonst wirft Keychain.
    /// Genutzt für transparenten 401-Fallback während die App läuft.
    func tryServerReLogin() async -> Bool {
        guard hasStoredCredentials else { return false }
        do {
            let creds = try Keychain.load(prompt: "Sitzung am Server erneuern")
            try await login(username: creds.username, password: creds.password)
            return true
        } catch {
            return false
        }
    }

    func forgetStoredCredentials() {
        Keychain.clear()
        hasStoredCredentials = false
    }

    func changePassword(old: String, new newPW: String) async throws {
        try await requestOK("PUT", "/password", body: ["current": old, "next": newPW])
    }

    // MARK: - Load all

    func loadAll() async throws {
        async let m:  [Meeting]  = request("GET", "/meetings")
        async let t:  [TodoItem] = request("GET", "/todos")
        async let th: [Theme]    = request("GET", "/themes")
        async let co: [Contact]  = request("GET", "/contacts")
        async let kp: [KnowledgePage] = request("GET", "/knowledge")
        meetings = try await m; todos = try await t; themes = try await th
        contacts = (try? await co) ?? contacts   // contacts ist neu, alte Server tolerieren
        knowledgePages = (try? await kp) ?? knowledgePages // Wissen ist neu, alte Server tolerieren
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
        _ = try await createTopicReturning(meetingId: meetingId, title: title, description: description,
                                            isTodo: isTodo, snoozedUntil: snoozedUntil)
    }

    @discardableResult
    func createTopicReturning(meetingId: String, title: String, description: String,
                     isTodo: Bool = false, snoozedUntil: String? = nil) async throws -> Topic {
        var body: [String: Any] = ["title": title, "description": description, "isTodo": isTodo]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        let t: Topic = try await request("POST", "/meetings/\(meetingId)/topics", body: body)
        if let i = meetings.firstIndex(where: { $0.id == meetingId }) { meetings[i].topics.append(t) }
        return t
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
        NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(id)")
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
        if until == nil { NotificationScheduler.shared.cancel(id: "topic-\(meetingId)-\(id)") }
    }

    func reorderTopics(meetingId: String, ids: [String]) async throws {
        try await requestOK("PUT", "/meetings/\(meetingId)/topics/reorder", body: ["ids": ids])
    }

    // MARK: - Todos

    func createTodo(title: String, description: String, snoozedUntil: String? = nil, dueDate: String? = nil, isPrivate: Bool = false) async throws {
        _ = try await createTodoReturning(title: title, description: description, snoozedUntil: snoozedUntil, dueDate: dueDate, isPrivate: isPrivate)
    }

    @discardableResult
    func createTodoReturning(title: String, description: String, snoozedUntil: String? = nil, dueDate: String? = nil, isPrivate: Bool = false) async throws -> TodoItem {
        var body: [String: Any] = ["title": title, "description": description, "isPrivate": isPrivate]
        if let s = snoozedUntil { body["snoozedUntil"] = s }
        if let d = dueDate     { body["dueDate"]     = d }
        let t: TodoItem = try await request("POST", "/todos", body: body)
        todos.append(t)
        return t
    }

    func updateTodo(id: String, title: String, description: String,
                    done: Bool, result: String, resultDate: String,
                    snoozedUntil: String?, dueDate: String?, isPrivate: Bool = false) async throws {
        try await requestOK("PUT", "/todos/\(id)", body: [
            "title": title, "description": description, "done": done,
            "result": result, "resultDate": resultDate,
            "snoozedUntil": Self.nullable(snoozedUntil),
            "dueDate": Self.nullable(dueDate),
            "isPrivate": isPrivate
        ])
        if let i = todos.firstIndex(where: { $0.id == id }) {
            todos[i].title = title; todos[i].description = description
            todos[i].done = done; todos[i].result = result
            todos[i].resultDate = resultDate; todos[i].snoozedUntil = snoozedUntil
            todos[i].dueDate = dueDate; todos[i].isPrivate = isPrivate
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
        NotificationScheduler.shared.cancel(id: "todo-\(id)")
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
        if until == nil { NotificationScheduler.shared.cancel(id: "todo-\(id)") }
    }

    func reorderTodos(ids: [String]) async throws {
        try await requestOK("PUT", "/todos/reorder", body: ["ids": ids])
    }

    // MARK: - Themes

    func createTheme(title: String, description: String, parentId: String? = nil) async throws {
        var body: [String: Any] = ["title": title, "description": description]
        if let parentId { body["parentId"] = parentId }
        let th: Theme = try await request("POST", "/themes", body: body)
        themes.append(th)
    }

    func updateTheme(id: String, title: String, description: String) async throws {
        try await requestOK("PUT", "/themes/\(id)",
                            body: ["title": title, "description": description])
        if let i = themes.firstIndex(where: { $0.id == id }) {
            themes[i].title = title; themes[i].description = description
        }
    }

    /// Verschiebt ein Topic unter ein neues Parent (nil = Wurzel).
    func moveTheme(id: String, parentId: String?) async throws {
        try await requestOK("PUT", "/themes/\(id)/move", body: ["parentId": Self.nullable(parentId)])
        if let i = themes.firstIndex(where: { $0.id == id }) { themes[i].parentId = parentId }
    }

    func themeDeletePreview(id: String) async -> ThemeDeletePreview {
        (try? await request("GET", "/themes/\(id)/delete-preview"))
            ?? ThemeDeletePreview(subTopicCount: 0, knowledgePageCount: 0)
    }

    /// cascade=true löscht Unter-Topics und deren Wissen mit; cascade=false stuft Unter-Topics
    /// eine Ebene hoch. Lädt Themes und Wissen danach neu, da sich die Baumstruktur ändert.
    func deleteTheme(id: String, cascade: Bool) async throws {
        try await requestOK("DELETE", "/themes/\(id)?cascade=\(cascade)")
        themes = (try? await request("GET", "/themes")) ?? themes.filter { $0.id != id }
        await loadKnowledgePages()
    }

    func themeChildren(of parentId: String?) -> [Theme] {
        themes.filter { $0.parentId == parentId }
            .sorted { ($0.sortOrder ?? 0) < ($1.sortOrder ?? 0) }
    }

    /// Pfad von der Wurzel bis zum Topic (inklusive), für Breadcrumbs.
    func themeAncestorsPath(_ id: String) -> [Theme] {
        var path: [Theme] = []
        var seen = Set<String>()
        var current = themes.first(where: { $0.id == id })
        while let cur = current, !seen.contains(cur.id) {
            path.insert(cur, at: 0)
            seen.insert(cur.id)
            current = cur.parentId.flatMap { pid in themes.first(where: { $0.id == pid }) }
        }
        return path
    }

    func themeDescendantIds(_ id: String) -> [String] {
        var out: [String] = []
        var stack = [id]
        while let cur = stack.popLast() {
            for c in themeChildren(of: cur) { out.append(c.id); stack.append(c.id) }
        }
        return out
    }

    // MARK: - Knowledge (Wissensseiten, read-only in der App — Bearbeitung nur im Web)

    func loadKnowledgePages() async {
        knowledgePages = (try? await request("GET", "/knowledge")) ?? knowledgePages
    }

    /// Wissen zu einem Topic, optional inkl. Unter-Topics (mit originThemeId/-Title für Herkunfts-Badges).
    func themeKnowledge(id: String, includeDescendants: Bool) async -> [KnowledgePage] {
        (try? await request("GET", "/themes/\(id)/knowledge?includeDescendants=\(includeDescendants)")) ?? []
    }

    /// Todos zu einem Topic, optional inkl. Unter-Topics (mit originThemeId/-Title für Herkunfts-Badges).
    func themeTodos(id: String, includeDescendants: Bool) async -> [TodoItem] {
        (try? await request("GET", "/themes/\(id)/todos?includeDescendants=\(includeDescendants)")) ?? []
    }

    // MARK: - Contacts (Ansprechpartner)

    func loadContacts() async {
        do { contacts = try await request("GET", "/contacts") }
        catch { /* still — alte Server liefern 404, ok */ }
    }

    func createContact(name: String, role: String, email: String, description: String) async throws {
        let c: Contact = try await request("POST", "/contacts",
                                           body: ["name": name, "role": role, "email": email, "description": description])
        contacts.append(c)
    }

    func updateContact(id: String, name: String, role: String, email: String, description: String) async throws {
        let c: Contact = try await request("PUT", "/contacts/\(id)",
                                           body: ["name": name, "role": role, "email": email, "description": description])
        if let i = contacts.firstIndex(where: { $0.id == id }) { contacts[i] = c }
    }

    func deleteContact(id: String) async throws {
        try await requestOK("DELETE", "/contacts/\(id)")
        contacts.removeAll { $0.id == id }
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

    // MARK: - v1.1 Phase 2: Stack

    func loadStack() async {
        do {
            let r: StackResponse = try await request("GET", "/stack")
            stackFrames = r.frames; stackDepth = r.depth
        } catch { stackFrames = []; stackDepth = 0 }
    }

    @discardableResult
    func stackPush(refType: String, refId: String, nextStepNote: String) async throws -> StackPushResponse {
        let r: StackPushResponse = try await request("POST", "/stack/push",
            body: ["refType": refType, "refId": refId, "nextStepNote": nextStepNote])
        await loadStack()
        return r
    }

    @discardableResult
    func stackPop(frameId: String, resolution: String,
                  result: String? = nil, resultDate: String? = nil,
                  snoozedUntil: String? = nil) async throws -> StackPopResponse {
        var body: [String: Any] = ["resolution": resolution]
        if let r = result, !r.isEmpty { body["result"] = r }
        if let d = resultDate, !d.isEmpty { body["resultDate"] = d }
        if let s = snoozedUntil, !s.isEmpty { body["snoozedUntil"] = s }
        let r: StackPopResponse = try await request("POST", "/stack/pop/\(frameId)", body: body)
        await loadStack()
        try? await loadAll()
        return r
    }

    func stackUpdateNote(frameId: String, note: String) async throws {
        try await requestOK("PUT", "/stack/\(frameId)/note", body: ["nextStepNote": note])
        await loadStack()
    }

    /// Hebt ein geparktes Frame zurück an die Spitze (= macht es zum aktiven).
    /// Frame bleibt offen — keine andere Side-Effects am referenzierten Topic/Todo.
    func stackResume(frameId: String) async throws {
        let _: StackPopResponse = try await request("POST", "/stack/pop/\(frameId)",
                                                    body: ["resolution": "resumed"])
        await loadStack()
    }

    func stackHistory(from: String? = nil, to: String? = nil, resolution: String? = nil) async throws -> [StackFrame] {
        var parts: [String] = []
        if let f = from { parts.append("from=\(f)") }
        if let t = to   { parts.append("to=\(t)") }
        if let r = resolution { parts.append("resolution=\(r)") }
        let q = parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
        let r: StackHistoryResponse = try await request("GET", "/stack/history\(q)")
        return r.frames
    }

    // MARK: - v1.1: AI Settings

    func loadAiSettings() async {
        do { aiSettings = try await request("GET", "/ai/settings") }
        catch { aiSettings = nil }
    }

    @discardableResult
    func saveAiSettings(_ body: [String: Any]) async throws -> AISettings {
        let s: AISettings = try await aiRequest("PUT", "/ai/settings", body: body)
        aiSettings = s
        return s
    }

    func removeAiKey() async throws {
        let s: AISettings = try await aiRequest("DELETE", "/ai/settings/key")
        aiSettings = s
    }

    func testAiConnection() async throws -> Bool {
        struct R: Codable { let ok: Bool }
        let r: R = try await aiRequest("POST", "/ai/test")
        return r.ok
    }

    func aiUsage(period: String = "month") async throws -> AIUsageResponse {
        try await aiRequest("GET", "/ai/usage?period=\(period)")
    }

    // MARK: - v1.1: AI features

    func aiBrief(meetingId: String, confirm: Bool = false) async throws -> BriefResponse {
        try await aiRequest("POST", "/ai/meeting/\(meetingId)/brief\(confirm ? "?confirm=true" : "")")
    }

    func aiCapture(meetingId: String, notes: String, confirm: Bool = false) async throws -> CaptureResponse {
        try await aiRequest("POST", "/ai/meeting/\(meetingId)/capture\(confirm ? "?confirm=true" : "")",
                            body: ["notes": notes])
    }

    struct CaptureApplyResponse: Codable {
        struct Created: Codable {
            let topics: [String]?; let todos: [String]?; let theme_links: [String]?; let results: Int?
        }
        let created: Created
    }
    func aiCaptureApply(meetingId: String, suggestions: CaptureSuggestions) async throws {
        let body: [String: Any] = [
            "apply_now": [
                "new_topics":    suggestions.new_topics.map    { ["title": $0.title, "description": $0.description ?? ""] },
                "topic_results": suggestions.topic_results.map { ["topic_id": $0.topic_id, "result": $0.result] },
                "new_todos":     suggestions.new_todos.map     { ["title": $0.title, "description": $0.description ?? ""] },
                "theme_links":   suggestions.theme_links.map   { ["ref_type": $0.ref_type, "ref_id": $0.ref_id, "theme_id": $0.theme_id] }
            ]
        ]
        let _: CaptureApplyResponse = try await aiRequest("POST", "/ai/meeting/\(meetingId)/capture", body: body)
        try? await loadAll()
    }

    func aiResultDraft(refType: String, refId: String, confirm: Bool = false) async throws -> ResultDraftResponse {
        try await aiRequest("POST", "/ai/\(refType)/\(refId)/result-draft\(confirm ? "?confirm=true" : "")")
    }

    func aiReentry(frameId: String, confirm: Bool = false) async throws -> ReentryResponse {
        try await aiRequest("POST", "/ai/stack/\(frameId)/reentry\(confirm ? "?confirm=true" : "")")
    }

    func aiSuggestThemes(refType: String, refId: String, confirm: Bool = false) async throws -> ThemeSuggestionsResponse {
        try await aiRequest("POST", "/ai/\(refType)/\(refId)/suggest-themes\(confirm ? "?confirm=true" : "")")
    }

    func aiDigestCurrent() async throws -> DigestResponse {
        try await aiRequest("GET", "/ai/digest/weekly")
    }
    func aiDigestRegenerate(confirm: Bool = false) async throws -> DigestResponse {
        try await aiRequest("POST", "/ai/digest/weekly\(confirm ? "?confirm=true" : "")")
    }
    func aiDigestArchive() async throws -> [DigestArchiveEntry] {
        let r: DigestArchiveResponse = try await aiRequest("GET", "/ai/digest/archive")
        return r.entries
    }

    func aiCmiLoad(meetingId: String) async {
        guard aiFeatureEnabled(\.cross_meeting) else { cmiByMeeting[meetingId] = nil; return }
        do {
            let r: CMIResponse = try await aiRequest("GET", "/ai/insights/cross-meeting/\(meetingId)")
            cmiByMeeting[meetingId] = r.content
        } catch { cmiByMeeting[meetingId] = nil }
    }
    @discardableResult
    func aiCmiRecompute(meetingId: String, confirm: Bool = false) async throws -> CMIResponse {
        let r: CMIResponse = try await aiRequest("POST", "/ai/insights/cross-meeting/\(meetingId)\(confirm ? "?confirm=true" : "")")
        cmiByMeeting[meetingId] = r.content
        return r
    }
    func aiCmiDismiss(meetingId: String, artifactId: String) async throws {
        try await requestOK("DELETE", "/ai/insights/cross-meeting/\(meetingId)/\(artifactId)")
        cmiByMeeting[meetingId] = nil
    }

    func aiLoadDrift() async {
        guard aiFeatureEnabled(\.drift) else { driftIds = []; return }
        do {
            let r: DriftResponse = try await aiRequest("GET", "/ai/insights/drift")
            driftIds = Set(r.drifted.map(\.topic_id))
        } catch { driftIds = [] }
    }

    // MARK: - Graph (Story B9)

    /// Loads the full graph in a single round trip. Falls back to the last
    /// cached snapshot (see `GraphCache`) if the request fails, so the view
    /// still has something useful to show when offline.
    func loadGraph() async {
        graphIsLoading = true
        defer { graphIsLoading = false }
        do {
            let resp: GraphResponse = try await request("GET", "/graph")
            graphNodes = resp.nodes
            graphEdges = resp.edges
            graphSchema = resp.schema
            graphStats = resp.stats
            graphIsOffline = false
            graphError = nil
            graphLastLoadedAt = Date()
            GraphCache.save(resp)
            // A reconnect might have brought back moves queued while offline.
            await graphPositionSync.flushNow()
        } catch {
            if let cached = GraphCache.load() {
                graphNodes = cached.nodes
                graphEdges = cached.edges
                graphSchema = cached.schema
                graphStats = cached.stats
                graphIsOffline = true
                graphError = nil
            } else {
                graphNodes = []; graphEdges = []
                graphIsOffline = false
                graphError = error.localizedDescription
            }
        }
    }

    /// Queues a single node's new position for debounced (500ms), serialized
    /// persistence. Safe to call repeatedly during a drag; only the final
    /// position per node key survives to be sent.
    func enqueueGraphPositionSave(type: String, id: String, x: Double, y: Double) {
        graphPositionSaveError = nil
        graphPositionSync.enqueue(type: type, id: id, x: x, y: y)
    }

    /// Direct save of a batch of positions. Called by `GraphPositionSync`;
    /// exposed for callers (e.g. tests) that want to bypass debouncing.
    /// Contract: `PATCH /api/graph/positions`, body `{positions: [...]}`, max 500 per request.
    func savePositions(_ moves: [GraphPositionSync.Move]) async throws {
        guard !moves.isEmpty else { return }
        var idx = 0
        while idx < moves.count {
            let end = min(idx + 500, moves.count)
            let chunk = moves[idx..<end]
            let payload: [[String: Any]] = chunk.map {
                ["type": $0.type, "id": $0.id, "x": $0.x, "y": $0.y]
            }
            let _: GraphPositionsSaveResponse = try await request("PATCH", "/graph/positions",
                                                                   body: ["positions": payload])
            idx = end
        }
    }

    // MARK: - Refresh (auto + manual)

    /// Lädt Meetings/Todos/Themes + Stack + Drift neu. Setzt `isRefreshing` für UI-Feedback.
    /// Verschluckt Server-Fehler still (User wird nicht durch jeden Polling-Glitch genervt).
    func refreshAll(showSpinner: Bool = true) async {
        guard currentUser != nil, !isLocked else { return }
        if showSpinner { isRefreshing = true }
        do { try await loadAll() } catch { /* still */ }
        await loadStack()
        await aiLoadDrift()
        resyncSnoozeNotifications()
        lastRefreshAt = Date()
        if showSpinner { isRefreshing = false }
    }

    /// Plant lokale Notifications für alle zeitbasiert schlafenden Todos/Themen
    /// erneut ein — idempotent dank fester Identifier, sichert Re-Sync nach
    /// Neuinstallation, anderem Gerät oder verpassten Terminen bei App-Start.
    private func resyncSnoozeNotifications() {
        for t in todos {
            guard let s = t.snoozedUntil, s.count > 10, let d = parseFlexDate(s), d > Date() else { continue }
            NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: t.title, fireAt: d)
        }
        for m in meetings {
            for t in m.topics {
                guard let s = t.snoozedUntil, s.count > 10, let d = parseFlexDate(s), d > Date() else { continue }
                NotificationScheduler.shared.reschedule(id: "topic-\(m.id)-\(t.id)", title: t.title, fireAt: d)
            }
        }
    }

    /// Startet einen wiederkehrenden Auto-Refresh. Idempotent — vorhandener Timer wird ersetzt.
    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: autoRefreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshAll(showSpinner: false) }
        }
    }

    func stopAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }
}
