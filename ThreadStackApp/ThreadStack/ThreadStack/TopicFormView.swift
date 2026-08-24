import SwiftUI

struct TopicFormView: View {
    let meetingId: String
    var topic: Topic? = nil
    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore // A3: Fortschrittsverlauf-Zugriff
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
    @State private var showProgressHistory = false // A3
    // Story 6 (Tester-Fund): optionaler Zwischenstand beim direkten Snoozen
    // (außerhalb des Stacks) — analog zum Checkpoint-Feld in StackPopSheet.
    @State private var whereAmI = ""
    @State private var checkpointError: String?

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
                if hasSnooze {
                    Section("Wo stehe ich gerade? (optional)") {
                        TextEditor(text: $whereAmI).frame(minHeight: 80)
                        Text("\(whereAmI.count) / \(ProgressEntryCharLimit.maxLength)")
                            .scaledFont(.caption).foregroundStyle(.secondary)
                        if let checkpointError {
                            Text(checkpointError).scaledFont(.caption).foregroundStyle(.orange)
                        }
                    }
                }
                // A3: Verlaufs-Zugriff nur für bereits gespeicherte Topics (id vorhanden).
                if topic != nil {
                    Section {
                        Button { showProgressHistory = true } label: {
                            Label("Fortschrittsverlauf", systemImage: "chart.line.uptrend.xyaxis")
                        }
                    }
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
                        .disabled(title.isEmpty || loading
                                  || (hasSnooze && ProgressEntryCharLimit.isOverLimit(length: whereAmI.count)))
                }
            }
            .onAppear { populate() }
            .sheet(isPresented: $showLinkSheet) {
                LinkInsertSheet(onInsert: { text in
                    description += (description.isEmpty ? "" : "\n\n") + text
                })
            }
            // A3: Fortschrittsverlauf-Sheet, nur für bereits gespeicherte Topics.
            .sheet(isPresented: $showProgressHistory) {
                if let t = topic {
                    ProgressHistorySheet(refType: "topic", refId: t.id, store: progressStore)
                }
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
                var savedId = topic?.id
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
                    savedId = created.id
                    NotificationScheduler.shared.reschedule(id: "topic-\(meetingId)-\(created.id)", title: notificationTitle, fireAt: fireAt)
                }
                // Story 6 (Tester-Fund): der Snooze ist bereits serverseitig
                // erfolgt — ein Fehler beim optionalen Zwischenstand darf ihn
                // NICHT als fehlgeschlagen erscheinen lassen.
                let checkpointOK = await saveCheckpointIfNeeded(refId: savedId)
                loading = false
                if checkpointOK { dismiss() }
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }

    private func saveCheckpointIfNeeded(refId: String?) async -> Bool {
        guard hasSnooze, let refId else { return true }
        let trimmed = whereAmI.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        do {
            _ = try await progressStore.addEntry(refType: "topic", refId: refId, bodyHTML: trimmed, source: "snooze")
            return true
        } catch {
            checkpointError = "Zwischenstand konnte nicht gespeichert werden — dein Text bleibt oben erhalten."
            return false
        }
    }
}
