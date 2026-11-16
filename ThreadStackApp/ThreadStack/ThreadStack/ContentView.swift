import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var graphStore: GraphStore
    // Offline-Modus: Status fuer Logout-Warnung und Offline-Sperren der Menueeintraege.
    @EnvironmentObject var offline: OfflineStatusStore
    @State private var selectedMeetingId: String? = nil
    @State private var selectedView: SidebarItem = .meetings
    @State private var error: String?
    @State private var showSettings = false
    @State private var showAdmin = false
    @State private var showAiSettings = false
    // Offline-Modus: gemeinsamer Abmelde-Impuls fuer BEIDE Logout-Stellen (macOS-Menue, iOS-Menue),
    // "Aenderungen ansehen" aus der Logout-Warnung.
    @State private var logoutRequested = false
    @State private var showPendingChanges = false

    var body: some View {
        #if os(macOS)
        ZStack(alignment: .bottomTrailing) {
            macContent
            if state.currentUser != nil {
                StackPanelView().padding(16)
            }
        }
        .overlay(alignment: .top) { ToastOverlayView() }
        .sheet(isPresented: $showAiSettings) { AISettingsView() }
        .offlineIntegration(logoutRequested: $logoutRequested, showPendingChanges: $showPendingChanges,
                            performLogout: performLogout)
        #else
        iosLayout
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if state.currentUser != nil {
                    HStack { Spacer(); StackPanelView() }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 4)
                        .background(.clear)
                }
            }
            .overlay(alignment: .top) { ToastOverlayView() }
            .sheet(isPresented: $showAiSettings) { AISettingsView() }
            .offlineIntegration(logoutRequested: $logoutRequested, showPendingChanges: $showPendingChanges,
                                performLogout: performLogout)
        #endif
    }

    /// Einzige Abmelde-Aktion (Bestaetigung bei ausstehenden Aenderungen uebernimmt `.logoutConfirmation`).
    private func performLogout() {
        Task { try? await state.logout() }
    }

    // MARK: - macOS: plain HSplitView (no NSToolbar, no crash)
    #if os(macOS)
    private var macContent: some View {
        HSplitView {
            // Sidebar column
            VStack(spacing: 0) {
                SidebarView(selectedMeetingId: $selectedMeetingId,
                            selectedView: $selectedView)
                Divider()
                // Bottom action bar — alles unter einem User-Menü
                HStack {
                    if let u = state.currentUser {
                        Text(u.username)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { Task { await state.refreshAll() } } label: {
                        if state.isRefreshing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(state.isRefreshing)
                    .help(refreshTooltip)
                    Menu {
                        Button {
                            showSettings = true
                        } label: { Label("Einstellungen", systemImage: "gear") }
                        Button {
                            showAiSettings = true
                        } label: { Label("AI-Einstellungen", systemImage: "sparkles") }
                        .disabledWhenOfflineCompact(offline.isOffline)
                        if state.currentUser?.isAdmin == true {
                            Button {
                                showAdmin = true
                            } label: { Label("Benutzerverwaltung", systemImage: "person.2") }
                            .disabledWhenOfflineCompact(offline.isOffline)
                        }
                        Divider()
                        Button(role: .destructive) {
                            logoutRequested = true
                        } label: { Label("Abmelden", systemImage: "rectangle.portrait.and.arrow.right") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(.secondary)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Menü")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .frame(minWidth: 220, maxWidth: 320)

            // Detail column - Offline-Statusleiste GENAU EINMAL (macOS-Layout), oberhalb der Detailspalte.
            VStack(spacing: 0) {
                OfflineStatusBanner()
                detailView
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .errorAlert($error)
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showAdmin)    { AdminView() }
        .task { await reload() }
        .onChange(of: graphStore.navigationRequest) { _, target in
            applyGraphNavigation(target)
        }
    }
    #endif

    // MARK: - iOS: NavigationSplitView
    #if os(iOS)
    private var iosLayout: some View {
        // Offline-Statusleiste GENAU EINMAL (iOS-Layout): oberhalb der gesamten Split-View, damit sie auch
        // im zusammengeklappten iPhone-Layout (Sidebar/Detail) sichtbar bleibt.
        VStack(spacing: 0) {
            OfflineStatusBanner()
            iosSplitView
        }
    }

    private var iosSplitView: some View {
        NavigationSplitView {
            SidebarView(selectedMeetingId: $selectedMeetingId,
                        selectedView: $selectedView)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { menuButton }
            }
        } detail: {
            detailView
        }
        .navigationSplitViewStyle(.balanced)
        .errorAlert($error)
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showAdmin)    { AdminView() }
        .refreshable { await state.refreshAll() }
        .task { await reload() }
        .onChange(of: graphStore.navigationRequest) { _, target in
            applyGraphNavigation(target)
        }
    }
    #endif

    // MARK: - Shared detail
    @ViewBuilder private var detailView: some View {
        switch selectedView {
        case .meetings:
            if let id = selectedMeetingId, !id.hasPrefix("__"),
               let m = state.meetings.first(where: { $0.id == id }) {
                MeetingDetailView(meeting: m)
            } else {
                emptyState
            }
        case .todos:
            #if os(iOS)
            NavigationStack { TodosView() }
            #else
            TodosView()
            #endif
        case .themes:
            // ThemesView verwaltet auf iOS seinen eigenen NavigationStack (programmatischer Push
            // für "Unter-Topics"-Chips via NavigationPath) — hier nicht zusätzlich wrappen.
            ThemesView()
        case .knowledge:
            #if os(iOS)
            NavigationStack { KnowledgeView() }
            #else
            KnowledgeView()
            #endif
        case .contacts:
            #if os(iOS)
            NavigationStack { ContactsView() }
            #else
            ContactsView()
            #endif
        case .digest:
            #if os(iOS)
            NavigationStack { DigestView() }
            #else
            DigestView()
            #endif
        case .momentum:
            #if os(iOS)
            NavigationStack { MomentumView() }
            #else
            MomentumView()
            #endif
        case .graph:
            #if os(iOS)
            NavigationStack { GraphView() }
            #else
            GraphView()
            #endif
        case .archive:
            #if os(iOS)
            NavigationStack { MeetingArchiveView() }
            #else
            MeetingArchiveView()
            #endif
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 48)).foregroundStyle(.secondary)
            Text("Willkommen bei ThreadStack")
                .font(.title3).fontWeight(.semibold)
            Text("Wähle links ein Meeting aus oder erstelle ein neues.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding()
    }

    private var refreshTooltip: String {
        guard let d = state.lastRefreshAt else { return "Aktualisieren" }
        let f = DateFormatter(); f.timeStyle = .short; f.locale = Locale(identifier: "de_DE")
        return "Zuletzt aktualisiert: \(f.string(from: d))"
    }

    private var menuButton: some View {
        Menu {
            Button {
                Task { await state.refreshAll() }
            } label: { Label("Aktualisieren", systemImage: "arrow.clockwise") }
            Divider()
            Button { showSettings = true } label: {
                Label("Einstellungen", systemImage: "gear")
            }
            Button { showAiSettings = true } label: {
                Label("AI-Einstellungen", systemImage: "sparkles")
            }
            .disabledWhenOfflineCompact(offline.isOffline)
            if state.currentUser?.isAdmin == true {
                Button { showAdmin = true } label: {
                    Label("Benutzerverwaltung", systemImage: "person.2")
                }
                .disabledWhenOfflineCompact(offline.isOffline)
            }
            Divider()
            Button(role: .destructive) {
                logoutRequested = true
            } label: {
                Label("Abmelden", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    /// Consumes a Graph-view "Öffnen" request by switching the existing
    /// sidebar selection to the matching pre-existing detail view.
    private func applyGraphNavigation(_ target: GraphNavigationTarget?) {
        guard let target else { return }
        switch target {
        case .meeting(let meetingId):
            selectedView = .meetings
            selectedMeetingId = meetingId
        case .todos:
            selectedMeetingId = SidebarItem.todos.sentinel
            selectedView = .todos
        case .themes:
            selectedMeetingId = SidebarItem.themes.sentinel
            selectedView = .themes
        case .contacts:
            selectedMeetingId = SidebarItem.contacts.sentinel
            selectedView = .contacts
        }
        graphStore.navigationRequest = nil
    }

    /// Erste Datenladung beim Erscheinen (Boot/Login haben sie ggf. schon erledigt) und Auto-Refresh-Timer.
    /// Fehler der Ladung behandelt der Offline-Coordinator (still offline, kein Alert pro Ansicht).
    private func reload() async {
        if !state.hasCompletedInitialLoad {
            await state.completeAuthentication(trigger: .afterLogin)
        }
        // Auto-Refresh-Timer beim ersten Erscheinen starten (idempotent)
        state.startAutoRefresh()
    }
}

// MARK: - Offline-Integration

private extension View {
    /// Gemeinsame Offline-Bausteine beider Layouts: Abmelde-Bestaetigung (an beiden Menues ueber EINE Funktion),
    /// "Aenderungen ansehen" aus der Logout-Warnung und das Re-Auth-Sheet. Alle Sheets erben die
    /// Environment-Objekte (OfflineStatusStore, AppState, ProgressStore, ...) von der WindowGroup.
    func offlineIntegration(logoutRequested: Binding<Bool>, showPendingChanges: Binding<Bool>,
                            performLogout: @escaping () -> Void) -> some View {
        modifier(OfflineIntegrationModifier(logoutRequested: logoutRequested,
                                            showPendingChanges: showPendingChanges,
                                            performLogout: performLogout))
    }
}

private struct OfflineIntegrationModifier: ViewModifier {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @Binding var logoutRequested: Bool
    @Binding var showPendingChanges: Bool
    let performLogout: () -> Void

    func body(content: Content) -> some View {
        content
            .logoutConfirmation(isPresented: $logoutRequested, unsyncedCount: offline.unsyncedCount,
                                onConfirm: performLogout,
                                onShowChanges: { showPendingChanges = true })
            .sheet(isPresented: $showPendingChanges) { PendingChangesSheet() }
            .sheet(isPresented: $state.reauthRequested) { LoginView(mode: .reauth) }
    }
}

enum SidebarItem: Hashable { case meetings, todos, themes, knowledge, contacts, digest, momentum, graph, archive }
