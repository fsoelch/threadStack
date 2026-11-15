import Foundation
import CryptoKit

//  UserScopedFileStore.swift
//  Arbeitspaket P2 (Offline-Modus), Schnittstelle S-5.
//
//  Verallgemeinerung der Sicherheitsbausteine des KnowledgeDraftStore:
//  gehashtes Scope-Verzeichnis (kein Pfad aus Nutzer-ID/URL), Dateischutz
//  `.completeFileProtection` (iOS) bereits beim Schreiben, Ausschluss vom
//  Backup und eine strikte Allowlist fuer Dateinamen (Path-Traversal-Schutz).
//  Layout: `<baseDirectory>/<sha256(scopeKey)>/<stem>.json`.

enum UserScopedFileStoreError: Error, Equatable {
    case noDirectory, unsafeFileName, writeFailed
}

/// `nonisolated`: reines Datei-IO, muss auch ausserhalb des MainActors
/// (z.B. Hintergrund-Schreiben des Snapshots) aufrufbar sein.
nonisolated struct UserScopedFileStore {
    let baseDirectory: URL

    init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    /// `Application Support/<namespace>`. `nil`, wenn der Namespace unsicher ist
    /// oder das Verzeichnis nicht ermittelbar ist.
    static func applicationSupport(namespace: String) -> UserScopedFileStore? {
        guard isSafeFileStem(namespace),
              let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                  in: .userDomainMask).first else { return nil }
        return UserScopedFileStore(baseDirectory: dir.appendingPathComponent(namespace, isDirectory: true))
    }

    /// SHA-256 (hex) des Scope-Schluessels.
    static func scopeDirectoryName(forKey key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// `^[A-Za-z0-9_-]{1,64}$`. Bewusst ohne Regex (`$` wuerde ein
    /// abschliessendes Newline durchlassen).
    static func isSafeFileStem(_ s: String) -> Bool {
        let scalars = Array(s.unicodeScalars)
        guard (1...64).contains(scalars.count) else { return false }
        return scalars.allSatisfy { c in
            (c.value >= 0x30 && c.value <= 0x39) || (c.value >= 0x41 && c.value <= 0x5A) ||
            (c.value >= 0x61 && c.value <= 0x7A) || c == "_" || c == "-"
        }
    }

    // MARK: Pfade

    /// Akzeptiert `<stem>` oder `<stem>.json`; der Stem muss sicher sein.
    private static func stem(of fileName: String) throws -> String {
        let s = fileName.hasSuffix(".json") ? String(fileName.dropLast(5)) : fileName
        guard isSafeFileStem(s) else { throw UserScopedFileStoreError.unsafeFileName }
        return s
    }

    private func scopeURL(_ scopeKey: String) throws -> URL {
        guard !scopeKey.isEmpty else { throw UserScopedFileStoreError.noDirectory }
        return baseDirectory.appendingPathComponent(Self.scopeDirectoryName(forKey: scopeKey), isDirectory: true)
    }

    private func fileURL(scopeKey: String, fileName: String) throws -> URL {
        try scopeURL(scopeKey).appendingPathComponent(Self.stem(of: fileName) + ".json")
    }

    private func unscopedURL(_ fileName: String) throws -> URL {
        baseDirectory.appendingPathComponent(try Self.stem(of: fileName) + ".json")
    }

    // MARK: Schreiben/Lesen (scoped)

    func write(_ data: Data, scopeKey: String, fileName: String) throws {
        let url = try fileURL(scopeKey: scopeKey, fileName: fileName)
        try writeFile(data, to: url, directory: url.deletingLastPathComponent())
    }

    /// `nil` = Datei existiert nicht. Andere Lesefehler werden geworfen.
    func read(scopeKey: String, fileName: String) throws -> Data? {
        try readFile(try fileURL(scopeKey: scopeKey, fileName: fileName))
    }

    func remove(scopeKey: String, fileName: String) {
        guard let url = try? fileURL(scopeKey: scopeKey, fileName: fileName) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    func removeScope(scopeKey: String) {
        guard let url = try? scopeURL(scopeKey) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: baseDirectory)
    }

    /// Benennt die Datei in `<stem>.corrupt-<epoch>.json` um (nie still loeschen).
    func quarantine(scopeKey: String, fileName: String) throws {
        let url = try fileURL(scopeKey: scopeKey, fileName: fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let stem = try Self.stem(of: fileName)
        let epoch = Int(Date().timeIntervalSince1970)
        let dir = url.deletingLastPathComponent()
        var target = dir.appendingPathComponent("\(stem).corrupt-\(epoch).json")
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            target = dir.appendingPathComponent("\(stem).corrupt-\(epoch)-\(n).json")
            n += 1
        }
        do { try FileManager.default.moveItem(at: url, to: target) }
        catch { throw UserScopedFileStoreError.writeFailed }
    }

    // MARK: Ohne Scope (z.B. Session-Marker)

    func writeUnscoped(_ data: Data, fileName: String) throws {
        let url = try unscopedURL(fileName)
        try writeFile(data, to: url, directory: baseDirectory)
    }

    func readUnscoped(fileName: String) throws -> Data? {
        try readFile(try unscopedURL(fileName))
    }

    func removeUnscoped(fileName: String) {
        guard let url = try? unscopedURL(fileName) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: Intern

    private func writeFile(_ data: Data, to url: URL, directory: URL) throws {
        do {
            if !FileManager.default.fileExists(atPath: directory.path) {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            options.insert(.completeFileProtection)
            #endif
            try data.write(to: url, options: options)
        } catch {
            throw UserScopedFileStoreError.writeFailed
        }
        excludeFromBackup(url)
        excludeFromBackup(directory)
        if directory != baseDirectory { excludeFromBackup(baseDirectory) }
    }

    private func readFile(_ url: URL) throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }

    private func excludeFromBackup(_ url: URL) {
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }
}
