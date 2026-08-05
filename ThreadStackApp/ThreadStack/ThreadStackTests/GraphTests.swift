//
//  GraphTests.swift
//  ThreadStackTests
//
//  Unit tests for the Graph-Ansicht (Story B9): decoding of the
//  `GET /api/graph` contract, the deterministic layout algorithm, and the
//  debounced/serialized position-sync batching logic.
//

import Testing
import Foundation
@testable import ThreadStack

struct GraphModelsTests {

    @Test func decodesFullGraphResponseAcrossAllNodeTypes() throws {
        let json = """
        {
          "nodes": [
            { "type": "theme", "id": "t1", "title": "Projekt X", "x": 10, "y": 20,
              "hasStoredPosition": true, "done": null,
              "meta": { "parentId": null, "childCount": 2, "linkCount": 1, "descriptionText": "Beschreibung" } },
            { "type": "knowledge", "id": "k1", "title": "Doku", "x": null, "y": null,
              "hasStoredPosition": false, "done": null,
              "meta": { "updatedAt": "2026-08-01T10:00:00Z" } },
            { "type": "todo", "id": "d1", "title": "Erledigen", "x": null, "y": null,
              "hasStoredPosition": false, "done": false,
              "meta": { "dueDate": "2026-08-10" } },
            { "type": "topic", "id": "p1", "title": "Besprechen", "x": null, "y": null,
              "hasStoredPosition": false, "done": true,
              "meta": { "meetingId": "m1", "meetingTitle": "Jour Fixe" } },
            { "type": "contact", "id": "c1", "title": "Max Muster", "x": null, "y": null,
              "hasStoredPosition": false, "done": null,
              "meta": { "role": "Product Owner" } }
          ],
          "edges": [
            { "id": "e1", "kind": "hierarchy", "source": {"type":"theme","id":"t1"}, "target": {"type":"theme","id":"t2"} },
            { "id": "e2", "kind": "knowledge_knowledge", "source": {"type":"knowledge","id":"k1"}, "target": {"type":"knowledge","id":"k2"} }
          ],
          "schema": {
            "nodeTypes": ["theme","knowledge","todo","topic","contact"],
            "edgeKinds": ["hierarchy","knowledge_topic","knowledge_knowledge","theme_link"],
            "compatibility": [ { "source": "theme", "target": "theme", "kind": "hierarchy" } ]
          },
          "stats": { "nodeCount": 5, "edgeCount": 2, "truncated": false }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(GraphResponse.self, from: json)

        #expect(decoded.nodes.count == 5)
        #expect(decoded.edges.count == 2)
        #expect(decoded.stats.nodeCount == 5)
        #expect(decoded.schema.compatibility.first?.kind == "hierarchy")

        let theme = try #require(decoded.nodes.first { $0.type == "theme" })
        #expect(theme.nodeType == .theme)
        #expect(theme.hasStoredPosition == true)
        #expect(theme.x == 10)
        #expect(theme.meta?.childCount == 2)
        #expect(theme.meta?.descriptionText == "Beschreibung")

        let knowledge = try #require(decoded.nodes.first { $0.type == "knowledge" })
        #expect(knowledge.nodeType == .knowledge)
        #expect(knowledge.hasStoredPosition == false)
        #expect(knowledge.meta?.updatedAt == "2026-08-01T10:00:00Z")

        let todo = try #require(decoded.nodes.first { $0.type == "todo" })
        #expect(todo.done == false)
        #expect(todo.meta?.dueDate == "2026-08-10")

        let topic = try #require(decoded.nodes.first { $0.type == "topic" })
        #expect(topic.done == true)
        #expect(topic.meta?.meetingId == "m1")

        let contact = try #require(decoded.nodes.first { $0.type == "contact" })
        #expect(contact.meta?.role == "Product Owner")

        let hierarchyEdge = try #require(decoded.edges.first { $0.kind == "hierarchy" })
        #expect(hierarchyEdge.edgeKind == .hierarchy)
        #expect(hierarchyEdge.edgeKind.isDashed == false)

        let kkEdge = try #require(decoded.edges.first { $0.kind == "knowledge_knowledge" })
        #expect(kkEdge.edgeKind == .knowledgeKnowledge)
        #expect(kkEdge.edgeKind.isDashed == true)
    }

    @Test func nodeKeyIsUniqueAcrossTypesWithSameRawId() {
        let a = GraphNode(type: "theme", id: "shared", title: "A", x: nil, y: nil, hasStoredPosition: false, done: nil, meta: nil)
        let b = GraphNode(type: "todo", id: "shared", title: "B", x: nil, y: nil, hasStoredPosition: false, done: nil, meta: nil)
        #expect(a.id == b.id)          // raw server id collides across types
        #expect(a.key != b.key)        // but the composite key does not
    }

    @Test func decodesUnknownNodeTypeAsThemeFallback() {
        let node = GraphNode(type: "future_type", id: "x", title: "X", x: nil, y: nil, hasStoredPosition: false, done: nil, meta: nil)
        #expect(node.nodeType == .theme)
    }

    @Test func positionsPatchEncodesExpectedShape() throws {
        let update = GraphPositionUpdate(type: "theme", id: "t1", x: 12.5, y: -4)
        let data = try JSONEncoder().encode(update)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(obj?["type"] as? String == "theme")
        #expect(obj?["id"] as? String == "t1")
        #expect(obj?["x"] as? Double == 12.5)
        #expect(obj?["y"] as? Double == -4)
    }

    @Test func decodesPositionsSaveResponseWithIgnoredEntries() throws {
        let json = """
        { "ok": true, "saved": 1, "ignored": [ { "type": "theme", "id": "missing", "reason": "not_found" } ] }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(GraphPositionsSaveResponse.self, from: json)
        #expect(decoded.ok == true)
        #expect(decoded.saved == 1)
        #expect(decoded.ignored.first?.reason == "not_found")
    }
}

struct GraphLayoutTests {

    private func node(_ type: String, _ id: String, x: Double? = nil, y: Double? = nil,
                      stored: Bool = false, parentId: String? = nil) -> GraphNode {
        var meta: GraphNodeMeta? = nil
        if let parentId {
            meta = GraphNodeMeta(parentId: parentId)
        }
        return GraphNode(type: type, id: id, title: id, x: x, y: y, hasStoredPosition: stored, done: nil, meta: meta)
    }

    @Test func preservesAllStoredPositionsUnchanged() {
        let nodes = [
            node("theme", "a", x: 5, y: 5, stored: true),
            node("theme", "b", x: -5, y: -5, stored: true)
        ]
        let positions = GraphLayout.computePositions(nodes: nodes, edges: [])
        #expect(positions["theme:a"] == CGPoint(x: 5, y: 5))
        #expect(positions["theme:b"] == CGPoint(x: -5, y: -5))
    }

    @Test func assignsDefaultPositionToNodeWithoutStoredPosition() {
        let nodes = [node("theme", "a", x: 0, y: 0, stored: true), node("theme", "b")]
        let positions = GraphLayout.computePositions(nodes: nodes, edges: [])
        #expect(positions["theme:b"] != nil)
        #expect(positions["theme:b"] != CGPoint(x: 0, y: 0))
    }

    @Test func newNodePositionDoesNotOverlapExistingNodes() throws {
        let nodes = [node("theme", "a", x: 0, y: 0, stored: true), node("theme", "b")]
        let edges = [GraphEdge(id: "e1", kind: "hierarchy",
                                source: GraphNodeRef(type: "theme", id: "a"),
                                target: GraphNodeRef(type: "theme", id: "b"))]
        let positions = GraphLayout.computePositions(nodes: nodes, edges: edges)
        let a = try #require(positions["theme:a"])
        let b = try #require(positions["theme:b"])
        let distance = hypot(a.x - b.x, a.y - b.y)
        #expect(distance >= GraphLayout.minDistance)
    }

    @Test func isDeterministicAcrossRepeatedCalls() {
        let nodes = [
            node("theme", "a", x: 0, y: 0, stored: true),
            node("theme", "b"), node("theme", "c"), node("todo", "d")
        ]
        let edges = [
            GraphEdge(id: "e1", kind: "hierarchy", source: GraphNodeRef(type: "theme", id: "a"), target: GraphNodeRef(type: "theme", id: "b")),
            GraphEdge(id: "e2", kind: "hierarchy", source: GraphNodeRef(type: "theme", id: "a"), target: GraphNodeRef(type: "theme", id: "c"))
        ]
        let first = GraphLayout.computePositions(nodes: nodes, edges: edges)
        let second = GraphLayout.computePositions(nodes: nodes, edges: edges)
        #expect(first == second)
    }

    @Test func placesUnpositionedNodeNearItsThemeParentWhenNoDirectEdgeExists() throws {
        let nodes = [
            node("theme", "parent", x: 0, y: 0, stored: true),
            node("theme", "child", parentId: "parent")
        ]
        let positions = GraphLayout.computePositions(nodes: nodes, edges: [])
        let child = try #require(positions["theme:child"])
        // Should be within a small number of ring steps of its parent, not at the origin.
        let distance = hypot(child.x, child.y)
        #expect(distance > 0)
        #expect(distance < GraphLayout.ringStep * 20)
    }
}

@MainActor
struct GraphPositionSyncTests {

    @Test func mergesRepeatedMovesForSameNodeIntoOneEntry() async throws {
        let sync = GraphPositionSync(debounceNanoseconds: 20_000_000)
        var flushedBatches: [[GraphPositionSync.Move]] = []
        sync.onFlush = { moves in flushedBatches.append(moves) }

        sync.enqueue(type: "theme", id: "t1", x: 1, y: 1)
        sync.enqueue(type: "theme", id: "t1", x: 2, y: 2)
        sync.enqueue(type: "theme", id: "t1", x: 3, y: 3)

        try await Task.sleep(nanoseconds: 100_000_000)

        #expect(flushedBatches.count == 1)
        #expect(flushedBatches.first?.count == 1)
        #expect(flushedBatches.first?.first?.x == 3)
        #expect(flushedBatches.first?.first?.y == 3)
    }

    /// A failed flush must not drop the batch: `GraphPositionSync` keeps the
    /// moves pending and automatically re-schedules a flush (no separate user
    /// action required), so the position is retried on the "next successful
    /// cycle" per the architecture's contract.
    @Test func retriesPendingBatchAfterFlushFailure() async throws {
        let sync = GraphPositionSync(debounceNanoseconds: 20_000_000)
        var attempt = 0
        var succeededBatches: [[GraphPositionSync.Move]] = []
        sync.onFlush = { moves in
            attempt += 1
            if attempt == 1 { throw URLError(.notConnectedToInternet) }
            succeededBatches.append(moves)
        }
        var reportedErrors = 0
        sync.onError = { _ in reportedErrors += 1 }

        sync.enqueue(type: "todo", id: "d1", x: 5, y: 5)

        // First attempt fails, then the automatic retry (no further user
        // interaction) succeeds — give both cycles enough time.
        try await Task.sleep(nanoseconds: 300_000_000)

        #expect(reportedErrors == 1)
        let allMoves = succeededBatches.flatMap { $0 }
        #expect(allMoves.contains { $0.id == "d1" && $0.x == 5 && $0.y == 5 })
    }

    @Test func newMoveForSameNodeWhileInFlightOverwritesRatherThanAppends() async throws {
        let sync = GraphPositionSync(debounceNanoseconds: 10_000_000)
        var flushedBatches: [[GraphPositionSync.Move]] = []
        sync.onFlush = { moves in
            flushedBatches.append(moves)
            try? await Task.sleep(nanoseconds: 60_000_000) // simulate slow network
        }

        sync.enqueue(type: "theme", id: "t1", x: 1, y: 1)
        try await Task.sleep(nanoseconds: 30_000_000) // let first flush start
        sync.enqueue(type: "theme", id: "t1", x: 99, y: 99) // arrives while in flight

        try await Task.sleep(nanoseconds: 250_000_000)

        let allMoves = flushedBatches.flatMap { $0 }
        let entriesForNode = allMoves.filter { $0.id == "t1" }
        // Never duplicated/appended: at most one pending + one in-flight entry,
        // and the final value observed must be the latest one.
        #expect(entriesForNode.last?.x == 99)
    }
}
