import SwiftUI

// MARK: - Complete Sheet (Topic)

struct CompleteSheet: View {
    let meetingId: String
    let topicId: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var result = ""
    @State private var resultDate = Date()
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Ergebnis") {
                    TextEditor(text: $result).frame(minHeight: 80)
                }
                Section("Datum") {
                    DatePicker("Erledigt am", selection: $resultDate, displayedComponents: .date)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("Als erledigt markieren")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Erledigt") { save() }.disabled(loading)
                }
            }
        }
    }

    private func save() {
        loading = true
        let fmt = ISO8601DateFormatter(); fmt.formatOptions = [.withFullDate]
        Task {
            do {
                try await state.completeTopic(meetingId: meetingId, id: topicId,
                                              result: result,
                                              resultDate: fmt.string(from: resultDate))
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - Share Topic Sheet

struct ShareTopicSheet: View {
    let meetingId: String
    let topicId: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var selectedMeetingId = ""
    @State private var loading = false
    @State private var error: String?

    private var otherMeetings: [Meeting] { state.meetings.filter { $0.id != meetingId } }

    var body: some View {
        NavigationStack {
            Form {
                Section("Meeting auswählen") {
                    if otherMeetings.isEmpty {
                        Text("Keine anderen Meetings vorhanden.").foregroundStyle(.secondary)
                    } else {
                        ForEach(otherMeetings) { m in
                            Button {
                                selectedMeetingId = m.id
                            } label: {
                                HStack {
                                    Circle().fill(Color(hex: m.color)).frame(width: 8, height: 8)
                                    Text(m.title).foregroundStyle(.primary)
                                    Spacer()
                                    if selectedMeetingId == m.id {
                                        Image(systemName: "checkmark").foregroundStyle(.indigo)
                                    }
                                }
                            }
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Thema teilen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Teilen") { share() }
                        .disabled(selectedMeetingId.isEmpty || loading)
                }
            }
        }
    }

    private func share() {
        loading = true
        Task {
            do {
                try await state.shareTopic(meetingId: meetingId, id: topicId,
                                           targetMeetingId: selectedMeetingId)
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - Move Item Sheet

enum MoveItemType {
    case topic(meetingId: String, id: String)
    case todo(id: String)
}

struct MoveItemSheet: View {
    let type: MoveItemType
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var toMeeting = true
    @State private var selectedMeetingId = ""
    @State private var loading = false
    @State private var error: String?

    private var isTodo: Bool { if case .todo = type { return true }; return false }

    private var otherMeetings: [Meeting] {
        switch type {
        case .topic(let mid, _): return state.meetings.filter { $0.id != mid }
        case .todo:              return state.meetings
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if !isTodo {
                    Section {
                        Picker("Ziel", selection: $toMeeting) {
                            Text("Anderes Meeting").tag(true)
                            Text("Persönliche Todos").tag(false)
                        }.pickerStyle(.segmented)
                    }
                }

                if isTodo || toMeeting {
                    Section("Meeting auswählen") {
                        if otherMeetings.isEmpty {
                            Text("Keine Meetings vorhanden.").foregroundStyle(.secondary)
                        } else {
                            ForEach(otherMeetings) { m in
                                Button {
                                    selectedMeetingId = m.id
                                } label: {
                                    HStack {
                                        Circle().fill(Color(hex: m.color)).frame(width: 8, height: 8)
                                        Text(m.title).foregroundStyle(.primary)
                                        Spacer()
                                        if selectedMeetingId == m.id {
                                            Image(systemName: "checkmark").foregroundStyle(.indigo)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Verschieben")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Verschieben") { move() }
                        .disabled(loading || ((isTodo || toMeeting) && selectedMeetingId.isEmpty))
                }
            }
        }
    }

    private func move() {
        loading = true
        Task {
            do {
                switch type {
                case .topic(let mid, let id):
                    let target: String? = toMeeting ? selectedMeetingId : nil
                    try await state.moveTopic(meetingId: mid, id: id, targetMeetingId: target)
                case .todo(let id):
                    try await state.moveTodo(id: id, targetMeetingId: selectedMeetingId)
                }
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}

// MARK: - Theme Link Sheet

struct ThemeLinkSheet: View {
    let refType: String
    let refId: String
    let title: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var error: String?

    private var linked:    [(theme: Theme, link: ThemeLink)] { state.themeLinks(for: refId) }
    private var linkedIds: Set<String> { Set(linked.map(\.theme.id)) }
    private var unlinked:  [Theme]    { state.themes.filter { !linkedIds.contains($0.id) } }

    var body: some View {
        NavigationStack {
            List {
                if !linked.isEmpty {
                    Section("Zugewiesen") {
                        ForEach(linked, id: \.link.id) { tl in
                            HStack {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                Text(tl.theme.title)
                                Spacer()
                                Button { remove(linkId: tl.link.id) } label: {
                                    Image(systemName: "minus.circle").foregroundStyle(.red)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                if !unlinked.isEmpty {
                    Section("Hinzufügen") {
                        ForEach(unlinked) { theme in
                            Button { add(themeId: theme.id) } label: {
                                HStack {
                                    Image(systemName: "plus.circle").foregroundStyle(.indigo)
                                    Text(theme.title).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                }
                if state.themes.isEmpty {
                    Section { Text("Noch keine Topics vorhanden.").foregroundStyle(.secondary) }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(title)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } }
            }
        }
    }

    private func add(themeId: String) {
        Task {
            do { try await state.addThemeLink(themeId: themeId, refType: refType, refId: refId) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func remove(linkId: String) {
        Task {
            do { try await state.removeThemeLink(id: linkId) }
            catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: - Snooze Sheet

struct SnoozeSheet: View {
    let onSnooze: (String) -> Void
    let onWake: (() -> Void)?
    @Environment(\.dismiss) var dismiss
    @State private var date = Date().addingTimeInterval(7 * 86400)

    var body: some View {
        NavigationStack {
            Form {
                if onWake != nil {
                    Section {
                        Button(role: .destructive) { onWake?(); dismiss() } label: {
                            Label("Jetzt aufwecken", systemImage: "sun.max")
                        }
                    }
                }
                Section("Schlafen bis") {
                    DatePicker("Datum", selection: $date, in: Date()..., displayedComponents: .date)
                        .datePickerStyle(.graphical)
                }
            }
            .navigationTitle(onWake != nil ? "Schlaf-Einstellungen" : "Schlafen legen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schlafen") {
                        let fmt = ISO8601DateFormatter(); fmt.formatOptions = [.withFullDate]
                        onSnooze(fmt.string(from: date))
                        dismiss()
                    }
                }
            }
        }
    }
}

// MARK: - Meeting Form View

struct MeetingFormView: View {
    var meeting: Meeting? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var participants = ""
    @State private var color = "#6366f1"
    @State private var nextDate = ""
    @State private var isRecurring = false
    @State private var recurrencePattern = "weekly"
    @State private var loading = false
    @State private var error: String?

    private let colors  = ["#6366f1","#8b5cf6","#ec4899","#f97316","#22c55e","#06b6d4","#f59e0b","#64748b"]
    private let patterns = [("weekly","Wöchentlich"),("biweekly","Zweiwöchentlich"),("monthly","Monatlich")]

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") { TextField("Titel", text: $title) }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical).lineLimit(3...)
                }
                Section("Teilnehmer") {
                    TextField("Kommagetrennt", text: $participants, axis: .vertical).lineLimit(2...)
                }
                Section("Farbe") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: 8) {
                        ForEach(colors, id: \.self) { c in
                            Circle().fill(Color(hex: c)).frame(width: 28, height: 28)
                                .overlay {
                                    if c == color {
                                        Image(systemName: "checkmark")
                                            .font(.caption2.weight(.bold)).foregroundStyle(.white)
                                    }
                                }
                                .onTapGesture { color = c }
                        }
                    }.padding(.vertical, 4)
                }
                Section("Nächster Termin") {
                    TextField("JJJJ-MM-TT", text: $nextDate).numberKeyboard()
                }
                Section {
                    Toggle("Wiederkehrend", isOn: $isRecurring)
                    if isRecurring {
                        Picker("Muster", selection: $recurrencePattern) {
                            ForEach(patterns, id: \.0) { Text($0.1).tag($0.0) }
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(meeting == nil ? "Neues Meeting" : "Meeting bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }.disabled(title.isEmpty || loading)
                }
            }
            .onAppear { populate() }
        }
    }

    private func populate() {
        guard let m = meeting else { return }
        title = m.title; description = m.description
        participants = m.participants.joined(separator: ", ")
        color = m.color; nextDate = m.nextDate
        isRecurring = m.isRecurring; recurrencePattern = m.recurrencePattern
    }

    private func save() {
        loading = true
        let parts = participants.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        Task {
            do {
                if let m = meeting {
                    try await state.updateMeeting(
                        id: m.id, title: title, description: description,
                        participants: parts, color: color, nextDate: nextDate,
                        isRecurring: isRecurring, recurrencePattern: recurrencePattern)
                } else {
                    try await state.createMeeting(
                        title: title, description: description,
                        participants: parts, color: color, nextDate: nextDate,
                        isRecurring: isRecurring, recurrencePattern: recurrencePattern)
                }
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
