import Foundation

//  OfflineOutbox.swift
//  Arbeitspaket P2, Schnittstelle S-7: persistente Warteschlange offline
//  erfasster Neuanlagen. Jede Mutation schreibt `outbox.json` synchron und
//  atomar, BEVOR sie zurueckkehrt; bei Schreibfehler bleibt der Speicherzustand
//  unveraendert (`OfflineStorageError.writeFailed`).
//
//  Datenschutz/Logging: Diese Datei loggt nichts (keine Titel, Texte, Tokens).

final class OfflineOutbox {
    static let fileName = "outbox"
    static let maxAliases = 1000
    private static let schemaVersion = 1

    private struct AliasEntry: Codable, Equatable {
        let localId: String
        let serverId: String
        let refType: String
    }

    private struct State: Equatable {
        var changes: [PendingChange] = []
        var nextSeq: Int64 = 1
        var aliases: [AliasEntry] = []   // aelteste zuerst (FIFO)
    }

    private struct FileHeader: Decodable { let schemaVersion: Int }
    private struct FileBody: Codable {
        var schemaVersion: Int
        var nextSeq: Int64
        var changes: [PendingChange]
        var aliases: [AliasEntry]
    }

    private let scope: OfflineScope
    private let store: UserScopedFileStore
    private let now: () -> Date
    private var state = State()

    var onChange: (() -> Void)?

    /// Aufsteigend nach `seq`.
    var changes: [PendingChange] { state.changes }

    /// Laden. Unlesbare Datei -> Quarantaene + `corruptQuarantined`; neuere
    /// Schema-Version -> `unsupportedFutureSchema` (Datei bleibt unberuehrt).
    /// Nicht-tombstoned `inFlight`-Eintraege werden nach einem Neustart (kein
    /// Request laeuft mehr) im Speicher auf `pending` zurueckgesetzt; das
    /// Client-Token macht das erneute Senden idempotent.
    init(scope: OfflineScope, store: UserScopedFileStore, now: @escaping () -> Date = Date.init) throws {
        self.scope = scope
        self.store = store
        self.now = now

        let data: Data?
        do { data = try store.read(scopeKey: scope.key, fileName: Self.fileName) }
        catch { try Self.quarantineOrThrow(store: store, scope: scope) }
        guard let data else { return }

        let decoder = JSONDecoder()
        guard let header = try? decoder.decode(FileHeader.self, from: data) else {
            try Self.quarantineOrThrow(store: store, scope: scope)
        }
        if header.schemaVersion > Self.schemaVersion { throw OfflineStorageError.unsupportedFutureSchema }
        guard let body = try? decoder.decode(FileBody.self, from: data) else {
            try Self.quarantineOrThrow(store: store, scope: scope)
        }
        var changes = body.changes.sorted { $0.seq < $1.seq }
        for i in changes.indices {
            if case .inFlight = changes[i].state, !changes[i].isTombstone {
                changes[i].state = .pending
                changes[i].followUp = .none
            }
        }
        let maxSeq = changes.map(\.seq).max() ?? 0
        state = State(changes: changes, nextSeq: max(body.nextSeq, maxSeq + 1), aliases: body.aliases)
    }

    private static func quarantineOrThrow(store: UserScopedFileStore, scope: OfflineScope) throws -> Never {
        do { try store.quarantine(scopeKey: scope.key, fileName: fileName) }
        catch { throw OfflineStorageError.writeFailed }
        throw OfflineStorageError.corruptQuarantined
    }

    // MARK: Persistenz

    private func mutate<T>(_ body: (inout State) throws -> T) throws -> T {
        var copy = state
        let result = try body(&copy)
        if copy != state {
            try persist(copy)
            state = copy
            onChange?()
        }
        return result
    }

    private func persist(_ s: State) throws {
        let file = FileBody(schemaVersion: Self.schemaVersion, nextSeq: s.nextSeq,
                            changes: s.changes, aliases: s.aliases)
        do {
            let data = try JSONEncoder().encode(file)
            try store.write(data, scopeKey: scope.key, fileName: Self.fileName)
        } catch {
            throw OfflineStorageError.writeFailed
        }
    }

    // MARK: Enqueue

    private func enqueue(_ payload: PendingPayload, clientToken: String?, capturedAt: Date?) throws -> PendingChange {
        try Self.validateReferences(payload)
        let token = Self.normalizedToken(clientToken)
        return try mutate { s in
            let change = PendingChange(id: UUID(), seq: s.nextSeq, clientToken: token,
                                       capturedAt: capturedAt ?? now(), payload: payload, state: .pending,
                                       revision: 1, followUp: .none, isTombstone: false, attemptCount: 0,
                                       lastAttemptAt: nil, acknowledgedObject: nil)
            s.nextSeq += 1
            s.changes.append(change)
            return change
        }
    }

    func enqueueTodo(_ p: PendingTodoPayload, clientToken: String? = nil, capturedAt: Date? = nil) throws -> PendingChange {
        try enqueue(.todo(p), clientToken: clientToken, capturedAt: capturedAt)
    }

    func enqueueTopic(_ p: PendingTopicPayload, clientToken: String? = nil, capturedAt: Date? = nil) throws -> PendingChange {
        try enqueue(.topic(p), clientToken: clientToken, capturedAt: capturedAt)
    }

    func enqueueProgress(_ p: PendingProgressPayload, clientToken: String? = nil, capturedAt: Date? = nil) throws -> PendingChange {
        try enqueue(.progress(p), clientToken: clientToken, capturedAt: capturedAt)
    }

    /// Server-IDs in Referenzen werden vor dem spaeteren Pfadaufbau per Allowlist geprueft.
    private static func validateReferences(_ payload: PendingPayload) throws {
        let invalid = OfflineError.validation("Ungültige Referenz.")
        switch payload {
        case .todo: return
        case .topic(let p):
            guard OfflineIds.isSafeServerId(p.meetingId) else { throw invalid }
        case .progress(let p):
            if case .server(let refType, let refId) = p.ref {
                guard (refType == "todo" || refType == "topic"), OfflineIds.isSafeServerId(refId) else { throw invalid }
            }
        }
    }

    /// Uebergebenes Token nur akzeptieren, wenn es ein UUID-String ist; sonst assertionFailure (Debug) + neues Token.
    private static func normalizedToken(_ t: String?) -> String {
        if let t {
            if UUID(uuidString: t) != nil { return t }
            // Programmierfehler des Aufrufers: Debug bricht ab, Release ersetzt das Token.
            assertionFailure("OfflineOutbox: clientToken ist keine UUID")
        }
        return UUID().uuidString
    }

    // MARK: Aenderungen

    private func index(of id: UUID, in s: State) throws -> Int {
        guard let i = s.changes.firstIndex(where: { $0.id == id }) else { throw OfflineOutboxError.notFound }
        return i
    }

    func updatePayload(id: UUID, _ payload: PendingPayload) throws {
        try Self.validateReferences(payload)
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            if c.isTombstone { throw OfflineError.pendingNotSynced }
            let oldKind = c.kind
            c.payload = payload
            guard c.kind == oldKind else { throw OfflineOutboxError.invalidState }
            switch c.state {
            case .pending:
                c.revision += 1
            case .failed:
                c.revision += 1
                c.state = .pending
            case .inFlight:
                c.revision += 1
                c.followUp = .update
            case .acknowledged:
                c.followUp = .update
            }
            s.changes[i] = c
        }
    }

    @discardableResult
    func discard(id: UUID) throws -> [PendingChange] {
        try mutate { s in
            let root = try index(of: id, in: s)
            var targets: [UUID] = [s.changes[root].id]
            var queue = [s.changes[root].id]
            while let next = queue.popLast() {
                for dep in Self.dependents(of: next, in: s.changes) where !targets.contains(dep.id) {
                    targets.append(dep.id)
                    queue.append(dep.id)
                }
            }
            var affected: [PendingChange] = []
            for target in targets {
                guard let i = s.changes.firstIndex(where: { $0.id == target }) else { continue }
                var c = s.changes[i]
                if c.isTombstone { continue }
                switch c.state {
                case .pending, .failed:
                    s.changes.remove(at: i)
                    affected.append(c)
                case .inFlight, .acknowledged:
                    c.isTombstone = true
                    c.followUp = .delete
                    s.changes[i] = c
                    affected.append(c)
                }
            }
            return affected
        }
    }

    func retry(id: UUID) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            switch s.changes[i].state {
            case .failed: s.changes[i].state = .pending
            case .pending: break
            default: throw OfflineOutboxError.invalidState
            }
        }
    }

    func reassignTopic(id: UUID, toMeetingId: String) throws {
        guard OfflineIds.isSafeServerId(toMeetingId) else { throw OfflineError.validation("Ungültige Referenz.") }
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            guard case .topic(var p) = c.payload, Self.isPendingOrFailed(c.state), !c.isTombstone else {
                throw OfflineOutboxError.invalidState
            }
            p.meetingId = toMeetingId
            c.payload = .topic(p)
            c.state = .pending
            c.revision += 1
            s.changes[i] = c
        }
    }

    func convertTopicToTodo(id: UUID) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            guard case .topic(let p) = c.payload, Self.isPendingOrFailed(c.state), !c.isTombstone else {
                throw OfflineOutboxError.invalidState
            }
            c.payload = .todo(PendingTodoPayload(title: p.title, descriptionHTML: p.descriptionHTML,
                                                 snoozedUntil: p.snoozedUntil, dueDate: nil, isPrivate: false))
            c.clientToken = UUID().uuidString
            c.state = .pending
            c.revision += 1
            s.changes[i] = c
        }
    }

    private static func isPendingOrFailed(_ st: PendingSyncState) -> Bool {
        switch st {
        case .pending, .failed: return true
        default: return false
        }
    }

    // MARK: Sync-Zustandsuebergaenge (vom Sync-Motor)

    /// Zulaessig aus `pending` (und `inFlight` fuer ein erneutes Senden).
    func markInFlight(id: UUID) throws -> Int {
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            switch c.state {
            case .pending, .inFlight: break
            default: throw OfflineOutboxError.invalidState
            }
            c.state = .inFlight(sentRevision: c.revision)
            c.lastAttemptAt = now()
            s.changes[i] = c
            return c.revision
        }
    }

    func markAcknowledged(id: UUID, serverId: String, object: AcknowledgedObject) throws {
        guard OfflineIds.isSafeServerId(serverId) else { throw OfflineError.validation("Ungültige Server-ID.") }
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            switch c.state {
            case .pending, .inFlight: break
            default: throw OfflineOutboxError.invalidState
            }
            // Wurde die Nutzlast waehrend des Sendens bearbeitet, muss die Bearbeitung nachgereicht werden.
            if case .inFlight(let sent) = c.state, sent != c.revision, !c.isTombstone { c.followUp = .update }
            c.state = .acknowledged(serverId: serverId, at: now())
            c.acknowledgedObject = object
            s.changes[i] = c
            s.aliases.removeAll { $0.localId == c.localEntityId }
            s.aliases.append(AliasEntry(localId: c.localEntityId, serverId: serverId, refType: c.kind.refType))
            if s.aliases.count > Self.maxAliases { s.aliases.removeFirst(s.aliases.count - Self.maxAliases) }
        }
    }

    /// Fachliche Ablehnung. Ein waehrend des Sendens verworfener Eintrag
    /// (Tombstone) wird stattdessen entfernt - es gibt nichts mehr zu retten.
    func markFailed(id: UUID, reason: PendingFailureReason) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            switch c.state {
            case .pending, .inFlight: break
            default: throw OfflineOutboxError.invalidState
            }
            if c.isTombstone { s.changes.remove(at: i); return }
            c.state = .failed(reason)
            c.followUp = .none
            c.lastAttemptAt = now()
            s.changes[i] = c
        }
    }

    /// Transienter Fehler: zurueck auf `pending` (bei `acknowledged` bleibt der
    /// Zustand, nur der Folge-Request wird spaeter wiederholt).
    func markTransientFailure(id: UUID, countAttempt: Bool) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            var c = s.changes[i]
            if case .inFlight = c.state { c.state = .pending }
            if countAttempt { c.attemptCount += 1 }
            c.lastAttemptAt = now()
            s.changes[i] = c
        }
    }

    func clearFollowUp(id: UUID) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            s.changes[i].followUp = PendingFollowUp.none
        }
    }

    /// Entfernt einen vollstaendig abgearbeiteten (`acknowledged`) Eintrag. Der Alias bleibt.
    func complete(id: UUID) throws {
        try mutate { s in
            let i = try index(of: id, in: s)
            guard case .acknowledged = s.changes[i].state else { throw OfflineOutboxError.invalidState }
            s.changes.remove(at: i)
        }
    }

    // MARK: Abfragen

    func resolve(_ ref: PendingRef) -> PendingRefResolution {
        switch ref {
        case .server(let refType, let refId):
            return .server(refType: refType, refId: refId)
        case .local(let changeId):
            if let c = state.changes.first(where: { $0.id == changeId }) {
                if c.isTombstone { return .parentGone }
                guard c.kind != .createProgressEntry else { return .parentGone }
                let refType = c.kind.refType
                switch c.state {
                case .acknowledged(let serverId, _): return .server(refType: refType, refId: serverId)
                case .failed: return .parentFailed(changeId)
                case .pending, .inFlight: return .waitingForParent(changeId)
                }
            }
            let localId = OfflineIds.localPrefix + changeId.uuidString.lowercased()
            if let a = state.aliases.first(where: { $0.localId == localId }),
               a.refType == "todo" || a.refType == "topic" {
                return .server(refType: a.refType, refId: a.serverId)
            }
            return .parentGone
        }
    }

    /// Abgleich nach einem Server-Abruf (Orchestrator-Entscheidung, verbindlich fuer P3).
    /// Betrachtet werden nur `acknowledged`-Eintraege mit `at < fetchStartedAt`
    /// (neuere kann der Abruf noch nicht enthalten):
    /// - `followUp == .none`: entfernen (egal ob die serverId in den Daten steht).
    /// - `followUp != .none` und serverId NICHT in den Serverdaten:
    ///   `.delete` (auch Tombstones): entfernen - das Ziel ist schon weg (Erfolg).
    ///   `.update`: Zustand `failed(.refGone)`, `followUp = .none`, damit der
    ///   Nutzer den Text kopieren kann (kein stiller Verlust).
    /// - `followUp != .none` und serverId vorhanden: unveraendert (Folgeaktion offen).
    /// Zwischenstaende (Typ "progress") haben keine ID-Menge im Abruf und werden
    /// bei offener Folgeaktion nicht angefasst.
    func reconcile(serverTodoIds: Set<String>, serverTopicIds: Set<String>, fetchStartedAt: Date) throws {
        try mutate { s in
            var kept: [PendingChange] = []
            kept.reserveCapacity(s.changes.count)
            for var c in s.changes {
                guard case .acknowledged(let serverId, let at) = c.state, at < fetchStartedAt else {
                    kept.append(c); continue
                }
                if c.followUp == PendingFollowUp.none { continue }
                let present: Bool
                switch c.kind {
                case .createTodo: present = serverTodoIds.contains(serverId)
                case .createTopic: present = serverTopicIds.contains(serverId)
                case .createProgressEntry: present = true
                }
                if present { kept.append(c); continue }
                if c.followUp == .delete || c.isTombstone { continue }
                c.state = .failed(.refGone)
                c.followUp = PendingFollowUp.none
                c.acknowledgedObject = nil
                kept.append(c)
            }
            s.changes = kept
        }
    }

    func alias(forLocalId id: String) -> String? {
        state.aliases.last(where: { $0.localId == id })?.serverId
    }

    var visibleChanges: [PendingChange] {
        state.changes.filter { c in
            if c.isTombstone { return false }
            if case .acknowledged = c.state { return false }
            return true
        }
    }

    func dependents(of id: UUID) -> [PendingChange] {
        Self.dependents(of: id, in: state.changes)
    }

    private static func dependents(of id: UUID, in changes: [PendingChange]) -> [PendingChange] {
        changes.filter { c in
            if case .progress(let p) = c.payload, case .local(let parent) = p.ref { return parent == id }
            return false
        }
    }

    func change(forLocalEntityId id: String) -> PendingChange? {
        state.changes.first { $0.localEntityId == id && !$0.isTombstone }
    }

    /// Loescht die Outbox-Datei und den Speicherzustand. Scope komplett loeschen: `OfflineSnapshotStore.removeScope(_:)`.
    func deleteStorage() {
        // Nur die eigene Datei: Snapshot/Caches im selben Scope bleiben erhalten.
        store.remove(scopeKey: scope.key, fileName: Self.fileName)
        state = State()
        onChange?()
    }
}
