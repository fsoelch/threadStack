//
//  TodoOverviewLogicTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A3 ("App-UI Übersicht und Meeting-Detail"): Tests für die
//  reinen, aus den SwiftUI-Views extrahierten Logik-Funktionen (siehe
//  `TodosView.swift` — `TodoOverviewLogic`, `AISummaryCardView.swift` —
//  `AISummaryCardLogic`/`AISummaryCardKind`, `SummaryModels.swift` —
//  `AISummaryStatus`, `SummaryStore.swift`). SwiftUI-View-Bodies selbst
//  werden hier bewusst NICHT getestet (analog `ProgressViewLogicTests`).
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Fixtures

private func makeSummaryView(status: String, text: String? = "Zusammenfassungstext",
                              updatedAt: String? = "2026-08-20T10:00:00.000Z") -> AISummaryView {
    AISummaryView(status: status, text: text, updatedAt: updatedAt)
}

// MARK: - AISummaryStatus (Robustheit gegen unbekannte Server-Werte)

struct AISummaryStatusTests {

    @Test func mapsAllKnownStatusValues() {
        #expect(AISummaryView(status: "ready", text: nil, updatedAt: nil).kind == .ready)
        #expect(AISummaryView(status: "stale", text: nil, updatedAt: nil).kind == .stale)
        #expect(AISummaryView(status: "pending", text: nil, updatedAt: nil).kind == .pending)
        #expect(AISummaryView(status: "error", text: nil, updatedAt: nil).kind == .error)
        #expect(AISummaryView(status: "disabled", text: nil, updatedAt: nil).kind == .disabled)
        #expect(AISummaryView(status: "not_applicable", text: nil, updatedAt: nil).kind == .notApplicable)
    }

    @Test func unknownServerValueFallsBackSafely() {
        #expect(AISummaryView(status: "some_future_status", text: nil, updatedAt: nil).kind == .unknown)
        #expect(AISummaryView(status: "", text: nil, updatedAt: nil).kind == .unknown)
    }
}

// MARK: - AISummaryCardLogic

struct AISummaryCardLogicTests {

    @Test func readyStaleePendingErrorAreRendered() {
        #expect(AISummaryCardLogic.shouldRender(.ready) == true)
        #expect(AISummaryCardLogic.shouldRender(.stale) == true)
        #expect(AISummaryCardLogic.shouldRender(.pending) == true)
        #expect(AISummaryCardLogic.shouldRender(.error) == true)
    }

    /// Sicherer Default: `disabled`/`not_applicable`/`unknown` rendern NICHTS
    /// (siehe Vertrag: `not_applicable` deckt sowohl "wirklich nicht
    /// anwendbar" als auch "Bestandsdaten ohne bisherige Generierung" ab —
    /// niemals ein "Jetzt zusammenfassen"-Button).
    @Test func disabledNotApplicableAndUnknownAreNotRendered() {
        #expect(AISummaryCardLogic.shouldRender(.disabled) == false)
        #expect(AISummaryCardLogic.shouldRender(.notApplicable) == false)
        #expect(AISummaryCardLogic.shouldRender(.unknown) == false)
    }

    @Test func spinnerOnlyWhenPendingAndMotionNotReduced() {
        #expect(AISummaryCardLogic.showsSpinner(status: .pending, reduceMotion: false) == true)
        #expect(AISummaryCardLogic.showsSpinner(status: .pending, reduceMotion: true) == false)
        #expect(AISummaryCardLogic.showsSpinner(status: .ready, reduceMotion: false) == false)
    }

    @Test func staleAccessibilityLabelMentionsUpdating() {
        let label = AISummaryCardLogic.staleAccessibilityLabel(text: "Alter Text", badgeLabel: "KI-Zusammenfassung")
        #expect(label.contains("Alter Text"))
        #expect(label.contains("wird aktualisiert"))
    }

    @Test func kindLabelsAndAPIValuesDiffer() {
        #expect(AISummaryCardKind.progress.badgeLabel == "KI-Zusammenfassung")
        #expect(AISummaryCardKind.description.badgeLabel == "KI-Kurzfassung")
        #expect(AISummaryCardKind.progress.apiValue == "progress")
        #expect(AISummaryCardKind.description.apiValue == "description")
    }
}

// MARK: - TodoOverviewLogic (Sichtbarkeit Fortschrittszeile/Composer/KI-Karte)

struct TodoOverviewLogicTests {

    @Test func progressBadgeHiddenOnlyWhenDone() {
        #expect(TodoOverviewLogic.showsProgressBadge(done: false) == true)
        #expect(TodoOverviewLogic.showsProgressBadge(done: true) == false)
    }

    /// Erledigte Todos: kein Composer (unabhängig von `isReadOnly`, das für
    /// Todos immer `false` ist).
    @Test func composerHiddenWhenDone() {
        #expect(TodoOverviewLogic.showsInlineComposer(done: true, isReadOnly: false) == false)
        #expect(TodoOverviewLogic.showsInlineComposer(done: false, isReadOnly: false) == true)
    }

    /// Archivierte Meeting-Themen: kein Composer, auch wenn nicht erledigt
    /// (bestehender Schreibschutz).
    @Test func composerHiddenWhenReadOnlyEvenIfNotDone() {
        #expect(TodoOverviewLogic.showsInlineComposer(done: false, isReadOnly: true) == false)
    }

    @Test func aiSummaryHiddenWhenDoneOrReadOnly() {
        #expect(TodoOverviewLogic.showsAISummary(done: true, isReadOnly: false) == false)
        #expect(TodoOverviewLogic.showsAISummary(done: false, isReadOnly: true) == false)
        #expect(TodoOverviewLogic.showsAISummary(done: false, isReadOnly: false) == true)
    }

    @Test func pollingStartsOnlyWhenVisibleAndPending() {
        let pendingPair = AISummaryPair(progress: makeSummaryView(status: "pending"), description: nil)
        let readyPair = AISummaryPair(progress: makeSummaryView(status: "ready"), description: nil)

        #expect(TodoOverviewLogic.shouldStartPolling(done: false, isReadOnly: false, pair: pendingPair) == true)
        #expect(TodoOverviewLogic.shouldStartPolling(done: false, isReadOnly: false, pair: readyPair) == false)
        #expect(TodoOverviewLogic.shouldStartPolling(done: false, isReadOnly: false, pair: nil) == false)
        // Erledigt/ReadOnly: kein Polling, selbst wenn (noch) pending im Store steht.
        #expect(TodoOverviewLogic.shouldStartPolling(done: true, isReadOnly: false, pair: pendingPair) == false)
        #expect(TodoOverviewLogic.shouldStartPolling(done: false, isReadOnly: true, pair: pendingPair) == false)
    }

    @Test func pollingConsidersDescriptionStatusToo() {
        let pair = AISummaryPair(progress: makeSummaryView(status: "ready"), description: makeSummaryView(status: "pending"))
        #expect(TodoOverviewLogic.shouldStartPolling(done: false, isReadOnly: false, pair: pair) == true)
    }
}

// MARK: - SummaryStore (Ingest/Zustand ohne Netzwerk)

@MainActor
struct SummaryStoreIngestTests {

    @Test func ingestPopulatesFromTodoAISummary() {
        let store = SummaryStore()
        let pair = AISummaryPair(progress: makeSummaryView(status: "ready", text: "Läuft gut"), description: nil)
        let todo = TodoItem(id: "t1", title: "T", description: "", done: false, result: "", resultDate: "",
                             snoozedUntil: nil, dueDate: nil, isPrivate: false, sortOrder: nil,
                             createdAt: "2026-08-01T00:00:00.000Z", originThemeId: nil, originThemeTitle: nil,
                             progress: nil, aiSummary: pair)

        store.ingest(from: [todo])

        #expect(store.pair(refType: "todo", refId: "t1")?.progress?.text == "Läuft gut")
    }

    @Test func ingestPopulatesFromTopicAISummary() {
        let store = SummaryStore()
        let pair = AISummaryPair(progress: nil, description: makeSummaryView(status: "ready", text: "Kurzfassung"))
        let topic = Topic(id: "x1", meetingId: "m1", title: "X", description: "lang…", done: false, result: "",
                           resultDate: "", groupId: nil, isTodo: false, snoozedUntil: nil, sortOrder: nil,
                           createdAt: "2026-08-01T00:00:00.000Z", progress: nil, aiSummary: pair)

        store.ingest(from: [topic])

        #expect(store.pair(refType: "topic", refId: "x1")?.description?.text == "Kurzfassung")
    }

    /// Ein Todo ohne `aiSummary` (nil) darf einen bereits vorhandenen,
    /// aktuelleren Eintrag (z.B. durch `poll`/`regenerate`) NICHT überschreiben.
    @Test func ingestDoesNotOverwriteWithNilAISummary() {
        let store = SummaryStore()
        let existing = AISummaryPair(progress: makeSummaryView(status: "ready", text: "Behalten"), description: nil)
        store.ingest(from: [TodoItem(id: "t1", title: "T", description: "", done: false, result: "",
                                      resultDate: "", snoozedUntil: nil, dueDate: nil, isPrivate: false,
                                      sortOrder: nil, createdAt: "2026-08-01T00:00:00.000Z",
                                      originThemeId: nil, originThemeTitle: nil, progress: nil, aiSummary: existing)])

        // Zweiter Ingest-Aufruf ohne aiSummary (z.B. veralteter Zwischenstand
        // aus einer anderen Quelle) — darf den Store nicht zurücksetzen.
        store.ingest(from: [TodoItem(id: "t1", title: "T", description: "", done: false, result: "",
                                      resultDate: "", snoozedUntil: nil, dueDate: nil, isPrivate: false,
                                      sortOrder: nil, createdAt: "2026-08-01T00:00:00.000Z",
                                      originThemeId: nil, originThemeTitle: nil, progress: nil, aiSummary: nil)])

        #expect(store.pair(refType: "todo", refId: "t1")?.progress?.text == "Behalten")
    }

    @Test func pairIsNilForUnknownRef() {
        let store = SummaryStore()
        #expect(store.pair(refType: "todo", refId: "unbekannt") == nil)
    }

    /// Abbrechen eines nicht laufenden Pollings darf nicht crashen (Randfall).
    @Test func cancelPollingWithoutRunningTaskIsNoop() {
        let store = SummaryStore()
        store.cancelPolling(for: .init(refType: "todo", refId: "t1"))
    }

    /// `regenerate` ohne angehängten `AppState` (Stand-in-Fehlerfall, siehe
    /// Abschlussbericht) wirft einen `ProgressError`, statt zu crashen oder
    /// interne Details zu leaken.
    @Test func regenerateWithoutAttachedAppStateThrowsOffline() async {
        let store = SummaryStore()
        await #expect(throws: ProgressError.self) {
            try await store.regenerate(kind: "progress", refType: "todo", refId: "t1")
        }
    }
}
