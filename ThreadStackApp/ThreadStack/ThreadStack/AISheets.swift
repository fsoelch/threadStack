import SwiftUI

extension OfflineUnavailableReason {
    /// Platzhaltertext fuer KI-Funktionen (nie zwischengespeichert).
    static let aiFeatures = OfflineUnavailableReason.custom(
        "KI-Funktionen brauchen eine Verbindung zum Server. Sie sind verfügbar, sobald du wieder online bist.")
}

// MARK: - Brief Sheet

struct AIBriefSheet: View {
    let meetingId: String
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @Environment(\.dismiss) var dismiss
    @State private var content: BriefContent?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if OfflineGating.showsUnavailable(isOffline: offline.isOffline,
                                                             hasContent: content != nil,
                                                             loadFailedOffline: false) {
                        OfflineUnavailableView(reason: OfflineUnavailableReason.aiFeatures)
                            .frame(minHeight: 260)
                    } else if loading {
                        ProgressView("Erzeuge Briefing …").frame(maxWidth: .infinity)
                    } else if let c = content {
                        section("Talking Points", items: c.talking_points)
                        section("Offene Punkte",  items: c.open_issues)
                        if !c.history.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Vorgeschichte").font(.subheadline).fontWeight(.semibold)
                                Text(c.history).font(.callout)
                            }
                        }
                    } else if let error {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }
                .padding()
            }
            .navigationTitle("🤖 Briefing")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Neu") { Task { await load() } }
                        .disabled(loading)
                        .disabledWhenOfflineCompact(offline.isOffline)
                }
            }
            .reloadWhenBackOnline(hasContent: content != nil) { Task { await load() } }
            .task { await load() }
        }
    }
    private func section(_ title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline).fontWeight(.semibold)
            ForEach(Array(items.enumerated()), id: \.offset) { _, t in
                HStack(alignment: .top, spacing: 8) {
                    Text("•").foregroundStyle(DS.brandIndigo).fontWeight(.bold)
                    Text(t).font(.callout)
                }
            }
        }
    }
    private func load() async {
        guard !offline.isOffline else { return }
        loading = true; error = nil
        do {
            let r = try await state.aiBrief(meetingId: meetingId)
            content = r.content
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                let r = try await state.aiBrief(meetingId: meetingId, confirm: true)
                content = r.content
            } catch { self.error = OfflineGating.message(for: error, fallback: error.localizedDescription) }
        } catch {
            self.error = OfflineGating.message(for: error, fallback: error.localizedDescription)
        }
        loading = false
    }
}

// MARK: - Capture Sheet

struct AICaptureSheet: View {
    let meetingId: String
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @Environment(\.dismiss) var dismiss
    @State private var notes = ""
    @State private var suggestions: CaptureSuggestions?
    @State private var pickedTopics:  Set<String> = []
    @State private var pickedResults: Set<String> = []
    @State private var pickedTodos:   Set<String> = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Notizen / Transkript") {
                    TextEditor(text: $notes).frame(minHeight: 120)
                }
                if suggestions == nil {
                    Section {
                        Button("🤖 Vorschläge erzeugen") { Task { await process() } }
                            .disabled(notes.trimmingCharacters(in: .whitespaces).isEmpty || loading)
                            .disabledWhenOffline(offline.isOffline)
                    }
                } else {
                    suggestionLists
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Notizen verarbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if suggestions != nil {
                        Button("Übernehmen") { Task { await apply() } }
                            .disabled((pickedTopics.isEmpty && pickedResults.isEmpty && pickedTodos.isEmpty) || loading)
                            .disabledWhenOfflineCompact(offline.isOffline)
                    }
                }
            }
        }
    }

    @ViewBuilder private var suggestionLists: some View {
        if let s = suggestions {
            if !s.new_topics.isEmpty {
                Section("Neue Themen") {
                    ForEach(s.new_topics) { t in
                        Toggle(isOn: topicBinding(t.id)) {
                            VStack(alignment: .leading) {
                                Text(t.title).font(.subheadline).fontWeight(.medium)
                                if let d = t.description, !d.isEmpty {
                                    Text(d).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            if !s.topic_results.isEmpty {
                Section("Ergebnisse zu Themen") {
                    ForEach(s.topic_results) { r in
                        Toggle(isOn: resultBinding(r.id)) {
                            VStack(alignment: .leading) {
                                Text(r.topic_id).font(.caption2).foregroundStyle(.secondary)
                                Text(r.result).font(.callout)
                            }
                        }
                    }
                }
            }
            if !s.new_todos.isEmpty {
                Section("Neue Todos") {
                    ForEach(s.new_todos) { t in
                        Toggle(isOn: todoBinding(t.id)) {
                            VStack(alignment: .leading) {
                                Text(t.title).font(.subheadline).fontWeight(.medium)
                                if let d = t.description, !d.isEmpty {
                                    Text(d).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func topicBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { pickedTopics.contains(id) },
                set: { v in if v { pickedTopics.insert(id) } else { pickedTopics.remove(id) } })
    }
    private func resultBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { pickedResults.contains(id) },
                set: { v in if v { pickedResults.insert(id) } else { pickedResults.remove(id) } })
    }
    private func todoBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { pickedTodos.contains(id) },
                set: { v in if v { pickedTodos.insert(id) } else { pickedTodos.remove(id) } })
    }

    private func process() async {
        guard !offline.isOffline else { error = OfflineGating.notAvailableMessage; return }
        loading = true; error = nil
        do {
            let r = try await state.aiCapture(meetingId: meetingId, notes: notes)
            suggestions = r.suggestions
            pickedTopics  = Set(r.suggestions.new_topics.map(\.id))
            pickedResults = Set(r.suggestions.topic_results.map(\.id))
            pickedTodos   = Set(r.suggestions.new_todos.map(\.id))
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                let r = try await state.aiCapture(meetingId: meetingId, notes: notes, confirm: true)
                suggestions = r.suggestions
            } catch { self.error = OfflineGating.message(for: error, fallback: error.localizedDescription) }
        } catch {
            self.error = OfflineGating.message(for: error, fallback: error.localizedDescription)
        }
        loading = false
    }

    private func apply() async {
        guard let s = suggestions else { return }
        guard !offline.isOffline else { error = OfflineGating.notAvailableMessage; return }
        let picked = CaptureSuggestions(
            new_topics:    s.new_topics.filter    { pickedTopics.contains($0.id) },
            topic_results: s.topic_results.filter { pickedResults.contains($0.id) },
            new_todos:     s.new_todos.filter     { pickedTodos.contains($0.id) },
            theme_links:   []
        )
        do { try await state.aiCaptureApply(meetingId: meetingId, suggestions: picked); dismiss() }
        catch { self.error = OfflineGating.message(for: error, fallback: error.localizedDescription) }
    }
}

// MARK: - Result Draft Sheet

struct AIResultDraftSheet: View {
    let refType: String
    let refId:   String
    @Binding var resultText: String
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @State private var loading = false
    @State private var draft: String = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if loading { ProgressView("Erzeuge Vorschlag …") }
                else if OfflineGating.showsUnavailable(isOffline: offline.isOffline,
                                                              hasContent: !draft.isEmpty,
                                                              loadFailedOffline: false) {
                    OfflineUnavailableView(reason: OfflineUnavailableReason.aiFeatures)
                } else {
                    TextEditor(text: $draft)
                        .frame(minHeight: 120)
                        .overlay(RoundedRectangle(cornerRadius: DS.radiusS).stroke(.gray.opacity(0.3)))
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                Spacer()
            }
            .padding()
            .navigationTitle("🤖 Ergebnis-Vorschlag")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Übernehmen") { resultText = draft; dismiss() }
                        .disabled(loading || draft.isEmpty)
                }
            }
            .reloadWhenBackOnline(hasContent: !draft.isEmpty) { Task { await load() } }
            .task { await load() }
        }
    }
    private func load() async {
        guard !offline.isOffline else { return }
        loading = true
        do {
            let r = try await state.aiResultDraft(refType: refType, refId: refId)
            draft = r.draft
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                let r = try await state.aiResultDraft(refType: refType, refId: refId, confirm: true)
                draft = r.draft
            } catch { self.error = OfflineGating.message(for: error, fallback: error.localizedDescription) }
        } catch {
            self.error = OfflineGating.message(for: error, fallback: error.localizedDescription)
        }
        loading = false
    }
}
