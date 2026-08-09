//
//  LinkInsertSheetTests.swift
//  ThreadStackTests
//
//  Unit tests for Paket 4 (Native iOS/macOS-Umsetzung von "KI-Zusammenfassung
//  beim Einfügen von Links"): Decoding der Backend-Contracts
//  (`POST /api/ai/link/fetch`, `POST /api/ai/link/summarize`), Rückwärts-
//  kompatibilität von `AIFeatures.link_summary`, das exakte Klartext-
//  Einfügeformat sowie die deutsche Fehlertext-Zuordnung.
//

import Testing
import Foundation
@testable import ThreadStack

struct LinkFetchDecodingTests {

    @Test func decodesFullFetchResponse() throws {
        let json = """
        { "page_token": "tok-1", "title": "Beispielseite", "final_url": "https://example.com/a",
          "lang": "de", "text_chars": 1234, "truncated": false }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LinkFetchResponse.self, from: json)
        #expect(decoded.page_token == "tok-1")
        #expect(decoded.title == "Beispielseite")
        #expect(decoded.final_url == "https://example.com/a")
        #expect(decoded.lang == "de")
        #expect(decoded.text_chars == 1234)
        #expect(decoded.truncated == false)
    }

    @Test func decodesFetchResponseWithNullableFieldsMissing() throws {
        // title/lang/text_chars/truncated können laut Vertrag fehlen bzw. null sein.
        let json = """
        { "page_token": "tok-2", "final_url": "https://example.com/b" }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LinkFetchResponse.self, from: json)
        #expect(decoded.page_token == "tok-2")
        #expect(decoded.title == nil)
        #expect(decoded.lang == nil)
    }
}

struct LinkSummarizeDecodingTests {

    @Test func decodesSummaryResponse() throws {
        let json = """
        { "summary": "Kurze Zusammenfassung.", "length": "short", "truncated": true, "cost_cents": 3 }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LinkSummaryResponse.self, from: json)
        #expect(decoded.summary == "Kurze Zusammenfassung.")
        #expect(decoded.length == "short")
        #expect(decoded.truncated == true)
        #expect(decoded.cost_cents == 3)
    }
}

struct AIFeaturesLinkSummaryTests {

    @Test func missingFieldDecodesAsOffForBackwardCompatibilityWithOlderServers() throws {
        // Älterer Server kennt "link_summary" noch nicht — das Feld fehlt komplett im JSON.
        // Ein non-optionales Feld würde hier die gesamte AISettings-Dekodierung brechen.
        let json = """
        { "brief": true, "capture": true, "result_draft": true, "reentry": true,
          "theme_tagging": false, "digest": false, "cross_meeting": false, "drift": false }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(AIFeatures.self, from: json)
        #expect(decoded.link_summary == nil)
        #expect(decoded.linkSummaryOn == false)
    }

    @Test func explicitTrueDecodesAsOn() throws {
        let json = """
        { "brief": true, "capture": true, "result_draft": true, "reentry": true,
          "theme_tagging": false, "digest": false, "cross_meeting": false, "drift": false,
          "link_summary": true }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(AIFeatures.self, from: json)
        #expect(decoded.link_summary == true)
        #expect(decoded.linkSummaryOn == true)
    }

    @Test func explicitFalseDecodesAsOff() throws {
        let json = """
        { "brief": true, "capture": true, "result_draft": true, "reentry": true,
          "theme_tagging": false, "digest": false, "cross_meeting": false, "drift": false,
          "link_summary": false }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(AIFeatures.self, from: json)
        #expect(decoded.link_summary == false)
        #expect(decoded.linkSummaryOn == false)
    }

    @Test func defaultsHaveLinkSummaryOff() {
        #expect(AIFeatures.defaults.linkSummaryOn == false)
    }
}

struct LinkInsertFormattingTests {

    @Test func linkOnlyFormatMatchesContractExactly() {
        #expect(linkInsertLinkOnlyText("https://example.com/a") == "🔗 https://example.com/a")
    }

    @Test func summaryFormatMatchesContractExactly() {
        let text = linkInsertSummaryText(link: "https://example.com/a", summary: "Kurzfassung.")
        #expect(text == "🔗 https://example.com/a\n\n✨ KI-Zusammenfassung: Kurzfassung.")
    }

    @Test func formatEuroConvertsCentsToGermanDecimalComma() {
        #expect(linkInsertFormatEuro(cents: 1234) == "12,34 €")
        #expect(linkInsertFormatEuro(cents: 5) == "0,05 €")
        #expect(linkInsertFormatEuro(cents: 0) == "0,00 €")
    }
}

struct LinkInsertErrorMappingTests {

    private func err(code: String?, status: Int = 400, message: String = "Server-Fehler") -> APIAIError {
        APIAIError(status: status, message: message, code: code, detail: nil)
    }

    @Test func mapsAllKnownFetchAndSummarizeCodesToGermanText() {
        let cases: [(String, String)] = [
            ("invalid_url", "Keine gültige http/https-Adresse."),
            ("blocked_target", "Diese Adresse kann nicht abgerufen werden."),
            ("no_text_content", "Auf der Seite wurde zu wenig Text gefunden."),
            ("fetch_timeout", "Die Seite hat nicht rechtzeitig geantwortet."),
            ("fetch_failed", "Die Seite ist nicht erreichbar."),
            ("too_large", "Die Seite ist zu groß."),
            ("unsupported_content_type", "Dieser Inhaltstyp lässt sich nicht zusammenfassen."),
            ("empty_summary", "Die KI hat keine Zusammenfassung geliefert."),
            ("page_token_expired", "Der Seiteninhalt ist nicht mehr verfügbar, bitte erneut laden."),
            ("fetch_http_error", "Die Seite konnte nicht geladen werden."),
            ("too_many_redirects", "Zu viele Weiterleitungen."),
            ("fetch_in_progress", "Ein Abruf läuft bereits, bitte kurz warten."),
            ("invalid_length", "Ungültige Länge ausgewählt."),
        ]
        for (code, expected) in cases {
            #expect(linkInsertMapError(err(code: code)) == expected, "code=\(code)")
        }
    }

    @Test func mapsBudgetExceededByCode() {
        #expect(linkInsertMapError(err(code: "budget_exceeded", status: 402)) == "Monatliches KI-Budget ist erreicht.")
    }

    @Test func mapsBudgetExceededByStatusEvenWithoutCode() {
        // budgetExceeded ist auch true, wenn status==402 aber code nil/unbekannt ist.
        #expect(linkInsertMapError(err(code: nil, status: 402)) == "Monatliches KI-Budget ist erreicht.")
    }

    @Test func unknownOrFeatureGatingCodeFallsBackToServerMessage() {
        let e = err(code: nil, status: 409, message: "Diese Funktion ist deaktiviert.")
        #expect(linkInsertMapError(e) == "Diese Funktion ist deaktiviert.")
    }

    @Test func confirmationRequiredIsDetectedViaStatusOrCode() {
        let byStatus = err(code: nil, status: 428)
        let byCode = err(code: "confirmation_required", status: 200)
        #expect(byStatus.needsConfirmation)
        #expect(byCode.needsConfirmation)
    }

    @Test func estimatedCostIsReadFromDetailOnConfirmationRequired() {
        let detail = AIErrorDetail(estimated_cost_cents: 42, threshold_cents: 10,
                                    spent_cents: nil, limit_cents: nil, estimated_cents: nil)
        let e = APIAIError(status: 428, message: "Bestätigung nötig", code: "confirmation_required", detail: detail)
        #expect(e.needsConfirmation)
        #expect(e.detail?.estimated_cost_cents == 42)
    }
}
