import Testing
import Foundation
@testable import ThreadStack

//  Paket P4: reine Formatierungs-/Label-Logik der Status-UI (Leiste, Liste,
//  Fehlerausloesung, Meeting-Auswahl, Logout-Bestaetigung).

private let cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}()

private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 14, _ mi: Int = 32) -> Date {
    cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
}

private let now = date(2026, 11, 15, 16, 0)

private func banner(_ connection: OfflineConnectionState = .online, _ activity: OfflineSyncActivity = .idle,
                    asOf: Date? = nil, unsynced: Int = 0, failed: Int = 0,
                    storage: String? = nil) -> OfflineBannerContent? {
    OfflineBannerLogic.content(connection: connection, activity: activity, dataAsOf: asOf, unsyncedCount: unsynced,
                               failedCount: failed, storageProblemMessage: storage, now: now, calendar: cal)
}

private func item(kind: PendingChangeKind = .createTodo, title: String = "Titel", context: String? = nil,
                  status: PendingItemStatus = .pending, full: String = "Titel\n\nText",
                  refType: String? = nil, refId: String? = nil, capturedAt: Date = date(2026, 11, 15)) -> PendingItemSummary {
    PendingItemSummary(id: UUID(), kind: kind, title: title, contextText: context, capturedAt: capturedAt,
                       status: status, entityId: nil, refType: refType, refId: refId, fullText: full)
}

@MainActor struct OfflineBannerLogicTests {
    @Test func hiddenWhenOnlineAndNothingToReport() {
        #expect(banner() == nil)
        #expect(banner(.online, .waitingRetry(until: now), unsynced: 0) == nil)
    }

    @Test func offlineShowsStandAndRetry() {
        let c = banner(.offline(.noNetwork), asOf: date(2026, 11, 15))!
        #expect(c.text == "Offline")
        #expect(c.detail == "Stand: heute, 14:32")
        #expect(c.showsRetry)
        #expect(c.summary == nil)
        #expect(!c.opensList)
        #expect(c.accessibilityLabel == "Offline. Stand: heute, 14 Uhr 32.")
    }

    @Test func offlineNeverLoaded() {
        let c = banner(.offline(.serverUnreachable))!
        #expect(c.detail == "Noch kein Stand geladen")
        #expect(c.accessibilityLabel.hasPrefix("Offline. Noch kein Stand geladen."))
    }

    @Test func offlineWithPendingAndFailedCounts() {
        let c = banner(.offline(.noNetwork), asOf: date(2026, 11, 1), unsynced: 4, failed: 1)!
        #expect(c.summary == "3 ausstehend, 1 fehlgeschlagen")
        #expect(c.opensList)
        #expect(c.isWarning)
        #expect(c.detail == "Stand vom 01.11., 14:32")
        #expect(c.accessibilityLabel
                == "Offline. Stand vom 1. November, 14 Uhr 32. 3 Änderungen ausstehend, 1 Änderung fehlgeschlagen.")
    }

    @Test func onlinePendingAndFailed() {
        let p = banner(.online, .idle, unsynced: 2)!
        #expect(p.text == "2 ausstehend")
        #expect(!p.isWarning && !p.showsRetry)
        let f = banner(.online, .idle, unsynced: 3, failed: 2)!
        #expect(f.text == "2 fehlgeschlagen")
        #expect(f.detail == "1 ausstehend")
        #expect(f.isWarning)
        #expect(f.icon == "exclamationmark.triangle")
        let w = banner(.online, .waitingRetry(until: now), unsynced: 1)!
        #expect(w.detail == "Wird später erneut versucht.")
    }

    @Test func syncingXOfYBelowFiftyAndRemainingFromFifty() {
        #expect(OfflineBannerLogic.syncingText(done: 2, total: 5) == "Wird synchronisiert … (2 von 5)")
        #expect(OfflineBannerLogic.syncingText(done: 0, total: 49) == "Wird synchronisiert … (0 von 49)")
        #expect(OfflineBannerLogic.syncingText(done: 10, total: 50) == "Wird synchronisiert … (40 verbleibend)")
        #expect(OfflineBannerLogic.syncingText(done: 99, total: 60) == "Wird synchronisiert … (0 verbleibend)")
        #expect(OfflineBannerLogic.syncingText(done: -3, total: 5) == "Wird synchronisiert … (0 von 5)")
        let c = banner(.online, .syncing(done: 2, total: 5), unsynced: 5)!
        #expect(c.showsSpinner)
        #expect(c.text == "Wird synchronisiert … (2 von 5)")
    }

    @Test func reauthSingularPluralAndButton() {
        let one = banner(.online, .paused(.needsReauth), unsynced: 1)!
        #expect(one.text == "Bitte neu anmelden, um 1 Änderung zu übertragen.")
        #expect(one.showsReauthButton)
        let many = banner(.online, .paused(.needsReauth), unsynced: 3)!
        #expect(many.text == "Bitte neu anmelden, um 3 Änderungen zu übertragen.")
        // nur fehlgeschlagene -> kein Re-Auth-Hinweis, sondern Fehlerleiste
        let onlyFailed = banner(.online, .paused(.needsReauth), unsynced: 1, failed: 1)!
        #expect(!onlyFailed.showsReauthButton)
        #expect(onlyFailed.text == "1 fehlgeschlagen")
    }

    @Test func pausedReasons() {
        #expect(banner(.online, .paused(.serverUnsupported), unsynced: 1)!.text == OfflineBannerLogic.serverUnsupportedText)
        #expect(banner(.online, .paused(.userMismatch), unsynced: 1)!.text == OfflineBannerLogic.userMismatchText)
        #expect(banner(.online, .paused(.storageProblem), storage: "Speicher voll")!.text == "Speicher voll")
        let fallback = banner(.online, .paused(.storageProblem))!
        #expect(fallback.text == OfflineError.localStorageFailed.errorDescription)
        #expect(fallback.isWarning)
    }

    @Test func negativeOrInconsistentCountsAreClamped() {
        let c = banner(.online, .idle, unsynced: 0, failed: 2)!
        #expect(c.text == "2 fehlgeschlagen")
        #expect(banner(.online, .idle, unsynced: -5, failed: -1) == nil)
    }

    @Test func spokenDateVariants() {
        #expect(OfflineBannerLogic.spokenDate(date(2026, 11, 14), now: now, calendar: cal) == "gestern, 14 Uhr 32")
        #expect(OfflineBannerLogic.spokenDate(date(2026, 3, 2, 9, 5), now: now, calendar: cal) == "2. März, 9 Uhr 5")
        #expect(OfflineBannerLogic.spokenDate(date(2025, 12, 24), now: now, calendar: cal) == "24. Dezember 2025, 14 Uhr 32")
    }

    @Test func announcementKeyIgnoresProgressSteps() {
        let a = banner(.online, .syncing(done: 1, total: 5), unsynced: 5)!
        let b = banner(.online, .syncing(done: 2, total: 5), unsynced: 5)!
        #expect(a.accessibilityLabel != b.accessibilityLabel)
        #expect(a.announcementKey == b.announcementKey)
        #expect(a.announcementKey != banner(.offline(.noNetwork))!.announcementKey)
    }

    @Test func userMismatchReusesOfflineErrorText() {
        #expect(OfflineBannerLogic.userMismatchText == OfflineError.scopeMismatch.errorDescription)
    }

    @Test func countTexts() {
        #expect(OfflineCountText.changes(1) == "1 Änderung")
        #expect(OfflineCountText.changes(2) == "2 Änderungen")
        #expect(OfflineCountText.logoutWarning(1) == "1 Änderung ist noch nicht übertragen und geht verloren.")
        #expect(OfflineCountText.logoutWarning(7) == "7 Änderungen sind noch nicht übertragen und gehen verloren.")
    }
}

@MainActor struct PendingChangesLogicTests {
    @Test func headerOmitsZeroParts() {
        #expect(PendingChangesLogic.headerText(items: []) == nil)
        #expect(PendingChangesLogic.headerText(items: [item(), item()]) == "2 ausstehend")
        #expect(PendingChangesLogic.headerText(items: [item(), item(status: .failed(message: "x"))])
                == "1 ausstehend, 1 fehlgeschlagen")
        #expect(PendingChangesLogic.headerText(items: [item(status: .failed(message: "x"))]) == "1 fehlgeschlagen")
    }

    @Test func groupingKeepsOrderAndPutsBlockedAndSyncingIntoPending() {
        let a = item(title: "A"), b = item(title: "B", status: .failed(message: "x"))
        let c = item(title: "C", status: .syncing), d = item(title: "D", status: .blocked(message: "w"))
        let all = [a, b, c, d]
        #expect(PendingChangesLogic.failedItems(all).map(\.title) == ["B"])
        #expect(PendingChangesLogic.outstandingItems(all).map(\.title) == ["A", "C", "D"])
    }

    @Test func typeLabelsAndNeverTopic() {
        #expect(PendingChangesLogic.typeLabel(.createTodo) == "Todo")
        #expect(PendingChangesLogic.typeLabel(.createTopic) == "Thema")
        #expect(PendingChangesLogic.typeLabel(.createProgressEntry) == "Zwischenstand")
    }

    @Test func titleSubtitleAndAccessibility() {
        let i = item(kind: .createTopic, title: "Budget", context: "Sprint", status: .failed(message: "Meeting weg."))
        #expect(PendingChangesLogic.displayTitle(item(title: "  ")) == "Todo")
        #expect(PendingChangesLogic.subtitle(i, now: now, calendar: cal) == "Sprint · erfasst heute, 14:32")
        #expect(PendingChangesLogic.subtitle(item(), now: now, calendar: cal) == "erfasst heute, 14:32")
        #expect(PendingChangesLogic.rowAccessibilityLabel(i, now: now, calendar: cal)
                == "Thema 'Budget', fehlgeschlagen. Meeting weg.. Sprint. Erfasst heute, 14 Uhr 32")
    }

    @Test func tapTargets() {
        #expect(PendingChangesLogic.tapTarget(for: .failed(message: "x")) == .detail)
        #expect(PendingChangesLogic.tapTarget(for: .blocked(message: "x")) == .detail)
        #expect(PendingChangesLogic.tapTarget(for: .pending) == .editForm)
        #expect(PendingChangesLogic.tapTarget(for: .syncing) == .editForm)
    }

    @Test func discardMessageViaSharedGating() {
        #expect(OfflineGating.discardMessage(title: "Budget", dependents: 0)
                == "'Budget' wird nicht übertragen und gelöscht. Zugehörige ausstehende Zwischenstände werden ebenfalls verworfen.")
        #expect(OfflineGating.discardMessage(title: " ", dependents: 0).hasPrefix("Der Eintrag wird"))
        #expect(PendingDetailLogic.discardTitle == OfflineTexts.discardButton)
        #expect(PendingDetailLogic.pendingReason == OfflineTexts.pendingNote)
    }

    @Test func discardRequestResolution() {
        let a = PendingItemSummary(id: UUID(), kind: .createTodo, title: "T", contextText: nil,
                                   capturedAt: Date(timeIntervalSince1970: 0), status: .pending,
                                   entityId: "local-1", refType: nil, refId: nil, fullText: "T")
        let b = PendingItemSummary(id: UUID(), kind: .createProgressEntry, title: "Z", contextText: nil,
                                   capturedAt: Date(timeIntervalSince1970: 1), status: .pending,
                                   entityId: nil, refType: "todo", refId: "r", fullText: "Z")
        let store = OfflineStatusStore()
        let rb = PendingChangesLogic.discardRequest(for: b, offline: store)
        #expect(!rb.showsDependentsHint)
        #expect(PendingChangesLogic.item(for: rb, in: [a, b])?.id == b.id)
        let ra = PendingChangesLogic.discardRequest(for: a, offline: store)
        #expect(ra.showsDependentsHint && ra.id == "local-1")
        #expect(PendingChangesLogic.item(for: ra, in: [a, b])?.id == a.id)
    }

    @Test func errorMessageDoesNotLeakInternals() {
        struct Internal: Error, CustomStringConvertible { var description: String { "/private/path/db.sqlite" } }
        #expect(PendingChangesLogic.errorMessage(for: Internal()) == PendingChangesLogic.genericError)
        #expect(PendingChangesLogic.errorMessage(for: OfflineOutboxError.invalidState) == PendingChangesLogic.genericError)
        #expect(PendingChangesLogic.errorMessage(for: OfflineError.pendingNotSynced)
                == OfflineError.pendingNotSynced.errorDescription)
    }

    @Test func editTargetUsesLocalBuilders() {
        let id = UUID()
        let todoSummary = PendingItemSummary(id: id, kind: .createTodo, title: "T", contextText: nil,
                                             capturedAt: now, status: .failed(message: "x"), entityId: nil,
                                             refType: nil, refId: nil, fullText: "")
        let todo = PendingEditTarget.make(summary: todoSummary,
                                          payload: .todo(PendingTodoPayload(title: "T", descriptionHTML: "<p>d</p>",
                                                                            snoozedUntil: nil, dueDate: nil, isPrivate: true)))
        guard case .todo(let t)? = todo else { Issue.record("kein Todo-Ziel"); return }
        #expect(t.id == "local-" + id.uuidString.lowercased())
        #expect(t.isPrivate && t.title == "T")

        let topic = PendingEditTarget.make(summary: todoSummary,
                                           payload: .topic(PendingTopicPayload(meetingId: "m1", title: "X", descriptionHTML: "",
                                                                               isTodo: false, snoozedUntil: nil)))
        guard case .topic(let mid, let tp)? = topic else { Issue.record("kein Thema-Ziel"); return }
        #expect(mid == "m1" && tp.meetingId == "m1")

        let progressPayload = PendingPayload.progress(PendingProgressPayload(ref: .server(refType: "todo", refId: "t1"),
                                                                              bodyHTML: "<p>x</p>", source: "manual"))
        #expect(PendingEditTarget.make(summary: todoSummary, payload: progressPayload) == nil) // Ref fehlt
        let withRef = item(kind: .createProgressEntry, refType: "todo", refId: "t1")
        guard case .progress(let e, let rt, let rid)? = PendingEditTarget.make(summary: withRef, payload: progressPayload) else {
            Issue.record("kein Zwischenstand-Ziel"); return
        }
        #expect(rt == "todo" && rid == "t1" && e.refId == "t1")
        #expect(PendingEditTarget.make(summary: todoSummary, payload: nil) == nil)
    }
}

@MainActor struct PendingDetailLogicTests {
    @Test func actionsForFailedTodoAndProgress() {
        let expected: [PendingDetailAction] = [.edit, .retry, .copy, .discard]
        #expect(PendingDetailLogic.actions(kind: .createTodo, status: .failed(message: "x")) == expected)
        #expect(PendingDetailLogic.actions(kind: .createProgressEntry, status: .failed(message: "x")) == expected)
    }

    @Test func actionsForFailedTopicIncludeReassignAndConvert() {
        #expect(PendingDetailLogic.actions(kind: .createTopic, status: .failed(message: "x"))
                == [.edit, .retry, .reassign, .convertToTodo, .copy, .discard])
    }

    @Test func dependentOnlyCopyAndDiscard() {
        #expect(PendingDetailLogic.actions(kind: .createProgressEntry, status: .blocked(message: "Wartet auf 'X'"))
                == [.copy, .discard])
    }

    @Test func pendingAndSyncing() {
        #expect(PendingDetailLogic.actions(kind: .createTopic, status: .pending) == [.edit, .copy, .discard])
        #expect(PendingDetailLogic.actions(kind: .createTodo, status: .syncing) == [.copy])
    }

    @Test func reasonTexts() {
        #expect(PendingDetailLogic.reasonText(for: .failed(message: "Grund")) == "Grund")
        #expect(PendingDetailLogic.reasonText(for: .blocked(message: "Wartet auf 'A', der fehlgeschlagen ist.")).hasPrefix("Wartet auf"))
        #expect(PendingDetailLogic.reasonText(for: .pending) == "Dieser Eintrag ist noch nicht übertragen.")
    }

    @Test func copyTextFallsBackToTitle() {
        #expect(PendingDetailLogic.copyText(for: item(title: "T", full: "T\n\nBody")) == "T\n\nBody")
        #expect(PendingDetailLogic.copyText(for: item(title: "T", full: "  \n")) == "T")
    }

    @Test func sheetTitleFollowsStatus() {
        #expect(PendingDetailLogic.title(for: .failed(message: "x")) == "Änderung fehlgeschlagen")
        #expect(PendingDetailLogic.title(for: .blocked(message: "x")) == "Änderung wartet")
        #expect(PendingDetailLogic.title(for: .pending) == "Ausstehende Änderung")
    }

    @Test func actionTitlesFollowUX() {
        #expect(PendingDetailLogic.actionTitle(.edit) == "Bearbeiten und erneut senden")
        #expect(PendingDetailLogic.actionTitle(.reassign) == "Anderem Meeting zuordnen")
        #expect(PendingDetailLogic.actionTitle(.convertToTodo) == "Als Todo übernehmen")
        #expect(PendingDetailLogic.actionTitle(.copy) == "Inhalt kopieren")
        #expect(PendingDetailLogic.actionTitle(.discard) == "Verwerfen")
    }
}

@MainActor struct PendingMeetingPickerLogicTests {
    private func meeting(_ id: String, _ title: String, archived: Bool? = nil) -> Meeting {
        Meeting(id: id, title: title, description: "", participants: [], isRecurring: false, recurrencePattern: "",
                nextDate: "", color: "#6366f1", sortOrder: nil, createdAt: "2026-01-01T00:00:00Z", topics: [],
                archived: archived, archivedAt: nil)
    }

    @Test func onlyActiveSortedAndSearchable() {
        let ms = [meeting("b", "Zebra"), meeting("a", "Änderung"), meeting("c", "Alt", archived: true)]
        #expect(PendingMeetingPickerLogic.candidates(ms, query: "").map(\.id) == ["a", "b"])
        #expect(PendingMeetingPickerLogic.candidates(ms, query: " zeb ").map(\.id) == ["b"])
        #expect(PendingMeetingPickerLogic.candidates(ms, query: "anderung").map(\.id) == ["a"])
        #expect(PendingMeetingPickerLogic.candidates(ms, query: "alt").isEmpty)
    }

    @Test func canAssignRules() {
        let ms = [meeting("a", "A"), meeting("c", "C", archived: true)]
        #expect(!PendingMeetingPickerLogic.canAssign(selection: nil, currentMeetingId: "a", meetings: ms))
        #expect(!PendingMeetingPickerLogic.canAssign(selection: "a", currentMeetingId: "a", meetings: ms))
        #expect(!PendingMeetingPickerLogic.canAssign(selection: "c", currentMeetingId: "a", meetings: ms))
        #expect(!PendingMeetingPickerLogic.canAssign(selection: "zz", currentMeetingId: "a", meetings: ms))
        #expect(PendingMeetingPickerLogic.canAssign(selection: "a", currentMeetingId: nil, meetings: ms))
    }

    @Test func emptyTextMentionsTodoFallback() {
        #expect(PendingMeetingPickerLogic.emptyText
                == "Kein aktives Meeting vorhanden. Du kannst den Eintrag als Todo übernehmen.")
        #expect(!PendingMeetingPickerLogic.title.contains("Topic"))
    }
}

@MainActor struct LogoutConfirmationLogicTests {
    @Test func confirmationOnlyWithUnsynced() {
        #expect(!LogoutConfirmationLogic.needsConfirmation(unsyncedCount: 0))
        #expect(!LogoutConfirmationLogic.needsConfirmation(unsyncedCount: -1))
        #expect(LogoutConfirmationLogic.needsConfirmation(unsyncedCount: 1))
    }

    @Test func messageAndButtons() {
        #expect(LogoutConfirmationLogic.title == "Abmelden?")
        #expect(LogoutConfirmationLogic.confirmTitle == "Abmelden und verwerfen")
        #expect(LogoutConfirmationLogic.message(unsyncedCount: 3) == "3 Änderungen sind noch nicht übertragen und gehen verloren.")
        #expect(LogoutConfirmationLogic.message(unsyncedCount: 1) == "1 Änderung ist noch nicht übertragen und geht verloren.")
    }
}
