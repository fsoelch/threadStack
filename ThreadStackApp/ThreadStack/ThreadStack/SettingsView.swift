import SwiftUI

// MARK: - Settings (password change)

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @Environment(\.dismiss) var dismiss
    @AppStorage("fontSizeIndex") private var fontSizeIndex = 3
    @State private var oldPassword = ""
    @State private var newPassword = ""
    @State private var confirm = ""
    @State private var loading = false
    @State private var success = false
    @State private var error: String?

    private let labels = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Schriftgröße") {
                    HStack(spacing: 12) {
                        Text("A").font(.footnote).foregroundStyle(.secondary)
                        Slider(
                            value: Binding(
                                get: { Double(fontSizeIndex) },
                                set: { fontSizeIndex = Int($0.rounded()) }
                            ),
                            in: 0...6, step: 1
                        )
                        Text("A").font(.title2).foregroundStyle(.secondary)
                    }
                    Text("Aktuelle Größe: \(labels[fontSizeIndex])")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Server") {
                    Text(state.serverURL.isEmpty ? "Nicht konfiguriert" : state.serverURL)
                        .foregroundStyle(.secondary).font(.footnote)
                        .lineLimit(2).truncationMode(.middle)
                }
                Section("Passwort ändern") {
                    SecureField("Aktuelles Passwort", text: $oldPassword)
                    SecureField("Neues Passwort",     text: $newPassword)
                    SecureField("Bestätigen",         text: $confirm)
                    Button("Passwort ändern") { changePassword() }
                        .disabled(!OfflineFeatureBLogic.canSave(
                            isOffline: offline.isOffline,
                            inputValid: !oldPassword.isEmpty && !newPassword.isEmpty && !confirm.isEmpty,
                            isBusy: loading))
                        .disabledWhenOffline(offline.isOffline)
                }

                if state.hasStoredCredentials {
                    Section("App-Sperre (\(Keychain.biometryTypeDescription))") {
                        Label("Anmeldedaten sind im Schlüsselbund hinterlegt",
                              systemImage: "lock.shield.fill")
                            .foregroundStyle(.green).font(.footnote)
                        Button("Anmeldedaten aus Schlüsselbund entfernen", role: .destructive) {
                            state.forgetStoredCredentials()
                        }
                    }
                }
                if success {
                    Section {
                        Label("Passwort geändert.", systemImage: "checkmark.circle")
                            .foregroundStyle(.green)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Einstellungen")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Schließen") { dismiss() } }
            }
        }
    }

    private func changePassword() {
        guard !offline.isOffline else { error = OfflineFeatureBLogic.blockedDialogMessage; return }
        guard newPassword == confirm else { error = "Passwörter stimmen nicht überein."; return }
        loading = true; error = nil; success = false
        Task {
            do {
                try await state.changePassword(old: oldPassword, new: newPassword)
                success = true; oldPassword = ""; newPassword = ""; confirm = ""
            } catch {
                self.error = isTransportFailure(error)
                    ? OfflineFeatureBLogic.blockedDialogMessage : error.localizedDescription
            }
            loading = false
        }
    }
}

// MARK: - Settings URL View (shown from LoginView if no URL set)

struct SettingsURLView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var url = ""

    /// Security-Nachbesserung: dieselbe Pruefung wie in
    /// `AppState.url(_:)`/`ProgressAPI`/`SummaryAPI` (siehe
    /// `isAllowedServerURLScheme` in Extensions.swift), aber bereits BEIM
    /// SPEICHERN angewendet statt erst beim naechsten Request - vermeidet,
    /// dass ein Nutzer eine http://-URL zu einem fremden Host speichert und
    /// den Fehler erst beim naechsten Login/API-Aufruf bemerkt. Die eigent-
    /// liche Logik liegt testbar in Extensions.swift (trimmedServerURLInput/
    /// isValidServerURLInput), analog zu TodoOverviewLogic in TodosView.swift.
    private var trimmedUrl: String { trimmedServerURLInput(url) }
    private var isSchemeValid: Bool { isValidServerURLInput(trimmedUrl) }
    private var showSchemeWarning: Bool {
        !trimmedUrl.isEmpty && !isSchemeValid
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://mein-server.example.com", text: $url)
                        .urlKeyboard()
                        .autocorrectionDisabled()
                        .noAutocapitalize()
                } header: {
                    Text("Server-URL")
                } footer: {
                    if showSchemeWarning {
                        Text("Nur https:// ist erlaubt (http:// nur für localhost/127.0.0.1). Bitte Adresse prüfen.")
                            .foregroundStyle(.red)
                    } else {
                        Text("Gib die Adresse deines ThreadStack-Servers ein (ohne abschließenden Schrägstrich).")
                    }
                }
            }
            .navigationTitle("Server konfigurieren")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") {
                        state.serverURL = trimmedUrl
                        dismiss()
                    }
                    .disabled(trimmedUrl.isEmpty || !isSchemeValid)
                }
            }
            .onAppear { url = state.serverURL }
        }
    }
}
