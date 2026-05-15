import SwiftUI

struct MeetingDetailView: View {
    let meeting: Meeting
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var showEdit = false
    @State private var showNewTopic = false
    @State private var error: String?

    private var current: Meeting { state.meetings.first(where: { $0.id == meeting.id }) ?? meeting }

    private var filtered: [Topic] {
        guard !search.isEmpty else { return current.topics }
        return current.topics.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            $0.description.localizedCaseInsensitiveContains(search)
        }
    }

    private var openTopics:    [Topic] { filtered.filter { !$0.done && !$0.isSnoozed } }
    private var snoozedTopics: [Topic] { filtered.filter { !$0.done &&  $0.isSnoozed } }
    private var doneTopics:    [Topic] { filtered.filter {  $0.done }.sorted { $0.resultDate > $1.resultDate } }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Themen suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            #endif

            // Meeting header
            Section {
                meetingHeader
            }

            // Offen
            if !openTopics.isEmpty {
                Section(header: sectionHeader("Offen", count: openTopics.count, color: .indigo)) {
                    ForEach(openTopics) { t in
                        TopicRowView(topic: t, meetingId: current.id)
                    }
                    .onDelete { deleteTopic(from: openTopics, at: $0) }
                    .onMove   { moveTopics(in: openTopics, from: $0, to: $1) }
                }
            }

            // Schlafend
            if !snoozedTopics.isEmpty {
                Section(header: sectionHeader("😴 Schlafend", count: snoozedTopics.count, color: .gray)) {
                    ForEach(snoozedTopics) { t in TopicRowView(topic: t, meetingId: current.id) }
                }
            }

            // Erledigt
            if !doneTopics.isEmpty {
                Section(header: sectionHeader("Erledigt", count: doneTopics.count, color: .green)) {
                    ForEach(doneTopics) { t in TopicRowView(topic: t, meetingId: current.id) }
                    .onDelete { deleteTopic(from: doneTopics, at: $0) }
                }
            }

            if current.topics.isEmpty {
                Section {
                    Text("Noch keine Themen — tippe auf + um das erste hinzuzufügen.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .navigationTitle(current.title)
        #if os(iOS)
        .searchable(text: $search, prompt: "Themen suchen")
        #endif
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showNewTopic = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
        }
        #endif
        .sheet(isPresented: $showEdit)     { MeetingFormView(meeting: current) }
        .sheet(isPresented: $showNewTopic) { TopicFormView(meetingId: current.id) }
        .alert("Fehler", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    // ── Meeting header card ──────────────────────────────────
    @ViewBuilder private var meetingHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(hex: current.color))
                    .frame(width: 4, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    if !current.description.isEmpty {
                        Text(current.description)
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if !current.participants.isEmpty {
                        Label(current.participants.joined(separator: ", "), systemImage: "person.2")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let d = current.nextDateFormatted {
                        Label(d, systemImage: "calendar")
                            .font(.caption)
                            .foregroundStyle(current.isPast ? .orange : .secondary)
                    }
                    if current.isRecurring {
                        Label(recLabel(current.recurrencePattern), systemImage: "repeat")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            HStack(spacing: 8) {
                Button { showEdit = true } label: {
                    Label("Bearbeiten", systemImage: "pencil")
                }.buttonStyle(.bordered).controlSize(.small)

                #if os(macOS)
                Button { showNewTopic = true } label: {
                    Label("Neues Thema", systemImage: "plus")
                }.buttonStyle(.bordered).controlSize(.small)
                #endif

                if current.isRecurring && !current.nextDate.isEmpty {
                    Button {
                        Task { do { try await state.advanceDate(current.id) }
                              catch { self.error = error.localizedDescription } }
                    } label: {
                        Label("Nächster Termin", systemImage: "arrow.clockwise")
                    }.buttonStyle(.bordered).controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func sectionHeader(_ label: String, count: Int, color: Color) -> some View {
        HStack {
            Text(label).foregroundStyle(color)
            Text("(\(count))").foregroundStyle(.secondary)
        }.scaledFont(.footnote).fontWeight(.semibold)
    }

    private func deleteTopic(from list: [Topic], at offsets: IndexSet) {
        let ids = offsets.map { list[$0].id }
        Task {
            for id in ids {
                do { try await state.deleteTopic(meetingId: current.id, id: id) }
                catch { self.error = error.localizedDescription }
            }
        }
    }

    private func moveTopics(in list: [Topic], from source: IndexSet, to destination: Int) {
        var arr = list
        arr.move(fromOffsets: source, toOffset: destination)
        Task {
            do { try await state.reorderTopics(meetingId: current.id, ids: arr.map(\.id)) }
            catch { self.error = error.localizedDescription }
        }
        // Optimistic update in state
        if let mi = state.meetings.firstIndex(where: { $0.id == current.id }) {
            let allTopics = state.meetings[mi].topics
            let openIds = Set(list.map(\.id))
            let others = allTopics.filter { !openIds.contains($0.id) }
            state.meetings[mi].topics = others + arr
        }
    }

    func recLabel(_ p: String) -> String {
        ["weekly": "Wöchentlich", "biweekly": "Zweiwöchentlich", "monthly": "Monatlich"][p] ?? p
    }
}

// MARK: - Topic Row

struct TopicRowView: View {
    let topic: Topic
    let meetingId: String
    @EnvironmentObject var state: AppState
    @State private var showEdit = false
    @State private var showComplete = false
    @State private var showShare = false
    @State private var showMove = false
    @State private var showThemes = false
    @State private var showSnooze = false
    @State private var error: String?

    private var themeLinks: [(theme: Theme, link: ThemeLink)] { state.themeLinks(for: topic.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                // Status dot
                statusIcon
                VStack(alignment: .leading, spacing: 3) {
                    Text(topic.title)
                        .scaledFont(.subheadline).fontWeight(.medium)
                        .strikethrough(topic.done)
                        .foregroundStyle(topic.done ? .secondary : .primary)

                    if !topic.description.isEmpty {
                        Text(stripHTML(topic.description))
                            .scaledFont(.caption).foregroundStyle(.secondary)
                            .lineLimit(2)
                    }

                    if topic.isSnoozed, let wake = topic.snoozeWakeFormatted {
                        Label("Wacht auf am \(wake)", systemImage: "moon.zzz")
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }

                    // Theme chips
                    if !themeLinks.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(themeLinks, id: \.link.id) { tl in
                                    themeChip(tl.theme.title)
                                }
                            }
                        }
                    }

                    // Shared with other meetings
                    let sharedIn = state.meetings.filter {
                        $0.id != meetingId && $0.topics.contains(where: { $0.groupId != nil && $0.groupId == topic.groupId })
                    }
                    if topic.groupId != nil && !sharedIn.isEmpty {
                        ForEach(sharedIn) { m in
                            Label(m.title, systemImage: "link")
                                .scaledFont(.caption2).foregroundStyle(.indigo)
                        }
                    }
                }
                Spacer()
                // Todo pin
                if topic.isTodo {
                    Image(systemName: "pin.fill").font(.caption).foregroundStyle(.green)
                }
            }

            // Done result
            if topic.done && !topic.result.isEmpty {
                Text(stripHTML(topic.result))
                    .scaledFont(.caption).foregroundStyle(.green)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .opacity(topic.isSnoozed ? 0.7 : 1)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { do { try await state.deleteTopic(meetingId: meetingId, id: topic.id) }
                      catch { self.error = error.localizedDescription } }
            } label: { Label("Löschen", systemImage: "trash") }

            if !topic.done {
                Button { showComplete = true } label: {
                    Label("Erledigt", systemImage: "checkmark.circle")
                }.tint(.green)
            } else {
                Button {
                    Task { do { try await state.reopenTopic(meetingId: meetingId, id: topic.id) }
                          catch { self.error = error.localizedDescription } }
                } label: { Label("Öffnen", systemImage: "arrow.uturn.left") }
            }
        }
        .swipeActions(edge: .leading) {
            Button { showSnooze = true } label: {
                Label(topic.isSnoozed ? "Wecken" : "Schlafen", systemImage: "moon.zzz")
            }.tint(.indigo)
        }
        .contextMenu { contextMenuItems }
        .sheet(isPresented: $showEdit)     { TopicFormView(meetingId: meetingId, topic: topic) }
        .sheet(isPresented: $showComplete) { CompleteSheet(meetingId: meetingId, topicId: topic.id) }
        .sheet(isPresented: $showShare)    { ShareTopicSheet(meetingId: meetingId, topicId: topic.id) }
        .sheet(isPresented: $showMove)     { MoveItemSheet(type: .topic(meetingId: meetingId, id: topic.id)) }
        .sheet(isPresented: $showThemes)   { ThemeLinkSheet(refType: "topic", refId: topic.id, title: topic.title) }
        .sheet(isPresented: $showSnooze)   { SnoozeSheet(onSnooze: { until in
            Task { do { try await state.snoozeTopic(meetingId: meetingId, id: topic.id, until: until) }
                  catch { self.error = error.localizedDescription } }
        }, onWake: topic.isSnoozed ? {
            Task { do { try await state.snoozeTopic(meetingId: meetingId, id: topic.id, until: nil) }
                  catch { self.error = error.localizedDescription } }
        } : nil) }
        .alert("Fehler", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    @ViewBuilder private var statusIcon: some View {
        if topic.done {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).scaledFont(.subheadline)
        } else if topic.isSnoozed {
            Image(systemName: "moon.zzz.fill").foregroundStyle(.gray).scaledFont(.subheadline)
        } else {
            Circle().stroke(Color.indigo, lineWidth: 1.5)
                .frame(width: 16, height: 16)
        }
    }

    @ViewBuilder private var contextMenuItems: some View {
        Button { showEdit = true } label: { Label("Bearbeiten", systemImage: "pencil") }
        Button { showThemes = true } label: { Label("Topic zuweisen", systemImage: "tag") }
        Button { showShare = true } label: { Label("Teilen", systemImage: "link") }
        Button { showMove = true } label: { Label("Verschieben", systemImage: "arrow.right") }
        Divider()
        Button { showSnooze = true } label: { Label(topic.isSnoozed ? "Wecken" : "Schlafen legen", systemImage: "moon.zzz") }
        Button {
            Task { do { try await state.toggleTopicTodo(meetingId: meetingId, id: topic.id) }
                  catch { self.error = error.localizedDescription } }
        } label: {
            Label(topic.isTodo ? "Aus Todos entfernen" : "Als Todo markieren", systemImage: topic.isTodo ? "pin.slash" : "pin")
        }
        Divider()
        if !topic.done {
            Button { showComplete = true } label: { Label("Als erledigt markieren", systemImage: "checkmark.circle") }
        } else {
            Button {
                Task { do { try await state.reopenTopic(meetingId: meetingId, id: topic.id) }
                      catch { self.error = error.localizedDescription } }
            } label: { Label("Wieder öffnen", systemImage: "arrow.uturn.left") }
        }
        Divider()
        Button(role: .destructive) {
            Task { do { try await state.deleteTopic(meetingId: meetingId, id: topic.id) }
                  catch { self.error = error.localizedDescription } }
        } label: { Label("Löschen", systemImage: "trash") }
    }

    private func themeChip(_ title: String) -> some View {
        Text("🏷️ \(title)")
            .scaledFont(.caption2).fontWeight(.medium)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.purple.opacity(0.1))
            .foregroundStyle(.purple)
            .clipShape(Capsule())
    }
}
