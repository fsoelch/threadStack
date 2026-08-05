import CoreGraphics
import Foundation

/// Deterministic, stateless default-position layout.
///
/// This is explicitly NOT a force-directed / ticking layout: it is invoked
/// once per load (or once per newly-appearing node) purely to give nodes
/// without a `hasStoredPosition` a sensible spot near their neighbors that
/// does not overlap any already-placed node. Positions it returns are final
/// until the user (or a future load with `hasStoredPosition == true`)
/// changes them.
enum GraphLayout {

    /// Minimum center-to-center distance enforced between any two nodes.
    static let minDistance: CGFloat = 110
    /// Radial step used while spiraling outward to find a free slot.
    static let ringStep: CGFloat = 90
    /// Golden-angle spiral step — avoids axis-aligned clumping, fully deterministic.
    private static let goldenAngle: Double = 137.508 * .pi / 180

    /// Computes a position for every node: stored positions are passed through
    /// unchanged; nodes without a stored position receive a computed default.
    /// - Parameters:
    ///   - nodes: all currently known graph nodes
    ///   - edges: all currently known graph edges (used to find a neighbor anchor)
    /// - Returns: map from `GraphNode.key` to its position.
    static func computePositions(nodes: [GraphNode], edges: [GraphEdge]) -> [String: CGPoint] {
        var positions: [String: CGPoint] = [:]
        var occupied: [CGPoint] = []

        for n in nodes where n.hasStoredPosition {
            guard let x = n.x, let y = n.y else { continue }
            let p = CGPoint(x: x, y: y)
            positions[n.key] = p
            occupied.append(p)
        }

        // Undirected adjacency by node key, built from edges.
        var adjacency: [String: [String]] = [:]
        for e in edges {
            let a = e.source.key
            let b = e.target.key
            adjacency[a, default: []].append(b)
            adjacency[b, default: []].append(a)
        }

        let byKey = Dictionary(uniqueKeysWithValues: nodes.map { ($0.key, $0) })
        // Deterministic processing order (stable sort by key) so repeated calls
        // with the same input always produce the same output.
        let missing = nodes.filter { !$0.hasStoredPosition }.sorted { $0.key < $1.key }

        for n in missing {
            let neighborKeys = adjacency[n.key] ?? []
            var anchor: CGPoint? = neighborKeys.compactMap { positions[$0] }.first

            if anchor == nil, n.nodeType != .theme, let parentId = n.meta?.parentId {
                anchor = positions["theme:\(parentId)"]
            }
            if anchor == nil, n.nodeType == .theme, let parentId = n.meta?.parentId {
                anchor = positions["theme:\(parentId)"]
            }
            let center = anchor ?? CGPoint.zero
            let point = nextFreeSlot(around: center, occupied: occupied)
            positions[n.key] = point
            occupied.append(point)
            _ = byKey // silence unused warning if byKey ends up not referenced further
        }

        return positions
    }

    /// Spirals outward (golden-angle step) from `center` until a slot at least
    /// `minDistance` away from every occupied point is found.
    private static func nextFreeSlot(around center: CGPoint, occupied: [CGPoint]) -> CGPoint {
        if !isOccupied(center, occupied) { return center }
        var radius = ringStep
        var angle = 0.0
        var attempt = 0
        let maxAttempts = 500
        while attempt < maxAttempts {
            let candidate = CGPoint(x: center.x + radius * CGFloat(cos(angle)),
                                     y: center.y + radius * CGFloat(sin(angle)))
            if !isOccupied(candidate, occupied) { return candidate }
            angle += goldenAngle
            attempt += 1
            if attempt % 12 == 0 { radius += ringStep }
        }
        // Practically unreachable with realistic graph sizes (<= a few thousand
        // nodes); fall back to the last candidate ring position.
        return CGPoint(x: center.x + radius, y: center.y)
    }

    private static func isOccupied(_ p: CGPoint, _ occupied: [CGPoint]) -> Bool {
        occupied.contains { hypot($0.x - p.x, $0.y - p.y) < minDistance }
    }
}
