import SwiftUI

struct TopicFormView: View {
    let meetingId: String
    var topic: Topic? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var isTodo = false
    @State private var snoozeDate = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Thema eingeben", text: $title)
                }
                Section("Beschreibung") {
                    TextField("Optional", text: $description, axis: .vertical)
                        .lineLimit(3...)
                }
                Section {
                    Toggle("Als Todo markieren", isOn: $isTodo)
                }
                Section("Schlafen bis (optional)") {
                    TextField("JJJJ-MM-TT", text: $snoozeDate)
                        .numberKeyboard()
                    if !snoozeDate.isEmpty {
                        Button("Snooze entfernen", role: .destructive) { snoozeDate = "" }
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
                        .disabled(title.isEmpty || loading)
                }
            }
            .onAppear { populate() }
        }
    }

    private func populate() {
        guard let t = topic else { return }
        title = t.title
        description = t.description
        isTodo = t.isTodo
        snoozeDate = t.snoozedUntil ?? ""
    }

    private func save() {
        loading = true
        let snooze: String? = snoozeDate.isEmpty ? nil : snoozeDate
        Task {
            do {
                if let t = topic {
                    try await state.updateTopic(
                        meetingId: meetingId, id: t.id,
                        title: title, description: description,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        isTodo: isTodo, snoozedUntil: snooze
                    )
                } else {
                    try await state.createTopic(
                        meetingId: meetingId, title: title,
                        description: description, isTodo: isTodo,
                        snoozedUntil: snooze
                    )
                }
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
