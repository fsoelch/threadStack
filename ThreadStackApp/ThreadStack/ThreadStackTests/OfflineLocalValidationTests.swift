import Testing
import Foundation
@testable import ThreadStack

//  Paket P2: lokale Vorabpruefung (Stories 4/5/6) - gleiche Regeln/Texte wie der Server.

struct OfflineLocalValidationTests {
    typealias T = OfflineTestSupport
    typealias V = OfflineLocalValidation

    private func message(_ body: () throws -> Void) -> String? {
        do { try body(); return nil } catch let e as OfflineError {
            if case .validation(let m) = e { return m }
            return "anderer Fehler"
        } catch { return "unerwartet" }
    }

    @Test func validTodoPasses() {
        #expect(message { try V.validate(T.todo("Ok")) } == nil)
    }

    @Test func emptyOrWhitespaceTitleIsRejected() {
        #expect(message { try V.validate(T.todo("")) } == "Titel erforderlich")
        #expect(message { try V.validate(T.todo("  \n\t ")) } == "Titel erforderlich")
        #expect(message { try V.validate(T.topic("")) } == "Titel erforderlich")
    }

    @Test func titleLengthBoundary300() {
        #expect(message { try V.validate(T.todo(String(repeating: "a", count: 300))) } == nil)
        #expect(message { try V.validate(T.todo(String(repeating: "a", count: 301))) } == "Titel zu lang")
    }

    @Test func titleLengthIsMeasuredLikeJSLengthUTF16() {
        // 150 Emojis = 300 UTF-16-Einheiten (ok), 151 = 302 (zu lang), obwohl nur 151 Zeichen.
        #expect(message { try V.validate(T.todo(String(repeating: "😀", count: 150))) } == nil)
        #expect(message { try V.validate(T.todo(String(repeating: "😀", count: 151))) } == "Titel zu lang")
    }

    @Test func descriptionLimit() {
        var p = T.todo()
        p.descriptionHTML = String(repeating: "a", count: 500_000)
        #expect(message { try V.validate(p) } == nil)
        p.descriptionHTML += "a"
        #expect(message { try V.validate(p) } == "Beschreibung zu lang")
        var tp = T.topic()
        tp.descriptionHTML = String(repeating: "a", count: 500_001)
        #expect(message { try V.validate(tp) } == "Beschreibung zu lang")
    }

    @Test func dateValidationMirrorsServer() {
        for ok in ["", "2026-11-15", "2026-11-15T10:00:00.000Z", "2024-02-29"] { #expect(V.isValidDate(ok), "\(ok)") }
        for bad in ["2026-02-30", "2025-02-29", "15.11.2026", "2026-13-01", "2026-00-10", "2026-11-15 10:00",
                    "2026-11-15Tabc", "2026-11-15T", "garbage", "2026-1-5"] { #expect(!V.isValidDate(bad), "\(bad)") }
        var t = T.todo(); t.snoozedUntil = "2026-02-30"
        #expect(message { try V.validate(t) } == "Ungültiges Schlafen-bis-Datum")
        t.snoozedUntil = nil; t.dueDate = "kaputt"
        #expect(message { try V.validate(t) } == "Ungültiges Fälligkeitsdatum")
        var tp = T.topic(); tp.snoozedUntil = "kaputt"
        #expect(message { try V.validate(tp) } == "Ungültiges Schlafen-bis-Datum")
    }

    @Test func progressEmptyAndWhitespaceOnly() {
        for body in ["", "   ", "<p></p>", "<p>&nbsp;</p>", "<p> \u{00A0} </p><p><br></p>"] {
            #expect(message { try V.validateProgress(bodyHTML: body) } == "Der Zwischenstand darf nicht leer sein.", "\(body)")
        }
    }

    @Test func progressLengthBoundary5000MeasuredOnPlainText() {
        let ok = "<p>" + String(repeating: "a", count: 5000) + "</p>"
        let over = "<p><strong>" + String(repeating: "a", count: 5001) + "</strong></p>"
        #expect(message { try V.validateProgress(bodyHTML: ok) } == nil)
        #expect(message { try V.validateProgress(bodyHTML: over) } == "Der Zwischenstand ist zu lang.")
        #expect(message { try V.validate(PendingPayload.progress(T.progress(ref: .local(changeId: UUID()), body: over))) }
                == "Der Zwischenstand ist zu lang.")
    }

    @Test func progressHTMLHardLimit() {
        let huge = "<p>x</p>" + String(repeating: "<b></b>", count: 8000) // > 50.000 Zeichen
        #expect(huge.utf16.count > 50_000)
        #expect(message { try V.validateProgress(bodyHTML: huge) } == "Der Zwischenstand ist zu lang.")
    }

    @Test func plainTextNormalizesTagsEntitiesAndWhitespace() {
        #expect(V.plainText(fromHTML: "<p>Hallo &amp;   Welt</p>\n<p>zwei</p>") == "Hallo & Welt zwei")
        #expect(V.plainText(fromHTML: "") == "")
    }

    @Test func genericPayloadValidationDispatches() {
        #expect(message { try V.validate(PendingPayload.todo(T.todo(""))) } == "Titel erforderlich")
        #expect(message { try V.validate(PendingPayload.topic(T.topic("ok"))) } == nil)
    }
}
