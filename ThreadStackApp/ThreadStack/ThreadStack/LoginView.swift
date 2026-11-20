import SwiftUI

/// Texte der Anmeldung im Offline-Modus (rein, testbar).
enum LoginOfflineTexts {
    static let reauthTitle = "Bitte neu anmelden"
    static let accountWarning = "Wenn du dich mit einem anderen Konto anmeldest, gehen die nicht übertragenen Änderungen verloren."
    static let discardAlertTitle = "Anderes Konto?"
    static let discardConfirm = "Anmelden und verwerfen"
    static let cancel = "Abbrechen"

    /// "N Änderungen warten auf die Übertragung." (Singular: "1 Änderung wartet auf die Übertragung.")
    static func pendingText(_ n: Int) -> String {
        n == 1 ? "\(OfflineCountText.changes(n)) wartet auf die Übertragung."
               : "\(OfflineCountText.changes(n)) warten auf die Übertragung."
    }

    /// Anmeldung ohne Netz: Transportfehler -> Hinweistext statt technischer Meldung.
    static func message(for error: Error) -> String {
        isTransportFailure(error)
            ? (OfflineError.offlineLoginUnavailable.errorDescription ?? error.localizedDescription)
            : error.localizedDescription
    }
}

struct LoginView: View {
    /// `.initial`: normale Anmeldung. `.reauth`: erneute Anmeldung als Sheet (Sitzung abgelaufen, Aenderungen
    /// warten; Benutzername vorbelegt, Warnung bei anderem Konto).
    enum Mode: Equatable { case initial, reauth }

    var mode: Mode = .initial
    @EnvironmentObject var state: AppState
    @EnvironmentObject var offline: OfflineStatusStore
    @State private var showDiscardConfirm = false
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var loading = false
    @State private var showSettings = false
    @State private var rememberWithBiometry = true
    @State private var didAutoBiometricAttempt = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 24) {
                // Logo
                VStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(DS.brandIndigo.opacity(0.12))
                            .frame(width: 72, height: 72)
                        Text("💬").font(.system(size: 36))
                    }
                    Text("ThreadStack")
                        .font(.title2).fontWeight(.bold)
                    if mode == .reauth {
                        Text(LoginOfflineTexts.reauthTitle)
                            .font(.subheadline).fontWeight(.semibold)
                        Text(LoginOfflineTexts.pendingText(offline.unsyncedCount))
                            .font(.subheadline).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Text(LoginOfflineTexts.accountWarning)
                            .font(.footnote).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    } else {
                        Text("Melden Sie sich an, um fortzufahren")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if mode == .initial, let notice = state.loginNotice {
                        // Icon + Text (nie nur Farbe).
                        Label(notice, systemImage: "wifi.slash")
                            .font(.footnote).foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                }

                // Server URL hint
                if state.serverURL.isEmpty {
                    Button { showSettings = true } label: {
                        Label("Server-URL einrichten", systemImage: "gear")
                            .font(.footnote)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                } else {
                    Text(state.serverURL)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }

                // Form
                VStack(spacing: 12) {
                    TextField("Benutzername", text: $username)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .textFieldStyle(.roundedBorder)

                    SecureField("Passwort", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await doLogin() } }

                    if Keychain.biometryAvailable {
                        Toggle(isOn: $rememberWithBiometry) {
                            Label("Mit \(Keychain.biometryTypeDescription) merken",
                                  systemImage: Keychain.biometryIconName)
                                .font(.footnote)
                        }
                    }

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }

                    Button {
                        Task { await doLogin() }
                    } label: {
                        Group {
                            if loading { ProgressView() } else { Text("Anmelden") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(DS.brandIndigo)
                    .disabled(loading || username.isEmpty || password.isEmpty)
                    .controlSize(.large)

                    if state.hasStoredCredentials {
                        Button {
                            Task { await doBiometricLogin() }
                        } label: {
                            Label("Mit \(Keychain.biometryTypeDescription) anmelden",
                                  systemImage: Keychain.biometryIconName)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(DS.brandIndigo)
                        .disabled(loading)
                        .controlSize(.large)
                    }
                }
            }
            .padding(32)
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: .black.opacity(0.08), radius: 24, x: 0, y: 8)
            .frame(maxWidth: 380)

            Spacer()

            if mode == .reauth {
                Button(LoginOfflineTexts.cancel) { state.reauthRequested = false }
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 20)
            } else {
                Button("Einstellungen") { showSettings = true }
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 20)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DS.groupedBg)
        .sheet(isPresented: $showSettings) { SettingsURLView() }
        .onAppear {
            if mode == .reauth, username.isEmpty { username = state.currentUser?.username ?? "" }
        }
        .task {
            // Re-Auth-Sheet (Sitzung abgelaufen, z.B. weil die Erneuerung im Hintergrund keinen
            // Face-ID-Dialog zeigen durfte): genau einmal automatisch Face ID anbieten.
            if mode == .reauth, !didAutoBiometricAttempt, state.hasStoredCredentials {
                didAutoBiometricAttempt = true
                await doBiometricLogin()
            }
        }
        .alert(LoginOfflineTexts.discardAlertTitle, isPresented: $showDiscardConfirm) {
            Button(LoginOfflineTexts.discardConfirm, role: .destructive) {
                Task { await doLogin(discardPreviousOfflineScope: true) }
            }
            Button(LoginOfflineTexts.cancel, role: .cancel) {}
        } message: {
            Text(LoginOfflineTexts.accountWarning)
        }
    }

    private func doLogin(discardPreviousOfflineScope: Bool = false) async {
        error = nil; loading = true
        defer { loading = false }
        do {
            try await state.login(username: username, password: password,
                                  rememberWithBiometry: rememberWithBiometry && Keychain.biometryAvailable,
                                  discardPreviousOfflineScope: discardPreviousOfflineScope)
            // Die erste Datenladung uebernimmt ContentView (bzw. hier im Re-Auth-Sheet der Sync).
            if mode == .reauth { await state.refreshAfterReauth() }
        } catch OfflineError.scopeMismatch {
            // Anderes Konto mit ausstehenden Aenderungen: erst bestaetigen lassen (Daten gehen verloren).
            showDiscardConfirm = true
        } catch {
            self.error = LoginOfflineTexts.message(for: error)
        }
    }

    /// Anmeldung mit den biometrisch geschuetzten, gespeicherten Zugangsdaten - ohne Benutzername/Passwort.
    /// `.initial` (z.B. nach Abmelden): wie der Lock-Screen (`unlockAndAutoLogin`). `.reauth`: Sitzung mit den
    /// gespeicherten Zugangsdaten erneuern und die Warteschlange senden.
    private func doBiometricLogin() async {
        error = nil; loading = true
        defer { loading = false }
        if mode == .reauth {
            if await state.tryServerReLogin() {
                await state.refreshAfterReauth()
            } else if !state.hasStoredCredentials {
                error = KeychainError.itemNotFound.errorDescription
            }
            return
        }
        do {
            try await state.unlockAndAutoLogin()
        } catch KeychainError.userCancelled {
            // Abgebrochen: Formular bzw. erneuter Versuch per Button bleiben moeglich.
        } catch KeychainError.itemNotFound {
            state.forgetStoredCredentials()
        } catch {
            self.error = LoginOfflineTexts.message(for: error)
        }
    }
}
