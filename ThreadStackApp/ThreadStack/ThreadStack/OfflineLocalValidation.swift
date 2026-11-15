import Foundation

//  OfflineLocalValidation.swift
//  Arbeitspaket P2: lokale Vorabpruefung (Stories 4/5/6). Gleiche Regeln und
//  gleiche Texte wie der Server (server.js / lib/progress); Laengen nach
//  `utf16.count` (entspricht JS `String.length`). Nur Vorabpruefung - der
//  Server bleibt massgeblich.

enum OfflineLocalValidation {
    static let maxTitle = 300
    static let maxDescription = 500_000
    static let maxProgressHTML = 50_000
    static var maxProgressText: Int { ProgressEntryCharLimit.maxLength }

    static let titleRequired = "Titel erforderlich"
    static let titleTooLong = "Titel zu lang"
    static let descriptionTooLong = "Beschreibung zu lang"
    static let invalidSnoozeDate = "Ungültiges Schlafen-bis-Datum"
    static let invalidDueDate = "Ungültiges Fälligkeitsdatum"
    static let progressEmpty = "Der Zwischenstand darf nicht leer sein."
    static let progressTooLong = "Der Zwischenstand ist zu lang."

    static func validate(_ p: PendingTodoPayload) throws {
        try validateCommon(title: p.title, description: p.descriptionHTML)
        if let s = p.snoozedUntil, !isValidDate(s) { throw OfflineError.validation(invalidSnoozeDate) }
        if let d = p.dueDate, !isValidDate(d) { throw OfflineError.validation(invalidDueDate) }
    }

    static func validate(_ p: PendingTopicPayload) throws {
        try validateCommon(title: p.title, description: p.descriptionHTML)
        if let s = p.snoozedUntil, !isValidDate(s) { throw OfflineError.validation(invalidSnoozeDate) }
    }

    static func validate(_ p: PendingProgressPayload) throws {
        try validateProgress(bodyHTML: p.bodyHTML)
    }

    static func validateProgress(bodyHTML: String) throws {
        if bodyHTML.utf16.count > maxProgressHTML { throw OfflineError.validation(progressTooLong) }
        let text = plainText(fromHTML: bodyHTML)
        if text.isEmpty { throw OfflineError.validation(progressEmpty) }
        if text.utf16.count > maxProgressText { throw OfflineError.validation(progressTooLong) }
    }

    static func validate(_ payload: PendingPayload) throws {
        switch payload {
        case .todo(let p): try validate(p)
        case .topic(let p): try validate(p)
        case .progress(let p): try validate(p)
        }
    }

    private static func validateCommon(title: String, description: String) throws {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw OfflineError.validation(titleRequired) }
        if title.utf16.count > maxTitle { throw OfflineError.validation(titleTooLong) }
        if description.utf16.count > maxDescription { throw OfflineError.validation(descriptionTooLong) }
    }

    /// Spiegel von `isValidDate` (server.js): leer ok; `YYYY-MM-DD` optional mit
    /// `T…`-Zeitteil (Zeichen `0-9 : . Z + -`, 1-30), real existierender Kalendertag.
    static func isValidDate(_ s: String) -> Bool {
        if s.isEmpty { return true }
        let chars = Array(s.unicodeScalars)
        guard chars.count >= 10 else { return false }
        func digits(_ r: Range<Int>) -> Int? {
            var v = 0
            for i in r {
                let c = chars[i].value
                guard c >= 0x30 && c <= 0x39 else { return nil }
                v = v * 10 + Int(c - 0x30)
            }
            return v
        }
        guard chars[4] == "-", chars[7] == "-",
              let y = digits(0..<4), let mo = digits(5..<7), let d = digits(8..<10) else { return false }
        if chars.count > 10 {
            guard chars[10] == "T", (1...30).contains(chars.count - 11) else { return false }
            let allowed = Set("0123456789:.Z+-".unicodeScalars)
            guard chars[11...].allSatisfy({ allowed.contains($0) }) else { return false }
        }
        guard (1...12).contains(mo), d >= 1 else { return false }
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return d <= days[mo - 1]
    }

    /// Klartext eines HTML-Fragments: Tags entfernt, haeufige Entities
    /// dekodiert, Whitespace (inkl. NBSP) normalisiert und getrimmt.
    static func plainText(fromHTML html: String) -> String {
        var text = stripHTML(html)
        for (entity, rep) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""),
                              ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: rep)
        }
        let parts = text.components(separatedBy: CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "\u{00A0}")))
        return parts.filter { !$0.isEmpty }.joined(separator: " ")
    }
}
