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
        if s.count > 10, let d = parseFlexDate(s) { return d > Date() }
        return s.prefix(10) > todayString()
    }

    var snoozeWakeFormatted: String? {
        guard isSnoozed, let s = snoozedUntil else { return nil }
        if s.count > 10, let d = parseFlexDate(s) {
            let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; f.locale = Locale(identifier: "de_DE")
            return f.string(from: d)
        }
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
    var dueDate: String?
    var isPrivate: Bool = false
    var sortOrder: Int?
    var createdAt: String
    // Nur gesetzt bei GET /themes/:id/todos?includeDescendants= — zeigt Herkunfts-Unter-Topic
    var originThemeId: String?
    var originThemeTitle: String?

    var isSnoozed: Bool {
        guard let s = snoozedUntil, !s.isEmpty else { return false }
        if s.count > 10, let d = parseFlexDate(s) { return d > Date() }
        return s.prefix(10) > todayString()
    }

    var snoozeWakeFormatted: String? {
        guard isSnoozed, let s = snoozedUntil else { return nil }
        if s.count > 10, let d = parseFlexDate(s) {
            let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; f.locale = Locale(identifier: "de_DE")
            return f.string(from: d)
        }
        return formatDateOnly(String(s.prefix(10)))
    }

    /// Sortier-Schlüssel: Fälligkeitsdatum oder "9999..." damit Todos ohne dueDate ans Ende rutschen
    var dueSortKey: String {
        if let d = dueDate, !d.isEmpty { return String(d.prefix(10)) }
        return "9999-12-31"
    }

    var dueDateFormatted: String? {
        guard let d = dueDate, !d.isEmpty else { return nil }
        return formatDateOnly(String(d.prefix(10)))
    }

    /// nil = kein Datum, true = überfällig, false = fällig oder zukünftig
    var dueStatus: DueStatus {
        guard let d = dueDate, !d.isEmpty else { return .none }
        let due = String(d.prefix(10))
        let today = todayString()
        if due < today { return .overdue }
        if due == today { return .today }
        return .future
    }
}

enum DueStatus { case none, overdue, today, future }

// MARK: - Theme

struct Theme: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var description: String
    var parentId: String?
    var sortOrder: Int?
    var createdAt: String
    var links: [ThemeLink]
}

struct ThemeLink: Identifiable, Codable, Equatable {
    let id: String
    var refType: String
    var refId: String
}

struct ThemeDeletePreview: Codable {
    let subTopicCount: Int
    let knowledgePageCount: Int
}

// MARK: - Knowledge (Wissensseiten)
// originThemeId/originThemeTitle sind nur bei den themenbezogenen Endpoints
// (GET /themes/:id/knowledge?includeDescendants=) gesetzt — zeigen, aus welchem
// Unter-Topic ein vererbter Eintrag stammt.
struct KnowledgePage: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var content: String
    var sortOrder: Int?
    var createdAt: String
    var updatedAt: String
    var themeIds: [String]
    var originThemeId: String?
    var originThemeTitle: String?
}

// MARK: - Contact (Ansprechpartner)

struct Contact: Identifiable, Codable, Equatable {
    let id: String
    var name: String
    var role: String
    var email: String
    var description: String
    var sortOrder: Int?
    var createdAt: String
    var updatedAt: String?
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

// MARK: - v1.1 Phase 2: Stack-Layer

struct StackFrame: Identifiable, Codable, Equatable {
    let id: String
    let ref_type: String
    let ref_id: String
    let title: String
    let ref_exists: Bool?
    let next_step_note: String
    let pushed_at: String
    let popped_at: String?
    let parent_frame_id: String?
    let pop_resolution: String?
    let age_seconds: Int

    var ageFormatted: String {
        let s = age_seconds
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m) min" }
        let h = m / 60, rm = m % 60
        return rm > 0 ? "\(h)h \(rm)min" : "\(h)h"
    }
}

struct StackResponse:        Codable { let frames: [StackFrame]; let depth: Int }
struct StackPushResponse:    Codable { let frame: StackFrame; let depth: Int; let depth_warning: Bool }
struct StackPopAppliedFlags: Codable {
    let topicDone: Bool?; let todoDone: Bool?
    let snoozedUntil: String?; let resultSaved: Bool?
}
struct StackPopResponse: Codable {
    let frame: StackFrame; let next_active: StackFrame?
    let applied: StackPopAppliedFlags?; let drift_warning: Bool
}
struct StackHistoryResponse: Codable { let frames: [StackFrame]; let count: Int }

// MARK: - v1.1: AI Settings

struct AIFeatures: Codable, Equatable {
    var brief: Bool; var capture: Bool; var result_draft: Bool; var reentry: Bool
    var theme_tagging: Bool; var digest: Bool; var cross_meeting: Bool; var drift: Bool
    static let defaults = AIFeatures(brief: true, capture: true, result_draft: true,
                                     reentry: true, theme_tagging: false, digest: false,
                                     cross_meeting: false, drift: false)
}

struct AISettings: Codable, Equatable {
    var provider: String; var model: String
    var api_key_last4: String
    var azure_endpoint: String; var azure_api_version: String
    var features_enabled: AIFeatures
    var max_monthly_cost_cents: Int
    var confirm_threshold_cents: Int
    var globally_disabled: Bool
    var drift_days: Int?
    var theme_tag_threshold: Double?
    var weekly_digest_enabled: Bool?
    var weekly_digest_dow: Int?
    var weekly_digest_hour: Int?
    var configured: Bool

    var isActive: Bool { configured && !globally_disabled }
}

// MARK: - v1.1: AI feature payloads

struct BriefContent: Codable, Equatable {
    let talking_points: [String]
    let open_issues: [String]
    let history: String
}
struct BriefResponse: Codable { let artifact_id: String; let content: BriefContent; let cost_cents: Int }

struct CaptureNewTopic: Codable, Equatable, Identifiable {
    var id: String { title + "|" + (description ?? "") }
    let title: String; let description: String?
    let suggested_meeting_id: String?
}
struct CaptureTopicResult: Codable, Equatable, Identifiable {
    var id: String { topic_id }
    let topic_id: String; let result: String
}
struct CaptureNewTodo: Codable, Equatable, Identifiable {
    var id: String { title + "|" + (description ?? "") }
    let title: String; let description: String?
}
struct CaptureThemeLink: Codable, Equatable {
    let ref_type: String; let ref_id: String; let theme_id: String
}
struct CaptureSuggestions: Codable, Equatable {
    var new_topics: [CaptureNewTopic]
    var topic_results: [CaptureTopicResult]
    var new_todos: [CaptureNewTodo]
    var theme_links: [CaptureThemeLink]
}
struct CaptureResponse: Codable { let suggestions: CaptureSuggestions; let cost_cents: Int }

struct ResultDraftResponse: Codable { let draft: String; let cost_cents: Int }

struct ReentryContent: Codable { let summary: String }
struct ReentryResponse: Codable {
    let artifact_id: String; let content: ReentryContent; let cost_cents: Int
}

struct ThemeSuggestion: Codable, Equatable, Identifiable {
    var id: String { theme_id }
    let theme_id: String; let theme_title: String
    let confidence: Double; let existing: Bool?
}
struct ThemeSuggestionsResponse: Codable {
    let suggestions: [ThemeSuggestion]; let cost_cents: Int?; let note: String?
}

struct DigestContent: Codable, Equatable {
    let summary: String; let highlights: [String]?; let focus_next: [String]?
}
struct DigestResponse: Codable {
    let artifact_id: String?; let content: DigestContent
    let week: String?; let cached: Bool?; let cost_cents: Int?
}
struct DigestArchiveEntry: Codable, Identifiable {
    var id: String { artifact_id }
    let artifact_id: String; let week: String
    let model: String?; let created_at: String; let content: DigestContent
}
struct DigestArchiveResponse: Codable { let entries: [DigestArchiveEntry] }

struct CMIMatch: Codable, Equatable, Identifiable {
    var id: String { this_topic_id + "|" + other_topic_id }
    let this_topic_id: String; let this_topic_title: String
    let other_topic_id: String; let other_topic_title: String
    let other_meeting: String
    let confidence: Double; let reason: String
}
struct CMIContent:  Codable, Equatable { let matches: [CMIMatch] }
struct CMIResponse: Codable {
    let artifact_id: String?; let content: CMIContent; let cost_cents: Int?
}

struct DriftItem: Codable, Equatable, Identifiable {
    var id: String { topic_id }
    let topic_id: String; let title: String
    let meeting_id: String; let meeting_title: String
    let days_idle: Int
}
struct DriftResponse: Codable { let drifted: [DriftItem]; let drift_days: Int }

struct AIUsageEntry: Codable, Identifiable {
    var id: String { feature }
    let feature: String; let cost_cents: Int; let tokens: Int; let calls: Int
}
struct AIUsageResponse: Codable {
    let period: String; let since: String?
    let total_cost_cents: Int; let entries: [AIUsageEntry]
}

struct AIErrorDetail: Codable {
    let estimated_cost_cents: Int?; let threshold_cents: Int?
    let spent_cents: Int?; let limit_cents: Int?; let estimated_cents: Int?
}
struct AIErrorBody: Codable {
    let error: String; let code: String?; let detail: AIErrorDetail?
}
