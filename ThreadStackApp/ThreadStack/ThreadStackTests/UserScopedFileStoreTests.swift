import Testing
import Foundation
import CryptoKit
@testable import ThreadStack

//  Paket P2, S-5: UserScopedFileStore.

@MainActor @Suite(.serialized)
struct UserScopedFileStoreTests {

    private func data(_ s: String) -> Data { Data(s.utf8) }

    @Test func writeThenReadRoundTrips() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("hallo"), scopeKey: "k1", fileName: "outbox")
        #expect(try store.read(scopeKey: "k1", fileName: "outbox") == data("hallo"))
        try store.write(data("neu"), scopeKey: "k1", fileName: "outbox")
        #expect(try store.read(scopeKey: "k1", fileName: "outbox") == data("neu"))
    }

    @Test func readOfMissingFileIsNil() throws {
        let store = OfflineTestSupport.makeStore()
        #expect(try store.read(scopeKey: "k1", fileName: "nix") == nil)
        #expect(try store.readUnscoped(fileName: "nix") == nil)
    }

    @Test func scopesAreIsolatedAndDirectoryIsHashed() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("A"), scopeKey: "https://s\nuserA", fileName: "f")
        #expect(try store.read(scopeKey: "https://s\nuserB", fileName: "f") == nil)
        let names = try FileManager.default.contentsOfDirectory(atPath: store.baseDirectory.path)
        #expect(names == [UserScopedFileStore.scopeDirectoryName(forKey: "https://s\nuserA")])
        #expect(!names[0].contains("userA"))
    }

    @Test func scopeDirectoryNameIsSha256Hex() {
        let expected = SHA256.hash(data: Data("abc".utf8)).map { String(format: "%02x", $0) }.joined()
        #expect(UserScopedFileStore.scopeDirectoryName(forKey: "abc") == expected)
        #expect(expected.count == 64)
    }

    @Test func safeFileStemAllowlist() {
        #expect(UserScopedFileStore.isSafeFileStem("Abc123_-XYZ"))
        #expect(UserScopedFileStore.isSafeFileStem(String(repeating: "a", count: 64)))
        #expect(!UserScopedFileStore.isSafeFileStem(""))
        #expect(!UserScopedFileStore.isSafeFileStem(String(repeating: "a", count: 65)))
        #expect(!UserScopedFileStore.isSafeFileStem("../etc"))
        #expect(!UserScopedFileStore.isSafeFileStem("a/b"))
        #expect(!UserScopedFileStore.isSafeFileStem("a.b"))
        #expect(!UserScopedFileStore.isSafeFileStem("abc\n"))
        #expect(!UserScopedFileStore.isSafeFileStem("äöü"))
    }

    @Test func unsafeFileNamesThrowAndNeverTouchDisk() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        for bad in ["../x", "a/b", "", "x.y.json", "abc\n"] {
            #expect(throws: UserScopedFileStoreError.unsafeFileName) {
                try store.write(Data(), scopeKey: "k", fileName: bad)
            }
            #expect(throws: UserScopedFileStoreError.unsafeFileName) {
                try store.read(scopeKey: "k", fileName: bad)
            }
            #expect(throws: UserScopedFileStoreError.unsafeFileName) {
                try store.writeUnscoped(Data(), fileName: bad)
            }
        }
        #expect(!FileManager.default.fileExists(atPath: store.baseDirectory.path))
    }

    @Test func fileNameWithJsonSuffixIsAccepted() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("x"), scopeKey: "k", fileName: "outbox.json")
        #expect(try store.read(scopeKey: "k", fileName: "outbox") == data("x"))
    }

    @Test func emptyScopeKeyThrowsNoDirectory() {
        let store = OfflineTestSupport.makeStore()
        #expect(throws: UserScopedFileStoreError.noDirectory) {
            try store.write(Data(), scopeKey: "", fileName: "f")
        }
    }

    @Test func removeRemoveScopeAndRemoveAll() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("1"), scopeKey: "a", fileName: "f1")
        try store.write(data("2"), scopeKey: "a", fileName: "f2")
        try store.write(data("3"), scopeKey: "b", fileName: "f1")
        store.remove(scopeKey: "a", fileName: "f1")
        #expect(try store.read(scopeKey: "a", fileName: "f1") == nil)
        #expect(try store.read(scopeKey: "a", fileName: "f2") != nil)
        store.removeScope(scopeKey: "a")
        #expect(try store.read(scopeKey: "a", fileName: "f2") == nil)
        #expect(try store.read(scopeKey: "b", fileName: "f1") != nil)
        store.removeAll()
        #expect(try store.read(scopeKey: "b", fileName: "f1") == nil)
        // Kein Absturz bei bereits Geloeschtem.
        store.remove(scopeKey: "zz", fileName: "f")
        store.removeScope(scopeKey: "zz")
    }

    @Test func unscopedRoundTripAndRemove() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.writeUnscoped(data("m"), fileName: "session")
        #expect(try store.readUnscoped(fileName: "session") == data("m"))
        store.removeUnscoped(fileName: "session")
        #expect(try store.readUnscoped(fileName: "session") == nil)
    }

    @Test func quarantineRenamesAndKeepsContent() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("kaputt"), scopeKey: "k", fileName: "outbox")
        try store.quarantine(scopeKey: "k", fileName: "outbox")
        #expect(try store.read(scopeKey: "k", fileName: "outbox") == nil)
        let dir = store.baseDirectory.appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: "k"))
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names.count == 1)
        #expect(names[0].hasPrefix("outbox.corrupt-") && names[0].hasSuffix(".json"))
        let kept = try Data(contentsOf: dir.appendingPathComponent(names[0]))
        #expect(kept == data("kaputt"))
        // Zweite Quarantaene in derselben Sekunde ueberschreibt nichts.
        try store.write(data("zwei"), scopeKey: "k", fileName: "outbox")
        try store.quarantine(scopeKey: "k", fileName: "outbox")
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 2)
    }

    @Test func quarantineOfMissingFileIsNoOp() throws {
        let store = OfflineTestSupport.makeStore()
        try store.quarantine(scopeKey: "k", fileName: "outbox")
    }

    @Test func writtenFilesAreExcludedFromBackup() throws {
        let store = OfflineTestSupport.makeStore()
        defer { store.removeAll() }
        try store.write(data("x"), scopeKey: "k", fileName: "f")
        let url = store.baseDirectory
            .appendingPathComponent(UserScopedFileStore.scopeDirectoryName(forKey: "k"))
            .appendingPathComponent("f.json")
        let values = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func writeFailureThrowsWriteFailed() throws {
        let blocker = OfflineTestSupport.tempDir()
        try FileManager.default.createDirectory(at: blocker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data("datei").write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let store = UserScopedFileStore(baseDirectory: blocker.appendingPathComponent("sub"))
        #expect(throws: UserScopedFileStoreError.writeFailed) {
            try store.write(data("x"), scopeKey: "k", fileName: "f")
        }
    }

    @Test func applicationSupportRejectsUnsafeNamespace() {
        #expect(UserScopedFileStore.applicationSupport(namespace: "../x") == nil)
        #expect(UserScopedFileStore.applicationSupport(namespace: "Offline") != nil)
    }
}
