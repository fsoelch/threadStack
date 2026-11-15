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

    func body(content: Content) -> some View {
        content
            .confirmationDialog(LogoutConfirmationLogic.title,
                                isPresented: Binding(
                                    get: { isPresented && LogoutConfirmationLogic.needsConfirmation(unsyncedCount: unsyncedCount) },
                                    set: { isPresented = $0 }),
                                titleVisibility: .visible) {
                Button(LogoutConfirmationLogic.confirmTitle, role: .destructive) { onConfirm() }
                if let onShowChanges {
                    Button(LogoutConfirmationLogic.showChangesTitle) { onShowChanges() }
                }
                Button(LogoutConfirmationLogic.cancelTitle, role: .cancel) {}
            } message: {
                Text(LogoutConfirmationLogic.message(unsyncedCount: unsyncedCount))
            }
            // Ohne ausstehende Aenderungen: sofort abmelden, keine Rueckfrage.
            .onChange(of: isPresented) { _, presented in
                if presented && !LogoutConfirmationLogic.needsConfirmation(unsyncedCount: unsyncedCount) {
                    isPresented = false
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
