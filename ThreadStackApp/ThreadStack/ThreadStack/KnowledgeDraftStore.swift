import Foundation

/// A locally persisted, unsaved edit of a knowledge page (native rich-text
/// editor). Drafts let the editor survive app termination / crashes without
/// silently losing user input, and are cleared once the user explicitly
/// saves or discards.
struct KnowledgeDraft: Codable, Equatable {
    var schemaVersion: Int = 1
    /// nil = draft for a new (not yet created) page.
    let pageId: String?
    var title: String
    var contentHTML: String
    var themeIds: [String]
    var relatedPageIds: [String]
    var baseUpdatedAt: String?
    var savedAt: Date
}

/// Persists `KnowledgeDraft`s to disk, one file per (user, page).
///
/// Storage layout: `Application Support/KnowledgeDrafts/<sha256(userId)>/<pageId | "new">.json`.
/// Datei-IO, Hashing, Dateischutz (`.completeFileProtection` schon beim
/// Schreiben, iOS), Backup-Ausschluss und Namensvalidierung liegen in
/// `UserScopedFileStore` (gemeinsame Loesung mit dem Offline-Bestand).
///
/// Security considerations:
/// - Drafts contain ordinary user content (knowledge page text), not secrets,
///   but are still scoped per-user (hashed user id directory) and protected
///   while the device is locked, and are excluded from iCloud/iTunes backups
///   since a draft is inherently transient, unsynced local state.
/// - `pageId` originates from server-issued ids in this app's normal flow,
///   but is still treated as external input for filename construction: it is
///   validated against a strict allow-list pattern before being used to build
///   a path, to rule out path traversal (e.g. `../../etc`) if a caller ever
///   passes an unexpected value.
enum KnowledgeDraftStore {

    private static var fileStore: UserScopedFileStore? {
        UserScopedFileStore.applicationSupport(namespace: "KnowledgeDrafts")
    }

    /// Sanitized filename stem for a page id — falls back to "new" for nil
    /// or any value that does not match the strict allow-list (defense in
    /// depth against path traversal via unexpected input).
    private static func fileStem(for pageId: String?) -> String {
        guard let pageId, UserScopedFileStore.isSafeFileStem(pageId) else { return "new" }
        return pageId
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    enum DraftStoreError: Error {
        case noDirectory
    }

    /// Atomically writes the draft to disk, protected while the device is
    /// locked and excluded from backups.
    static func save(_ draft: KnowledgeDraft, userId: String) throws {
        guard !userId.isEmpty, let store = fileStore else { throw DraftStoreError.noDirectory }
        let data = try encoder.encode(draft)
        try store.write(data, scopeKey: userId, fileName: fileStem(for: draft.pageId))
    }

    /// Loads a previously saved draft. Returns `nil` if none exists, or if
    /// the file is corrupt / from an incompatible (future) schema — in that
    /// case the broken file is removed so it does not keep failing silently
    /// on every future load attempt.
    static func load(pageId: String?, userId: String) -> KnowledgeDraft? {
        guard !userId.isEmpty, let store = fileStore else { return nil }
        let stem = fileStem(for: pageId)
        let data: Data?
        do { data = try store.read(scopeKey: userId, fileName: stem) }
        catch {
            store.remove(scopeKey: userId, fileName: stem)
            return nil
        }
        guard let data else { return nil }
        guard let draft = try? decoder.decode(KnowledgeDraft.self, from: data),
              draft.schemaVersion == 1 else {
            store.remove(scopeKey: userId, fileName: stem)
            return nil
        }
        return draft
    }

    /// Removes a single draft (e.g. after a successful save / explicit discard).
    static func delete(pageId: String?, userId: String) {
        guard !userId.isEmpty, let store = fileStore else { return }
        store.remove(scopeKey: userId, fileName: fileStem(for: pageId))
    }

    /// Removes drafts for ALL users. Must be called on logout: drafts are
    /// unsynced local content of the previously authenticated user and must
    /// not remain reachable to whoever uses the device/app next.
    static func clearAll() {
        fileStore?.removeAll()
    }
}
