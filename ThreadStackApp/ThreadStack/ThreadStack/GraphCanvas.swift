import SwiftUI

#if os(iOS)
import UIKit
#endif

/// Renders the knowledge graph using `SwiftUI.Canvas` (never per-node Views —
/// hard performance requirement for graphs with hundreds of nodes/edges).
///
/// Interaction surface (see GraphView for the higher-level logic this drives):
/// - Pan: drag on empty canvas background.
/// - Zoom: pinch (`MagnificationGesture`), clamped 0.2–4.0.
/// - Tap node / edge: reported via closures, no built-in navigation here.
/// - Move node: iOS requires a long-press to arm the drag (with haptic
///   feedback on arm/release); macOS drags directly on mouse-down.
struct GraphCanvas: View {
    let nodes: [GraphNode]
    let edges: [GraphEdge]
    @Binding var positions: [String: CGPoint]
    let visibleTypes: Set<GraphNodeType>
    let searchMatchKeys: Set<String>
    /// When set, the canvas re-centers on this node once.
    let focusKey: String?
    /// false while offline / no data loaded — disables node dragging.
    let editingEnabled: Bool

    var onTapNode: (GraphNode) -> Void = { _ in }
    var onTapEdge: (GraphEdge) -> Void = { _ in }
    var onBackgroundTap: () -> Void = {}
    /// Reported once per completed drag. `droppedOnKey` is the key of another
    /// node the drag ended on top of (if any) — GraphView decides whether
    /// that constitutes a reparent candidate.
    var onNodeDragEnded: (_ node: GraphNode, _ previous: CGPoint, _ new: CGPoint, _ droppedOnKey: String?) -> Void = { _, _, _, _ in }

    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var panStartOffset: CGSize = .zero

    @State private var draggingKey: String?
    @State private var dragStartPoint: CGPoint?
    @State private var dragCurrentScreenPoint: CGPoint?
    @State private var isDragArmed = false
    @State private var lastAppliedFocusKey: String?

    private let minScale: CGFloat = 0.2
    private let maxScale: CGFloat = 4.0
    private let tapRadius: CGFloat = 26
    private let dragArmHitRadius: CGFloat = 30

    private var visibleNodes: [GraphNode] { nodes.filter { visibleTypes.contains($0.nodeType) } }
    private var visibleKeySet: Set<String> { Set(visibleNodes.map(\.key)) }
    private var visibleEdges: [GraphEdge] {
        let vk = visibleKeySet
        return edges.filter { vk.contains($0.source.key) && vk.contains($0.target.key) }
    }
    private var nodesByKey: [String: GraphNode] { Dictionary(uniqueKeysWithValues: nodes.map { ($0.key, $0) }) }

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            Canvas { context, canvasSize in
                drawEdges(context: context, size: canvasSize)
                drawNodes(context: context, size: canvasSize)
            }
            .background(Color(white: 0.97))
            .contentShape(Rectangle())
            #if os(macOS)
            .gesture(macDragGesture(size: size))
            #else
            .gesture(iosLongPressDragGesture(size: size).exclusively(before: panGesture(size: size)))
            #endif
            .simultaneousGesture(magnifyGesture)
            .onTapGesture { location in handleTap(at: location, size: size) }
            .onAppear { centerIfNeeded(on: focusKey, size: size) }
            .onChange(of: focusKey) { _, newKey in centerIfNeeded(on: newKey, size: size) }
            .clipped()
        }
    }

    // MARK: - Coordinate transforms

    private func graphToScreen(_ p: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: p.x * scale + size.width / 2 + offset.width,
                y: p.y * scale + size.height / 2 + offset.height)
    }

    private func screenToGraph(_ p: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: (p.x - size.width / 2 - offset.width) / scale,
                y: (p.y - size.height / 2 - offset.height) / scale)
    }

    // MARK: - Drawing

    private func drawEdges(context: GraphicsContext, size: CGSize) {
        for e in visibleEdges {
            guard let a = positions[e.source.key], let b = positions[e.target.key] else { continue }
            var path = Path()
            let pa = graphToScreen(a, size: size)
            let pb = graphToScreen(b, size: size)
            path.move(to: pa)
            path.addLine(to: pb)
            let style = StrokeStyle(lineWidth: 1.5,
                                    dash: e.edgeKind.isDashed ? [5, 4] : [])
            context.stroke(path, with: .color(.secondary.opacity(0.5)), style: style)
        }
    }

    private func drawNodes(context: GraphicsContext, size: CGSize) {
        for node in visibleNodes {
            guard let p = positions[node.key] else { continue }
            let screen = graphToScreen(p, size: size)
            drawNode(node, at: screen, context: context)
        }
    }

    private func drawNode(_ node: GraphNode, at point: CGPoint, context: GraphicsContext) {
        let type = node.nodeType
        let isDone = node.done == true
        let baseColor = type.color
        let color = isDone ? baseColor.opacity(0.35) : baseColor
        let isMatch = searchMatchKeys.contains(node.key)
        let isDragging = draggingKey == node.key
        let radius: CGFloat = 22
        var ctx = context
        if isDragging, let live = dragCurrentScreenPoint {
            drawShape(type: type, center: live, radius: radius, color: color, context: &ctx)
            drawIcon(type: type, center: live, context: &ctx)
            return
        }
        drawShape(type: type, center: point, radius: radius, color: color, context: &ctx)
        drawIcon(type: type, center: point, context: &ctx)
        if isDone {
            drawDoneOverlay(center: point, context: &ctx)
        }
        if isMatch {
            let ring = Path(ellipseIn: CGRect(x: point.x - radius - 4, y: point.y - radius - 4,
                                               width: (radius + 4) * 2, height: (radius + 4) * 2))
            ctx.stroke(ring, with: .color(DS.accent), lineWidth: 2.5)
        }
        // Title label below the node.
        let text = Text(node.title).font(.caption2).foregroundColor(.primary)
        let resolved = ctx.resolve(text)
        let textSize = resolved.measure(in: CGSize(width: 140, height: 20))
        ctx.draw(resolved, at: CGPoint(x: point.x, y: point.y + radius + 10 + textSize.height / 2))
    }

    private func drawShape(type: GraphNodeType, center: CGPoint, radius: CGFloat, color: Color, context: inout GraphicsContext) {
        let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        switch type {
        case .theme:
            context.fill(Path(ellipseIn: rect), with: .color(color))
        case .knowledge:
            let r = CGRect(x: center.x - radius, y: center.y - radius * 0.8, width: radius * 2, height: radius * 1.6)
            context.fill(Path(roundedRect: r, cornerRadius: 4), with: .color(color))
        case .todo:
            var path = Path()
            path.move(to: CGPoint(x: center.x, y: center.y - radius))
            path.addLine(to: CGPoint(x: center.x + radius, y: center.y))
            path.addLine(to: CGPoint(x: center.x, y: center.y + radius))
            path.addLine(to: CGPoint(x: center.x - radius, y: center.y))
            path.closeSubpath()
            context.fill(path, with: .color(color))
        case .topic:
            context.fill(hexagonPath(center: center, radius: radius), with: .color(color))
        case .contact:
            context.fill(Path(ellipseIn: rect), with: .color(color))
            let innerRect = rect.insetBy(dx: 4, dy: 4)
            context.stroke(Path(ellipseIn: innerRect), with: .color(.white), lineWidth: 1.5)
        }
    }

    private func hexagonPath(center: CGPoint, radius: CGFloat) -> Path {
        var path = Path()
        for i in 0..<6 {
            let angle = Double(i) * .pi / 3 - .pi / 2
            let point = CGPoint(x: center.x + radius * CGFloat(cos(angle)),
                                 y: center.y + radius * CGFloat(sin(angle)))
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }

    private func drawIcon(type: GraphNodeType, center: CGPoint, context: inout GraphicsContext) {
        drawTintedSymbol(type.symbolName, size: 15, tint: .white, at: center, context: &context)
    }

    private func drawDoneOverlay(center: CGPoint, context: inout GraphicsContext) {
        let badgeCenter = CGPoint(x: center.x + 16, y: center.y + 16)
        let rect = CGRect(x: badgeCenter.x - 8, y: badgeCenter.y - 8, width: 16, height: 16)
        context.fill(Path(ellipseIn: rect), with: .color(DS.green))
        drawTintedSymbol("checkmark", size: 9, tint: .white, at: badgeCenter, context: &context)
    }

    /// `GraphicsContext.resolve(_:)` only accepts a plain `Image`, so tinting
    /// (via `.foregroundStyle`/`.foregroundColor`, which turn it into
    /// `some View`) can't be chained directly. Instead: resolve the plain
    /// symbol image, then fill its resolved shape with the desired color
    /// using it as a mask (`GraphicsContext.draw(_:in:)` composited via a
    /// tinted layer with `.blendMode(.sourceIn)`).
    private func drawTintedSymbol(_ systemName: String, size: CGFloat, tint: Color,
                                  at point: CGPoint, context: inout GraphicsContext) {
        // Note: `Image` modifiers such as `.font`/`.foregroundStyle` turn the
        // expression into `some View`, which `GraphicsContext.resolve(_:)`
        // (Image-only overload) then rejects — so the plain symbol is
        // resolved and sized explicitly via the destination `rect` instead.
        let resolved = context.resolve(Image(systemName: systemName))
        let rect = CGRect(x: point.x - size / 2, y: point.y - size / 2, width: size, height: size)
        context.drawLayer { layerContext in
            layerContext.draw(resolved, in: rect)
            layerContext.blendMode = .sourceIn
            layerContext.fill(Path(rect), with: .color(tint))
        }
    }

    // MARK: - Hit testing

    private func hitTestNode(at screenPoint: CGPoint, size: CGSize, excluding: String? = nil) -> GraphNode? {
        var best: (GraphNode, CGFloat)?
        for node in visibleNodes {
            if node.key == excluding { continue }
            guard let p = positions[node.key] else { continue }
            let screen = graphToScreen(p, size: size)
            let d = hypot(screen.x - screenPoint.x, screen.y - screenPoint.y)
            if d <= tapRadius, (best == nil || d < best!.1) { best = (node, d) }
        }
        return best?.0
    }

    private func hitTestEdge(at screenPoint: CGPoint, size: CGSize) -> GraphEdge? {
        for e in visibleEdges {
            guard let a = positions[e.source.key], let b = positions[e.target.key] else { continue }
            let pa = graphToScreen(a, size: size)
            let pb = graphToScreen(b, size: size)
            if distanceFromPoint(screenPoint, toSegment: pa, pb) < 10 { return e }
        }
        return nil
    }

    private func distanceFromPoint(_ p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let lengthSq = dx * dx + dy * dy
        if lengthSq == 0 { return hypot(p.x - a.x, p.y - a.y) }
        var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq
        t = max(0, min(1, t))
        let proj = CGPoint(x: a.x + t * dx, y: a.y + t * dy)
        return hypot(p.x - proj.x, p.y - proj.y)
    }

    private func handleTap(at location: CGPoint, size: CGSize) {
        if let node = hitTestNode(at: location, size: size) { onTapNode(node); return }
        if let edge = hitTestEdge(at: location, size: size) { onTapEdge(edge); return }
        onBackgroundTap()
    }

    // MARK: - Gestures

    private var magnifyGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                let proposed = scale * value
                scale = min(max(proposed, minScale), maxScale)
            }
            .onEnded { _ in
                scale = min(max(scale, minScale), maxScale)
            }
    }

    private func panGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                offset = CGSize(width: panStartOffset.width + value.translation.width,
                                 height: panStartOffset.height + value.translation.height)
            }
            .onEnded { value in
                panStartOffset = CGSize(width: panStartOffset.width + value.translation.width,
                                        height: panStartOffset.height + value.translation.height)
                offset = panStartOffset
            }
    }

    #if os(macOS)
    private func macDragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                if draggingKey == nil && dragStartPoint == nil {
                    // First update of this gesture — decide pan vs. node-drag.
                    if editingEnabled, let node = hitTestNode(at: value.startLocation, size: size) {
                        draggingKey = node.key
                        dragStartPoint = positions[node.key]
                    } else {
                        draggingKey = nil
                    }
                }
                if let key = draggingKey, let start = dragStartPoint {
                    let graphDelta = CGSize(width: value.translation.width / scale,
                                            height: value.translation.height / scale)
                    let newGraphPoint = CGPoint(x: start.x + graphDelta.width, y: start.y + graphDelta.height)
                    dragCurrentScreenPoint = graphToScreen(newGraphPoint, size: size)
                    positions[key] = newGraphPoint
                } else {
                    offset = CGSize(width: panStartOffset.width + value.translation.width,
                                    height: panStartOffset.height + value.translation.height)
                }
            }
            .onEnded { value in
                if let key = draggingKey, let start = dragStartPoint, let node = nodesByKey[key] {
                    let graphDelta = CGSize(width: value.translation.width / scale,
                                            height: value.translation.height / scale)
                    let newPoint = CGPoint(x: start.x + graphDelta.width, y: start.y + graphDelta.height)
                    positions[key] = newPoint
                    let droppedOn = hitTestNode(at: graphToScreen(newPoint, size: size), size: size, excluding: key)
                    onNodeDragEnded(node, start, newPoint, droppedOn?.key)
                } else {
                    panStartOffset = CGSize(width: panStartOffset.width + value.translation.width,
                                            height: panStartOffset.height + value.translation.height)
                    offset = panStartOffset
                }
                draggingKey = nil; dragStartPoint = nil; dragCurrentScreenPoint = nil
            }
    }
    #endif

    #if os(iOS)
    private func iosLongPressDragGesture(size: CGSize) -> some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                switch value {
                case .first(true):
                    break
                case .second(true, let drag):
                    if draggingKey == nil, let drag {
                        if editingEnabled, let node = hitTestNode(at: drag.startLocation, size: size) {
                            draggingKey = node.key
                            dragStartPoint = positions[node.key]
                            fireHaptic(.medium)
                        }
                    }
                    if let key = draggingKey, let start = dragStartPoint, let drag {
                        let graphDelta = CGSize(width: drag.translation.width / scale,
                                                height: drag.translation.height / scale)
                        let newGraphPoint = CGPoint(x: start.x + graphDelta.width, y: start.y + graphDelta.height)
                        dragCurrentScreenPoint = graphToScreen(newGraphPoint, size: size)
                        positions[key] = newGraphPoint
                    }
                default:
                    break
                }
            }
            .onEnded { value in
                guard case .second(true, let drag) = value,
                      let key = draggingKey, let start = dragStartPoint, let node = nodesByKey[key] else {
                    draggingKey = nil; dragStartPoint = nil; dragCurrentScreenPoint = nil
                    return
                }
                let translation = drag?.translation ?? .zero
                let graphDelta = CGSize(width: translation.width / scale, height: translation.height / scale)
                let newPoint = CGPoint(x: start.x + graphDelta.width, y: start.y + graphDelta.height)
                positions[key] = newPoint
                let droppedOn = hitTestNode(at: graphToScreen(newPoint, size: size), size: size, excluding: key)
                fireHaptic(.light)
                onNodeDragEnded(node, start, newPoint, droppedOn?.key)
                draggingKey = nil; dragStartPoint = nil; dragCurrentScreenPoint = nil
            }
    }

    private func fireHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
    #endif

    // MARK: - Zoom / centering

    private func centerIfNeeded(on key: String?, size: CGSize) {
        guard let key, key != lastAppliedFocusKey, let p = positions[key] else { return }
        lastAppliedFocusKey = key
        withAnimation(.easeInOut(duration: 0.25)) {
            offset = CGSize(width: -p.x * scale, height: -p.y * scale)
            panStartOffset = offset
        }
    }
}

// MARK: - Legend

/// Shows the same shape+icon+label mapping used for node drawing, plus the
/// two edge styles — identical vocabulary to the web module's legend.
struct GraphLegendView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Legende").font(.headline)
            ForEach(GraphNodeType.allCases, id: \.self) { type in
                HStack(spacing: 10) {
                    legendShape(for: type)
                        .frame(width: 24, height: 24)
                    Text(type.label).font(.caption)
                    Spacer()
                }
            }
            Divider()
            HStack(spacing: 10) {
                legendLine(dashed: false)
                Text("Hierarchie / Verknüpfung").font(.caption)
                Spacer()
            }
            HStack(spacing: 10) {
                legendLine(dashed: true)
                Text("Wissen ↔ Wissen").font(.caption)
                Spacer()
            }
        }
        .padding()
    }

    @ViewBuilder
    private func legendShape(for type: GraphNodeType) -> some View {
        ZStack {
            switch type {
            case .theme:
                Circle().fill(type.color)
            case .knowledge:
                RoundedRectangle(cornerRadius: 4).fill(type.color)
            case .todo:
                Diamond().fill(type.color)
            case .topic:
                Hexagon().fill(type.color)
            case .contact:
                Circle().fill(type.color)
                    .overlay(Circle().strokeBorder(.white, lineWidth: 1.5).padding(3))
            }
            Image(systemName: type.symbolName)
                .font(.system(size: 10))
                .foregroundStyle(.white)
        }
    }

    private func legendLine(dashed: Bool) -> some View {
        Path { path in
            path.move(to: CGPoint(x: 0, y: 12))
            path.addLine(to: CGPoint(x: 24, y: 12))
        }
        .stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: dashed ? [4, 3] : []))
        .frame(width: 24, height: 24)
    }
}

private struct Diamond: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        p.closeSubpath()
        return p
    }
}

private struct Hexagon: Shape {
    func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        var p = Path()
        for i in 0..<6 {
            let angle = Double(i) * .pi / 3 - .pi / 2
            let pt = CGPoint(x: center.x + radius * CGFloat(cos(angle)), y: center.y + radius * CGFloat(sin(angle)))
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}
