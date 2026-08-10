//
//  KnowledgeLinkTests.swift
//  ThreadStackTests
//
//  Unit tests für Arbeitspaket 3 ("knowledge-link") des Features "Nativer
//  Rich-Text-Editor für Wissen (iOS/macOS)": die reinen, testbaren
//  Hilfsfunktionen `knowledgeLinkSplitSummary` und `knowledgeLinkIsValidHttpURL`
//  sowie die Struktur von `KnowledgeLinkResult`.
//

import Testing
import Foundation
@testable import ThreadStack

struct KnowledgeLinkSplitSummaryTests {

    @Test func splitsOnSingleBlankLine() {
        let result = knowledgeLinkSplitSummary("Erster Absatz.\n\nZweiter Absatz.")
        #expect(result == ["Erster Absatz.", "Zweiter Absatz."])
    }

    @Test func splitsOnMultipleConsecutiveBlankLines() {
        let result = knowledgeLinkSplitSummary("Erster Absatz.\n\n\n\nZweiter Absatz.")
        #expect(result == ["Erster Absatz.", "Zweiter Absatz."])
    }

    @Test func trimsLeadingAndTrailingWhitespacePerParagraph() {
        let result = knowledgeLinkSplitSummary("  Erster Absatz.  \n\n  Zweiter Absatz.\t")
        #expect(result == ["Erster Absatz.", "Zweiter Absatz."])
    }

    @Test func dropsEmptyParagraphsCausedByWhitespaceOnlyBlocks() {
        // Ein Block, der nur aus Leerraum besteht, gilt nach dem Trimmen als leer
        // und wird verworfen — z. B. bei "\n\n   \n\n".
        let result = knowledgeLinkSplitSummary("Erster Absatz.\n\n   \n\nZweiter Absatz.")
        #expect(result == ["Erster Absatz.", "Zweiter Absatz."])
    }

    @Test func completelyEmptyStringYieldsEmptyArray() {
        #expect(knowledgeLinkSplitSummary("") == [])
    }

    @Test func whitespaceOnlyStringYieldsEmptyArray() {
        #expect(knowledgeLinkSplitSummary("   \n\n  \n\n ") == [])
    }

    @Test func singleParagraphWithoutBlankLineIsKeptAsOneElement() {
        #expect(knowledgeLinkSplitSummary("Nur ein Absatz ohne Leerzeile.") == ["Nur ein Absatz ohne Leerzeile."])
    }
}

struct KnowledgeLinkIsValidHttpURLTests {

    @Test func acceptsValidHttpsURL() {
        #expect(knowledgeLinkIsValidHttpURL("https://example.com/a") == true)
    }

    @Test func acceptsValidHttpURL() {
        #expect(knowledgeLinkIsValidHttpURL("http://example.com") == true)
    }

    @Test func acceptsSchemelessInputAfterNormalization() {
        // linkInsertNormalizeUrl ergänzt https:// bei fehlendem Schema.
        #expect(knowledgeLinkIsValidHttpURL("example.com") == true)
    }

    @Test func rejectsJavascriptSchemeWithSlashes() {
        // "javascript://…" enthält bereits "://" und wird von
        // linkInsertNormalizeUrl deshalb nicht verändert — das Schema bleibt
        // "javascript" und muss abgelehnt werden.
        #expect(knowledgeLinkIsValidHttpURL("javascript://alert(1)") == false)
    }

    @Test func rejectsFtpScheme() {
        #expect(knowledgeLinkIsValidHttpURL("ftp://example.com") == false)
    }

    @Test func rejectsEmptyHost() {
        #expect(knowledgeLinkIsValidHttpURL("https:///path") == false)
    }

    @Test func rejectsEmptyString() {
        #expect(knowledgeLinkIsValidHttpURL("") == false)
    }

    @Test func rejectsWhitespaceOnlyString() {
        #expect(knowledgeLinkIsValidHttpURL("   ") == false)
    }

    @Test func rejectsSchemelessJavascriptLikeInputBecauseItGetsHttpsSchemeApplied() {
        // "javascript:alert(1)" enthält kein "://" und wird deshalb von
        // linkInsertNormalizeUrl zu "https://javascript:alert(1)" — das ist keine
        // gültige Autorität (Host mit ungültigem Port-Anteil) und URLComponents
        // liefert dafür keine gültigen Components, also ebenfalls ungültig.
        #expect(knowledgeLinkIsValidHttpURL("javascript:alert(1)") == false)
    }
}

struct KnowledgeLinkResultTests {

    @Test func equatableComparesAllFields() {
        let a = KnowledgeLinkResult(href: "https://example.com", text: "Beispiel", summaryParagraphs: ["Eins", "Zwei"])
        let b = KnowledgeLinkResult(href: "https://example.com", text: "Beispiel", summaryParagraphs: ["Eins", "Zwei"])
        let c = KnowledgeLinkResult(href: "https://example.com", text: "Beispiel", summaryParagraphs: ["Eins"])
        #expect(a == b)
        #expect(a != c)
    }

    @Test func linkOnlyModeHasEmptySummaryParagraphsByContract() {
        let r = KnowledgeLinkResult(href: "https://example.com", text: "Beispiel", summaryParagraphs: [])
        #expect(r.summaryParagraphs.isEmpty)
    }
}
