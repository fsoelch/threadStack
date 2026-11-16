import SwiftUI

@main
struct ThreadStackApp: App {
    @StateObject private var state: AppState
    // Arbeitspaket A3: zentrale ProgressStore-Instanz, an dieselbe AppState-
    // Instanz gebunden wie `state` selbst (kein zweiter, unabhängiger
    // Session-/Cookie-Kontext) — Injektion analog zu `state` per
    // `.environmentObject(...)`, damit alle Views denselben Muster folgen.
    @StateObject private var progressStore: ProgressStore
    // Redesign Todo/Task-Übersicht (Arbeitspaket A1/A3): zentrale
    // SummaryStore-Instanz, an dieselbe AppState-Instanz gebunden wie `state`/
    // `progressStore` — Injektion analog per `.environmentObject(...)`, damit
    // Karten-Views (TodosView/MeetingDetailView) dieselbe, app-weit geteilte
    // Instanz nutzen statt divergierender lokaler `@StateObject`s.
    @StateObject private var summaryStore: SummaryStore
    // Arbeit zur Lesbarkeit/Wartbarkeit: Graph-Zustand analog zu
    // ProgressStore/SummaryStore ausgelagert (siehe GraphStore.swift).
    @StateObject private var graphStore: GraphStore
    // Offline-Modus (Paket P7, Kompositionswurzel): gemeinsamer Status fuer alle Views (Banner,
    // Badges, Sperren) und der Coordinator, der Verbindung, Outbox, Sync-Motor und Snapshot steuert.
    // Der Status wird als EnvironmentObject injiziert; alle Sheets erben die Environment-Hierarchie
    // dieser einzigen WindowGroup (es gibt keine weitere Scene / kein eigenes Hosting-Fenster).
    @StateObject private var offlineStatus: OfflineStatusStore
    private let offlineCoordinator: OfflineCoordinator?
    private let connectivity: ConnectivityMonitor
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Clear stale NSToolbar configuration from UserDefaults.
        // macOS persists toolbar layout and can crash on launch if old data
        // contains deprecated types like NSCalendarDate.
        UserDefaults.standard.dictionaryRepresentation().keys
            .filter { $0.hasPrefix("NSToolbar") }
            .forEach { UserDefaults.standard.removeObject(forKey: $0) }

        let appState = AppState()
        _state = StateObject(wrappedValue: appState)
        _summaryStore = StateObject(wrappedValue: SummaryStore(appState: appState))
        let graphStore = GraphStore(appState: appState)
        _graphStore = StateObject(wrappedValue: graphStore)
        // Schwache Rueckreferenz, damit AppState.logout() weiterhin garantieren
        // kann, dass der Graph-Cache jeden Logout nicht ueberlebt (siehe
        // GraphStore.swift-Kopfkommentar).
        appState.graphStore = graphStore

        let progress = ProgressStore(appState: appState)
        _progressStore = StateObject(wrappedValue: progress)
        appState.progressStore = progress

        let status = OfflineStatusStore()
        _offlineStatus = StateObject(wrappedValue: status)
        let monitor = ConnectivityMonitor()
        connectivity = monitor
        if let files = UserScopedFileStore.applicationSupport(namespace: "Offline") {
            let snapshots = OfflineSnapshotStore(store: files)
            let coordinator = OfflineCoordinator(status: status, connectivity: monitor, files: files,
                                                 snapshots: snapshots)
            appState.attachOffline(coordinator: coordinator, status: status, snapshots: snapshots,
                                   pathSatisfied: { monitor.isPathSatisfied })
            graphStore.bindOfflineStatus(status)
            coordinator.startMonitoring()
            offlineCoordinator = coordinator
        } else {
            // Kein Application-Support-Verzeichnis: App laeuft ohne Offline-Modus (wie bisher).
            offlineCoordinator = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .environmentObject(progressStore)
                .environmentObject(summaryStore)
                .environmentObject(graphStore)
                .environmentObject(offlineStatus)
                .onChange(of: scenePhase) { _, phase in
                    let active = phase == .active
                    state.isSceneActive = active
                    if phase == .background { state.offlineUnlockCredentials = nil }
                    offlineCoordinator?.scenePhaseChanged(isActive: active)
                }
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 720)
        #endif
    }
}

struct RootView: View {
    @EnvironmentObject var state: AppState
    @State private var checked = false
    @AppStorage("fontSizeIndex") private var fontSizeIndex = 3

    var body: some View {
        Group {
            if !checked {
                ProgressView("Verbinde …")
                    .task { await initialCheck() }
            } else if state.isLocked {
                LockScreenView()
            } else if state.currentUser == nil {
                LoginView()
            } else {
                ContentView()
            }
        }
        #if os(macOS)
        .environment(\.fontScale, fontScales[fontSizeIndex])
        #endif
    }

    private func initialCheck() async {
        // Boot-Ablauf (Offline-Modus): Probe, dann je nach Ergebnis aktivieren, offline starten,
        // Lock-Screen oder Login (siehe `AppState.bootstrap`).
        await state.bootstrap()
        checked = true
    }
}
