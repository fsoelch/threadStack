import SwiftUI

struct SidebarView: View {
    @EnvironmentObject var state: AppState
    @Binding var selectedMeetingId: String?
    @Binding var selectedView: SidebarItem
    @State private var search = ""
    @State private var showNewMeeting = false
    @State private var error: String?

    private var filteredMeetings: [Meeting] {
        guard !search.isEmpty else { return state.meetings }
        return state.meetings.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            $0.participants.joined(separator: " ").localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        #if os(macOS)
        TextField("Meetings suchen", text: $search)
            .textFieldStyle(.roundedBorder)
            .padding(.horizontal, 8)
            .padding(.top, 6)
        #endif
        List(selection: Binding(
            get: { selectedView == .meetings ? selectedMeetingId : nil },
            set: { selectedMeetingId = $0 }
        )) {
            // ── Topics & Todos nav ─────────────────────────
            Section {
                navRow(icon: "tag.fill", iconColor: .purple,
                       label: "Meine Topics",
                       badge: state.themes.isEmpty ? nil : "\(state.themes.count)",
                       item: .themes)
                navRow(icon: "checkmark.circle.fill", iconColor: .green,
                       label: "Meine Todos",
                       badge: state.openTodoCount > 0 ? "\(state.openTodoCount)" : nil,
                       item: .todos)
            }

            // ── Meetings ───────────────────────────────────
            Section("Meetings") {
                ForEach(filteredMeetings) { m in
                    MeetingRowView(meeting: m)
                        .tag(m.id)
                        .onTapGesture {
                            selectedMeetingId = m.id
                            selectedView = .meetings
                        }
                }
                .onDelete { idx in
                    let ids = idx.map { filteredMeetings[$0].id }
                    Task {
                        for id in ids {
                            do { try await state.deleteMeeting(id)
                                if selectedMeetingId == id { selectedMeetingId = nil }
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                }

                // macOS: inline add button (no toolbar)
                #if os(macOS)
                Button { showNewMeeting = true } label: {
                    Label("Neues Meeting", systemImage: "plus.circle")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                #endif
            }
        }
        .listStyle(.inset)
        .navigationTitle("ThreadStack")
        #if os(iOS)
        .searchable(text: $search, prompt: "Meetings suchen")
        #endif
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNewMeeting = true } label: { Image(systemName: "plus") }
            }
        }
        #endif
        .sheet(isPresented: $showNewMeeting) { MeetingFormView() }
        .alert("Fehler", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    @ViewBuilder
    private func navRow(icon: String, iconColor: Color, label: String,
                        badge: String?, item: SidebarItem) -> some View {
        Button {
            selectedView = item
            selectedMeetingId = nil
        } label: {
            HStack {
                Image(systemName: icon)
                    .frame(width: 24, height: 24)
                    .background(iconColor.opacity(0.15))
                    .foregroundStyle(iconColor)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(label).foregroundStyle(.primary)
                Spacer()
                if let badge {
                    Text(badge)
                        .scaledFont(.caption2).fontWeight(.semibold)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(hex: "#6366f1").opacity(0.15))
                        .foregroundStyle(Color(hex: "#6366f1"))
                        .clipShape(Capsule())
                }
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(selectedView == item ? Color(hex: "#6366f1").opacity(0.12) : nil)
    }
}

struct MeetingRowView: View {
    let meeting: Meeting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(Color(hex: meeting.color)).frame(width: 8, height: 8)
                Text(meeting.title).scaledFont(.subheadline).fontWeight(.medium).lineLimit(1)
            }
            if !meeting.participants.isEmpty {
                Text(meeting.participants.prefix(3).joined(separator: ", "))
                    .scaledFont(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack(spacing: 6) {
                if let d = meeting.nextDateFormatted {
                    Label(d, systemImage: "calendar").scaledFont(.caption2)
                        .foregroundStyle(meeting.isPast ? .orange : .secondary)
                }
                if meeting.openTopicsCount > 0 {
                    Text("\(meeting.openTopicsCount) offen")
                        .scaledFont(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color(hex: "#6366f1").opacity(0.15))
                        .foregroundStyle(Color(hex: "#6366f1"))
                        .clipShape(Capsule())
                }
            }
        }
        .padding(.vertical, 2)
    }
}
