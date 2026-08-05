import SwiftUI

// Globale Wissens-Ansicht — read-only in der App; Erstellen/Bearbeiten nur über die Web-App
// (kein Rich-Text-Editor auf iOS/macOS, analog zur bestehenden Einschränkung bei anderen Feldern).
struct KnowledgeView: View {
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var themeFilter: String? = nil

    private var themeOptions: [Theme] {
        state.themes.sorted {
            state.themeAncestorsPath($0.id).map(\.title).joined(separator: " › ") <
            state.themeAncestorsPath($1.id).map(\.title).joined(separator: " › ")
        }
    }

    private var filtered: [KnowledgePage] {
        var list = state.knowledgePages
        if let themeFilter { list = list.filter { $0.themeIds.contains(themeFilter) } }
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return list }
        return list.filter {
            $0.title.localizedCaseInsensitiveContains(q) ||
            stripHTML($0.content).localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Wissen suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("Topic", selection: $themeFilter) {
                    Text("Alle Topics").tag(String?.none)
                    ForEach(themeOptions) { t in
                        Text(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › "))
                            .tag(Optional(t.id))
                    }
                }
            }
            #endif

            if state.knowledgePages.isEmpty {
                Section {
                    Text("Noch kein Wissen hinterlegt. Wissensseiten werden in der Web-App erstellt und mit Topics verknüpft.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else if filtered.isEmpty {
                Section {
                    Text("Keine Treffer.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filtered) { k in
                    NavigationLink { KnowledgeDetailView(page: k) } label: { KnowledgeRowView(page: k) }
                }
            }
        }
        .navigationTitle("Wissen")
        #if os(iOS)
        .searchable(text: $search, prompt: "Wissen suchen")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button("Alle Topics") { themeFilter = nil }
                    ForEach(themeOptions) { t in
                        Button(state.themeAncestorsPath(t.id).map(\.title).joined(separator: " › ")) {
                            themeFilter = t.id
                        }
                    }
                } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
            }
        }
        #endif
    }

}
