//
//  KnowledgeSaveCoordinatorTests.swift
//  ThreadStackTests
//
//  Unit tests for Arbeitspaket 6 ("knowledge-editor-view"):
//  `KnowledgeSaveCoordinator` orchestration logic — POST-vs-PUT decision,
//  Topic-/Links-Diff-Berechnung und die Teilfehler-Zustandsmaschine inkl.
//  sicherem Retry (kein zweites `createKnowledgePage`).
//
//  Nutzt eine reine In-Memory-Fake-Implementierung, die als
//  `KnowledgeSaveCoordinatorOperations`-Bündel injiziert wird — keine
//  Netzwerk-/`AppState`-Abhängigkeit nötig, da der Koordinator bewusst
//  gegen ein schmales, closure-basiertes Interface entkoppelt ist.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Fake API

private final class FakeKnowledgeSaveAPI {
    private(set) var createCallCount = 0
    private(set) var updateCallCount = 0
    private(set) var setThemesCallCount = 0
    private(set) var addLinkCalls: [String] = []
    private(set) var removeLinkCalls: [String] = []

    private(set) var lastCreateThemeIds: [String]?
    private(set) var lastUpdateContent: String?
    private(set) var lastSetThemesIds: [String]?

    var createResult: Result<KnowledgePage, Error> = .success(FakeKnowledgeSaveAPI.samplePage(id: "new-id"))
    var updateResult: Result<String, Error> = .success("2026-01-01T00:00:00Z")
    var setThemesResult: Result<AppState.KnowledgeThemesResult, Error> = .success(.init(appliedThemeIds: [], droppedCount: 0))
    /// Keyed by target page id — allows simulating individual add/remove failures.
    var addLinkFailingTargets: Set<String> = []
    var removeLinkFailingLinkIds: Set<String> = []

    static func samplePage(id: String, title: String = "Titel", themeIds: [String] = []) -> KnowledgePage {
        KnowledgePage(id: id, title: title, content: "<p>Inhalt</p>", sortOrder: nil,
                      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
                      themeIds: themeIds, relatedPageIds: [])
    }

    struct FakeError: Error {}

    func createKnowledgePage(title: String, content: String, themeIds: [String]) throws -> KnowledgePage {
        createCallCount += 1
        lastCreateThemeIds = themeIds
        return try createResult.get()
    }

    func updateKnowledgePage(id: String, title: String, content: String) throws -> String {
        updateCallCount += 1
        lastUpdateContent = content
        return try updateResult.get()
    }

    func setKnowledgeThemes(id: String, themeIds: [String]) throws -> AppState.KnowledgeThemesResult {
        setThemesCallCount += 1
        lastSetThemesIds = themeIds
        return try setThemesResult.get()
    }

    func addKnowledgeLink(pageId: String, targetId: String) throws -> AppState.KnowledgeLink {
        addLinkCalls.append(targetId)
        if addLinkFailingTargets.contains(targetId) { throw FakeError() }
        return AppState.KnowledgeLink(linkId: "link-\(targetId)",
                                       page: .init(id: targetId, title: "Ziel \(targetId)", updatedAt: nil))
    }

    func removeKnowledgeLink(pageId: String, linkId: String) throws {
        removeLinkCalls.append(linkId)
        if removeLinkFailingLinkIds.contains(linkId) { throw FakeError() }
    }

    /// Baut das für `KnowledgeSaveCoordinator.save(...)` benötigte
    /// Operationen-Bündel aus diesem Fake.
    func operations() -> KnowledgeSaveCoordinatorOperations {
        KnowledgeSaveCoordinatorOperations(
            createKnowledgePage: { try self.createKnowledgePage(title: $0, content: $1, themeIds: $2) },
            updateKnowledgePage: { try self.updateKnowledgePage(id: $0, title: $1, content: $2) },
            setKnowledgeThemes: { try self.setKnowledgeThemes(id: $0, themeIds: $1) },
            addKnowledgeLink: { try self.addKnowledgeLink(pageId: $0, targetId: $1) },
            removeKnowledgeLink: { try self.removeKnowledgeLink(pageId: $0, linkId: $1) }
        )
    }
}

// MARK: - Create-Flow

@Suite struct KnowledgeSaveCoordinatorCreateFlowTests {

    @Test func createFlowIssuesPostWithThemesAndNoSeparateThemesCall() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.createResult = .success(FakeKnowledgeSaveAPI.samplePage(id: "p1", themeIds: ["t1"]))
        let coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: [])

        let outcome = try await coordinator.save(
            title: "Titel", content: "<p>Hi</p>", themeIds: ["t1"], relatedPageIds: [], operations: api.operations()
        )

        #expect(api.createCallCount == 1)
        #expect(api.updateCallCount == 0)
        #expect(api.setThemesCallCount == 0, "Themes wurden bereits im Create-Request mitgeschickt")
        #expect(api.lastCreateThemeIds == ["t1"])
        #expect(outcome.pageId == "p1")
        #expect(outcome.createdPage?.id == "p1")
        #expect(outcome.isFullSuccess)
        #expect(coordinator.pageId == "p1")
    }

    @Test func createFlowWithoutRelatedPagesDoesNotCallLinkEndpoints() async throws {
        let api = FakeKnowledgeSaveAPI()
        let coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: [])
        _ = try await coordinator.save(title: "T", content: "C", themeIds: [], relatedPageIds: [], operations: api.operations())
        #expect(api.addLinkCalls.isEmpty)
        #expect(api.removeLinkCalls.isEmpty)
    }
}

// MARK: - Edit-Flow

@Suite struct KnowledgeSaveCoordinatorEditFlowTests {

    @Test func editFlowWithoutChangesOnlyCallsUpdateNoThemesOrLinksRequest() async throws {
        let api = FakeKnowledgeSaveAPI()
        let coordinator = KnowledgeSaveCoordinator(
            pageId: "p1", initialThemeIds: ["t1"],
            initialLinks: [.init(linkId: "l1", targetPageId: "k2")]
        )

        let outcome = try await coordinator.save(
            title: "Titel", content: "<p>Neu</p>",
            themeIds: ["t1"], relatedPageIds: ["k2"], // identisch zur Baseline
            operations: api.operations()
        )

        #expect(api.createCallCount == 0)
        #expect(api.updateCallCount == 1)
        #expect(api.lastUpdateContent == "<p>Neu</p>")
        #expect(api.setThemesCallCount == 0)
        #expect(api.addLinkCalls.isEmpty)
        #expect(api.removeLinkCalls.isEmpty)
        #expect(outcome.pageId == "p1")
        #expect(outcome.createdPage == nil)
        #expect(outcome.isFullSuccess)
    }

    @Test func editFlowWithThemeChangeCallsSetKnowledgeThemes() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.setThemesResult = .success(.init(appliedThemeIds: ["t2"], droppedCount: 0))
        let coordinator = KnowledgeSaveCoordinator(pageId: "p1", initialThemeIds: ["t1"])

        let outcome = try await coordinator.save(
            title: "Titel", content: "C", themeIds: ["t2"], relatedPageIds: [], operations: api.operations()
        )

        #expect(api.updateCallCount == 1)
        #expect(api.setThemesCallCount == 1)
        #expect(api.lastSetThemesIds == ["t2"])
        #expect(coordinator.appliedThemeIds == ["t2"])
        #expect(outcome.isFullSuccess)
    }

    @Test func secondSaveAfterFirstCreateNeverIssuesAnotherPost() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.createResult = .success(FakeKnowledgeSaveAPI.samplePage(id: "p1"))
        let coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: [])

        _ = try await coordinator.save(title: "T", content: "C1", themeIds: [], relatedPageIds: [], operations: api.operations())
        #expect(api.createCallCount == 1)

        _ = try await coordinator.save(title: "T", content: "C2", themeIds: [], relatedPageIds: [], operations: api.operations())
        #expect(api.createCallCount == 1, "Ein zweiter save() nach erfolgreichem Create darf kein zweites POST auslösen")
        #expect(api.updateCallCount == 1)
    }
}

// MARK: - Teilfehler-Szenario

@Suite struct KnowledgeSaveCoordinatorPartialFailureTests {

    @Test func contentSucceedsButThemesFailReturnsPartialFailureWithoutThrowing() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.setThemesResult = .failure(FakeKnowledgeSaveAPI.FakeError())
        let coordinator = KnowledgeSaveCoordinator(pageId: "p1", initialThemeIds: ["t1"])

        let outcome = try await coordinator.save(
            title: "Titel", content: "C", themeIds: ["t2"], relatedPageIds: [], operations: api.operations()
        )

        #expect(api.updateCallCount == 1, "Inhalt wurde trotz Themes-Fehler gespeichert")
        #expect(outcome.themesFailed == true)
        #expect(outcome.linksFailed == false)
        #expect(outcome.isFullSuccess == false)
        // Baseline bleibt unverändert, da der Sync fehlgeschlagen ist — nächster
        // Aufruf berechnet den gleichen Diff erneut.
        #expect(coordinator.appliedThemeIds == ["t1"])
    }

    @Test func retryAfterPartialFailureDoesNotIssueASecondPost() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.createResult = .success(FakeKnowledgeSaveAPI.samplePage(id: "p1", themeIds: ["t1"]))
        let coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: [])

        // Erster Save: Create erfolgreich (POST, Themes bereits im Request enthalten).
        _ = try await coordinator.save(
            title: "T", content: "C", themeIds: ["t1"], relatedPageIds: [], operations: api.operations()
        )
        #expect(api.createCallCount == 1)
        #expect(coordinator.pageId == "p1")

        // Zweiter Save mit geänderter Topic-Auswahl: Themes-Sync schlägt fehl (Teilfehler).
        api.setThemesResult = .failure(FakeKnowledgeSaveAPI.FakeError())
        let second = try await coordinator.save(
            title: "T", content: "C", themeIds: ["t2"], relatedPageIds: [], operations: api.operations()
        )
        #expect(api.createCallCount == 1, "Zweiter Save darf kein weiteres POST auslösen")
        #expect(api.updateCallCount == 1)
        #expect(second.themesFailed == true)

        // Retry ("Erneut versuchen"): darf ausschließlich PUT + erneuten
        // Themes-Sync auslösen, niemals ein (weiteres) POST.
        api.setThemesResult = .success(.init(appliedThemeIds: ["t2"], droppedCount: 0))
        let third = try await coordinator.save(
            title: "T", content: "C", themeIds: ["t2"], relatedPageIds: [], operations: api.operations()
        )
        #expect(api.createCallCount == 1, "Retry darf kein zweites createKnowledgePage auslösen")
        #expect(api.updateCallCount == 2)
        #expect(api.setThemesCallCount == 2)
        #expect(third.isFullSuccess == true)
    }

    @Test func contentSaveFailureThrowsAndDoesNotAttemptThemesOrLinks() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.createResult = .failure(FakeKnowledgeSaveAPI.FakeError())
        let coordinator = KnowledgeSaveCoordinator(pageId: nil, initialThemeIds: [])

        await #expect(throws: FakeKnowledgeSaveAPI.FakeError.self) {
            _ = try await coordinator.save(
                title: "T", content: "C", themeIds: ["t1"], relatedPageIds: ["k2"], operations: api.operations()
            )
        }
        #expect(api.setThemesCallCount == 0)
        #expect(api.addLinkCalls.isEmpty)
        #expect(coordinator.pageId == nil, "pageId bleibt nil — ein Retry muss weiterhin POST auslösen")
    }

    @Test func linksPartialFailureKeepsSuccessfulOperationsAppliedForNextDiff() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.addLinkFailingTargets = ["kBad"]
        let coordinator = KnowledgeSaveCoordinator(pageId: "p1", initialThemeIds: [])

        let outcome = try await coordinator.save(
            title: "T", content: "C", themeIds: [], relatedPageIds: ["kGood", "kBad"], operations: api.operations()
        )

        #expect(outcome.linksFailed == true)
        #expect(outcome.themesFailed == false)
        // kGood wurde erfolgreich hinzugefügt und ist Teil der neuen Baseline...
        #expect(coordinator.appliedLinks.contains { $0.targetPageId == "kGood" })
        // ...kBad ist es nicht, da der Aufruf fehlgeschlagen ist.
        #expect(coordinator.appliedLinks.contains { $0.targetPageId == "kBad" } == false)
    }
}

// MARK: - Links-Diff-Berechnung (rein, ohne Netzwerk-Fake)

@Suite struct KnowledgeSaveCoordinatorLinksDiffTests {

    @Test func noChangeYieldsEmptyDiff() {
        let applied = [KnowledgeSaveCoordinator.LinkRef(linkId: "l1", targetPageId: "k1")]
        let diff = KnowledgeSaveCoordinator.computeLinksDiff(applied: applied, desiredTargetIds: ["k1"])
        #expect(diff.toAdd.isEmpty)
        #expect(diff.toRemove.isEmpty)
    }

    @Test func addedTargetAppearsInToAdd() {
        let applied = [KnowledgeSaveCoordinator.LinkRef(linkId: "l1", targetPageId: "k1")]
        let diff = KnowledgeSaveCoordinator.computeLinksDiff(applied: applied, desiredTargetIds: ["k1", "k2"])
        #expect(diff.toAdd == ["k2"])
        #expect(diff.toRemove.isEmpty)
    }

    @Test func removedTargetAppearsInToRemoveWithItsLinkId() {
        let applied = [
            KnowledgeSaveCoordinator.LinkRef(linkId: "l1", targetPageId: "k1"),
            KnowledgeSaveCoordinator.LinkRef(linkId: "l2", targetPageId: "k2"),
        ]
        let diff = KnowledgeSaveCoordinator.computeLinksDiff(applied: applied, desiredTargetIds: ["k1"])
        #expect(diff.toAdd.isEmpty)
        #expect(diff.toRemove == [KnowledgeSaveCoordinator.LinkRef(linkId: "l2", targetPageId: "k2")])
    }

    @Test func simultaneousAddAndRemove() {
        let applied = [KnowledgeSaveCoordinator.LinkRef(linkId: "l1", targetPageId: "k1")]
        let diff = KnowledgeSaveCoordinator.computeLinksDiff(applied: applied, desiredTargetIds: ["k2"])
        #expect(diff.toAdd == ["k2"])
        #expect(diff.toRemove == [KnowledgeSaveCoordinator.LinkRef(linkId: "l1", targetPageId: "k1")])
    }

    @Test func emptyAppliedAndEmptyDesiredYieldsEmptyDiff() {
        let diff = KnowledgeSaveCoordinator.computeLinksDiff(applied: [], desiredTargetIds: [])
        #expect(diff.toAdd.isEmpty)
        #expect(diff.toRemove.isEmpty)
    }
}

// MARK: - resetForNewPage (KNOWLEDGE_PAGE_GONE-Fluss)

@Suite struct KnowledgeSaveCoordinatorResetForNewPageTests {

    @Test func resetForNewPageClearsPageIdAndAppliedState() async throws {
        let api = FakeKnowledgeSaveAPI()
        api.createResult = .success(FakeKnowledgeSaveAPI.samplePage(id: "p2"))
        let coordinator = KnowledgeSaveCoordinator(
            pageId: "dead-id", initialThemeIds: ["t1"],
            initialLinks: [.init(linkId: "l1", targetPageId: "k1")]
        )

        coordinator.resetForNewPage(themeIds: ["t1"])
        #expect(coordinator.pageId == nil)
        #expect(coordinator.appliedLinks.isEmpty)

        _ = try await coordinator.save(title: "T", content: "C", themeIds: ["t1"], relatedPageIds: [], operations: api.operations())
        #expect(api.createCallCount == 1, "Nach resetForNewPage muss der nächste save() wieder POST auslösen")
        #expect(api.updateCallCount == 0)
    }
}
