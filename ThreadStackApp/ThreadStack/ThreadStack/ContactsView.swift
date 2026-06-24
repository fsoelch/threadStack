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
        .sheet(item: $editContact)    { c in ContactFormView(contact: c) }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }
}

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
                            .scaledFont(.caption).foregroundStyle(Color(hex: "#be185d"))
                    }
                    if !contact.email.isEmpty {
                        Link(contact.email, destination: URL(string: "mailto:\(contact.email)") ?? URL(string: "https://example.com")!)
                            .scaledFont(.caption).foregroundStyle(Color(hex: "#db2777"))
                    }
                }
                Spacer()
                Button { onEdit() } label: {
                    Image(systemName: "pencil").scaledFont(.caption)
                }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            if !contact.description.isEmpty {
                Text(htmlAttributedString(contact.description))
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
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }
}

// MARK: - Contact Form

struct ContactFormView: View {
    var contact: Contact? = nil
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var name        = ""
    @State private var role        = ""
    @State private var email       = ""
    @State private var description = ""
    @State private var loading = false
    @State private var error: String?

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
                    TextEditor(text: $description).frame(minHeight: 120)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(contact == nil ? "Neuer Ansprechpartner" : "Bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(loading || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                if let c = contact {
                    name = c.name; role = c.role; email = c.email; description = c.description
                }
            }
        }
    }

    private func save() {
        loading = true; error = nil
        let cleanName  = name.trimmingCharacters(in: .whitespaces)
        let cleanRole  = role.trimmingCharacters(in: .whitespaces)
        let cleanEmail = email.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                if let c = contact {
                    try await state.updateContact(id: c.id, name: cleanName, role: cleanRole,
                                                  email: cleanEmail, description: description)
                } else {
                    try await state.createContact(name: cleanName, role: cleanRole,
                                                  email: cleanEmail, description: description)
                }
                dismiss()
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
