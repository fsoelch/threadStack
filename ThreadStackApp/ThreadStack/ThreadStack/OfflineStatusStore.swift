import Foundation
import Combine

//  OfflineStatusStore.swift
//  Arbeitspaket P2, Schnittstelle S-10: gemeinsamer Offline-/Sync-Status fuer
//  alle Views. Die Werte werden vom OfflineCoordinator (P3) bzw. der
//  AppState-Fassade (P7) geschrieben; die Views lesen nur.
//
//  Zaehlung (Festlegung, siehe Abschlussbericht): `unsyncedCount` = ALLE noch
//  nicht uebertragenen sichtbaren Eintraege (pending, syncing, blocked UND
//  failed); `failedCount` ist die Teilmenge der fehlgeschlagenen.
//  "Ausstehend" (ohne fehlgeschlagene) = `unsyncedCount - failedCount`.

enum OfflineReason: Equatable { case noNetwork, serverUnreachable }

enum OfflineConnectionState: Equatable {
    case online
    case offline(OfflineReason)
}

enum OfflinePauseReason: Equatable { case needsReauth, serverUnsupported, userMismatch, storageProblem }

enum OfflineSyncActivity: Equatable {
    case idle
    case syncing(done: Int, total: Int)
    case waitingRetry(until: Date)
    case paused(OfflinePauseReason)
}

enum PendingItemStatus: Equatable {
    case pending, syncing
    case failed(message: String)
    case blocked(message: String)
}

struct PendingItemSummary: Identifiable, Equatable {
    let id: UUID
    let kind: PendingChangeKind
    let title: String
    /// Meetingname bzw. Vorhaben.
    let contextText: String?
    let capturedAt: Date
    let status: PendingItemStatus
    /// `local-…`
    let entityId: String?
    let refType: String?
    let refId: String?
    /// Zum Kopieren.
    let fullText: String
}

struct OfflineIntents {
    var syncNow: () async -> Void = {}
    var retry: (UUID) throws -> Void = { _ in throw OfflineError.notAvailableOffline }
    var discard: (UUID) throws -> Void = { _ in throw OfflineError.notAvailableOffline }
    var dependentsCount: (UUID) -> Int = { _ in 0 }
    var payload: (UUID) -> PendingPayload? = { _ in nil }
    var reassignTopic: (UUID, String) throws -> Void = { _, _ in throw OfflineError.notAvailableOffline }
    var convertTopicToTodo: (UUID) throws -> Void = { _ in throw OfflineError.notAvailableOffline }
    var requestReauth: () -> Void = {}
}

final class OfflineStatusStore: ObservableObject {
    @Published var connection: OfflineConnectionState = .online
    @Published var activity: OfflineSyncActivity = .idle
    @Published var dataAsOf: Date?
    @Published var isShowingCachedData = false
    @Published var items: [PendingItemSummary] = []
    @Published var storageProblemMessage: String?

    var intents = OfflineIntents()

    var isOffline: Bool { connection != .online }
    var unsyncedCount: Int { items.count }
    /// Ausstehend ohne fehlgeschlagene (`unsyncedCount - failedCount`), z.B. fuer "N ausstehend".
    var outstandingCount: Int { unsyncedCount - failedCount }
    var failedCount: Int {
        items.filter { if case .failed = $0.status { return true } else { return false } }.count
    }

    func summary(forEntityId id: String) -> PendingItemSummary? {
        items.first { $0.entityId == id }
    }

    func pendingProgress(refType: String, refId: String) -> [PendingItemSummary] {
        items.filter { $0.kind == .createProgressEntry && $0.refType == refType && $0.refId == refId }
    }

    /// Baut `items` aus der Outbox (sichtbare Eintraege, nach `seq`). Titel von
    /// Meetings/Vorhaben stammen aus den uebergebenen Serverdaten bzw. den
    /// lokal ausstehenden Eintraegen.
    func refresh(from outbox: OfflineOutbox, meetings: [Meeting], todos: [TodoItem]) {
        let next = Self.makeSummaries(outbox: outbox, meetings: meetings, todos: todos)
        if next != items { items = next }
    }

    // MARK: Reine Ableitung (testbar)

    static func makeSummaries(outbox: OfflineOutbox, meetings: [Meeting], todos: [TodoItem]) -> [PendingItemSummary] {
        let meetingTitles = Dictionary(meetings.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        var serverTitles: [String: String] = [:]
        for t in todos { serverTitles["todo:" + t.id] = t.title }
        for m in meetings { for t in m.topics { serverTitles["topic:" + t.id] = t.title } }

        func plain(_ html: String) -> String { OfflineLocalValidation.plainText(fromHTML: html) }
        func preview(_ text: String) -> String {
            let p = plain(text)
            return p.count > 80 ? String(p.prefix(80)) + "…" : p
        }
        func joined(_ title: String, _ html: String) -> String {
            let body = plain(html)
            return body.isEmpty ? title : title + "\n\n" + body
        }

        return outbox.visibleChanges.map { c in
            var title = ""
            var context: String?
            var refType: String?
            var refId: String?
            var fullText = ""
            var blockedMessage: String?

            switch c.payload {
            case .todo(let p):
                title = p.title
                fullText = joined(p.title, p.descriptionHTML)
            case .topic(let p):
                title = p.title
                context = meetingTitles[p.meetingId]
                fullText = joined(p.title, p.descriptionHTML)
            case .progress(let p):
                title = preview(p.bodyHTML)
                fullText = plain(p.bodyHTML)
                // Ein Switch ueber resolve leitet Kontext und Wartehinweis gemeinsam ab.
                switch outbox.resolve(p.ref) {
                case .server(let t, let id):
                    refType = t; refId = id
                    context = serverTitles[t + ":" + id]
                case .waitingForParent(let parentId), .parentFailed(let parentId):
                    if let parent = outbox.changes.first(where: { $0.id == parentId }) {
                        let parentTitle: String
                        switch parent.payload {
                        case .todo(let tp): parentTitle = tp.title
                        case .topic(let tp): parentTitle = tp.title
                        case .progress: parentTitle = ""
                        }
                        context = parentTitle
                        refType = parent.kind.refType
                        refId = parent.localEntityId
                        if case .failed = parent.state {
                            blockedMessage = "Wartet auf '\(parentTitle)', der fehlgeschlagen ist."
                        } else {
                            blockedMessage = "Wird nach dem Vorhaben übertragen."
                        }
                    }
                case .parentGone:
                    // Der Sync-Motor (P3) markiert diesen Eintrag beim Senden als failed(.refGone).
                    blockedMessage = PendingFailureReason.refGone.userMessage
                }
            }

            let status: PendingItemStatus
            switch c.state {
            case .inFlight: status = .syncing
            case .failed(let reason): status = .failed(message: reason.userMessage)
            case .pending, .acknowledged:
                if let blockedMessage { status = .blocked(message: blockedMessage) } else { status = .pending }
            }

            return PendingItemSummary(id: c.id, kind: c.kind, title: title, contextText: context,
                                      capturedAt: c.capturedAt, status: status, entityId: c.localEntityId,
                                      refType: refType, refId: refId, fullText: fullText)
        }
    }
}
