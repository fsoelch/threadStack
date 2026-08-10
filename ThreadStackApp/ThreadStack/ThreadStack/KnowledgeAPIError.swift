import Foundation

/// Structured error for the Knowledge API surface, preserving the server's
/// `code` (e.g. "KNOWLEDGE_PAGE_GONE") and optional `limit` (validation
/// errors like TITLE_TOO_LONG / CONTENT_TOO_LONG) instead of collapsing
/// everything into a plain string as `APIError.server` does.
///
/// The `message` field is passed through verbatim from the server's `error`
/// field, which is already a German, user-facing message (never a stack
/// trace or internal detail — see server.js `fail()`), so it is safe to show
/// directly to the user.
struct KnowledgeAPIError: LocalizedError, Equatable {
    let status: Int
    /// Server-`code`, e.g. "KNOWLEDGE_PAGE_GONE". Empty string if the server
    /// did not provide a `code` field.
    let code: String
    /// Server-`error` message (already German, user-facing).
    let message: String
    /// Present for TITLE_TOO_LONG (300) / CONTENT_TOO_LONG (500000) style
    /// validation errors that carry a `limit` field.
    let limit: Int?

    var errorDescription: String? { message }
    var isGone: Bool { status == 404 }
}

// MARK: - Verbindliche Code-Konstanten (server.js `fail(res, status, code, msg, extra)`)

enum KnowledgeErrorCode {
    static let titleRequired      = "TITLE_REQUIRED"
    static let titleTooLong       = "TITLE_TOO_LONG"       // limit 300
    static let contentTooLong     = "CONTENT_TOO_LONG"     // limit 500000
    static let knowledgePageGone  = "KNOWLEDGE_PAGE_GONE"
    static let validationFailed   = "VALIDATION_FAILED"
    static let notFound           = "NOT_FOUND"
}
