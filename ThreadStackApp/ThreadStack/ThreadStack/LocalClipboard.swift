import Foundation
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

//  LocalClipboard.swift
//  Neutraler Helper zum Kopieren von Klartext in die Zwischenablage.

enum LocalClipboard {
    /// Kopiert Klartext, ohne ihn geraeteuebergreifend zu verteilen:
    /// macOS `.currentHostOnly` und iOS `.localOnly` halten den Inhalt vom
    /// Universal Clipboard fern; auf iOS laeuft er zusaetzlich nach 5 Minuten ab.
    static func copyPlainText(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.prepareForNewContents(with: .currentHostOnly)
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: text]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]
        )
        #endif
    }
}
