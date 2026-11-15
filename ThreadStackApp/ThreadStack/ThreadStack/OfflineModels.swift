import Foundation

//  OfflineModels.swift
//  Arbeitspaket P2 (Offline-Modus), Schnittstelle S-6: gemeinsame Offline-Modelle.
//  Nutzersichtbare Texte folgen dem UX-Wortlaut (Konsistenzentscheidung 5).

// MARK: - Scope / Marker / IDs

struct OfflineScope: Codable, Hashable {
    let serverURL: String
    let userId: String

    /// trim + ohne abschliessende "/".
    static func normalize(serverURL: String) -> String {
        var s = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    var key: String { serverURL + "\n" + userId }
}

struct OfflineSessionMarker: Codable, Equatable {
    var schemaVersion = 1
    let user: AppUser
    let serverURL: String
    var biometricProtected: Bool
    let savedAt: Date

    var scope: OfflineScope {
        OfflineScope(serverURL: OfflineScope.normalize(serverURL: serverURL), userId: user.id)
    }
}

enum OfflineIds {
    static let localPrefix = "local-"

    static func isLocal(_ id: String) -> Bool { id.hasPrefix(localPrefix) }

    /// `^[A-Za-z0-9_-]{1,64}$` und nicht lokal. Pflicht vor jedem Pfadaufbau.
    static func isSafeServerId(_ id: String) -> Bool {
        UserScopedFileStore.isSafeFileStem(id) && !isLocal(id)
    }
}

// MARK: - Pending-Aenderungen

enum PendingChangeKind: String, Codable { case createTodo, createTopic, createProgressEntry }

struct PendingTodoPayload: Codable, Equatable {
    var title: String
    var descriptionHTML: String
    var snoozedUntil: String?
    var dueDate: String?
    var isPrivate: Bool
}

struct PendingTopicPayload: Codable, Equatable {
    var meetingId: String
    var title: String
    var descriptionHTML: String
    var isTodo: Bool
    var snoozedUntil: String?
}

enum PendingRef: Codable, Equatable {
    case server(refType: String, refId: String)
    case local(changeId: UUID)
}

struct PendingProgressPayload: Codable, Equatable {
    var ref: PendingRef
    var bodyHTML: String
    var source: String
}

enum PendingPayload: Codable, Equatable {
    case todo(PendingTodoPayload)
    case topic(PendingTopicPayload)
    case progress(PendingProgressPayload)
}

enum PendingFailureReason: Codable, Equatable {
    case meetingGone, meetingArchived, refGone, refDone
    case validation(message: String)
    case tokenConflict
    case rejected(message: String?)

    var userMessage: String {
        switch self {
        case .meetingGone:
            return "Das Meeting existiert nicht mehr. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo."
        case .meetingArchived:
            return "Das Meeting wurde inzwischen archiviert. Ordne das Thema einem anderen Meeting zu oder übernimm es als Todo."
        case .refGone:
            return "Das zugehörige Vorhaben existiert nicht mehr. Kopiere den Text, falls du ihn behalten willst."
        case .refDone:
            return "Das Vorhaben wurde inzwischen erledigt. Kopiere den Text, falls du ihn behalten willst."
        case .validation(let m):
            var detail = m.trimmingCharacters(in: .whitespacesAndNewlines)
            while detail.hasSuffix(".") { detail.removeLast() }
            if detail.isEmpty { return "Der Server hat den Eintrag abgelehnt. Bitte bearbeite den Eintrag und sende ihn erneut." }
            return "Der Server hat den Eintrag abgelehnt: \(detail). Bitte bearbeite den Eintrag und sende ihn erneut."
        case .tokenConflict:
            return "Der Eintrag konnte nicht eindeutig zugeordnet werden. Bitte erneut senden."
        case .rejected(let m):
            if let m, !m.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return m }
            return "Der Server hat den Eintrag abgelehnt."
        }
    }
}

extension PendingChangeKind {
    /// Server-refType der angelegten Entitaet: "todo" / "topic" / "progress".
    var refType: String {
        switch self {
        case .createTodo: return "todo"
        case .createTopic: return "topic"
        case .createProgressEntry: return "progress"
        }
    }
}

enum PendingSyncState: Codable, Equatable {
    case pending
    case inFlight(sentRevision: Int)
    case failed(PendingFailureReason)
    case acknowledged(serverId: String, at: Date)
}

enum PendingFollowUp: String, Codable { case none, update, delete }

enum AcknowledgedObject: Codable, Equatable {
    case todo(TodoItem)
    case topic(meetingId: String, Topic)
    case progressEntry(ProgressEntry)
}

/// Ergebnis von `OfflineOutbox.resolve(_:)`.
enum PendingRefResolution: Equatable {
    case server(refType: String, refId: String)
    case waitingForParent(UUID)
    case parentFailed(UUID)
    case parentGone
}

struct PendingChange: Codable, Equatable, Identifiable {
    let id: UUID
    let seq: Int64
    var clientToken: String
    let capturedAt: Date
    var payload: PendingPayload
    var state: PendingSyncState
    var revision: Int
    var followUp: PendingFollowUp
    /// Verworfen waehrend inFlight/acknowledged; fuer die UI unsichtbar.
    var isTombstone: Bool
    var attemptCount: Int
    var lastAttemptAt: Date?
    var acknowledgedObject: AcknowledgedObject?

    var kind: PendingChangeKind {
        switch payload {
        case .todo: return .createTodo
        case .topic: return .createTopic
        case .progress: return .createProgressEntry
        }
    }

    var localEntityId: String { OfflineIds.localPrefix + id.uuidString.lowercased() }

    private var capturedAtISO: String { OfflineDateText.iso(capturedAt) }

    func localTodoItem() -> TodoItem? {
        guard case .todo(let p) = payload else { return nil }
        return TodoItem(id: localEntityId, title: p.title, description: p.descriptionHTML, done: false,
                        result: "", resultDate: "", snoozedUntil: p.snoozedUntil, dueDate: p.dueDate,
                        isPrivate: p.isPrivate, sortOrder: nil, createdAt: capturedAtISO)
    }

    func localTopic() -> Topic? {
        guard case .topic(let p) = payload else { return nil }
        return Topic(id: localEntityId, meetingId: p.meetingId, title: p.title, description: p.descriptionHTML,
                     done: false, result: "", resultDate: "", groupId: nil, isTodo: p.isTodo,
                     snoozedUntil: p.snoozedUntil, sortOrder: nil, createdAt: capturedAtISO)
    }

    /// `resolvedRef`: Typ/ID des Vorhabens (bei lokalem Vorhaben dessen `local-…`-ID).
    func localProgressEntry(resolvedRef: (refType: String, refId: String)) -> ProgressEntry? {
        guard case .progress(let p) = payload else { return nil }
        let plain = OfflineLocalValidation.plainText(fromHTML: p.bodyHTML)
        let excerpt = plain.count > 280 ? String(plain.prefix(280)) + "…" : plain
        return ProgressEntry(id: localEntityId, refType: resolvedRef.refType, refId: resolvedRef.refId,
                             kind: "note", source: p.source, bodyHtml: p.bodyHTML, excerpt: excerpt,
                             createdAt: capturedAtISO, editedAt: nil, gapDaysBefore: 0,
                             showDormancyMarker: false, editable: true)
    }
}

enum OfflineDateText {
    /// ISO-8601 mit Millisekunden (UTC), wie die vom Server gelieferten Zeitstempel.
    static func iso(_ d: Date) -> String {
        formatter.string(from: d)
    }

    /// Einmal angelegt: das Erzeugen eines ISO8601DateFormatters ist teuer (Overlay-Merge ruft das pro Eintrag auf).
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// MARK: - Snapshot

struct ServerDataSet: Codable, Equatable {
    var meetings: [Meeting]
    var todos: [TodoItem]
    var themes: [Theme]
    var contacts: [Contact]?
    var knowledgePages: [KnowledgePage]?
    var contactCategories: [ContactCategory]?
    var stackFrames: [StackFrame]?
    var stackDepth: Int?
}

struct OfflineSnapshot: Codable {
    var schemaVersion = 1
    let savedAt: Date
    let data: ServerDataSet
}

enum SessionProbeResult: Equatable { case valid(AppUser), noSession, unreachable }

// MARK: - Fehler

enum OfflineError: LocalizedError, Equatable {
    case pendingNotSynced, notAvailableOffline, localStorageFailed
    case validation(String)
    case offlineLoginUnavailable, scopeMismatch

    var errorDescription: String? {
        switch self {
        case .pendingNotSynced:
            return "Dieser Eintrag ist noch nicht synchronisiert. Diese Aktion ist erst danach möglich."
        case .notAvailableOffline:
            return "Keine Verbindung – dein Inhalt bleibt im Dialog erhalten. Bitte versuche es erneut, sobald du wieder online bist."
        case .localStorageFailed:
            return "Der Eintrag konnte auf diesem Gerät nicht gespeichert werden. Bitte kopiere den Text und versuche es später erneut."
        case .validation(let m): return m
        case .offlineLoginUnavailable:
            return "Keine Verbindung – Anmeldung erst mit Netz möglich."
        case .scopeMismatch:
            return "Die Änderungen gehören zu einem anderen Konto und werden nicht übertragen."
        }
    }
}

enum OfflineStorageError: Error, Equatable { case writeFailed, corruptQuarantined, unsupportedFutureSchema }

/// Ergaenzung zum Vertrag S-6/S-7: technische Fehler der Outbox, die der
/// Vertrag nicht abdeckt (unbekannte ID, Aktion im aktuellen Zustand unzulaessig).
enum OfflineOutboxError: Error, Equatable { case notFound, invalidState }
