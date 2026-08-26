import SwiftUI

@main
struct ThreadStackApp: App {
    @StateObject private var state: AppState
    // Arbeitspaket A3: zentrale ProgressStore-Instanz, an dieselbe AppState-
    // Instanz gebunden wie `state` selbst (kein zweiter, unabhängiger
    // Session-/Cookie-Kontext) — Injektion analog zu `state` per
    // `.environmentObject(...)`, damit alle Views denselben Muster folgen.
    @StateObject private var progressStore: ProgressStore

    init() {
        // Clear stale NSToolbar configuration from UserDefaults.
        // macOS persists toolbar layout and can crash on launch if old data
        // contains deprecated types like NSCalendarDate.
        UserDefaults.standard.dictionaryRepresentation().keys
            .filter { $0.hasPrefix("NSToolbar") }
            .forEach { UserDefaults.standard.removeObject(forKey: $0) }

        let appState = AppState()
        _state = StateObject(wrappedValue: appState)
        _progressStore = StateObject(wrappedValue: ProgressStore(appState: appState))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .environmentObject(progressStore)
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
        // 1. Versuche die alte Session zu reaktivieren (Cookie noch da, weniger als 12h Inaktivität)
        if !state.serverURL.isEmpty {
            try? await state.checkSession()
            if state.currentUser != nil {
                try? await state.loadAll()
                NotificationScheduler.shared.requestPermissionIfNeeded()
            }
        }
        // 2. Wenn nicht eingeloggt UND Credentials in Keychain → Lock-Screen mit Auto-Biometrie
        if state.currentUser == nil && state.hasStoredCredentials {
            state.isLocked = true
        }
        checked = true
    }
}
