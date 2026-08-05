import Foundation

/// Debounced, serialized persistence of node positions the user moved by
/// dragging in the Graph view.
///
/// Contract (mirrors the web module):
/// - Saves are debounced by 500ms after the last drag-end.
/// - At most one PATCH request is in flight at a time.
/// - While a request is in flight, further moves for the *same* node
///   overwrite the pending entry (never appended/duplicated) — the batch is
///   keyed by `"type:id"`.
/// - On failure, the batch is kept (merged with anything queued meanwhile)
///   and retried on the next successful flush cycle; the moved position
///   stays visible locally regardless of save success.
@MainActor
final class GraphPositionSync {

    struct Move: Equatable {
        let type: String
        let id: String
        var x: Double
        var y: Double
        var key: String { "\(type):\(id)" }
    }

    /// Performs the actual network call. Throwing triggers a retry on the
    /// next flush cycle; the caller (AppState) also decides on user-facing
    /// error surfacing.
    var onFlush: (([Move]) async throws -> Void)?
    /// Reported after a failed flush so the UI can show a dezent hint.
    var onError: ((Error) -> Void)?

    private var pending: [String: Move] = [:]
    private var inFlight = false
    private var debounceTask: Task<Void, Never>?
    private let debounceNanoseconds: UInt64

    init(debounceNanoseconds: UInt64 = 500_000_000) {
        self.debounceNanoseconds = debounceNanoseconds
    }

    /// Enqueues (or overwrites) a pending move for one node and (re-)starts
    /// the debounce timer.
    func enqueue(type: String, id: String, x: Double, y: Double) {
        pending[Move(type: type, id: id, x: x, y: y).key] = Move(type: type, id: id, x: x, y: y)
        scheduleFlush()
    }

    var hasPending: Bool { !pending.isEmpty }

    private func scheduleFlush() {
        debounceTask?.cancel()
        let delay = debounceNanoseconds
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    private func flush() async {
        guard !inFlight, !pending.isEmpty else { return }
        inFlight = true
        let batch = Array(pending.values)
        pending.removeAll()
        do {
            try await onFlush?(batch)
        } catch {
            // Merge failed moves back in, but never clobber a newer pending
            // value for the same node that arrived while we were in flight.
            for m in batch where pending[m.key] == nil { pending[m.key] = m }
            onError?(error)
        }
        inFlight = false
        if !pending.isEmpty { scheduleFlush() }
    }

    /// Explicit trigger, e.g. once connectivity is restored, so a previously
    /// offline-queued batch does not have to wait for another user drag.
    func flushNow() async { await flush() }
}
