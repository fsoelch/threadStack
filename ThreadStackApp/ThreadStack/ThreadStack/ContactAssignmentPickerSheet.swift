//
//  ContactAssignmentPickerSheet.swift
//  ThreadStack
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): EIN gemeinsames
//  Auswahl-Sheet für die Zuständigkeits-Zuordnung ("Ansprechpartner"), das
//  SOWOHL von `TodoFormView` ALS AUCH von `TopicFormView` verwendet wird
//  (Feature-Parität, siehe Vertrag Punkt 5/7 — kein zweites, abweichendes
//  Sheet für den jeweils anderen Typ, CLAUDE.md "Wiederverwendung vor
//  Neuentwicklung").
//
//  UI-Muster (Suchfeld + checkbare Liste + Chips + "Fertig") übernimmt
//  bewusst 1:1 das bereits bestehende `KnowledgeTopicPickerSheet`
//  (Mehrfachauswahl-Vorbild laut Vertrag) — hier auf Kontakte statt Topics
//  angewendet, mit der zusätzlichen Limit-Regel (max. 20).
//
//  Committing: dieses Sheet ruft selbst KEINEN Netzwerk-Request auf — es
//  liefert die finale Auswahl nur über `onDone(_:)` an den Aufrufer zurück
//  (identisches Verhalten zu `KnowledgeTopicPickerSheet`). Der eigentliche
//  Server-Commit (`AppState.setAssignments`) läuft im Aufrufer (`TodoFormView`/
//  `TopicFormView.save()`), analog zum bestehenden `setTodoThemes`-Muster —
//  das erlaubt eine einzige, atomare Zuordnung auch für ein gerade erst neu
//  angelegtes Todo/Thema (dessen ID vor dem Speichern noch nicht existiert).
//

import SwiftUI

// MARK: - Reine Logik (testbar)

enum ContactAssignmentPickerLogic {
    /// Server-Limit laut Vertrag ("Max. 20 pro Vorhaben").
    static let maxAssignments = 20

    static func canSelect(currentCount: Int, alreadySelected: Bool) -> Bool {
        alreadySelected || currentCount < maxAssignments
    }

    static func filter(_ contacts: [Contact], query: String) -> [Contact] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return contacts }
        return contacts.filter { c in
            [c.name, c.role, c.email].contains { field in
                field.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }

    static func sorted(_ contacts: [Contact]) -> [Contact] {
        contacts.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Blocker-Fix (Code-Review): `save()` in `TodoFormView`/`TopicFormView`
    /// darf `AppState.setAssignments` NUR committen, wenn ein Todo/Thema
    /// erfolgreich gespeichert wurde UND die bestehende Zuordnung
    /// nachweislich geladen wurde (oder der Nutzer aktiv im Picker-Sheet
    /// bestätigt hat, siehe `assignmentsLoaded`-Dokumentation dort). Ohne
    /// diese Bedingung würde entweder ein Rendering-Timing-Problem (Form/
    /// List-Lazy-Rendering des `.task`) oder ein fehlgeschlagener
    /// Ladeversuch einen vollen Ersatz-Request mit einer leeren Auswahl
    /// absetzen und dadurch bestehende Ansprechpartner-Zuordnungen
    /// serverseitig löschen. Als reine, aus `save()` extrahierte
    /// Entscheidungsfunktion testbar (analog zu `TodoSaveTarget`/
    /// `TopicSaveTarget`).
    ///
    /// Niedrig-Fund (Code-Review): der `savedId`-Parameter war redundant, da
    /// jede Aufrufstelle ohnehin zusätzlich per `let savedId` prüft/entpackt —
    /// die Signatur hier deckt nur noch die eigentliche Lade-Bedingung ab.
    static func shouldCommitAssignments(assignmentsLoaded: Bool) -> Bool {
        assignmentsLoaded
    }

    /// Hoch-Fund (Code-Review): entscheidet, ob der Auswahl-Button in
    /// `ContactAssignmentSection` gesperrt bleibt. Im Bearbeiten-Modus
    /// (`refId != nil`) darf das Picker-Sheet erst geöffnet werden, sobald
    /// die bestehende Zuordnung nachweislich geladen wurde (`loaded == true`)
    /// — sonst könnte ein Tap auf "Fertig" ohne jede Änderung (bei
    /// fehlgeschlagenem oder noch laufendem Laden) `save()` mit einer
    /// fälschlich leeren Auswahl committen lassen. Im Anlegen-Modus
    /// (`refId == nil`) ist `loaded` bereits sofort über den bestehenden
    /// `.success([])`-Pfad `true`, der Button bleibt dort also nutzbar. Als
    /// reine, testbare Funktion (analog zu `shouldCommitAssignments`) aus dem
    /// View extrahiert.
    static func isPickerEntryDisabled(refId: String?, loaded: Bool) -> Bool {
        refId != nil && !loaded
    }

    /// Hoch-Fund (Code-Review, Fall c): entscheidet, ob ein (ggf. verspätet
    /// zurückkommender) erfolgreicher Ladevorgang die lokale Auswahl in
    /// `TodoFormView`/`TopicFormView.loadContactAssignments()` überschreiben
    /// darf — NICHT, sobald der Nutzer bereits aktiv eine Auswahl im
    /// Picker-Sheet bestätigt hat (`userConfirmedSelection == true`). Als
    /// reine, testbare Funktion aus den beiden Formularen extrahiert.
    static func shouldApplyLoadedSelection(userConfirmedSelection: Bool) -> Bool {
        !userConfirmedSelection
    }
}

// MARK: - View

struct ContactAssignmentPickerSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss

    /// Bereits zugeordnete Kontakt-IDs.
    let initialSelection: Set<String>
    /// Finale Auswahl nach Bestätigung ("Fertig").
    let onDone: (Set<String>) -> Void

    @State private var selection: Set<String> = []
    @State private var query = ""

    private var sortedContacts: [Contact] { ContactAssignmentPickerLogic.sorted(state.contacts) }
    private var filteredContacts: [Contact] { ContactAssignmentPickerLogic.filter(sortedContacts, query: query) }
    private var selectedContacts: [Contact] {
        ContactAssignmentPickerLogic.sorted(state.contacts.filter { selection.contains($0.id) })
    }
    private var limitReached: Bool { selection.count >= ContactAssignmentPickerLogic.maxAssignments }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !selectedContacts.isEmpty {
                    selectedChipsRow
                }
                if limitReached {
                    Text("Maximal \(ContactAssignmentPickerLogic.maxAssignments) Ansprechpartner pro Vorhaben.")
                        .scaledFont(.footnote).foregroundStyle(.secondary)
                        .padding(.horizontal).padding(.top, 4)
                }
                contactList
            }
            .searchable(text: $query, prompt: "Ansprechpartner durchsuchen")
            .navigationTitle("Ansprechpartner zuordnen")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                        .accessibilityLabel("Abbrechen")
                        .accessibilityHint("Schließt die Ansprechpartner-Auswahl ohne zu speichern.")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") {
                        onDone(selection)
                        dismiss()
                    }
                    .accessibilityLabel("Ansprechpartner-Auswahl übernehmen")
                }
            }
        }
        .onAppear { selection = initialSelection }
    }

    private var selectedChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(selectedContacts) { contact in
                    Button {
                        selection.remove(contact.id)
                    } label: {
                        HStack(spacing: 4) {
                            Text(contact.name).lineLimit(1)
                            Image(systemName: "xmark.circle.fill")
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(DS.pink.opacity(0.15)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(contact.name) entfernen")
                    .accessibilityHint("Entfernt diesen Ansprechpartner aus der Auswahl.")
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    private var contactList: some View {
        List {
            if state.contacts.isEmpty {
                Section {
                    Text("Noch keine Ansprechpartner angelegt.")
                        .foregroundStyle(.secondary)
                }
            } else if filteredContacts.isEmpty {
                Section {
                    Text("Keine Ansprechpartner gefunden.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach(filteredContacts) { contact in
                        contactRow(contact)
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private func contactRow(_ contact: Contact) -> some View {
        let isSelected = selection.contains(contact.id)
        let canSelect = ContactAssignmentPickerLogic.canSelect(currentCount: selection.count, alreadySelected: isSelected)
        return Button {
            toggle(contact.id)
        } label: {
            HStack {
                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(!canSelect ? Color.secondary.opacity(0.4) : (isSelected ? Color.accentColor : Color.secondary))
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.name)
                    if !contact.role.isEmpty {
                        Text(contact.role).scaledFont(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canSelect)
        .accessibilityLabel(contact.name)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityHint(!canSelect
            ? "Limit von \(ContactAssignmentPickerLogic.maxAssignments) Ansprechpartnern erreicht."
            : (isSelected ? "Ausgewählt. Doppeltippen zum Abwählen." : "Nicht ausgewählt. Doppeltippen zum Auswählen."))
    }

    private func toggle(_ id: String) {
        if selection.contains(id) {
            selection.remove(id)
        } else if selection.count < ContactAssignmentPickerLogic.maxAssignments {
            selection.insert(id)
        }
    }
}

// MARK: - Laden der bestehenden Zuordnung (Blocker, Code-Review-Nachbesserung)
//
// War zuvor ein `.task` DIREKT an `ContactAssignmentSection.body` — einer
// Zeile INNERHALB von `Form`/`List`. SwiftUI realisiert Form/List-Zeilen aber
// erst, wenn sie tatsächlich sichtbar werden (Lazy Rendering). Liegt die
// Sektion "Ansprechpartner" (wie inzwischen in beiden Formularen der Fall)
// weiter unten, lief das Laden bei einem bestehenden ToDo/Thema mit genug
// Inhalt oberhalb oft NIE, wenn der Nutzer nicht dorthin scrollte —
// `save()` hätte dann mit der leeren Startmenge einen vollen Ersatz-Request
// abgesetzt und serverseitig ALLE zugeordneten Ansprechpartner gelöscht.
//
// Fix: das Laden liegt jetzt als freie Funktion hier (EINE Implementierung,
// weiterhin von `TodoFormView` UND `TopicFormView` geteilt), wird aber vom
// jeweiligen Formular selbst über ein `.task` am `NavigationStack`-Root
// aufgerufen (dort, wo vor der letzten Umstrukturierung bereits ein `.task`
// lag) — das garantiert Ausführung beim Öffnen des Formulars, unabhängig vom
// Scroll-/Sichtbarkeitszustand der Sektion.
//
// Zweite Sicherheitsebene gegen denselben Datenverlustpfad über einen
// Ladefehler: `.failure` unterscheidet sich bewusst von `.success([])`, damit
// der Aufrufer einen echten Fehlschlag NIE mit "wirklich keine Zuordnung"
// verwechselt und die bestehende Auswahl im Fehlerfall unverändert lässt
// (siehe `TodoFormView`/`TopicFormView`: `assignmentsLoaded` wird nur nach
// `.success` gesetzt, `save()` committet nur dann).
//
// Abweichung von der im Review vorgeschlagenen Signatur
// (`... async -> Set<String>`): ein einzelner `Set<String>`-Rückgabewert
// könnte einen Ladefehler nicht von "wirklich keine Zuordnung" unterscheiden
// — genau der Fehlerweg, der laut Fund selbst geschlossen werden soll. Daher
// liefert diese Funktion stattdessen `ContactAssignmentLoadResult`.
enum ContactAssignmentLoadResult: Equatable {
    case success(Set<String>)
    case failure(String)
}

/// Lädt die bestehende Ansprechpartner-Zuordnung für ein Todo/Thema (oder
/// liefert sofort eine leere, erfolgreiche Auswahl im Anlegen-Modus ohne
/// `refId`, analog zum bisherigen `loadInitialAssignments()`-Verhalten).
func loadAssignedContactIds(state: AppState, refType: String, refId: String?) async -> ContactAssignmentLoadResult {
    guard let refId else { return .success([]) }
    do {
        let assignments = try await state.loadAssignments(refType: refType, refId: refId)
        return .success(Set(assignments.map(\.contactId)))
    } catch {
        let message = isTransportFailure(error)
            ? "Keine Verbindung — bitte erneut versuchen, sobald du wieder online bist."
            : "Ansprechpartner konnten nicht geladen werden."
        return .failure(message)
    }
}

// MARK: - Gemeinsame Ansprechpartner-Zuordnungs-Sektion (Fund 2, Code-Review)
//
// War zuvor byte-identisch (bis auf den `refType`-String) in `TodoFormView`
// UND `TopicFormView` dupliziert (`contactsSection`, `assignedContacts`,
// `contactsSummaryText`, `contactChip(_:)`, `loadInitialAssignments()`) —
// bereits sichtbarer Divergenz-Vorbote: die Sektion stand an unterschiedlicher
// Position im jeweiligen Formular. EINE Stelle für "Anzeige zugeordneter
// Kontakte als Chips + Navigation zur Kontaktansicht + Öffnen des
// `ContactAssignmentPickerSheet`" (CLAUDE.md "Wiederverwendung vor
// Neuentwicklung") — hier neben dem zugehörigen Auswahl-Sheet abgelegt.
//
// Bewusst NICHT für den eigentlichen Server-Commit zuständig: das bleibt wie
// zuvor Aufgabe des jeweiligen Formulars (`TodoFormView`/`TopicFormView`
// `save()`), da der Commit erst NACH dem Speichern des Todos/Themas erfolgen
// kann (dessen `refId` bei Neuanlage vorher noch nicht existiert) — siehe
// Kopfkommentar dieser Datei ("Committing"-Absatz).
struct ContactAssignmentSection: View {
    /// "todo" oder "topic" — wird 1:1 an `AppState.loadAssignments`/
    /// `setAssignments` durchgereicht.
    let refType: String
    /// `nil` im Anlegen-Modus (noch keine Server-ID) — dann bleibt `selection`
    /// bis zum ersten Speichern die rein lokale Auswahl (analog zur
    /// Themen-Zuordnung `themeIds`).
    let refId: String?
    @Binding var selection: Set<String>
    /// Wird NUR nach erfolgreichem Laden der bestehenden Zuordnung (durch das
    /// `.task` im Aufrufer, siehe `TodoFormView`/`TopicFormView`) auf `true`
    /// gesetzt — steuert im Aufrufer, ob `save()` `setAssignments` committen
    /// darf (Blocker-Fix: nie mit einer nie geladenen/fehlgeschlagenen leeren
    /// Menge überschreiben).
    ///
    /// Review-Nachbesserung (Hoch-Fund): eine Bestätigung im Picker-Sheet
    /// ("Fertig") setzt dieses Flag NICHT mehr selbst — solange `refId` (also
    /// Bearbeiten-Modus) gesetzt und `loaded` noch `false` ist, bleibt der
    /// Auswahl-Button unten (`Button { showContactPicker = true }`) über
    /// `.disabled(refId != nil && !loaded)` gesperrt. Damit kann das Sheet in
    /// diesem Modus überhaupt erst geöffnet werden, NACHDEM das Laden bereits
    /// erfolgreich war — ein Tap auf "Fertig" ohne bekannte Ausgangsbasis
    /// (fehlgeschlagenes oder noch laufendes Laden) ist so grundsätzlich
    /// ausgeschlossen, statt sich (wie zuvor) allein auf einen weiteren,
    /// unabhängigen `loaded = true`-Pfad im `onDone`-Callback zu verlassen.
    @Binding var loaded: Bool
    /// Review-Nachbesserung (Hoch-Fund, Fall c): wird im `onDone`-Callback
    /// dieses Views auf `true` gesetzt, sobald der Nutzer aktiv eine Auswahl
    /// im Picker-Sheet bestätigt hat. Verhindert im Aufrufer
    /// (`TodoFormView`/`TopicFormView.loadContactAssignments()`), dass ein
    /// (ggf. verspätet zurückkommender, dann veralteter) erfolgreicher
    /// Ladevorgang die gerade getroffene Auswahl kommentarlos überschreibt.
    @Binding var userConfirmedSelection: Bool
    /// Inline-Fehlermeldung eines fehlgeschlagenen Ladeversuchs (`nil` = kein
    /// Fehler). Wird vom Aufrufer gesetzt, da das Laden selbst dort passiert.
    let loadError: String?
    /// Erneuter Ladeversuch nach einem Fehler — beide Aufrufstellen
    /// (`TodoFormView`/`TopicFormView`) übergeben diesen ohnehin immer
    /// (Niedrig-Fund, Code-Review: kein optionaler Default mehr nötig).
    let onRetryLoad: () -> Void
    /// Offline-Modus (P5, Konsistenzentscheidung 8): Auswahl ist deaktiviert
    /// (Zuordnung braucht den Server), solange `disabledHint != nil` — z.B.
    /// "Offline nicht verfügbar" oder, für lokale (noch nicht synchronisierte)
    /// Einträge, der Hinweis `pendingNotSynced`. Default `nil` = unverändert.
    var disabledHint: String? = nil

    @EnvironmentObject var state: AppState
    @State private var showContactPicker = false
    /// Ziel eines Chip-Taps — öffnet die Ansprechpartner-Ansicht (Vertrag:
    /// "Anzeige zugeordneter Kontakte als Chips/Liste mit Navigation zur
    /// Kontaktansicht").
    @State private var contactDetailTarget: Contact?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                showContactPicker = true
            } label: {
                HStack {
                    Text(summaryText)
                        .foregroundStyle(selection.isEmpty ? .secondary : .primary)
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                }
            }
            // Hoch-Fund (Code-Review): im Bearbeiten-Modus (`refId != nil`)
            // erst nutzbar, sobald die bestehende Zuordnung nachweislich
            // geladen wurde. Im Anlegen-Modus (`refId == nil`) ist `loaded`
            // sofort über den bestehenden `.success([])`-Pfad `true`, dort
            // bleibt der Button also durchgehend nutzbar.
            .disabled(ContactAssignmentPickerLogic.isPickerEntryDisabled(refId: refId, loaded: loaded)
                      || disabledHint != nil)
            .accessibilityLabel("Ansprechpartner: \(summaryText)")
            .accessibilityHint(disabledHint ?? "Öffnet die Ansprechpartner-Auswahl.")
            if let disabledHint {
                // Pflicht laut UX: sichtbarer Zusatz statt stummem, deaktiviertem Button.
                Text(disabledHint)
                    .scaledFont(.caption2).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            } else if let loadError {
                VStack(alignment: .leading, spacing: 4) {
                    Text(loadError).scaledFont(.footnote).foregroundStyle(.secondary)
                    Button("Erneut versuchen") { onRetryLoad() }
                        .buttonStyle(.borderless)
                        .scaledFont(.footnote)
                }
            } else if !loaded {
                // Hoch-Fund (Code-Review): sichtbares Feedback für den
                // gesperrten Zustand oben, statt eines stummen, deaktivierten
                // Buttons ohne jede Erklärung.
                Text("Ansprechpartner werden geladen …")
                    .scaledFont(.footnote).foregroundStyle(.secondary)
            }
            if !assignedContacts.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(assignedContacts) { contact in
                            chip(contact)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showContactPicker) {
            ContactAssignmentPickerSheet(initialSelection: selection) { newSelection in
                selection = newSelection
                // Hoch-Fund (Code-Review): setzt bewusst NICHT mehr `loaded`
                // — das ist an dieser Stelle nicht mehr nötig (der
                // Anlegen-Modus setzt es bereits vorher via `.success([])`,
                // der Bearbeiten-Modus kann diesen Callback dank
                // `.disabled(refId != nil && !loaded)` oben ohnehin erst nach
                // erfolgreichem Laden erreichen) und war zuvor der einzige
                // Weg, der den Datenverlustpfad trotz fehlgeschlagenem/nicht
                // abgeschlossenem Laden ermöglichte. Stattdessen wird hier
                // nur die aktive Nutzerbestätigung markiert, damit ein
                // (ggf. verspätet zurückkommender) Ladevorgang diese frische
                // Auswahl im Aufrufer nicht überschreibt (Fall c).
                userConfirmedSelection = true
            }
        }
        .sheet(item: $contactDetailTarget) { ContactDetailView(contact: $0) }
    }

    /// Nur lokal bereits geladene Kontakte (`state.contacts`) werden
    /// angezeigt/verlinkt, analog zu `assignedContactNames`-Muster anderer
    /// Zuordnungen. Deterministisch sortiert (Code-Review, Fund "Mittel":
    /// zuvor `selection.compactMap` über ein `Set`, nicht-deterministische
    /// Reihenfolge) — dieselbe Sortierung wie im Picker-Sheet selbst.
    private var assignedContacts: [Contact] {
        ContactAssignmentPickerLogic.sorted(state.contacts.filter { selection.contains($0.id) })
    }

    private var summaryText: String {
        selection.isEmpty ? "Keine Ansprechpartner ausgewählt" : "\(selection.count) Ansprechpartner"
    }

    private func chip(_ contact: Contact) -> some View {
        Button {
            contactDetailTarget = contact
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "person.fill").font(.system(size: 8))
                Text(contact.name)
            }
            .scaledFont(.caption2).fontWeight(.medium)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(DS.pink.opacity(0.1))
            .foregroundStyle(DS.pink)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(contact.name) öffnen")
        .accessibilityHint("Öffnet die Ansprechpartner-Ansicht.")
    }
}
