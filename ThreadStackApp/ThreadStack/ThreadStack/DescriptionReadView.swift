//
//  DescriptionReadView.swift
//  ThreadStack
//
//  Arbeitspaket A2 ("App-UI Fortschritt und Bearbeiten"): schreibgeschützte
//  Leseansicht der (Rich-Text-)Beschreibung eines Todos/Themas — Teil der
//  UX-Entscheidung "Beschreibung ist nach Ersterfassung schreibgeschützt, nur
//  über Stift-Symbol editierbar" (siehe `TodoFormView`/`TopicFormView`).
//
//  Wiederverwendet ausschließlich die bestehende, bereits gehärtete
//  `HTMLContentView` (JS aus, CSP, externe Links) — kein neuer HTML-Renderer.
//  Rendert dieselbe Formatierung, die auch der Rich-Text-Editor
//  (`KnowledgeEditorController`/`-WebView`) erzeugt, konsistent mit der
//  Leseansicht für Wissen/Zwischenstände.
//
//  Vertrag (Schnittstelle 13): rendert formatierte, NICHT editierbare
//  Beschreibung; Links bleiben anklickbar, ohne den Bearbeitungsmodus
//  auszulösen (da `HTMLContentView` Navigation intern abfängt und http(s)-
//  Links im System-Browser öffnet, statt diese View selbst zu navigieren —
//  ein Antippen eines Links kann also nie versehentlich `onEdit` auslösen).
//  Ohne Beschreibung: Platzhaltertext + aktives Stift-Symbol. Das Stift-
//  Symbol ist ein normaler SwiftUI-`Button` — dadurch automatisch per
//  Tab/Fokus erreichbar und per Tippen ODER Eingabetaste/Leertaste bei Fokus
//  auslösbar (Standardverhalten von `Button` auf allen Plattformen).
//

import SwiftUI

// MARK: - Reine Logik (testbar)

/// Reine Sichtbarkeits-/Platzhalter-Logik für `DescriptionReadView`, getrennt
/// vom View-Body (analog zu den übrigen `*Logic`-Enums in diesem Feature).
enum DescriptionReadLogic {
    static let placeholderText = "Noch keine Beschreibung — tippe auf den Stift, um eine hinzuzufügen."

    /// `true`, wenn `html` (nach Entfernen des reinen Markups) keinen
    /// sichtbaren Text enthält — dann wird der Platzhalter statt
    /// `HTMLContentView` angezeigt.
    static func isEffectivelyEmpty(html: String) -> Bool {
        stripHTML(html).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - View

struct DescriptionReadView: View {
    let html: String
    let onEdit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text("Beschreibung").scaledFont(.footnote).foregroundStyle(.secondary)
                Spacer()
                Button(action: onEdit) {
                    Image(systemName: "pencil")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Beschreibung bearbeiten")
            }
            if DescriptionReadLogic.isEffectivelyEmpty(html: html) {
                Text(DescriptionReadLogic.placeholderText)
                    .scaledFont(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                HTMLContentView(html: html)
            }
        }
    }
}
