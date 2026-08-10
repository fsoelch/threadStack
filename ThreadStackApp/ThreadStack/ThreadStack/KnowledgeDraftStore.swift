import Foundation
import CryptoKit
#if canImport(UIKit)
import UIKit
#endif

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
///
/// Security considerations:
/// - Drafts contain ordinary user content (knowledge page text), not secrets,
///   but are still scoped per-user (hashed user id directory) and use
///   `.completeFileProtection` on iOS so content is inaccessible while the
///   device is locked, and are excluded from iCloud/iTunes backups since a
///   draft is inherently transient, unsynced local state.
/// - `pageId` originates from server-issued ids in this app's normal flow,
///   but is still treated as external input for filename construction: it is
///   validated against a strict allow-list pattern before being used to build
///   a path, to rule out path traversal (e.g. `../../etc`) if a caller ever
///   passes an unexpected value.
enum KnowledgeDraftStore {

    private static let pageIdPattern = "^[A-Za-z0-9_-]{1,64}$"

    private static func isValidPageId(_ id: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pageIdPattern) else { return false }
        let range = NSRange(id.startIndex..<id.endIndex, in: id)
        return regex.firstMatch(in: id, options: [], range: range) != nil
    }

    /// Sanitized filename stem for a page id — falls back to "new" for nil
    /// or any value that does not match the strict allow-list (defense in
    /// depth against path traversal via unexpected input).
    private static func fileStem(for pageId: String?) -> String {
        guard let pageId, isValidPageId(pageId) else { return "new" }
        return pageId
    }

    private static func userDirectoryName(userId: String) -> String {
        let digest = SHA256.hash(data: Data(userId.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static var baseDirectoryURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                   in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent("KnowledgeDrafts", isDirectory: true)
    }

    private static func userDirectoryURL(userId: String) -> URL? {
        guard let base = baseDirectoryURL else { return nil }
        return base.appendingPathComponent(userDirectoryName(userId: userId), isDirectory: true)
    }

    private static func fileURL(pageId: String?, userId: String) -> URL? {
        guard let dir = userDirectoryURL(userId: userId) else { return nil }
        return dir.appendingPathComponent(fileStem(for: pageId) + ".json")
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
        guard !userId.isEmpty else { throw DraftStoreError.noDirectory }
        guard let dir = userDirectoryURL(userId: userId),
              let url = fileURL(pageId: draft.pageId, userId: userId) else {
            throw DraftStoreError.noDirectory
        }
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        let data = try encoder.encode(draft)
        try data.write(to: url, options: .atomic)
        applyFileProtectionAndBackupExclusion(to: url)
    }

    /// Loads a previously saved draft. Returns `nil` if none exists, or if
    /// the file is corrupt / from an incompatible (future) schema — in that
    /// case the broken file is removed so it does not keep failing silently
    /// on every future load attempt.
    static func load(pageId: String?, userId: String) -> KnowledgeDraft? {
        guard !userId.isEmpty, let url = fileURL(pageId: pageId, userId: userId),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url),
              let draft = try? decoder.decode(KnowledgeDraft.self, from: data),
              draft.schemaVersion == 1 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return draft
    }

    /// Removes a single draft (e.g. after a successful save / explicit discard).
    static func delete(pageId: String?, userId: String) {
        guard !userId.isEmpty, let url = fileURL(pageId: pageId, userId: userId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Removes drafts for ALL users. Must be called on logout: drafts are
    /// unsynced local content of the previously authenticated user and must
    /// not remain reachable to whoever uses the device/app next.
    static func clearAll() {
        guard let base = baseDirectoryURL else { return }
        try? FileManager.default.removeItem(at: base)
    }

    private static func applyFileProtectionAndBackupExclusion(to url: URL) {
        #if canImport(UIKit) && !os(macOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        #endif
        var mutableURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutableURL.setResourceValues(values)
    }
}
