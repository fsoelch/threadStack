import Foundation
import os

//  OfflineSyncEngine.swift
//  Arbeitspaket P3, Schnittstelle S-11: arbeitet die Outbox strikt der Reihe nach ab.
//  Jede Uebertragung ist ueber das Client-Token idempotent und darf beliebig oft
//  wiederholt werden.
//
//  Datenschutz/Logging: Es werden nur Anzahlen, Zustandswechsel und Change-UUIDs
//  geloggt - nie Titel, Texte, Tokens oder Nutzernamen.

enum SyncRunOutcome: Equatable {
    case completed(acknowledgedAny: Bool)
    case stoppedTransient(retryAt: Date)
    case paused(OfflinePauseReason)
    case nothingToDo
}

extension OfflineTexts {
    // Eigene Erweiterung (OfflineUIComponents.swift wird parallel von P5 angepasst).
    /// Neuanlage, deren Ziel der Server inzwischen geloescht hat (410 CLIENT_TOKEN_TARGET_GONE).
    static let alreadyGoneOnServer = "Der Eintrag wurde auf dem Server bereits gelöscht."
}

final class OfflineSyncEngine {
    static let backoffSteps: [TimeInterval] = [5, 10, 20, 40, 80, 160, 300]
    static let capabilityCacheDuration: TimeInterval = 600
    /// Schutz vor Endlosschleife, falls waehrend eines Follow-ups ununterbrochen weiterbearbeitet wird.
    private static let maxFollowUpRounds = 5

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ThreadStack", category: "offline")

    private let outbox: OfflineOutbox
    private let api: OfflineSyncAPI
    private let scopeUserId: String
    private let currentUserId: () -> String?
    private let renewSession: () async -> AppUser?
    private let now: () -> Date
    private let progressBudget: Int
    private let progressWindow: TimeInterval
    private let jitter: () -> Double

    var onAcknowledged: ((PendingChange, AcknowledgedObject) -> Void)?
    var onCompleted: ((PendingChange) -> Void)?
    var onActivityChange: ((OfflineSyncActivity) -> Void)?

    // Laufzeitzustand
    private var currentRun: Task<SyncRunOutcome, Never>?
    private var stickyPause: OfflinePauseReason?          // needsReauth / storageProblem: bis resume()/resetBackoff()
    private var consecutiveFailures = 0
    private var notBefore: Date?
    private var capabilityCache: (result: SyncCapabilityResult, at: Date)?
    private var progressSendTimes: [Date] = []
    private var stopped = false

    /// `jitter` liefert den relativen Jitter (-0.2 ... +0.2); injizierbar fuer Tests.
    init(outbox: OfflineOutbox, api: OfflineSyncAPI, scopeUserId: String,
         currentUserId: @escaping () -> String?, renewSession: @escaping () async -> AppUser?,
         now: @escaping () -> Date = Date.init, progressBudget: Int = 40, progressWindow: TimeInterval = 600,
         jitter: @escaping () -> Double = { Double.random(in: -0.2...0.2) }) {
        self.outbox = outbox
        self.api = api
        self.scopeUserId = scopeUserId
        self.currentUserId = currentUserId
        self.renewSession = renewSession
        self.now = now
        self.progressBudget = progressBudget
        self.progressWindow = progressWindow
        self.jitter = jitter
    }

    // MARK: Steuerung

    /// Hebt die Pause auf (nach erneuter Anmeldung).
    func resume() {
        stickyPause = nil
        notBefore = nil
    }

    /// Aufrufer: Coordinator bei jedem Verbindungswechsel (offline<->online) und bei `.manual`. Setzt Backoff, Capability-Cache und technische Pausen (storageProblem) zuruecksetzen.
    func resetBackoff() {
        consecutiveFailures = 0
        notBefore = nil
        capabilityCache = nil
        if stickyPause == .storageProblem { stickyPause = nil }
    }

    /// Beendet den Motor endgueltig (Logout/Kontowechsel): laufende Laeufe schreiben nichts mehr in die Outbox.
    func stop() {
        stopped = true
        onAcknowledged = nil
        onCompleted = nil
        onActivityChange = nil
    }

    // MARK: Lauf

    func runOnce() async -> SyncRunOutcome {
        if let running = currentRun { return await running.value }
        let task = Task { await self.performRun() }
        currentRun = task
        let outcome = await task.value
        // Nur das EIGENE Handle freigeben (ein inzwischen gestarteter neuer Lauf bleibt teilbar).
        if currentRun == task { currentRun = nil }
        return outcome
    }

    private enum Step { case continueRun, finish(SyncRunOutcome) }

    private func performRun() async -> SyncRunOutcome {
        if stopped { return .nothingToDo }
        if let sticky = stickyPause {
            publish(.paused(sticky))
            return .paused(sticky)
        }
        guard currentUserId() == scopeUserId else { return pause(.userMismatch) }
        if !hasWork() {
            publish(.idle)
            return .nothingToDo
        }
        if let nb = notBefore, nb > now() {
            publish(.waitingRetry(until: nb))
            return .stoppedTransient(retryAt: nb)
        }

        // Capabilities (gecacht)
        if let step = await ensureCapabilities(), case .finish(let outcome) = step { return outcome }

        var acknowledgedAny = false
        var cursor: Int64 = 0
        var done = 0
        while !stopped {
            guard let change = nextActionable(after: cursor) else { break }
            cursor = change.seq
            publish(.syncing(done: done, total: done + remainingActionable(from: change.seq)))
            let step = await process(change, acknowledgedAny: &acknowledgedAny)
            done += 1
            if case .finish(let outcome) = step { return outcome }
        }
        if stopped { return .nothingToDo }
        consecutiveFailures = 0
        notBefore = nil
        publish(.idle)
        Self.log.debug("sync run completed, acknowledgedAny=\(acknowledgedAny)")
        return .completed(acknowledgedAny: acknowledgedAny)
    }

    private func ensureCapabilities() async -> Step? {
        if let cache = capabilityCache {
            switch cache.result {
            case .supported: return nil
            case .unsupported where now().timeIntervalSince(cache.at) < Self.capabilityCacheDuration:
                return .finish(pause(.serverUnsupported))
            default: break
            }
        }
        var renewedOnce = false
        while true {
            let result = await api.capabilities()
            if stopped { return .finish(.nothingToDo) }
            switch result {
            case .supported:
                capabilityCache = (.supported, now())
                return nil
            case .unsupported:
                capabilityCache = (.unsupported, now())
                return .finish(pause(.serverUnsupported))
            case .transient:
                return .finish(stopTransient(retryAfter: nil))
            case .unauthorized:
                if renewedOnce { return .finish(pause(.needsReauth)) }
                renewedOnce = true
                if let outcome = await renewOrPause() { return .finish(outcome) }
            }
        }
    }

    /// Einzige Entscheidung nach einem expliziten Renewal (Motor UND Coordinator): nil = Sitzung gehoert zum
    /// Scope, Wiederholung erlaubt; sonst der Pausengrund (kein Renewal -> needsReauth, fremdes Konto -> userMismatch).
    static func classifyRenewal(_ user: AppUser?, scopeUserId: String) -> OfflinePauseReason? {
        guard let user else { return .needsReauth }
        return user.id == scopeUserId ? nil : .userMismatch
    }

    /// Fuehrt das explizite Renewal aus. nil = erfolgreich (Aufrufer wiederholt einmal); sonst Abbruchergebnis.
    private func renewOrPause() async -> SyncRunOutcome? {
        let user = await renewSession()
        if stopped { return .nothingToDo }
        if let reason = Self.classifyRenewal(user, scopeUserId: scopeUserId) { return pause(reason) }
        return nil
    }

    /// Klebrige Pausen bleiben bis `resume()` (needsReauth) bzw. `resetBackoff()` (storageProblem) bestehen;
    /// userMismatch und serverUnsupported werden bei jedem Lauf neu bewertet.
    static func isSticky(_ reason: OfflinePauseReason) -> Bool {
        reason == .needsReauth || reason == .storageProblem
    }

    /// Einzige Stelle, an der Pausen gesetzt werden - auch fuer den Coordinator (haelt Motor und
    /// `OfflineStatusStore.activity` konsistent; die Klebrigkeit folgt immer `isSticky`).
    @discardableResult
    func setPaused(_ reason: OfflinePauseReason) -> SyncRunOutcome { pause(reason) }

    // MARK: Auswahl

    private func isActionable(_ c: PendingChange) -> Bool {
        switch c.state {
        case .pending: return !c.isTombstone
        case .acknowledged: return c.followUp != .none
        case .inFlight, .failed: return false
        }
    }

    private func hasWork() -> Bool { outbox.changes.contains(where: isActionable) }

    private func nextActionable(after seq: Int64) -> PendingChange? {
        outbox.changes.first { $0.seq > seq && isActionable($0) }
    }

    private func remainingActionable(from seq: Int64) -> Int {
        outbox.changes.filter { $0.seq >= seq && isActionable($0) }.count
    }

    private func current(_ id: UUID) -> PendingChange? { outbox.changes.first { $0.id == id } }

    // MARK: Einzelner Eintrag

    private func process(_ change: PendingChange, acknowledgedAny: inout Bool) async -> Step {
        switch change.state {
        case .acknowledged:
            return await processFollowUps(id: change.id)
        case .pending:
            return await processCreate(change, acknowledgedAny: &acknowledgedAny)
        default:
            return .continueRun
        }
    }

    /// Ergebnis einer Outbox-Mutation: Speicherfehler beenden den Lauf (storageProblem), alles andere wird ignoriert
    /// (der Eintrag wurde z.B. waehrenddessen verworfen).
    private func mutate(_ body: () throws -> Void) -> Step? {
        do { try body() }
        catch let e as OfflineStorageError where e == .writeFailed { return .finish(pause(.storageProblem)) }
        catch { /* notFound/invalidState: Eintrag wurde zwischenzeitlich veraendert */ }
        return nil
    }

    private func processCreate(_ initial: PendingChange, acknowledgedAny: inout Bool) async -> Step {
        let id = initial.id
        var renewedOnce = false
        while !stopped {
            guard let change = current(id), !change.isTombstone else { return .continueRun }
            switch change.state {
            case .pending: break
            case .inFlight where renewedOnce: break   // Wiederholung nach erfolgreichem Renewal
            default: return .continueRun
            }

            // Bezug aufloesen (Zwischenstaende)
            var progressTarget: (refType: String, refId: String)?
            if case .progress(let p) = change.payload {
                switch outbox.resolve(p.ref) {
                case .waitingForParent, .parentFailed:
                    return .continueRun
                case .parentGone:
                    if let step = mutate({ try outbox.markFailed(id: id, reason: .refGone) }) { return step }
                    return .continueRun
                case .server(let t, let rid):
                    progressTarget = (t, rid)
                }
                if budgetExhausted() { return .finish(budgetStop()) }
            }

            if let step = mutate({ _ = try outbox.markInFlight(id: id) }) { return step }
            if progressTarget != nil { progressSendTimes.append(now()) }
            guard let sent = current(id) else { return .continueRun }

            let outcome: CreateOutcome = await send(sent, progressTarget: progressTarget)
            if stopped { return .finish(.nothingToDo) }

            switch outcome {
            case .success(let serverId, let object):
                if let step = mutate({ try outbox.markAcknowledged(id: id, serverId: serverId, object: object) }) { return step }
                acknowledgedAny = true
                guard let acked = current(id) else { return .continueRun }
                if !acked.isTombstone { onAcknowledged?(acked, object) }
                if acked.kind == .createProgressEntry, acked.followUp == .none {
                    // Zwischenstaende werden sofort abgeschlossen (der Alias bleibt in der Outbox).
                    if let step = mutate({ try outbox.complete(id: id) }) { return step }
                    onCompleted?(acked)
                    return .continueRun
                }
                if acked.followUp != .none { return await processFollowUps(id: id) }
                return .continueRun
            case .alreadyGone:
                // Server kennt das Ziel nicht mehr. Die Outbox kann ein nicht-quittiertes Element nur ueber
                // markFailed entfernen; ein Tombstone verschwindet dabei, sonst bleibt der Text kopierbar sichtbar.
                let reason = PendingFailureReason.rejected(message: OfflineTexts.alreadyGoneOnServer)
                if let step = mutate({ try outbox.markFailed(id: id, reason: reason) }) { return step }
                return .continueRun
            case .rejected(let reason):
                if let step = mutate({ try outbox.markFailed(id: id, reason: reason) }) { return step }
                return .continueRun
            case .transient(let retryAfter):
                if let step = mutate({ try outbox.markTransientFailure(id: id, countAttempt: true) }) { return step }
                return .finish(stopTransient(retryAfter: retryAfter))
            case .unauthorized:
                // Zweites 401 nach Renewal: wie fehlgeschlagenes Renewal behandeln (keine Schleife).
                let paused: SyncRunOutcome?
                if renewedOnce { paused = pause(.needsReauth) } else { paused = await renewOrPause() }
                renewedOnce = true
                if let paused {
                    if !stopped { _ = mutate { try outbox.markTransientFailure(id: id, countAttempt: false) } }
                    return .finish(paused)
                }
                // gleichen Eintrag genau einmal wiederholen (state ist inFlight -> erneut erlaubt)
                continue
            }
        }
        return .finish(.nothingToDo)
    }

    private enum CreateOutcome {
        case success(serverId: String, object: AcknowledgedObject)
        case alreadyGone, rejected(PendingFailureReason), transient(TimeInterval?), unauthorized
    }

    private func outcome<T>(_ r: SyncCallResult<T>, ack: (T) -> (serverId: String, object: AcknowledgedObject)) -> CreateOutcome {
        switch r {
        case .success(let v):
            let a = ack(v)
            return .success(serverId: a.serverId, object: a.object)
        case .alreadyGone: return .alreadyGone
        case .rejected(let reason): return .rejected(reason)
        case .transient(let after): return .transient(after)
        case .unauthorized: return .unauthorized
        }
    }

    private func send(_ change: PendingChange, progressTarget: (refType: String, refId: String)?) async -> CreateOutcome {
        switch change.payload {
        case .todo(let p):
            return outcome(await api.createTodo(p, clientToken: change.clientToken, capturedAt: change.capturedAt)) { ($0.id, .todo($0)) }
        case .topic(let p):
            return outcome(await api.createTopic(p, clientToken: change.clientToken, capturedAt: change.capturedAt)) {
                ($0.id, .topic(meetingId: p.meetingId, $0))
            }
        case .progress(let p):
            guard let target = progressTarget else { return .rejected(.rejected(message: nil)) }
            return outcome(await api.addProgressEntry(refType: target.refType, refId: target.refId, bodyHTML: p.bodyHTML,
                                                      source: p.source, clientToken: change.clientToken)) { ($0.id, .progressEntry($0)) }
        }
    }

    // MARK: Follow-ups (Bearbeiten/Verwerfen nach dem Quittieren)

    private func processFollowUps(id: UUID) async -> Step {
        var renewedOnce = false
        var rounds = 0
        while !stopped, rounds < Self.maxFollowUpRounds {
            rounds += 1
            guard let change = current(id), case .acknowledged(let serverId, _) = change.state,
                  change.followUp != .none else { return .continueRun }
            let sentFollowUp = change.followUp
            let sentPayload = change.payload
            let result = await sendFollowUp(change, serverId: serverId)
            if stopped { return .finish(.nothingToDo) }
            switch result {
            case .success:
                guard let after = current(id) else { return .continueRun }
                if sentFollowUp == .delete {
                    if let step = mutate({ try outbox.complete(id: id) }) { return step }
                    onCompleted?(after)
                    return .continueRun
                }
                if after.followUp == sentFollowUp, after.payload == sentPayload {
                    if let step = mutate({ try outbox.clearFollowUp(id: id) }) { return step }
                    if after.kind == .createProgressEntry {
                        if let step = mutate({ try outbox.complete(id: id) }) { return step }
                        onCompleted?(after)
                    }
                    return .continueRun
                }
                continue   // zwischenzeitlich weiterbearbeitet/verworfen: neuen Stand nachreichen
            case .alreadyGone:
                if let step = mutate({ try outbox.complete(id: id) }) { return step }
                onCompleted?(change)
                return .continueRun
            case .rejected:
                // Der Eintrag selbst ist angekommen; die Folgeaktion wird abgelehnt. Keine Endlosschleife:
                // Folgeaktion verwerfen (Bearbeiten) bzw. Eintrag abschliessen (Loeschen, Objekt bleibt am Server).
                if sentFollowUp == .delete {
                    if let step = mutate({ try outbox.complete(id: id) }) { return step }
                    onCompleted?(change)
                } else if let step = mutate({ try outbox.clearFollowUp(id: id) }) { return step }
                return .continueRun
            case .transient(let retryAfter):
                if let step = mutate({ try outbox.markTransientFailure(id: id, countAttempt: true) }) { return step }
                return .finish(stopTransient(retryAfter: retryAfter))
            case .unauthorized:
                // Gleiche Entscheidung wie beim Anlegen (Eintrag bleibt quittiert, nur Versuch nicht zaehlen).
                let paused: SyncRunOutcome?
                if renewedOnce { paused = pause(.needsReauth) } else { paused = await renewOrPause() }
                renewedOnce = true
                if let paused {
                    if !stopped { _ = mutate { try outbox.markTransientFailure(id: id, countAttempt: false) } }
                    return .finish(paused)
                }
            }
        }
        if rounds >= Self.maxFollowUpRounds {
            Self.log.info("follow-up rounds exhausted for change \(id.uuidString)")
        }
        return .continueRun
    }

    private func sendFollowUp(_ change: PendingChange, serverId: String) async -> SyncCallResult<Void> {
        switch (change.payload, change.followUp) {
        case (.todo(let p), .update): return await api.updateTodo(serverId: serverId, p)
        case (.todo, .delete): return await api.deleteTodo(serverId: serverId)
        case (.topic(let p), .update): return await api.updateTopic(meetingId: p.meetingId, serverId: serverId, p)
        case (.topic(let p), .delete): return await api.deleteTopic(meetingId: p.meetingId, serverId: serverId)
        case (.progress(let p), .update): return await api.updateProgressEntry(entryId: serverId, bodyHTML: p.bodyHTML)
        case (.progress, .delete): return await api.deleteProgressEntry(entryId: serverId)
        case (_, .none): return .success(())
        }
    }

    // MARK: Budget / Backoff / Pausen

    private func pruneWindow() {
        let cutoff = now().addingTimeInterval(-progressWindow)
        progressSendTimes.removeAll { $0 <= cutoff }
    }

    private func budgetExhausted() -> Bool {
        pruneWindow()
        return progressSendTimes.count >= progressBudget
    }

    private func budgetStop() -> SyncRunOutcome {
        let free = (progressSendTimes.min() ?? now()).addingTimeInterval(progressWindow)
        publish(.waitingRetry(until: free))
        Self.log.info("progress budget exhausted")
        return .stoppedTransient(retryAt: free)
    }

    private func stopTransient(retryAfter: TimeInterval?) -> SyncRunOutcome {
        let step = Self.backoffSteps[min(consecutiveFailures, Self.backoffSteps.count - 1)]
        consecutiveFailures += 1
        var delay = step * (1 + max(-0.2, min(0.2, jitter())))
        if let retryAfter { delay = max(delay, retryAfter) }
        let at = now().addingTimeInterval(delay)
        notBefore = at
        publish(.waitingRetry(until: at))
        Self.log.info("sync stopped transient, failures=\(self.consecutiveFailures)")
        return .stoppedTransient(retryAt: at)
    }

    private func pause(_ reason: OfflinePauseReason) -> SyncRunOutcome {
        if Self.isSticky(reason) { stickyPause = reason }
        publish(.paused(reason))
        Self.log.info("sync paused")
        return .paused(reason)
    }

    private func publish(_ activity: OfflineSyncActivity) {
        onActivityChange?(activity)
    }
}
