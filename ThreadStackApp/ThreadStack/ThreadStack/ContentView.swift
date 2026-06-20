import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @State private var selectedMeetingId: String? = nil
    @State private var selectedView: SidebarItem = .meetings
    @State private var error: String?
    @State private var showSettings = false
    @State private var showAdmin = false
    @State private var showAiSettings = false

    var body: some View {
        #if os(macOS)
        ZStack(alignment: .bottomTrailing) {
            macContent
            if state.currentUser != nil {
                StackPanelView().padding(16)
            }
        }
        .sheet(isPresented: $showAiSettings) { AISettingsView() }
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
            .sheet(isPresented: $showAiSettings) { AISettingsView() }
        #endif
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
                        if state.currentUser?.isAdmin == true {
                            Button {
                                showAdmin = true
                            } label: { Label("Benutzerverwaltung", systemImage: "person.2") }
                        }
                        Divider()
                        Button(role: .destructive) {
                            Task { try? await state.logout() }
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

            // Detail column
            detailView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showAdmin)    { AdminView() }
        .task { await reload() }
    }
    #endif

    // MARK: - iOS: NavigationSplitView
    #if os(iOS)
    private var iosLayout: some View {
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
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showAdmin)    { AdminView() }
        .refreshable { await reload() }
        .task { await reload() }
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
            #if os(iOS)
            NavigationStack { ThemesView() }
            #else
            ThemesView()
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
            if state.currentUser?.isAdmin == true {
                Button { showAdmin = true } label: {
                    Label("Benutzerverwaltung", systemImage: "person.2")
                }
            }
            Divider()
            Button(role: .destructive) {
                Task { try? await state.logout() }
            } label: {
                Label("Abmelden", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    private func reload() async {
        do { try await state.loadAll() }
        catch { self.error = error.localizedDescription }
        await state.loadAiSettings()
        await state.loadStack()
        await state.aiLoadDrift()
        // Auto-Refresh-Timer beim ersten Erscheinen starten (idempotent)
        state.startAutoRefresh()
    }
}

enum SidebarItem: Hashable { case meetings, todos, themes, contacts, digest }
