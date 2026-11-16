import SwiftUI

//  LogoutConfirmation.swift
//  Arbeitspaket P4: einheitliche Logout-Bestaetigung (UX Screen 11 / Story 12).
//  Ohne nicht uebertragene Aenderungen (`unsyncedCount == 0`) wird direkt
//  abgemeldet; sonst erscheint der Dialog "Abmelden?" mit Standard-Abbrechen.

enum LogoutConfirmationLogic {
    static let title = "Abmelden?"
    static let confirmTitle = "Abmelden und verwerfen"
    static let cancelTitle = "Abbrechen"
    static let showChangesTitle = "Änderungen ansehen"

    static func message(unsyncedCount: Int) -> String { OfflineCountText.logoutWarning(max(0, unsyncedCount)) }

    /// Ohne ausstehende Aenderungen entfaellt die Rueckfrage.
    static func needsConfirmation(unsyncedCount: Int) -> Bool { unsyncedCount > 0 }
}

struct LogoutConfirmationModifier: ViewModifier {
    @Binding var isPresented: Bool
    let unsyncedCount: Int
    let onConfirm: () -> Void
    let onShowChanges: (() -> Void)?

    /// Interner Dialogzustand; `isPresented` ist nur ein Impuls und wird sofort zurueckgesetzt.
    @State private var showDialog = false

    func body(content: Content) -> some View {
        content
            .confirmationDialog(LogoutConfirmationLogic.title, isPresented: $showDialog, titleVisibility: .visible) {
                Button(LogoutConfirmationLogic.confirmTitle, role: .destructive) { onConfirm() }
                if let onShowChanges {
                    Button(LogoutConfirmationLogic.showChangesTitle) { onShowChanges() }
                }
                Button(LogoutConfirmationLogic.cancelTitle, role: .cancel) {}
            } message: {
                Text(LogoutConfirmationLogic.message(unsyncedCount: unsyncedCount))
            }
            .onChange(of: isPresented) { _, presented in
                guard presented else { return }
                isPresented = false
                if LogoutConfirmationLogic.needsConfirmation(unsyncedCount: unsyncedCount) {
                    showDialog = true
                } else {
                    onConfirm()
                }
            }
    }
}

extension View {
    /// Setzt `isPresented` auf true, um das Abmelden anzustossen. Bei `unsyncedCount == 0`
    /// wird `onConfirm` direkt aufgerufen, sonst erst nach Bestaetigung.
    func logoutConfirmation(isPresented: Binding<Bool>, unsyncedCount: Int,
                            onConfirm: @escaping () -> Void,
                            onShowChanges: (() -> Void)? = nil) -> some View {
        modifier(LogoutConfirmationModifier(isPresented: isPresented, unsyncedCount: unsyncedCount,
                                            onConfirm: onConfirm, onShowChanges: onShowChanges))
    }
}
