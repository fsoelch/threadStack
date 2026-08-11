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

    private var nextMeetingId: String? {
        filteredMeetings.first(where: { !$0.isPast })?.id
    }

    var body: some View {
        #if os(macOS)
        macSidebar
        #else
        iosSidebar
        #endif
    }

    // MARK: - macOS (layout erhalten, Farben aktualisiert)

    #if os(macOS)
    @ViewBuilder private var macSidebar: some View {
        TextField("Meetings suchen", text: $search)
            .textFieldStyle(.roundedBorder)
            .padding(.horizontal, 8)
            .padding(.top, 6)
        List(selection: $selectedMeetingId) {
            Section {
                navRow(icon: "tag.fill", iconColor: DS.purple,
                       label: "Meine Topics",
                       badge: state.themes.isEmpty ? nil : "\(state.themes.count)",
                       item: .themes)
                    .tag(SidebarItem.themes.sentinel)
                navRow(icon: "books.vertical.fill", iconColor: DS.purple,
                       label: "Wissen",
                       badge: state.knowledgePages.isEmpty ? nil : "\(state.knowledgePages.count)",
                       item: .knowledge)
                    .tag(SidebarItem.knowledge.sentinel)
                navRow(icon: "person.crop.circle.fill", iconColor: DS.pink,
                       label: "Ansprechpartner",
                       badge: state.contacts.isEmpty ? nil : "\(state.contacts.count)",
                       item: .contacts)
                    .tag(SidebarItem.contacts.sentinel)
                navRow(icon: "checkmark.circle.fill", iconColor: DS.green,
                       label: "Meine Todos",
                       badge: state.openTodoCount > 0 ? "\(state.openTodoCount)" : nil,
                       item: .todos)
                    .tag(SidebarItem.todos.sentinel)
                navRow(icon: "point.3.filled.connected.trianglepath.dotted", iconColor: DS.accent,
                       label: "Graph",
                       badge: nil,
                       item: .graph)
                    .tag(SidebarItem.graph.sentinel)
                if state.aiFeatureEnabled(\.digest) {
                    navRow(icon: "chart.bar.doc.horizontal", iconColor: .blue,
                           label: "Wochen-Digest",
                           badge: nil,
                           item: .digest)
                        .tag(SidebarItem.digest.sentinel)
                }
            }
            Section("Meetings") {
                ForEach(filteredMeetings) { m in
                    MeetingRowView(meeting: m).tag(m.id)
                }
                .onDelete { deleteMeetings(at: $0) }
                Button { showNewMeeting = true } label: {
                    Label("Neues Meeting", systemImage: "plus.circle")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.inset)
        .navigationTitle("ThreadStack")
        .sheet(isPresented: $showNewMeeting) { MeetingFormView() }
        .alert("Fehler", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .onChange(of: selectedMeetingId) { _, newId in
            selectedView = SidebarItem.fromSelection(newId)
        }
    }
    #endif

    // MARK: - iOS — Karten-Layout

    #if os(iOS)
    @ViewBuilder private var iosSidebar: some View {
        List(selection: $selectedMeetingId) {
            // ── Schnellzugriff ──────────────────────────────
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        quickCard(icon: "checkmark.circle.fill", color: DS.green,
                                  label: "Todos", count: state.openTodoCount,
                                  sentinel: SidebarItem.todos.sentinel)
                        quickCard(icon: "tag.fill", color: DS.purple,
                                  label: "Topics", count: state.themes.count,
                                  sentinel: SidebarItem.themes.sentinel)
                        quickCard(icon: "books.vertical.fill", color: DS.purple,
                                  label: "Wissen", count: state.knowledgePages.count,
                                  sentinel: SidebarItem.knowledge.sentinel)
                        quickCard(icon: "person.2.fill", color: DS.pink,
                                  label: "Kontakte", count: state.contacts.count,
                                  sentinel: SidebarItem.contacts.sentinel)
                    }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))

                Button {
                    selectedMeetingId = SidebarItem.graph.sentinel
                } label: {
                    Label("Graph", systemImage: "point.3.filled.connected.trianglepath.dotted")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))

                if state.aiFeatureEnabled(\.digest) {
                    Button {
                        selectedMeetingId = SidebarItem.digest.sentinel
                    } label: {
                        Label("Wochen-Digest", systemImage: "chart.bar.doc.horizontal")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
                }
            } header: {
                Text("Schnellzugriff")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }

            // ── Meetings ─────────────────────────────────────
            Section {
                ForEach(filteredMeetings) { m in
                    MeetingCardView(meeting: m, isNext: m.id == nextMeetingId)
                        .tag(m.id)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                }
                .onDelete { deleteMeetings(at: $0) }
            } header: {
                Text("Meetings")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.plain)
        .background(DS.groupedBg)
        .navigationTitle("ThreadStack")
        .searchable(text: $search, prompt: "Meetings suchen")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNewMeeting = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showNewMeeting) { MeetingFormView() }
        .alert("Fehler", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
        .onChange(of: selectedMeetingId) { _, newId in
            selectedView = SidebarItem.fromSelection(newId)
        }
    }

    private func quickCard(icon: String, color: Color, label: String,
                           count: Int, sentinel: String) -> some View {
        Button { selectedMeetingId = sentinel } label: {
            VStack(alignment: .leading, spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(color.opacity(0.15))
                        .frame(width: 30, height: 30)
                    Image(systemName: icon)
                        .font(.system(size: 14))
                        .foregroundStyle(color)
                }
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(count)")
                    .font(.title3.bold())
                    .foregroundStyle(.primary)
            }
            .padding(12)
            .frame(width: 92, alignment: .leading)
            .background(DS.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: DS.cardRadius))
            .shadow(color: DS.cardShadow, radius: 1, x: 0, y: 1)
        }
        .buttonStyle(.plain)
    }
    #endif

    // MARK: - macOS navRow

    @ViewBuilder
    private func navRow(icon: String, iconColor: Color, label: String,
                        badge: String?, item: SidebarItem) -> some View {
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
                    .background(DS.accent.opacity(0.15))
                    .foregroundStyle(DS.accent)
                    .clipShape(Capsule())
            }
        }
        .contentShape(Rectangle())
    }

    private func deleteMeetings(at offsets: IndexSet) {
        let ids = offsets.map { filteredMeetings[$0].id }
        Task {
            for id in ids {
                do {
                    try await state.deleteMeeting(id)
                    if selectedMeetingId == id { selectedMeetingId = nil }
                } catch { self.error = error.localizedDescription }
            }
        }
    }
}

// MARK: - SidebarItem extensions

extension SidebarItem {
    var sentinel: String {
        switch self {
        case .meetings:  return "__meetings__"
        case .themes:    return "__themes__"
        case .knowledge: return "__knowledge__"
        case .contacts:  return "__contacts__"
        case .todos:     return "__todos__"
        case .digest:    return "__digest__"
        case .graph:     return "__graph__"
        }
    }
    static func fromSelection(_ id: String?) -> SidebarItem {
        switch id {
        case "__themes__"?:    return .themes
        case "__knowledge__"?: return .knowledge
        case "__contacts__"?:  return .contacts
        case "__todos__"?:     return .todos
        case "__digest__"?:    return .digest
        case "__graph__"?:     return .graph
        default:               return .meetings
        }
    }
}

// MARK: - Meeting Row (macOS)

struct MeetingRowView: View {
    let meeting: Meeting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(Color(hex: meeting.color)).frame(width: 8, height: 8)
                Text(meeting.title).scaledFont(.subheadline).fontWeight(.medium).lineLimit(1)
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
                        .background(DS.accent.opacity(0.12))
                        .foregroundStyle(DS.accent)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Meeting Card (iOS)

#if os(iOS)
struct MeetingCardView: View {
    let meeting: Meeting
    let isNext: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(Color(hex: meeting.color)).frame(width: 8, height: 8)
                Text(meeting.title)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            HStack(spacing: 8) {
                if let d = meeting.nextDateFormatted {
                    Label(d, systemImage: "calendar")
                        .scaledFont(.caption2)
                        .foregroundStyle(meeting.isPast ? DS.orange : .secondary)
                }
                if meeting.openTopicsCount > 0 {
                    Text("\(meeting.openTopicsCount) offen")
                        .scaledFont(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(DS.accent.opacity(0.12))
                        .foregroundStyle(DS.accent)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(12)
        .background(DS.cardBg)
        .clipShape(RoundedRectangle(cornerRadius: DS.cardRadius))
        .overlay(
            RoundedRectangle(cornerRadius: DS.cardRadius)
                .strokeBorder(isNext ? DS.accent : Color.clear, lineWidth: 1.5)
        )
        .shadow(color: DS.cardShadow, radius: 1, x: 0, y: 1)
    }
}
#endif
