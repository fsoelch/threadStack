//
//  KnowledgeEditorToolbar.swift
//  ThreadStack
//
//  Arbeitspaket 6 ("knowledge-editor-view"): native, außerhalb der WKWebView
//  liegende Formatierungs-Toolbar für den Wissens-Editor (Paket 2:
//  `KnowledgeEditorController`/`KnowledgeEditorCommand`).
//
//  MVP-Scope (bindend, aus Konsistenzcheck Architektur/UX): ausschließlich
//  Fett, Kursiv, Unterstrichen, Aufzählungsliste (unsortiert), Link, Bild
//  einfügen — keine nummerierte Liste, keine Überschriften-Buttons, da die
//  Bridge aus Paket 2 (`KnowledgeEditorCommand`) diese Befehle bewusst nicht
//  kennt.
//

import SwiftUI

/// Native Toolbar für den Wissens-Editor. Wird oberhalb von
/// `KnowledgeEditorWebView` platziert (nicht innerhalb der WebView selbst).
///
/// Tastaturkürzel (macOS/iPad mit externer Tastatur): Cmd+B/I/U lösen
/// dieselben Aktionen wie die entsprechenden Buttons aus.
struct KnowledgeEditorToolbar: View {
    @ObservedObject var controller: KnowledgeEditorController

    /// Öffnet das Link-Einfüge-Sheet (Paket 3: `KnowledgeLinkInsertSheet`).
    /// Das eigentliche Einfügen erfolgt dort über `controller.insertLink`.
    let onInsertLinkTapped: () -> Void

    /// Wird aufgerufen, sobald der Nutzer im Bild-Picker (Paket 4:
    /// `KnowledgeImagePicker`) ein Bild + Alt-Text bestätigt hat.
    let onImagePicked: (KnowledgeImageResult) -> Void

    var body: some View {
        HStack(spacing: 4) {
            formatButton(
                label: "Fett",
                systemImage: "bold",
                isActive: controller.state.bold,
                command: .bold,
                shortcutKey: "b"
            )
            formatButton(
                label: "Kursiv",
                systemImage: "italic",
                isActive: controller.state.italic,
                command: .italic,
                shortcutKey: "i"
            )
            formatButton(
                label: "Unterstrichen",
                systemImage: "underline",
                isActive: controller.state.underline,
                command: .underline,
                shortcutKey: "u"
            )

            Divider().frame(height: 20)

            formatButton(
                label: "Aufzählungsliste",
                systemImage: "list.bullet",
                isActive: controller.state.unorderedList,
                command: .insertUnorderedList,
                shortcutKey: nil
            )

            Divider().frame(height: 20)

            Button {
                onInsertLinkTapped()
            } label: {
                Image(systemName: "link")
            }
            .accessibilityLabel("Link einfügen")

            KnowledgeImagePicker(onPicked: onImagePicked)
                .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderless)
        .disabled(!controller.isReady)
    }

    @ViewBuilder
    private func formatButton(
        label: String,
        systemImage: String,
        isActive: Bool,
        command: KnowledgeEditorCommand,
        shortcutKey: KeyEquivalent?
    ) -> some View {
        let button = Button {
            Task { await controller.exec(command) }
        } label: {
            Image(systemName: systemImage)
                .foregroundStyle(isActive ? Color.accentColor : Color.primary)
        }
        .accessibilityLabel(label)
        .accessibilityValue(isActive ? "Aktiv" : "Inaktiv")
        .accessibilityAddTraits(isActive ? [.isSelected] : [])

        if let shortcutKey {
            button.keyboardShortcut(shortcutKey, modifiers: .command)
        } else {
            button
        }
    }
}
