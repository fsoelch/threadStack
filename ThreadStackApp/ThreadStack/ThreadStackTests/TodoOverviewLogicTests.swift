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
                              generatedAt: String? = "2026-08-20T10:00:00.000Z") -> AISummaryView {
    AISummaryView(status: status, text: text, generatedAt: generatedAt, model: "mock-model", errorCode: nil)
}

// MARK: - AISummaryStatus (Robustheit gegen unbekannte Server-Werte)

struct AISummaryStatusTests {

    @Test func mapsAllKnownStatusValues() {
        #expect(AISummaryView(status: "ready", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .ready)
        #expect(AISummaryView(status: "stale", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .stale)
        #expect(AISummaryView(status: "pending", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .pending)
        #expect(AISummaryView(status: "error", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .error)
        #expect(AISummaryView(status: "disabled", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .disabled)
        #expect(AISummaryView(status: "not_applicable", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .notApplicable)
    }

    @Test func unknownServerValueFallsBackSafely() {
        #expect(AISummaryView(status: "some_future_status", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .unknown)
        #expect(AISummaryView(status: "", text: nil, generatedAt: nil, model: nil, errorCode: nil).kind == .unknown)
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

// Hinweis: Grundlegendes SummaryStore-Verhalten (ingest/pair/cancelPolling/
// regenerate-Fehlerpfad) wird bereits vollständig durch die A1-eigenen Tests
// in `SummaryStoreTests.swift` (`SummaryStoreIngestTests`,
// `SummaryStoreRegenerateTests`, `SummaryStorePollBehaviorTests`) abgedeckt -
// keine zweite, parallele Testsuite dafür (Wiederverwendung statt
// Neuentwicklung, siehe CLAUDE.md).
