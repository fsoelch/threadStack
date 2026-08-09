import SwiftUI

struct TopicFormView: View {
    let meetingId: String
    var topic: Topic? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var isTodo = false
    @State private var hasSnooze = false
    @State private var snoozeDate = Date()
    @State private var snoozeHasTime = false
    @State private var loading = false
    @State private var error: String?
    @State private var showLinkSheet = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Thema eingeben", text: $title)
                }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical)
                        .lineLimit(3...)
                    Button {
                        showLinkSheet = true
                    } label: {
                        Label("Link mit KI-Zusammenfassung einfügen", systemImage: "link")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Öffnet einen Dialog zum Einfügen eines Links, optional mit KI-Zusammenfassung.")
                }
                Section {
                    Toggle("Als Todo markieren", isOn: $isTodo)
                }
                Section {
                    Toggle("😴 Schlafen bis", isOn: $hasSnooze)
                    if hasSnooze {
                        DatePicker("Wacht auf am", selection: $snoozeDate, displayedComponents: .date)
                        Toggle("🕐 zu bestimmter Uhrzeit", isOn: $snoozeHasTime)
                        if snoozeHasTime {
                            DatePicker("Uhrzeit", selection: $snoozeDate, displayedComponents: .hourAndMinute)
                        }
                    }
                } footer: {
                    Text(snoozeHasTime ? "Wacht exakt zu dieser Uhrzeit auf — mit Benachrichtigung." : "Bis zu diesem Datum ausblenden.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(topic == nil ? "Neues Thema" : "Thema bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(title.isEmpty || loading)
                }
            }
            .onAppear { populate() }
            .sheet(isPresented: $showLinkSheet) {
                LinkInsertSheet(onInsert: { text in
                    description += (description.isEmpty ? "" : "\n\n") + text
                })
            }
        }
    }

    private func populate() {
        guard let t = topic else { return }
        title = t.title
        description = stripHTML(t.description)
        isTodo = t.isTodo
        if let s = t.snoozedUntil, !s.isEmpty {
            if s.count > 10, let d = parseFlexDate(s) {
                hasSnooze = true; snoozeDate = d; snoozeHasTime = true
            } else if let d = Self.parseDate(s) {
                hasSnooze = true; snoozeDate = d
            }
        }
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

    private static func formatDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    private func save() {
        loading = true
        let snooze: String? = hasSnooze
            ? (snoozeHasTime ? ISO8601DateFormatter().string(from: snoozeDate) : Self.formatDate(snoozeDate))
            : nil
        let notificationTitle = title
        let fireAt: Date? = (hasSnooze && snoozeHasTime) ? snoozeDate : nil
        Task {
            do {
                if let t = topic {
                    try await state.updateTopic(
                        meetingId: meetingId, id: t.id,
                        title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        isTodo: isTodo, snoozedUntil: snooze
                    )
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(t.id)", title: notificationTitle, fireAt: fireAt)
                } else {
                    let created = try await state.createTopicReturning(
                        meetingId: meetingId, title: title,
                        description: description, isTodo: isTodo,
                        snoozedUntil: snooze
                    )
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(created.id)", title: notificationTitle, fireAt: fireAt)
                }
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
