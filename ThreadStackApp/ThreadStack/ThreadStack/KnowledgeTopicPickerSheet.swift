//
//  KnowledgeTopicPickerSheet.swift
//  ThreadStack
//
//  Arbeitspaket 5 ("knowledge-pickers"): Auswahl-Sheet für Topic-Zuordnungen
//  einer Wissensseite. Mehrfachauswahl per Checkliste, Suche über den vollen
//  Topic-Pfad ("Eltern › Kind"), ausgewählte Topics zusätzlich als Chips.
//
//  Pfad-Darstellung wird aus `AppState.themeAncestorsPath(_:)` (bereits
//  vorhanden, siehe ThemesView/KnowledgeView) abgeleitet — keine eigene
//  Neuimplementierung der Ahnenkette.
//

import SwiftUI

// MARK: - Pure helpers (testable via @testable import, ohne AppState-Abhängigkeit)

/// Baut den vollen Anzeigepfad "Eltern › Kind" aus einer Ahnenkette (Wurzel zuerst,
/// das Topic selbst inklusive). Erwartet als Eingabe das Ergebnis von
/// `AppState.themeAncestorsPath(_:)`.
func knowledgeTopicPickerPath(_ ancestors: [Theme]) -> String {
    ancestors.map(\.title).joined(separator: " › ")
}

/// Filtert eine Topic-Liste anhand eines Suchbegriffs. Der Suchbegriff wird gegen
/// den vollen Anzeigepfad (nicht nur den Titel) case- und diakritik-insensitiv
/// geprüft, damit z. B. "eltern" auch Kind-Topics unter "Eltern" findet.
/// Bei leerem/nur-Whitespace-Suchbegriff wird die Liste unverändert zurückgegeben.
func knowledgeTopicPickerFilter(_ topics: [Theme], query: String, pathFor: (String) -> String) -> [Theme] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return topics }
    return topics.filter { topic in
        pathFor(topic.id).range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }
}

/// Sortiert Topics stabil nach ihrem Anzeigepfad (alphabetisch).
func knowledgeTopicPickerSorted(_ topics: [Theme], pathFor: (String) -> String) -> [Theme] {
    topics.sorted { pathFor($0.id) < pathFor($1.id) }
}

// MARK: - View

struct KnowledgeTopicPickerSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    /// Bereits zugeordnete Topic-IDs.
    let initialSelection: Set<String>
    /// Finale Auswahl nach Bestätigung ("Fertig").
    let onDone: (Set<String>) -> Void

    @State private var selection: Set<String> = []
    @State private var query = ""

    private var pathById: [String: String] {
        var out: [String: String] = [:]
        out.reserveCapacity(state.themes.count)
        for t in state.themes {
            out[t.id] = knowledgeTopicPickerPath(state.themeAncestorsPath(t.id))
        }
        return out
    }

    private var sortedTopics: [Theme] {
        let paths = pathById
        return knowledgeTopicPickerSorted(state.themes) { paths[$0] ?? "" }
    }

    private var filteredTopics: [Theme] {
        let paths = pathById
        return knowledgeTopicPickerFilter(sortedTopics, query: query) { paths[$0] ?? "" }
    }

    private var selectedTopics: [Theme] {
        let paths = pathById
        return knowledgeTopicPickerSorted(state.themes.filter { selection.contains($0.id) }) { paths[$0] ?? "" }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !selectedTopics.isEmpty {
                    selectedChipsRow
                }
                topicList
            }
            .searchable(text: $query, prompt: "Topics durchsuchen")
            .navigationTitle("Topics zuordnen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                        .accessibilityLabel("Abbrechen")
                        .accessibilityHint("Schließt die Topic-Auswahl ohne zu speichern.")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") {
                        onDone(selection)
                        dismiss()
                    }
                    .accessibilityLabel("Topic-Auswahl übernehmen")
                }
            }
        }
        .onAppear { selection = initialSelection }
    }

    private var selectedChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(selectedTopics) { topic in
                    let label = pathById[topic.id] ?? topic.title
                    Button {
                        selection.remove(topic.id)
                    } label: {
                        HStack(spacing: 4) {
                            Text(label).lineLimit(1)
                            Image(systemName: "xmark.circle.fill")
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(label) entfernen")
                    .accessibilityHint("Entfernt dieses Topic aus der Auswahl.")
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    private var topicList: some View {
        List {
            if selection.isEmpty {
                Section {
                    Text("Ohne Topic-Zuordnung erscheint diese Seite unter „Ohne Topic“ in der globalen Wissens-Ansicht.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                if filteredTopics.isEmpty {
                    Text("Keine Topics gefunden.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(filteredTopics) { topic in
                        topicRow(topic)
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func topicRow(_ topic: Theme) -> some View {
        let label = pathById[topic.id] ?? topic.title
        let isSelected = selection.contains(topic.id)
        return Button {
            toggle(topic.id)
        } label: {
            HStack {
                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                Text(label)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityHint(isSelected ? "Ausgewählt. Doppeltippen zum Abwählen." : "Nicht ausgewählt. Doppeltippen zum Auswählen.")
    }

    private func toggle(_ id: String) {
        if selection.contains(id) {
            selection.remove(id)
        } else {
            selection.insert(id)
        }
    }
}
