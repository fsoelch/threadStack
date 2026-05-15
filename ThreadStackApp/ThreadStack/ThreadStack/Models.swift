import Foundation

// MARK: - Meeting

struct Meeting: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var description: String
    var participants: [String]
    var isRecurring: Bool
    var recurrencePattern: String
    var nextDate: String
    var color: String
    var sortOrder: Int?
    var createdAt: String
    var topics: [Topic]

    var openTopicsCount: Int { topics.filter { !$0.done && !$0.isSnoozed }.count }

    var nextDateParsed: Date? { parseFlexDate(nextDate) }
    var isPast: Bool { nextDateParsed.map { $0 < Date() } ?? false }

    var nextDateFormatted: String? {
        guard let d = nextDateParsed else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium; f.timeStyle = .short; f.locale = Locale(identifier: "de_DE")
        return f.string(from: d)
    }
}

// MARK: - Topic

struct Topic: Identifiable, Codable, Equatable {
    let id: String
    var meetingId: String?
    var title: String
    var description: String
    var done: Bool
    var result: String
    var resultDate: String
    var groupId: String?
    var isTodo: Bool
    var snoozedUntil: String?
    var sortOrder: Int?
    var createdAt: String

    var isSnoozed: Bool {
        guard let s = snoozedUntil, !s.isEmpty else { return false }
        return s.prefix(10) > todayString()
    }

    var snoozeWakeFormatted: String? {
        guard isSnoozed, let s = snoozedUntil else { return nil }
        return formatDateOnly(String(s.prefix(10)))
    }

    var resultDateParsed: Date? { parseFlexDate(resultDate) }
}

// MARK: - TodoItem

struct TodoItem: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var description: String
    var done: Bool
    var result: String
    var resultDate: String
    var snoozedUntil: String?
    var sortOrder: Int?
    var createdAt: String

    var isSnoozed: Bool {
        guard let s = snoozedUntil, !s.isEmpty else { return false }
        return s.prefix(10) > todayString()
    }

    var snoozeWakeFormatted: String? {
        guard isSnoozed, let s = snoozedUntil else { return nil }
        return formatDateOnly(String(s.prefix(10)))
    }
}

// MARK: - Theme

struct Theme: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var description: String
    var sortOrder: Int?
    var createdAt: String
    var links: [ThemeLink]
}

struct ThemeLink: Identifiable, Codable, Equatable {
    let id: String
    var refType: String
    var refId: String
}

// MARK: - Users

struct AppUser: Codable, Equatable {
    let id: String
    let username: String
    let role: String
    var isAdmin: Bool { role == "admin" }
}

struct AdminUser: Identifiable, Codable {
    let id: String
    let username: String
    let role: String
    let created_at: String
    var isAdmin: Bool { role == "admin" }
}

// MARK: - Date helpers

func todayString() -> Substring { ISO8601DateFormatter().string(from: Date()).prefix(10) }

func parseFlexDate(_ s: String) -> Date? {
    guard !s.isEmpty else { return nil }
    for fmt in ["yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm:ssZ",
                "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
        let f = DateFormatter(); f.dateFormat = fmt
        if let d = f.date(from: s) { return d }
    }
    return nil
}

func formatDateOnly(_ s: String) -> String {
    let parts = s.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return s }
    guard let d = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    else { return s }
    let f = DateFormatter(); f.dateStyle = .medium; f.locale = Locale(identifier: "de_DE")
    return f.string(from: d)
}

func toAPIDate(_ date: Date, dateOnly: Bool = false) -> String {
    let f = DateFormatter()
    f.dateFormat = dateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm"
    return f.string(from: date)
}

struct OKResponse: Codable { let ok: Bool? }
