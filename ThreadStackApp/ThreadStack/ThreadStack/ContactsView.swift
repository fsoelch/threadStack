import SwiftUI

// MARK: - Contacts List

struct ContactsView: View {
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var showNew = false
    @State private var editContact: Contact? = nil
    @State private var error: String?

    private var filtered: [Contact] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return state.contacts }
        let tokens = q.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !tokens.isEmpty else { return state.contacts }
        return state.contacts.filter { c in
            let haystack = [
                c.name, c.role, c.email, stripHTML(c.description)
            ].joined(separator: "\n").lowercased()
            // Alle Tokens müssen irgendwo im haystack matchen (UND-Suche)
            return tokens.allSatisfy { haystack.contains($0) }
        }
    }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Ansprechpartner suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            Section {
                Button { showNew = true } label: {
                    Label("Neuer Ansprechpartner", systemImage: "plus.circle").foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
            #endif

            if state.contacts.isEmpty {
                Section {
                    Text("Noch keine Ansprechpartner — tippe auf + um den ersten anzulegen.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else {
                ForEach(filtered) { c in
                    ContactCardView(contact: c, onEdit: { editContact = c })
                }
                .onDelete { idx in
                    let ids = idx.map { filtered[$0].id }
                    Task {
                        for id in ids {
                            do { try await state.deleteContact(id: id) }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
        }
        .navigationTitle("Ansprechpartner")
        #if os(iOS)
        .searchable(text: $search, prompt: "Ansprechpartner suchen")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
        }
        #endif
        .sheet(isPresented: $showNew) { ContactFormView() }
        .sheet(item: $editContact)    { c in ContactDetailView(contact: c) }
        .errorAlert($error)
    }
}

// isTransportFailure(_:) und friendlyAssignmentErrorMessage(_:) liegen in
// `Extensions.swift` (siehe dortiger Kommentar) — von mehreren Contact-Views
// gemeinsam genutzte freie Helfer, keine Feature-View-spezifische Logik.

// MARK: - Contact Card Row

struct ContactCardView: View {
    let contact: Contact
    let onEdit: () -> Void
    @EnvironmentObject var state: AppState
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.name)
                        .scaledFont(.subheadline).fontWeight(.semibold)
                    if !contact.role.isEmpty {
                        Text(contact.role)
                            .scaledFont(.caption).foregroundStyle(DS.pink)
                    }
                    if !contact.email.isEmpty {
                        Link(contact.email, destination: URL(string: "mailto:\(contact.email)") ?? URL(string: "https://example.com")!)
                            .scaledFont(.caption).foregroundStyle(DS.pink)
                    }
                }
                Spacer()
                Button { onEdit() } label: {
                    Image(systemName: "pencil").scaledFont(.caption)
                }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            // Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): bevorzugt
            // den vom Server gelieferten `snippet` (Kurzvorschau über die neuen
            // Infoblöcke, additiv/optional dekodiert) — fällt auf das ältere,
            // nach Migration meist leere `description`-Feld zurück, damit
            // gegen ältere Server-Stände weiterhin eine Vorschau erscheint.
            let previewHTML = (contact.snippet?.isEmpty == false) ? contact.snippet! : contact.description
            if !previewHTML.isEmpty {
                Text(htmlAttributedString(previewHTML))
                    .scaledFont(.caption)
                    .lineLimit(4)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { onEdit() }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task {
                    do { try await state.deleteContact(id: contact.id) }
                    catch { self.error = error.localizedDescription }
                }
            } label: { Label("Löschen", systemImage: "trash") }
        }
        .errorAlert($error)
    }
}

// MARK: - Contact Form (Neuanlage)
//
// Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): AUSSCHLIESSLICH
// für das Neuanlegen eines Ansprechpartners zuständig — das Bearbeiten eines
// BESTEHENDEN Kontakts läuft jetzt über `ContactDetailView` (siehe dortiger
// Datei-Kopfkommentar), die zusätzlich Infoblöcke/Notizen/Topic-Zuordnung/
// Zuständigkeit zeigt und dafür zwingend eine bereits existierende
// `contactId` braucht. Damit gibt es für die Basisfelder (Name/Rolle/E-Mail/
// Beschreibung) eines bestehenden Kontakts nur noch EINE Bearbeiten-Stelle
// (`ContactDetailView`) statt zwei parallelen, potenziell divergierenden
// Formularen (CLAUDE.md "Wiederverwendung vor Neuentwicklung").
//
// Zentrale Bug-Behebung (Story 14): die Beschreibung wurde hier zuvor beim
// Bearbeiten via `stripHTML(c.description)` als Klartext geladen und dabei
// im Web erfasste Formatierung still zerstört. Da diese View jetzt gar
// keinen Bearbeiten-Modus mehr kennt, entfällt dieser Codepfad ersatzlos.
// Die Beschreibung wird — wie bei `TodoFormView`/`TopicFormView` beim
// Neuanlegen — sofort per Rich-Text-Editor erfasst (`DescriptionRichTextEditor`,
// siehe `DescriptionEditorSheet.swift`), NIE als Klartext.
struct ContactFormView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var name  = ""
    @State private var role  = ""
    @State private var email = ""
    @StateObject private var descriptionController = KnowledgeEditorController()
    @State private var descriptionContentLoaded = false
    @State private var loading = false
    @State private var error: String?
    @State private var isOffline = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("z. B. Anna Müller", text: $name)
                        .autocorrectionDisabled()
                }
                Section("Rolle / Funktion") {
                    TextField("z. B. Projektleitung APAC", text: $role)
                }
                Section("E-Mail") {
                    TextField("anna@example.com", text: $email)
                        .autocorrectionDisabled()
                        .noAutocapitalize()
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        #endif
                }
                Section("Zuständigkeit & Eigenschaften") {
                    DescriptionRichTextEditor(controller: descriptionController)
                }
                if let error {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(error).foregroundStyle(.red).font(.footnote)
                            if isOffline {
                                Button("Erneut versuchen") { save() }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Neuer Ansprechpartner")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(loading || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onChange(of: descriptionController.isReady) { _, ready in
                guard ready else { descriptionContentLoaded = false; return }
                Task {
                    await descriptionController.setContent("")
                    descriptionContentLoaded = true
                }
            }
        }
    }

    private func save() {
        loading = true; error = nil; isOffline = false
        let cleanName  = name.trimmingCharacters(in: .whitespaces)
        let cleanRole  = role.trimmingCharacters(in: .whitespaces)
        let cleanEmail = email.trimmingCharacters(in: .whitespaces)
        Task {
            let descriptionHTML: String = (descriptionController.isReady && descriptionContentLoaded)
                ? ((try? await descriptionController.content()) ?? "") : ""
            do {
                try await state.createContact(name: cleanName, role: cleanRole,
                                              email: cleanEmail, description: descriptionHTML)
                dismiss()
            } catch {
                // Eingabe bleibt im Formular erhalten (kein Datenverlust) —
                // bei Offline/Netzwerkfehler eine dedizierte, verständliche
                // Meldung mit erneutem Versuch statt eines stillen Verwurfs
                // (Story 14, explizit gefordertes Offline-/Fehlerverhalten).
                if isTransportFailure(error) {
                    isOffline = true
                    self.error = "Keine Verbindung — deine Eingabe bleibt erhalten. Bitte erneut versuchen, sobald du wieder online bist."
                } else {
                    self.error = error.localizedDescription
                }
                loading = false
            }
        }
    }
}

