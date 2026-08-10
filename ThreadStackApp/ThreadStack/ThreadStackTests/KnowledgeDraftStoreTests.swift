//
//  KnowledgeDraftStoreTests.swift
//  ThreadStackTests
//
//  Unit tests for Arbeitspaket 1 ("knowledge-api"): draft persistence
//  (save/load/delete round-trip, per-user isolation, corrupt/foreign schema
//  handling, path-traversal protection via the pageId allow-list, and
//  `clearAll()` wiping every user's drafts).
//

import Testing
import Foundation
import CryptoKit
@testable import ThreadStack

@Suite(.serialized)
struct KnowledgeDraftStoreTests {

    private func uniqueUserId(_ tag: String = "") -> String {
        "test-user-\(tag)-\(UUID().uuidString)"
    }

    private func sampleDraft(pageId: String?) -> KnowledgeDraft {
        KnowledgeDraft(pageId: pageId, title: "Titel", contentHTML: "<p>Inhalt</p>",
                        themeIds: ["th1"], relatedPageIds: ["k9"],
                        baseUpdatedAt: "2026-01-01T00:00:00Z", savedAt: Date())
    }

    @Test func saveThenLoadRoundTripsForNewPageDraft() throws {
        let user = uniqueUserId("new")
        let draft = sampleDraft(pageId: nil)
        try KnowledgeDraftStore.save(draft, userId: user)
        let loaded = KnowledgeDraftStore.load(pageId: nil, userId: user)
        #expect(loaded?.title == "Titel")
        #expect(loaded?.contentHTML == "<p>Inhalt</p>")
        #expect(loaded?.themeIds == ["th1"])
        #expect(loaded?.relatedPageIds == ["k9"])
        #expect(loaded?.pageId == nil)
        KnowledgeDraftStore.delete(pageId: nil, userId: user)
    }

    @Test func saveThenLoadRoundTripsForExistingPageDraft() throws {
        let user = uniqueUserId("existing")
        let draft = sampleDraft(pageId: "k123")
        try KnowledgeDraftStore.save(draft, userId: user)
        let loaded = KnowledgeDraftStore.load(pageId: "k123", userId: user)
        #expect(loaded?.pageId == "k123")
        #expect(loaded?.baseUpdatedAt == "2026-01-01T00:00:00Z")
        KnowledgeDraftStore.delete(pageId: "k123", userId: user)
    }

    @Test func loadReturnsNilWhenNoDraftExists() {
        let user = uniqueUserId("empty")
        #expect(KnowledgeDraftStore.load(pageId: "nope", userId: user) == nil)
        #expect(KnowledgeDraftStore.load(pageId: nil, userId: user) == nil)
    }

    @Test func deleteRemovesDraftAndSubsequentLoadIsNil() throws {
        let user = uniqueUserId("del")
        try KnowledgeDraftStore.save(sampleDraft(pageId: "k1"), userId: user)
        #expect(KnowledgeDraftStore.load(pageId: "k1", userId: user) != nil)
        KnowledgeDraftStore.delete(pageId: "k1", userId: user)
        #expect(KnowledgeDraftStore.load(pageId: "k1", userId: user) == nil)
    }

    @Test func deleteOfNonExistentDraftIsANoOp() {
        let user = uniqueUserId("del-noop")
        // Must not throw / crash.
        KnowledgeDraftStore.delete(pageId: "never-existed", userId: user)
    }

    @Test func draftsForDifferentPageIdsDoNotCollide() throws {
        let user = uniqueUserId("multi")
        try KnowledgeDraftStore.save(sampleDraft(pageId: "kA"), userId: user)
        try KnowledgeDraftStore.save(sampleDraft(pageId: "kB"), userId: user)
        #expect(KnowledgeDraftStore.load(pageId: "kA", userId: user)?.pageId == "kA")
        #expect(KnowledgeDraftStore.load(pageId: "kB", userId: user)?.pageId == "kB")
        KnowledgeDraftStore.delete(pageId: "kA", userId: user)
        KnowledgeDraftStore.delete(pageId: "kB", userId: user)
    }

    @Test func draftsAreIsolatedPerUser() throws {
        let userA = uniqueUserId("userA")
        let userB = uniqueUserId("userB")
        try KnowledgeDraftStore.save(sampleDraft(pageId: "shared-id"), userId: userA)
        // userB never saved a draft for this page id — must not see userA's draft.
        #expect(KnowledgeDraftStore.load(pageId: "shared-id", userId: userB) == nil)
        #expect(KnowledgeDraftStore.load(pageId: "shared-id", userId: userA) != nil)
        KnowledgeDraftStore.delete(pageId: "shared-id", userId: userA)
    }

    /// Path-traversal protection: a pageId that does not match the strict
    /// allow-list must never be used verbatim to build a file path. It falls
    /// back to the "new" slot instead of e.g. escaping the user directory.
    @Test func rejectsPathTraversalPageIdAndFallsBackToNewSlot() throws {
        let user = uniqueUserId("traversal")
        let malicious = "../../../etc/passwd"
        let draft = KnowledgeDraft(pageId: malicious, title: "Böse", contentHTML: "",
                                    themeIds: [], relatedPageIds: [], baseUpdatedAt: nil, savedAt: Date())
        try KnowledgeDraftStore.save(draft, userId: user)

        // Loading with the same malicious id must find the (sanitized) draft again...
        let loaded = KnowledgeDraftStore.load(pageId: malicious, userId: user)
        #expect(loaded?.title == "Böse")

        // ...and it must be indistinguishable from a plain "new" draft, i.e.
        // it must have landed in the same slot as pageId: nil (proves no
        // traversal outside the sanitized "new.json" file happened).
        let loadedAsNew = KnowledgeDraftStore.load(pageId: nil, userId: user)
        #expect(loadedAsNew?.title == "Böse")

        KnowledgeDraftStore.delete(pageId: nil, userId: user)
    }

    @Test func acceptsValidPageIdCharacterSet() throws {
        let user = uniqueUserId("valid-chars")
        let validId = "Abc123_-XYZ"
        try KnowledgeDraftStore.save(sampleDraft(pageId: validId), userId: user)
        #expect(KnowledgeDraftStore.load(pageId: validId, userId: user)?.pageId == validId)
        // Must NOT collide with the "new" slot.
        #expect(KnowledgeDraftStore.load(pageId: nil, userId: user) == nil)
        KnowledgeDraftStore.delete(pageId: validId, userId: user)
    }

    /// Defektes JSON darf nicht crashen, sondern liefert nil und räumt die
    /// kaputte Datei auf (kein wiederholtes Scheitern bei jedem künftigen Load).
    @Test func loadReturnsNilAndDeletesFileOnCorruptJSON() throws {
        let user = uniqueUserId("corrupt")
        // Write garbage directly via a fresh save+overwrite to reach the file location.
        try KnowledgeDraftStore.save(sampleDraft(pageId: "corrupt1"), userId: user)
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            Issue.record("no Application Support dir"); return
        }
        let userDirName = sha256Hex(user)
        let fileURL = dir.appendingPathComponent("KnowledgeDrafts").appendingPathComponent(userDirName).appendingPathComponent("corrupt1.json")
        try "{ not valid json ".data(using: .utf8)!.write(to: fileURL)

        #expect(KnowledgeDraftStore.load(pageId: "corrupt1", userId: user) == nil)
        // File should have been removed by load() so future loads don't keep failing on the same garbage.
        #expect(FileManager.default.fileExists(atPath: fileURL.path) == false)
    }

    /// Ein aus einer künftigen (inkompatiblen) Schema-Version stammender
    /// Entwurf wird verworfen statt fehlerhaft interpretiert zu werden.
    @Test func loadReturnsNilForUnsupportedSchemaVersion() throws {
        let user = uniqueUserId("schema")
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            Issue.record("no Application Support dir"); return
        }
        let userDirName = sha256Hex(user)
        let userDir = dir.appendingPathComponent("KnowledgeDrafts").appendingPathComponent(userDirName)
        try FileManager.default.createDirectory(at: userDir, withIntermediateDirectories: true)
        let fileURL = userDir.appendingPathComponent("futureschema.json")
        let futureJSON = """
        { "schemaVersion": 99, "pageId": "futureschema", "title": "x", "contentHTML": "",
          "themeIds": [], "relatedPageIds": [], "savedAt": 700000000 }
        """.data(using: .utf8)!
        try futureJSON.write(to: fileURL)

        #expect(KnowledgeDraftStore.load(pageId: "futureschema", userId: user) == nil)
        #expect(FileManager.default.fileExists(atPath: fileURL.path) == false)
    }

    @Test func clearAllRemovesDraftsForAllUsers() throws {
        let userA = uniqueUserId("clearA")
        let userB = uniqueUserId("clearB")
        try KnowledgeDraftStore.save(sampleDraft(pageId: "kA"), userId: userA)
        try KnowledgeDraftStore.save(sampleDraft(pageId: "kB"), userId: userB)
        #expect(KnowledgeDraftStore.load(pageId: "kA", userId: userA) != nil)
        #expect(KnowledgeDraftStore.load(pageId: "kB", userId: userB) != nil)

        KnowledgeDraftStore.clearAll()

        #expect(KnowledgeDraftStore.load(pageId: "kA", userId: userA) == nil)
        #expect(KnowledgeDraftStore.load(pageId: "kB", userId: userB) == nil)
    }
}

// Local, test-only helper mirroring the store's internal hashing so tests can
// locate files on disk for corruption/schema-version scenarios without
// exposing internal file-layout details from the store's public API.
private func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}
