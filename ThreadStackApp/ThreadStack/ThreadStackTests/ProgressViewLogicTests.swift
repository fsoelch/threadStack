//
//  ProgressViewLogicTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A2 ("App-UI-Bausteine Progress"): Tests für die reinen,
//  aus den SwiftUI-Views extrahierten Logik-Funktionen (siehe
//  `ProgressBadgeView.swift`, `ProgressTimelineView.swift`,
//  `ProgressReentryCardView.swift`, `ProgressEntryEditorSheet.swift`,
//  `DescriptionReadView.swift`). SwiftUI-View-Bodies selbst werden hier
//  bewusst NICHT getestet (siehe Vertrag: "da SwiftUI-Views selbst schwer
//  isoliert testbar sind, extrahiere reine Logik-Funktionen").
//
//  `ProgressGoalEditorSheet.swift` (inkl. `ProgressGoalCharLimit`) entfiel
//  ersatzlos: das Zielbild wird laut Produktentscheidung vollständig aus der
//  App-UI entfernt (siehe `ProgressDetail.goal`, DEPRECATED) — die
//  zugehörigen `ProgressGoalCharLimitTests` unten entfielen deshalb ebenso.
//

import Testing
import Foundation
import SwiftUI
@testable import ThreadStack

// MARK: - Fixtures

private func makeSummary(
    entryCount: Int = 5,
    lastEntryAt: String? = "2026-08-20T10:00:00.000Z",
    stale: Bool = false,
    staleDays: Int? = nil,
    dormant: Bool = false,
    dormantSince: String? = nil,
    orderKey: String? = nil,
    undocumented: Bool = false,
    nextStep: String? = nil,
    badgeLabel: String? = "5 Zwischenstände · vor 3 Tagen",
    badgeEmphasis: String = "normal"
) -> ProgressSummary {
    ProgressSummary(
        entryCount: entryCount, lastEntryAt: lastEntryAt, stale: stale, staleDays: staleDays,
        dormant: dormant, dormantSince: dormantSince, orderKey: orderKey, undocumented: undocumented,
        nextStep: nextStep, badgeLabel: badgeLabel, badgeEmphasis: badgeEmphasis
    )
}

private func makeEntry(
    id: String = "e1",
    kind: String = "note",
    bodyHtml: String = "<p>Kurzer Text</p>",
    excerpt: String = "Kurzer Text",
    editable: Bool = true,
    gapDaysBefore: Int = 0,
    showDormancyMarker: Bool = false
) -> ProgressEntry {
    ProgressEntry(
        id: id, refType: "todo", refId: "t1", kind: kind, source: "manual",
        bodyHtml: bodyHtml, excerpt: excerpt, createdAt: "2026-08-20T10:00:00.000Z",
        editedAt: nil, gapDaysBefore: gapDaysBefore, showDormancyMarker: showDormancyMarker, editable: editable
    )
}

private func makeReentry(
    show: Bool = true,
    dormantSince: String? = "2026-08-01T00:00:00.000Z",
    dormantLabel: String? = "ruht seit 3 Wochen",
    empty: Bool = false,
    aiAvailable: Bool = false,
    aiFrameId: String? = nil
) -> ProgressReentry {
    ProgressReentry(
        show: show, dormantSince: dormantSince, dormantLabel: dormantLabel, empty: empty,
        ai: ProgressReentryAI(available: aiAvailable, frameId: aiFrameId)
    )
}

// MARK: - Badge-Logik (ProgressBadgeLogic)

struct ProgressBadgeLogicTests {

    @Test func nilSummaryIsNotVisible() {
        #expect(ProgressBadgeLogic.isVisible(nil) == false)
    }

    @Test func zeroEntryCountIsNotVisible() {
        let summary = makeSummary(entryCount: 0, badgeLabel: nil)
        #expect(ProgressBadgeLogic.isVisible(summary) == false)
    }

    @Test func positiveEntryCountIsVisible() {
        let summary = makeSummary(entryCount: 1)
        #expect(ProgressBadgeLogic.isVisible(summary) == true)
    }

    @Test func displayTextUsesServerBadgeLabelWhenPresent() {
        let summary = makeSummary(badgeLabel: "5 Zwischenstände · vor 3 Tagen")
        #expect(ProgressBadgeLogic.displayText(summary) == "5 Zwischenstände · vor 3 Tagen")
    }

    @Test func displayTextFallsBackWhenBadgeLabelMissing() {
        let summary = makeSummary(entryCount: 1, badgeLabel: nil)
        #expect(ProgressBadgeLogic.displayText(summary) == "1 Zwischenstand")
        let summaryPlural = makeSummary(entryCount: 3, badgeLabel: nil)
        #expect(ProgressBadgeLogic.displayText(summaryPlural) == "3 Zwischenstände")
    }

    @Test func displayTextFallsBackWhenBadgeLabelIsWhitespaceOnly() {
        let summary = makeSummary(entryCount: 2, badgeLabel: "   ")
        #expect(ProgressBadgeLogic.displayText(summary) == "2 Zwischenstände")
    }

    @Test func iconChangesWithEmphasis() {
        #expect(ProgressBadgeLogic.iconName(for: .normal) == "chart.line.uptrend.xyaxis")
        #expect(ProgressBadgeLogic.iconName(for: .stale) == "hourglass")
        // Ein unbekannter/zukünftiger Server-Wert fällt auf dasselbe Icon wie
        // "normal" zurück statt abzustürzen.
        #expect(ProgressBadgeLogic.iconName(for: .unknown) == "chart.line.uptrend.xyaxis")
    }

    @Test func accessibilityLabelAddsStaleHintOnlyWhenStale() {
        let normal = makeSummary(badgeEmphasis: "normal")
        #expect(ProgressBadgeLogic.accessibilityLabel(normal).contains("länger nicht aktualisiert") == false)

        let stale = makeSummary(badgeEmphasis: "stale")
        let label = ProgressBadgeLogic.accessibilityLabel(stale)
        #expect(label.hasPrefix("Fortschritt: "))
        #expect(label.contains("länger nicht aktualisiert"))
    }

    @Test func badgeEmphasisKindMapsUnknownServerValueSafely() {
        let summary = makeSummary(badgeEmphasis: "some_future_value")
        #expect(summary.badgeEmphasisKind == .unknown)
    }
}

// MARK: - Kürzung/Aufklapp-Schwellenwert (ProgressEntryTruncation)

struct ProgressEntryTruncationTests {

    @Test func notTruncatedWhenExcerptMatchesPlainBody() {
        let isTruncated = ProgressEntryTruncation.isTruncated(
            excerpt: "Kurzer Text", bodyHtml: "<p>Kurzer Text</p>"
        )
        #expect(isTruncated == false)
    }

    @Test func truncatedWhenExcerptShorterThanPlainBody() {
        let fullText = String(repeating: "Wort ", count: 200)
        let isTruncated = ProgressEntryTruncation.isTruncated(
            excerpt: "Wort Wort Wort…", bodyHtml: "<p>\(fullText)</p>"
        )
        #expect(isTruncated == true)
    }

    @Test func emptyExcerptIsTreatedAsNotTruncated() {
        // Defensiv: ein leerer excerpt (unerwartete Server-Antwort) darf
        // nicht fälschlich einen "Mehr anzeigen"-Toggle vor leerem Text
        // erzeugen — stattdessen wird der volle Inhalt direkt gerendert.
        let isTruncated = ProgressEntryTruncation.isTruncated(excerpt: "", bodyHtml: "<p>Text</p>")
        #expect(isTruncated == false)
    }

    @Test func whitespaceOnlyDifferencesAreNotConsideredTruncated() {
        let isTruncated = ProgressEntryTruncation.isTruncated(
            excerpt: "  Kurzer Text  ", bodyHtml: "<p>Kurzer Text</p>"
        )
        #expect(isTruncated == false)
    }
}

// MARK: - Wiedereinstiegskarte / KI-Button (ProgressReentryLogic)

struct ProgressReentryLogicTests {

    @Test func shouldShowCardReflectsReentryShowFlag() {
        #expect(ProgressReentryLogic.shouldShowCard(makeReentry(show: true)) == true)
        #expect(ProgressReentryLogic.shouldShowCard(makeReentry(show: false)) == false)
    }

    @Test func isReducedVariantReflectsEmptyFlag() {
        #expect(ProgressReentryLogic.isReducedVariant(makeReentry(empty: true)) == true)
        #expect(ProgressReentryLogic.isReducedVariant(makeReentry(empty: false)) == false)
    }

    @Test func aiButtonRequiresBothAvailableAndFeatureEnabled() {
        #expect(ProgressReentryLogic.shouldShowAIButton(available: true, aiFeatureEnabled: true) == true)
        #expect(ProgressReentryLogic.shouldShowAIButton(available: true, aiFeatureEnabled: false) == false)
        #expect(ProgressReentryLogic.shouldShowAIButton(available: false, aiFeatureEnabled: true) == false)
        #expect(ProgressReentryLogic.shouldShowAIButton(available: false, aiFeatureEnabled: false) == false)
    }
}

// MARK: - Zeichenzähler Zwischenstand (ProgressEntryCharLimit, Grenze 5000)

struct ProgressEntryCharLimitTests {

    @Test func counterHiddenBelowWarnThreshold() {
        #expect(ProgressEntryCharLimit.shouldShowCounter(length: 4499) == false)
    }

    @Test func counterVisibleAtAndAboveWarnThreshold() {
        #expect(ProgressEntryCharLimit.shouldShowCounter(length: 4500) == true)
        #expect(ProgressEntryCharLimit.shouldShowCounter(length: 5000) == true)
        #expect(ProgressEntryCharLimit.shouldShowCounter(length: 5001) == true)
    }

    @Test func exactlyAtLimitIsNotOverLimit() {
        #expect(ProgressEntryCharLimit.isOverLimit(length: 5000) == false)
    }

    @Test func oneOverLimitIsOverLimit() {
        #expect(ProgressEntryCharLimit.isOverLimit(length: 5001) == true)
    }

    @Test func saveDisabledWhenContentLengthZero() {
        #expect(ProgressEntryCharLimit.isSaveDisabled(contentLength: 0) == true)
    }

    @Test func saveEnabledForNonEmptyContentWithinLimit() {
        #expect(ProgressEntryCharLimit.isSaveDisabled(contentLength: 120) == false)
    }

    @Test func saveEnabledExactlyAtLimit() {
        #expect(ProgressEntryCharLimit.isSaveDisabled(contentLength: 5000) == false)
    }

    @Test func saveDisabledOverLimit() {
        #expect(ProgressEntryCharLimit.isSaveDisabled(contentLength: 5001) == true)
    }

    @Test func effectivelyEmptyDetectsWhitespaceOnlyHtml() {
        #expect(ProgressEntryCharLimit.isEffectivelyEmpty(html: "<p>&nbsp;</p>") == false)
        // &nbsp; strips to a non-breaking space character via stripHTML, not
        // plain whitespace, so this documents the current (conservative)
        // behavior rather than asserting an unverified false positive.
        #expect(ProgressEntryCharLimit.isEffectivelyEmpty(html: "<p>   </p>") == true)
        #expect(ProgressEntryCharLimit.isEffectivelyEmpty(html: "") == true)
        #expect(ProgressEntryCharLimit.isEffectivelyEmpty(html: "<p>Text</p>") == false)
    }
}

// MARK: - Dormancy-Marker-Formatierung (ProgressDormancyFormatting)

struct ProgressDormancyFormattingTests {

    @Test func singularDayIsFormattedCorrectly() {
        #expect(ProgressDormancyFormatting.durationText(1) == "1 Tag")
    }

    @Test func pluralDaysBelowTwoWeeks() {
        #expect(ProgressDormancyFormatting.durationText(5) == "5 Tage")
        #expect(ProgressDormancyFormatting.durationText(13) == "13 Tage")
    }

    @Test func weeksFromTwoWeeksUpToJustBelowSixtyDays() {
        // Randfall untere Grenze: 14 Tage ist der erste Wert, der NICHT mehr
        // in die "Tage"-Bucket fällt (siehe `pluralDaysBelowTwoWeeks`, wo 13
        // noch "13 Tage" ergibt).
        #expect(ProgressDormancyFormatting.durationText(14) == "2 Wochen")
        #expect(ProgressDormancyFormatting.durationText(21) == "3 Wochen")
        // Randfall obere Grenze: 59 Tage ist der letzte Wert vor dem Wechsel
        // zu "Monate" bei 60 (siehe `monthsFromSixtyDaysOn`).
        #expect(ProgressDormancyFormatting.durationText(59) == "8 Wochen")
    }

    @Test func singularWeekBelowFourteenDaysNeverOccursButSevenDaysStaysInDaysBucket() {
        // 7 Tage liegt unter der 14-Tage-Schwelle und wird bewusst noch als
        // Tage ausgegeben, NICHT als "1 Woche" — die Wochen-Einheit beginnt
        // erst ab der 14-Tage-Schwelle (siehe `weeksFromTwoWeeksUpToJustBelowSixtyDays`).
        #expect(ProgressDormancyFormatting.durationText(7) == "7 Tage")
    }

    @Test func monthsFromSixtyDaysOn() {
        // Randfall untere Grenze: 60 Tage ist der erste Wert in der
        // "Monate"-Bucket (59 ist noch "8 Wochen", siehe oben).
        #expect(ProgressDormancyFormatting.durationText(60) == "2 Monate")
        #expect(ProgressDormancyFormatting.durationText(90) == "3 Monate")
    }

    @Test func negativeGapDaysAreClampedToZero() {
        #expect(ProgressDormancyFormatting.durationText(-3) == "0 Tage")
    }

    @Test func labelAndAccessibilityLabelUseSameDuration() {
        #expect(ProgressDormancyFormatting.label(gapDays: 21) == "🌙 3 Wochen Pause")
        #expect(ProgressDormancyFormatting.accessibilityLabel(gapDays: 21) == "Ruhephase: 3 Wochen ohne Zwischenstand")
    }
}

// MARK: - Sanity: Fixtures decodieren wie erwartet (Randfall-Absicherung)

struct ProgressViewLogicFixtureTests {

    @Test func entryFixtureHonorsEditableFlag() {
        let editable = makeEntry(editable: true)
        let notEditable = makeEntry(id: "e2", kind: "result", editable: false)
        #expect(editable.editable == true)
        #expect(notEditable.editable == false)
        #expect(notEditable.kind == "result")
    }
}

// MARK: - Zielbild-Entfernung (ProgressDetail.goal jetzt optional/DEPRECATED)

struct ProgressDetailGoalRemovalTests {

    /// Regression: `ProgressDetail.goal` wurde von `String` auf `String?`
    /// geändert (Zielbild entfällt vollständig aus der App-UI) — stellt
    /// sicher, dass sowohl ein weiterhin vom Server gelieferter Wert als
    /// auch dessen vollständiges Fehlen klaglos decodiert werden.
    @Test func decodesWithGoalFieldPresent() throws {
        let json = """
        {"ref":{"type":"todo","id":"t1","title":"x","done":false,"exists":true},
         "goal":"Altes Zielbild","goalUpdatedAt":"2026-08-01T00:00:00.000Z",
         "nextStep":"","nextStepUpdatedAt":null,
         "stats":{"entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                   "dormant":false,"dormantDays":null,"stale":false,"staleDays":null},
         "reentry":{"show":false,"dormantSince":null,"dormantLabel":null,"empty":true,
                    "ai":{"available":false,"frameId":null}},
         "entries":[], "page":{"limit":20,"hasMore":false,"nextCursor":null}}
        """
        let detail = try JSONDecoder().decode(ProgressDetail.self, from: Data(json.utf8))
        #expect(detail.goal == "Altes Zielbild")
    }

    @Test func decodesWithGoalFieldNull() throws {
        let json = """
        {"ref":{"type":"todo","id":"t1","title":"x","done":false,"exists":true},
         "goal":null,"goalUpdatedAt":null,
         "nextStep":"","nextStepUpdatedAt":null,
         "stats":{"entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                   "dormant":false,"dormantDays":null,"stale":false,"staleDays":null},
         "reentry":{"show":false,"dormantSince":null,"dormantLabel":null,"empty":true,
                    "ai":{"available":false,"frameId":null}},
         "entries":[], "page":{"limit":20,"hasMore":false,"nextCursor":null}}
        """
        let detail = try JSONDecoder().decode(ProgressDetail.self, from: Data(json.utf8))
        #expect(detail.goal == nil)
    }
}

// MARK: - Beschreibungs-Leseansicht (DescriptionReadLogic)

struct DescriptionReadLogicTests {

    @Test func emptyHtmlIsEffectivelyEmpty() {
        #expect(DescriptionReadLogic.isEffectivelyEmpty(html: "") == true)
    }

    @Test func whitespaceOnlyMarkupIsEffectivelyEmpty() {
        #expect(DescriptionReadLogic.isEffectivelyEmpty(html: "<p>   </p>") == true)
    }

    @Test func nonEmptyTextIsNotEffectivelyEmpty() {
        #expect(DescriptionReadLogic.isEffectivelyEmpty(html: "<p>Hallo</p>") == false)
    }

    @Test func placeholderTextDoesNotMentionZielbild() {
        // Regression: die Beschreibungs-Leseansicht darf niemals das entfernte
        // Zielbild-Konzept erwähnen.
        #expect(DescriptionReadLogic.placeholderText.localizedCaseInsensitiveContains("Zielbild") == false)
    }
}

// MARK: - Eingebetteter Fortschrittsverlauf: Seitengröße/Fehlertext (ProgressTimelineView)

struct ProgressTimelineEmbeddedConfigTests {

    @Test func embeddedPageSizeIsThree() {
        #expect(ProgressTimelineConfig.embeddedPageSize == 3)
    }

    @Test func embeddedLoadErrorTextMatchesUXVorgabe() {
        #expect(ProgressTimelineConfig.embeddedLoadErrorText
                == "Das hat leider nicht geklappt. Bitte später erneut versuchen.")
    }
}
