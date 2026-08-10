//
//  KnowledgePickerTests.swift
//  ThreadStackTests
//
//  Unit tests für Arbeitspaket 5 ("knowledge-pickers"): reine Filter-/
//  Formatierungslogik von KnowledgeTopicPickerSheet und
//  KnowledgeRelatedPickerSheet.
//
//  Hinweis: Die Tests für KnowledgeRelatedPickerSheet nutzen bewusst eine
//  lokale Test-Struct anstelle von `KnowledgeSearchHit` (Arbeitspaket 1, zum
//  Zeitpunkt dieser Implementierung noch nicht in diesem Worktree gemergt).
//  Die geprüfte Funktion `knowledgeRelatedPickerAnnotate` ist generisch über
//  `Identifiable where ID == String` gehalten und wird von der Sheet-View 1:1
//  mit dem echten `KnowledgeSearchHit` verwendet — die Testabdeckung überträgt
//  sich damit unverändert, sobald Paket 1 gemergt ist.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - KnowledgeTopicPickerSheet: Pfad-Formatierung

struct KnowledgeTopicPickerPathTests {

    private func theme(_ id: String, _ title: String, parentId: String? = nil) -> Theme {
        Theme(id: id, title: title, description: "", parentId: parentId, sortOrder: nil,
              createdAt: "2026-01-01T00:00:00Z", links: [])
    }

    @Test func rootOnlyPathIsJustTheTitle() {
        let t = theme("t1", "Projekte")
        #expect(knowledgeTopicPickerPath([t]) == "Projekte")
    }

    @Test func nestedPathJoinsWithSeparator() {
        let parent = theme("p1", "Eltern")
        let child = theme("c1", "Kind", parentId: "p1")
        #expect(knowledgeTopicPickerPath([parent, child]) == "Eltern › Kind")
    }

    @Test func deeplyNestedPathJoinsAllLevels() {
        let a = theme("a", "A")
        let b = theme("b", "B", parentId: "a")
        let c = theme("c", "C", parentId: "b")
        #expect(knowledgeTopicPickerPath([a, b, c]) == "A › B › C")
    }

    @Test func emptyAncestorsProducesEmptyString() {
        #expect(knowledgeTopicPickerPath([]) == "")
    }
}

// MARK: - KnowledgeTopicPickerSheet: Filterlogik

struct KnowledgeTopicPickerFilterTests {

    private func theme(_ id: String, _ title: String) -> Theme {
        Theme(id: id, title: title, description: "", parentId: nil, sortOrder: nil,
              createdAt: "2026-01-01T00:00:00Z", links: [])
    }

    private var sample: [Theme] {
        [theme("1", "Projekte › Website"), theme("2", "Projekte › App"), theme("3", "Privates")]
    }

    private func pathFor(_ topics: [Theme]) -> (String) -> String {
        var map: [String: String] = [:]
        for t in topics { map[t.id] = t.title }
        return { map[$0] ?? "" }
    }

    @Test func emptyQueryReturnsAllTopicsUnchanged() {
        let topics = sample
        let result = knowledgeTopicPickerFilter(topics, query: "", pathFor: pathFor(topics))
        #expect(result.count == 3)
    }

    @Test func whitespaceOnlyQueryReturnsAllTopics() {
        let topics = sample
        let result = knowledgeTopicPickerFilter(topics, query: "   ", pathFor: pathFor(topics))
        #expect(result.count == 3)
    }

    @Test func queryFiltersByFullPathCaseInsensitive() {
        let topics = sample
        let result = knowledgeTopicPickerFilter(topics, query: "website", pathFor: pathFor(topics))
        #expect(result.map(\.id) == ["1"])
    }

    @Test func queryMatchingParentSegmentFindsAllChildren() {
        let topics = sample
        let result = knowledgeTopicPickerFilter(topics, query: "Projekte", pathFor: pathFor(topics))
        #expect(Set(result.map(\.id)) == ["1", "2"])
    }

    @Test func queryWithNoMatchReturnsEmptyList() {
        let topics = sample
        let result = knowledgeTopicPickerFilter(topics, query: "Nicht vorhanden", pathFor: pathFor(topics))
        #expect(result.isEmpty)
    }

    @Test func diacriticInsensitiveMatching() {
        let topics = [theme("1", "Café Projekt")]
        let result = knowledgeTopicPickerFilter(topics, query: "cafe", pathFor: pathFor(topics))
        #expect(result.map(\.id) == ["1"])
    }

    @Test func sortedOrdersAlphabeticallyByPath() {
        let topics = [theme("b", "Zebra"), theme("a", "Anfang")]
        let result = knowledgeTopicPickerSorted(topics, pathFor: pathFor(topics))
        #expect(result.map(\.id) == ["a", "b"])
    }
}

// MARK: - KnowledgeRelatedPickerSheet: Suchgate

struct KnowledgeRelatedPickerShouldSearchTests {

    @Test func lessThanTwoCharactersDoesNotTriggerSearch() {
        #expect(knowledgeRelatedPickerShouldSearch("") == false)
        #expect(knowledgeRelatedPickerShouldSearch("a") == false)
    }

    @Test func twoOrMoreCharactersTriggersSearch() {
        #expect(knowledgeRelatedPickerShouldSearch("ab") == true)
        #expect(knowledgeRelatedPickerShouldSearch("abc") == true)
    }

    @Test func whitespaceIsTrimmedBeforeCounting() {
        #expect(knowledgeRelatedPickerShouldSearch("  a  ") == false)
        #expect(knowledgeRelatedPickerShouldSearch("  ab  ") == true)
    }
}

// MARK: - KnowledgeRelatedPickerSheet: Ausschluss/Markierungslogik

private struct TestHit: Identifiable, Equatable {
    let id: String
    let title: String
}

struct KnowledgeRelatedPickerAnnotateTests {

    private let hits = [
        TestHit(id: "self", title: "Aktuelle Seite"),
        TestHit(id: "linked-1", title: "Bereits verknüpft"),
        TestHit(id: "free-1", title: "Frei wählbar"),
    ]

    @Test func excludesCurrentPageFromResults() {
        let result = knowledgeRelatedPickerAnnotate(hits, currentPageId: "self", alreadyLinked: [])
        #expect(result.map(\.hit.id) == ["linked-1", "free-1"])
    }

    @Test func marksAlreadyLinkedHitsWithoutRemovingThem() {
        let result = knowledgeRelatedPickerAnnotate(hits, currentPageId: nil, alreadyLinked: ["linked-1"])
        #expect(result.count == 3)
        let linkedEntry = result.first { $0.hit.id == "linked-1" }
        #expect(linkedEntry?.isLinked == true)
        let freeEntry = result.first { $0.hit.id == "free-1" }
        #expect(freeEntry?.isLinked == false)
    }

    @Test func combinesExclusionAndAnnotation() {
        let result = knowledgeRelatedPickerAnnotate(hits, currentPageId: "self", alreadyLinked: ["linked-1"])
        #expect(result.count == 2)
        #expect(result.first { $0.hit.id == "self" } == nil)
        #expect(result.first { $0.hit.id == "linked-1" }?.isLinked == true)
        #expect(result.first { $0.hit.id == "free-1" }?.isLinked == false)
    }

    @Test func nilCurrentPageIdKeepsAllHits() {
        let result = knowledgeRelatedPickerAnnotate(hits, currentPageId: nil, alreadyLinked: [])
        #expect(result.count == 3)
    }

    @Test func emptyHitsListProducesEmptyResult() {
        let result = knowledgeRelatedPickerAnnotate([TestHit](), currentPageId: "self", alreadyLinked: ["x"])
        #expect(result.isEmpty)
    }
}
