import Foundation
import Network

//  ConnectivityMonitor.swift
//  Arbeitspaket P3, Schnittstelle S-11: Pfad-Ausloeser auf Basis von NWPathMonitor.
//  Der Pfad allein bestimmt NICHT den Online-Zustand (Captive Portal, Server down) -
//  er dient nur als Ausloeser und als schneller Ausschluss. Den Zustand bestimmt
//  der OfflineCoordinator ueber eine Probe `GET /me`.

/// Test-Seam: Quelle der Pfadmeldungen. `start` registriert den Rueckruf (Meldung "Pfad erfuellt?").
struct ConnectivityPathSource {
    var start: (_ onUpdate: @escaping (Bool) -> Void) -> Void
    var stop: () -> Void
}

extension ConnectivityPathSource {
    /// Produktionsquelle (Network.framework). Jeder `start` legt einen neuen NWPathMonitor an
    /// (ein beendeter NWPathMonitor laesst sich nicht neu starten).
    static var networkFramework: ConnectivityPathSource {
        let holder = NetworkPathHolder()
        return ConnectivityPathSource(start: { holder.start(onUpdate: $0) }, stop: { holder.stop() })
    }
}

private final class NetworkPathHolder {
    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "offline.connectivity")

    func start(onUpdate: @escaping (Bool) -> Void) {
        stop()
        let m = NWPathMonitor()
        nonisolated(unsafe) let callback = onUpdate
        m.pathUpdateHandler = { @Sendable path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in callback(satisfied) }
        }
        monitor = m
        m.start(queue: queue)
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
    }
}

final class ConnectivityMonitor {
    private let source: ConnectivityPathSource
    private var started = false
    private var receivedUpdate = false

    private(set) var isPathSatisfied = true
    /// Wird bei jeder Aenderung des Pfadzustands (und bei der ersten Meldung nach `start()`) gerufen.
    var onPathChange: ((Bool) -> Void)?

    init(pathSource: ConnectivityPathSource = .networkFramework) {
        self.source = pathSource
    }

    func start() {
        guard !started else { return }
        started = true
        receivedUpdate = false
        source.start { [weak self] satisfied in
            self?.handle(satisfied)
        }
    }

    func stop() {
        guard started else { return }
        started = false
        source.stop()
    }

    private func handle(_ satisfied: Bool) {
        guard started else { return }
        let changed = satisfied != isPathSatisfied
        let first = !receivedUpdate
        receivedUpdate = true
        isPathSatisfied = satisfied
        if changed || first { onPathChange?(satisfied) }
    }
}
