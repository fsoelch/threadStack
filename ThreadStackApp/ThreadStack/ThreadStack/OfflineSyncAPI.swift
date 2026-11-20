import Foundation

//  OfflineSyncAPI.swift
//  Arbeitspaket P3 (Offline-Modus), Schnittstelle S-11: HTTP-Schicht des Sync-Motors.
//  Klassifiziert JEDE Antwort einheitlich in success / alreadyGone / rejected /
//  transient / unauthorized (Klassifizierungstabelle des Vertrags).
//
//  Datenschutz/Logging: Diese Datei loggt nichts (keine Titel, Texte, Tokens).

/// Vom AppState (P7) gelieferte Transportschicht. `send` darf bei Transportfehlern
/// werfen; HTTP-Fehlerstatus liefert es als normale Antwort zurueck. Es nutzt KEIN
/// transparentes 401-Auto-Renewal (Architekturentscheidung, Story 10).
/// Pfade sind relativ zu `/api` (wie bei `AppState.request`), z.B. "/todos".
struct OfflineHTTPOperations {
    var send: (_ method: String, _ path: String, _ body: [String: Any]?, _ timeout: TimeInterval) async throws -> (Data, HTTPURLResponse)
    var progressEntriesPath: (_ refType: String, _ refId: String) -> String
}

enum SyncCallResult<T> {
    case success(T)
    case alreadyGone
    case rejected(PendingFailureReason)
    case transient(retryAfter: TimeInterval?)
    case unauthorized
}

enum SyncCapabilityResult: Equatable { case supported, unsupported, transient, unauthorized }

final class OfflineSyncAPI {
    static let requestTimeout: TimeInterval = 15
    static let rateLimitMinimumRetry: TimeInterval = 60
    /// Obergrenze fuer ein vom Server geliefertes Retry-After (Schutz vor absurden Werten).
    static let maxRetryAfter: TimeInterval = 3600

    private let http: OfflineHTTPOperations

    init(http: OfflineHTTPOperations) {
        self.http = http
    }

    // MARK: Operationen

    private enum Op { case createTodo, createTopic, createProgress, followUp }

    private struct ErrorBody { let code: String?; let message: String? }

    private struct ProgressEntryResponse: Decodable { let entry: ProgressEntry }

    func capabilities() async -> SyncCapabilityResult {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await http.send("GET", "/sync/capabilities", nil, Self.requestTimeout)
        } catch {
            return Self.isUnauthorizedError(error) ? .unauthorized : .transient
        }
        let status = response.statusCode
        if status == 401 { return Self.jsonObject(data) != nil ? .unauthorized : .transient }
        if status == 404 { return .unsupported }
        guard status == 200, let obj = Self.jsonObject(data) else { return .transient }
        if let ic = obj["idempotentCreate"] as? [String: Any], let v = ic["version"] as? Int, v >= 1 {
            return .supported
        }
        return .unsupported
    }

    func createTodo(_ p: PendingTodoPayload, clientToken: String, capturedAt: Date) async -> SyncCallResult<TodoItem> {
        var body: [String: Any] = ["title": p.title, "description": p.descriptionHTML, "isPrivate": p.isPrivate,
                                   "clientToken": clientToken, "capturedAt": Self.isoString(capturedAt)]
        if let s = p.snoozedUntil { body["snoozedUntil"] = s }
        if let d = p.dueDate { body["dueDate"] = d }
        return await call("POST", "/todos", body, .createTodo) { try JSONDecoder().decode(TodoItem.self, from: $0) }
    }

    func createTopic(_ p: PendingTopicPayload, clientToken: String, capturedAt: Date) async -> SyncCallResult<Topic> {
        guard OfflineIds.isSafeServerId(p.meetingId) else { return .rejected(.rejected(message: nil)) }
        var body: [String: Any] = ["title": p.title, "description": p.descriptionHTML, "isTodo": p.isTodo,
                                   "clientToken": clientToken, "capturedAt": Self.isoString(capturedAt)]
        if let s = p.snoozedUntil { body["snoozedUntil"] = s }
        return await call("POST", "/meetings/\(p.meetingId)/topics", body, .createTopic) {
            try JSONDecoder().decode(Topic.self, from: $0)
        }
    }

    func addProgressEntry(refType: String, refId: String, bodyHTML: String, source: String,
                          clientToken: String) async -> SyncCallResult<ProgressEntry> {
        guard refType == "todo" || refType == "topic", OfflineIds.isSafeServerId(refId) else {
            return .rejected(.rejected(message: nil))
        }
        let path = http.progressEntriesPath(refType, refId)
        let body: [String: Any] = ["body": bodyHTML, "source": source, "clientToken": clientToken]
        return await call("POST", path, body, .createProgress) {
            try JSONDecoder().decode(ProgressEntryResponse.self, from: $0).entry
        }
    }

    func updateTodo(serverId: String, _ p: PendingTodoPayload) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(serverId) else { return .rejected(.rejected(message: nil)) }
        let body: [String: Any] = ["title": p.title, "description": p.descriptionHTML, "isPrivate": p.isPrivate,
                                   "snoozedUntil": Self.nullable(p.snoozedUntil), "dueDate": Self.nullable(p.dueDate)]
        return await callVoid("PUT", "/todos/\(serverId)", body)
    }

    func updateTopic(meetingId: String, serverId: String, _ p: PendingTopicPayload) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(meetingId), OfflineIds.isSafeServerId(serverId) else {
            return .rejected(.rejected(message: nil))
        }
        let body: [String: Any] = ["title": p.title, "description": p.descriptionHTML, "isTodo": p.isTodo,
                                   "snoozedUntil": Self.nullable(p.snoozedUntil)]
        return await callVoid("PUT", "/meetings/\(meetingId)/topics/\(serverId)", body)
    }

    func deleteTodo(serverId: String) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(serverId) else { return .rejected(.rejected(message: nil)) }
        return await callVoid("DELETE", "/todos/\(serverId)", nil)
    }

    func deleteTopic(meetingId: String, serverId: String) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(meetingId), OfflineIds.isSafeServerId(serverId) else {
            return .rejected(.rejected(message: nil))
        }
        return await callVoid("DELETE", "/meetings/\(meetingId)/topics/\(serverId)", nil)
    }

    // Ergaenzung zum Vertrag (additiv): Nachreichen von Bearbeiten/Verwerfen bereits
    // uebertragener Zwischenstaende (Story 7), siehe Abschlussbericht.
    func updateProgressEntry(entryId: String, bodyHTML: String) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(entryId) else { return .rejected(.rejected(message: nil)) }
        return await callVoid("PUT", "/progress/entries/\(entryId)", ["body": bodyHTML])
    }

    func deleteProgressEntry(entryId: String) async -> SyncCallResult<Void> {
        guard OfflineIds.isSafeServerId(entryId) else { return .rejected(.rejected(message: nil)) }
        return await callVoid("DELETE", "/progress/entries/\(entryId)", nil)
    }

    // MARK: Aufruf + Klassifizierung

    private func callVoid(_ method: String, _ path: String, _ body: [String: Any]?) async -> SyncCallResult<Void> {
        await call(method, path, body, .followUp) { _ in () }
    }

    private func call<T>(_ method: String, _ path: String, _ body: [String: Any]?, _ op: Op,
                         decode: (Data) throws -> T) async -> SyncCallResult<T> {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await http.send(method, path, body, Self.requestTimeout)
        } catch {
            // Transportfehler, Timeout, Abbruch: nie fachlich bewerten, Wiederholung ist idempotent.
            return Self.isUnauthorizedError(error) ? .unauthorized : .transient(retryAfter: nil)
        }
        return Self.classify(status: response.statusCode, data: data, response: response, op: op, decode: decode)
    }

    private static func classify<T>(status: Int, data: Data, response: HTTPURLResponse, op: Op,
                                    decode: (Data) throws -> T) -> SyncCallResult<T> {
        if (200..<300).contains(status) {
            switch op {
            case .followUp:
                // Ein 200 ohne JSON-Objekt (Captive Portal) ist kein Beweis fuer Erfolg.
                guard jsonObject(data) != nil, let value = try? decode(data) else { return .transient(retryAfter: nil) }
                return .success(value)
            default:
                guard status == 200 || status == 201, let value = try? decode(data) else {
                    return .transient(retryAfter: nil)
                }
                return .success(value)
            }
        }
        if status == 429 {
            let header = response.value(forHTTPHeaderField: "Retry-After")
                .flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) } ?? 0
            return .transient(retryAfter: min(maxRetryAfter, max(rateLimitMinimumRetry, header)))
        }
        if status == 408 || status >= 500 { return .transient(retryAfter: nil) }
        // Ab hier 3xx/4xx: nur ein JSON-Objekt als Body gilt als Antwort UNSERES Servers.
        guard status >= 400, let obj = jsonObject(data) else { return .transient(retryAfter: nil) }
        let err = ErrorBody(code: obj["code"] as? String, message: (obj["error"] as? String).flatMap(nonEmpty))

        switch status {
        case 401:
            return .unauthorized
        case 410:
            if err.code == "CLIENT_TOKEN_TARGET_GONE" { return .alreadyGone }
            return .rejected(.rejected(message: err.message))
        case 404:
            if op == .followUp { return .alreadyGone }
            if err.code == "ref_not_found" { return .rejected(.refGone) }
            switch op {
            case .createTopic: return .rejected(.meetingGone)
            case .createProgress: return .rejected(.rejected(message: err.message))
            default: return .rejected(.rejected(message: nil))
            }
        case 409:
            switch err.code {
            case "ARCHIVED_READONLY": return .rejected(.meetingArchived)
            case "ref_done": return .rejected(.refDone)
            case "CLIENT_TOKEN_CONFLICT": return .rejected(.tokenConflict)
            default: return .rejected(.rejected(message: err.message))
            }
        case 400:
            if err.code == "invalid_client_token" || err.code == "INVALID_CLIENT_TOKEN" { return .rejected(.tokenConflict) }
            return .rejected(.validation(message: err.message ?? "Die Eingabe wurde vom Server nicht akzeptiert."))
        default:
            return .rejected(.rejected(message: err.message))
        }
    }

    // MARK: Helfer

    nonisolated private static func nonEmpty(_ s: String) -> String? {
        s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
    }

    private static func jsonObject(_ data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func nullable(_ s: String?) -> Any { s ?? NSNull() }

    private static func isUnauthorizedError(_ error: Error) -> Bool {
        if let api = error as? APIError, case .unauthorized = api { return true }
        return false
    }

    /// ISO-8601 mit `.withInternetDateTime` (Vertrag); Formatter einmal angelegt (Erzeugen ist teuer).
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func isoString(_ date: Date) -> String { isoFormatter.string(from: date) }
}
