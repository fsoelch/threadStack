import Foundation
import SwiftUI

// MARK: - Graph API contract types
//
// Mirrors the backend contract of GET /api/graph and PATCH /api/graph/positions
// exactly as specified by the architecture. Do NOT rename JSON keys — other
// packages (backend, web frontend) rely on this exact shape.

/// Reference to a node from an edge endpoint: `{ "type": ..., "id": ... }`.
struct GraphNodeRef: Codable, Equatable, Hashable {
    let type: String
    let id: String
    var key: String { "\(type):\(id)" }
}

/// Union of all per-type `meta` fields. Every field is optional because only
/// a subset is present depending on `GraphNode.type`. This keeps decoding
/// forward-compatible if the backend adds fields later.
struct GraphNodeMeta: Codable, Equatable {
    // theme
    var parentId: String?
    var childCount: Int?
    var linkCount: Int?
    var descriptionText: String?
    // knowledge
    var updatedAt: String?
    // todo
    var dueDate: String?
    // topic
    var meetingId: String?
    var meetingTitle: String?
    // contact
    var role: String?
}

struct GraphNode: Identifiable, Codable, Equatable {
    let type: String
    let id: String
    var title: String
    var x: Double?
    var y: Double?
    var hasStoredPosition: Bool
    var done: Bool?
    var meta: GraphNodeMeta?

    /// Stable, unique identity across node types (server ids are only unique
    /// per-type, e.g. a theme and a todo could share the same raw id).
    /// `Identifiable.id` uses the server's raw `id` (only unique per type);
    /// callers needing cross-type uniqueness (e.g. dictionary keys) must use `.key`.
    var key: String { "\(type):\(id)" }

    var nodeType: GraphNodeType { GraphNodeType(rawValue: type) ?? .theme }
}

struct GraphEdge: Identifiable, Codable, Equatable {
    let id: String
    let kind: String
    let source: GraphNodeRef
    let target: GraphNodeRef

    var edgeKind: GraphEdgeKind { GraphEdgeKind(rawValue: kind) ?? .themeLink }
}

struct GraphCompatibilityRule: Codable, Equatable {
    let source: String
    let target: String
    let kind: String
}

struct GraphSchema: Codable, Equatable {
    var nodeTypes: [String] = []
    var edgeKinds: [String] = []
    var compatibility: [GraphCompatibilityRule] = []
}

struct GraphStats: Codable, Equatable {
    var nodeCount: Int = 0
    var edgeCount: Int = 0
    var truncated: Bool = false
}

/// Top-level response of `GET /api/graph`.
struct GraphResponse: Codable, Equatable {
    var nodes: [GraphNode] = []
    var edges: [GraphEdge] = []
    var schema: GraphSchema = GraphSchema()
    var stats: GraphStats = GraphStats()
}

/// Body item of `PATCH /api/graph/positions`.
struct GraphPositionUpdate: Codable, Equatable {
    let type: String
    let id: String
    let x: Double
    let y: Double
}

struct GraphPositionIgnored: Codable, Equatable {
    let type: String
    let id: String
    let reason: String
}

struct GraphPositionsSaveResponse: Codable, Equatable {
    var ok: Bool = false
    var saved: Int = 0
    var ignored: [GraphPositionIgnored] = []
}

/// Generic error envelope used across the backend: `{error, code}`.
struct GraphErrorEnvelope: Codable, Equatable {
    let error: String
    let code: String?
}

// MARK: - Presentation metadata (shape / icon / color per node type)
//
// Nodes are double-encoded (shape AND icon), never color alone, per
// accessibility requirement — mirrors the web module's legend.

enum GraphNodeType: String, CaseIterable, Codable {
    case theme, knowledge, todo, topic, contact

    var label: String {
        switch self {
        case .theme:     return "Topic"
        case .knowledge: return "Wissen"
        case .todo:      return "Todo"
        case .topic:     return "Meeting-Thema"
        case .contact:   return "Ansprechpartner"
        }
    }

    var symbolName: String {
        switch self {
        case .theme:     return "folder.fill"
        case .knowledge: return "doc.text.fill"
        case .todo:      return "checkmark.circle.fill"
        case .topic:     return "bubble.left.and.bubble.right.fill"
        case .contact:   return "person.fill"
        }
    }

    var color: Color {
        switch self {
        case .theme:     return DS.purple
        case .knowledge: return DS.accent
        case .todo:      return DS.green
        case .topic:     return DS.cyan
        case .contact:   return DS.pink
        }
    }
}

/// Requested by the Graph view's node "Öffnen" action; consumed by
/// `ContentView` to switch the existing sidebar selection to the matching
/// pre-existing detail view (no new navigation stack is introduced).
enum GraphNavigationTarget: Equatable {
    case meeting(meetingId: String)
    case todos
    case themes
    case contacts
}

enum GraphEdgeKind: String, Codable {
    case hierarchy
    case knowledgeTopic   = "knowledge_topic"
    case knowledgeKnowledge = "knowledge_knowledge"
    case themeLink = "theme_link"

    /// Dashed edges are used exclusively for knowledge<->knowledge links.
    var isDashed: Bool { self == .knowledgeKnowledge }
}
