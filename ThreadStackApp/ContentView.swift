import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @State private var selectedMeetingId: String? = nil
    @State private var selectedView: SidebarItem = .meetings
    @State private var error: String?
    @State private var showSettings = false
    @State private var showAdmin = false

    var body: some View {
        #if os(macOS)
        macContent
        #else
        iosLayout
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
                // Bottom action bar
                HStack {
                    Button { showSettings = true } label: {
                        Image(systemName: "gear")
                    }
                    .buttonStyle(.plain).help("Einstellungen")

                    if state.currentUser?.isAdmin == true {
                        Button { showAdmin = true } label: {
                            Image(systemName: "person.2")
                        }
                        .buttonStyle(.plain).help("Benutzerverwaltung")
                    }
                    Spacer()
                    Button { Task { try? await state.logout() } } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                    }
                    .buttonStyle(.plain).help("Abmelden")
                }
                .foregroundStyle(.secondary)
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
            if let id = selectedMeetingId,
               let m = state.meetings.first(where: { $0.id == id }) {
                MeetingDetailView(meeting: m)
            } else {
                emptyState
            }
        case .todos:
            TodosView()
        case .themes:
            ThemesView()
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

    private var menuButton: some View {
        Menu {
            Button { showSettings = true } label: {
                Label("Einstellungen", systemImage: "gear")
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
    }
}

enum SidebarItem: Hashable { case meetings, todos, themes }
