import SwiftUI

@main
struct ThreadStackApp: App {
    @StateObject private var state = AppState()

    init() {
        // Clear stale NSToolbar configuration from UserDefaults.
        // macOS persists toolbar layout and can crash on launch if old data
        // contains deprecated types like NSCalendarDate.
        UserDefaults.standard.dictionaryRepresentation().keys
            .filter { $0.hasPrefix("NSToolbar") }
            .forEach { UserDefaults.standard.removeObject(forKey: $0) }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
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
                    .task {
                        if !state.serverURL.isEmpty {
                            try? await state.checkSession()
                            if state.currentUser != nil { try? await state.loadAll() }
                        }
                        checked = true
                    }
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
}
