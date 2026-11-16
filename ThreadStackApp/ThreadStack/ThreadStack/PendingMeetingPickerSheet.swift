import SwiftUI

//  PendingMeetingPickerSheet.swift
//  Arbeitspaket P4: "Meeting wählen" (Einzelauswahl, nur nicht archivierte
//  Meetings, Suche, Leerzustand), UX Screen 5. Struktur angelehnt an
//  KnowledgeTopicPickerSheet (dort Mehrfachauswahl; hier Einzelauswahl).

enum PendingMeetingPickerLogic {
    static let title = "Meeting wählen"
    static let searchPrompt = "Meetings durchsuchen"
    static let assignTitle = "Zuordnen"
    static let emptyText = "Kein aktives Meeting vorhanden. Du kannst den Eintrag als Todo übernehmen."
    static let noMatchText = "Keine Meetings gefunden."

    /// Nur nicht archivierte Meetings, alphabetisch, optional per Suchbegriff
    /// (case- und diakritik-insensitiv) gefiltert.
    static func candidates(_ meetings: [Meeting], query: String) -> [Meeting] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return meetings
            .filter { !$0.isArchived }
            .filter { q.isEmpty || $0.title.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    /// "Zuordnen" ist nur mit einer Auswahl aktiv, die vom aktuellen Meeting abweicht und aktiv (nicht archiviert) ist.
    static func canAssign(selection: String?, currentMeetingId: String?, meetings: [Meeting]) -> Bool {
        guard let selection, selection != currentMeetingId else { return false }
        return meetings.contains { $0.id == selection && !$0.isArchived }
    }
}

struct PendingMeetingPickerSheet: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss

    /// Aktuell zugeordnetes Meeting (wird als "aktuell" markiert).
    let currentMeetingId: String?
    /// Wird mit der gewaehlten Meeting-ID aufgerufen; Fehler wirft der Aufrufer selbst weiter.
    let onAssign: (String) -> Void

    @State private var selection: String?
    @State private var query = ""

    private var candidates: [Meeting] { PendingMeetingPickerLogic.candidates(state.meetings, query: query) }
    private var hasAnyActive: Bool { state.meetings.contains { !$0.isArchived } }

    var body: some View {
        NavigationStack {
            Group {
                if !hasAnyActive {
                    Text(PendingMeetingPickerLogic.emptyText)
                        .scaledFont(.subheadline).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).padding(24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        if candidates.isEmpty {
                            Text(PendingMeetingPickerLogic.noMatchText).foregroundStyle(.secondary)
                        } else {
                            ForEach(candidates) { row($0) }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .searchable(text: $query, prompt: PendingMeetingPickerLogic.searchPrompt)
            .navigationTitle(PendingMeetingPickerLogic.title)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PendingMeetingPickerLogic.assignTitle) {
                        if let selection { onAssign(selection) }
                        dismiss()
                    }
                    .disabled(!PendingMeetingPickerLogic.canAssign(selection: selection,
                                                                   currentMeetingId: currentMeetingId,
                                                                   meetings: state.meetings))
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 360)
        #endif
        .onAppear { selection = currentMeetingId }
    }

    private func row(_ m: Meeting) -> some View {
        let isSelected = selection == m.id
        let isCurrent = m.id == currentMeetingId
        return Button { selection = m.id } label: {
            MeetingSelectionRow(meeting: m, isSelected: isSelected, isCurrent: isCurrent)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCurrent ? "\(m.title), aktuell" : m.title)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityHint(isSelected ? "Ausgewählt." : "Doppeltippen zum Auswählen.")
    }
}
