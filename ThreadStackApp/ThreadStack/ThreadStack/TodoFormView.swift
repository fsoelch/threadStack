import SwiftUI

/// Reine, von SwiftUI entkoppelte Entscheidungslogik für `TodoFormView.save()`:
/// sobald für das aktuell bearbeitete Todo bereits eine Server-ID bekannt ist
/// — entweder weil ein bestehendes Todo bearbeitet wird ODER weil ein
/// vorheriger Speicherversuch im Anlegen-Modus das Todo bereits erfolgreich
/// angelegt hat (nur der anschliessende, optionale Zwischenstand-Commit ist
/// danach fehlgeschlagen, siehe `createdId`) — MUSS der nächste
/// Speicherversuch ein Update sein, niemals ein zweites Create (sonst
/// Duplikat, Security Review, Mittel: Fund 1).
enum TodoSaveTarget: Equatable {
    case create
    case update(id: String)

    static func resolve(existingTodoId: String?, createdId: String?) -> TodoSaveTarget {
        if let existingTodoId { return .update(id: existingTodoId) }
        if let createdId { return .update(id: createdId) }
        return .create
    }
}

/// Reine Logik für die einklappbare "Weitere Details"-Gruppe (Fällig am +
/// Erinnerung, Schlafen bis, Privat) — UX-Vorgabe: selten genutzte Felder
/// werden gebündelt, klappen bei bereits befüllten Werten automatisch auf,
/// und die Überschrift zeigt eine Kurzzusammenfassung der aktiven Werte
/// (z.B. "Weitere Details – Fällig am 12.09., Privat"), damit man den
/// Zustand nicht erst durch Aufklappen erfahren muss.
enum TodoFormDetailsSummary {
    /// `nil`, wenn keines der gruppierten Felder aktiv ist — dann zeigt die
    /// Überschrift nur "Weitere Details" ohne Zusatz.
    static func summaryText(hasDueDate: Bool, dueDateText: String, hasSnooze: Bool, snoozeDateText: String, isPrivate: Bool) -> String? {
        var parts: [String] = []
        if hasDueDate { parts.append("Fällig am \(dueDateText)") }
        if hasSnooze { parts.append("Schlafen bis \(snoozeDateText)") }
        if isPrivate { parts.append("Privat") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Die Gruppe startet automatisch aufgeklappt, sobald mindestens eines
    /// der selten genutzten Felder bereits einen Wert hat (z.B. beim
    /// Bearbeiten eines bestehenden Todos mit Fälligkeitsdatum) — beim
    /// Neuanlegen (alle Werte leer/aus) bleibt sie eingeklappt.
    static func isExpandedByDefault(hasDueDate: Bool, hasSnooze: Bool, isPrivate: Bool) -> Bool {
        hasDueDate || hasSnooze || isPrivate
    }

    /// Kurzes, deutsches Datumsformat für die Zusammenfassung, z.B. "12.09.".
    static func shortGermanDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "d.M."
        return f.string(from: date)
    }
}

struct TodoFormView: View {
    var todo: TodoItem? = nil
    /// Nur im Anlegen-Modus wirksam: verknüpft das neu erstellte Todo nach
    /// erfolgreichem Speichern automatisch mit diesem Topic (analog zum
    /// presetThemeId-Muster von KnowledgeEditorView).
    var presetThemeId: String? = nil
    /// Wird nach erfolgreichem Anlegen/Bearbeiten aufgerufen, bevor das Sheet
    /// schliesst — Aufrufer nutzen das zum gezielten Nachladen (z. B. der
    /// Themen-gescopten Todo-Liste in ThemeDetailScreen).
    var onSaved: (() -> Void)? = nil
    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore // Fortschrittsverlauf-Zugriff
    @EnvironmentObject var offline: OfflineStatusStore
    @Environment(\.dismiss) var dismiss
    @State private var discardRequest: OfflineDiscardRequest?
    @State private var title = ""
    /// Rich-Text-HTML der Beschreibung (siehe `DescriptionReadView`/
    /// `DescriptionEditorSheet`) — bewusst NICHT mehr Klartext (siehe
    /// zentrale Bug-Behebung dieses Pakets: der frühere `stripHTML`-
    /// Klartextpfad zerstörte still vom Web erzeugte Formatierung).
    @State private var description = ""
    @State private var showDescriptionEditor = false
    /// Nur im Anlegen-Modus verwendet: die Beschreibung ist dort sofort
    /// editierbar (kein Stift-Klick nötig, siehe UX-Vorgabe) — dafür wird
    /// derselbe Editor-Kern wie im Bearbeiten-Sheet inline eingebettet
    /// (`DescriptionRichTextEditor`, siehe `DescriptionEditorSheet.swift`).
    @StateObject private var createDescriptionController = KnowledgeEditorController()
    @State private var createDescriptionContentLoaded = false
    @State private var hasSnooze = false
    @State private var snoozeDate = Date()
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var dueReminderEnabled = false
    @State private var isPrivate = false
    @State private var detailsExpanded = false
    @State private var loading = false
    @State private var error: String?
    // Immer sichtbare Eingabe für einen neuen Zwischenstand (Paket A1),
    // direkt unter der Beschreibung eingebettet (Paket A2 dieser
    // Nachbesserung). Ersetzt den bisherigen "Wo stehe ich gerade?"-Block.
    @StateObject private var progressComposer = ProgressEntryComposer()
    @FocusState private var progressComposerFocused: Bool
    @State private var showDiscardConfirm = false
    // Wird gesetzt, sobald save() im Anlegen-Modus erfolgreich ein neues
    // Todo erzeugt hat — auch wenn der anschliessende, optionale
    // Zwischenstand-Commit fehlschlaegt und das Sheet deshalb offen bleibt.
    // Ein erneuter Klick auf "Speichern" muss dann als Update auf dieses
    // bereits angelegte Todo laufen statt erneut createTodoReturning
    // aufzurufen (das wuerde sonst ein Duplikat anlegen).
    @State private var createdId: String?
    // Manuelle Topic-Zuordnung (Requirements Fix 3: Topics muessen sich auch
    // ohne AI-Vorschlag manuell zuordnen lassen) - analog zu KnowledgeEditorView.
    @State private var themeIds: Set<String> = []
    @State private var showTopicPicker = false
    // Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): Zuständigkeit
    // (Ansprechpartner), analog zur Topic-Zuordnung oben — lokale Auswahl,
    // committed als EIN vollständiger Ersatz-Request (`AppState.setAssignments`,
    // analog zu `setTodoThemes`) NACH dem eigentlichen Speichern des Todos.
    // Anzeige/Auswahl-UI ist in `ContactAssignmentSection` ausgelagert (siehe
    // `ContactAssignmentPickerSheet.swift`, gemeinsam mit `TopicFormView`
    // genutzt — Code-Review Fund 2, CLAUDE.md "Wiederverwendung vor
    // Neuentwicklung").
    @State private var contactIds: Set<String> = []
    // Blocker-Fix (Code-Review): NUR nach erfolgreichem Laden der
    // bestehenden Zuordnung (`.task` unten, am `NavigationStack`-Root, NICHT
    // mehr in `ContactAssignmentSection.body` — siehe dortige Kopfkommentare)
    // ODER nach einer vom Nutzer aktiv bestätigten Auswahl im Picker-Sheet
    // wird dieses Flag `true`. `save()` committet `setAssignments` nur dann —
    // so kann weder ein Rendering-Timing-Problem (Form/List-Lazy-Rendering)
    // noch ein fehlgeschlagener Ladevorgang je bestehende Zuordnungen mit
    // einer leeren Liste überschreiben; im Zweifel wird der Commit einfach
    // übersprungen statt zu löschen.
    @State private var assignmentsLoaded = false
    @State private var assignmentsLoadError: String?
    // Hoch-Fund (Code-Review, Fall c): wird im `onDone`-Callback des Pickers
    // (über `ContactAssignmentSection`) gesetzt, sobald der Nutzer aktiv eine
    // Auswahl bestätigt hat — verhindert in `loadContactAssignments()`, dass
    // ein (ggf. verspätet zurückkommender) erfolgreicher Ladevorgang diese
    // frische Auswahl kommentarlos überschreibt.
    @State private var userConfirmedSelection = false

    private var detailsSummaryText: String? {
        TodoFormDetailsSummary.summaryText(
            hasDueDate: hasDueDate, dueDateText: TodoFormDetailsSummary.shortGermanDate(dueDate),
            hasSnooze: hasSnooze, snoozeDateText: TodoFormDetailsSummary.shortGermanDate(snoozeDate),
            isPrivate: isPrivate
        )
    }

    private var detailsHeaderText: String {
        if let detailsSummaryText { return "Weitere Details – \(detailsSummaryText)" }
        return "Weitere Details"
    }

    // MARK: Offline-Modus

    /// Das bearbeitete Todo ist lokal (noch nicht synchronisiert) -> "Offline-Eintrag".
    private var isLocalEntry: Bool { todo.map { OfflineGating.isLocal($0.id) } ?? false }
    /// Bestehendes, synchronisiertes Todo bei fehlender Verbindung: Speichern gesperrt.
    private var editBlockedReason: String? {
        guard let todo else { return nil }
        return OfflineGating.editDisabledReason(id: todo.id, isOffline: offline.isOffline)
    }
    /// Topic-/Ansprechpartner-Zuordnung braucht den Server (Konsistenzentscheidung 8).
    private var relationsDisabled: Bool {
        OfflineGating.relationFieldsDisabled(isOffline: offline.isOffline, entryId: todo?.id)
    }
    private var relationsHint: String? {
        OfflineGating.relationFieldsHintIfDisabled(isOffline: offline.isOffline, entryId: todo?.id)
    }

    private func discardLocalTodo(_ request: OfflineDiscardRequest) {
        Task {
            do {
                try await state.deleteTodo(id: request.id)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let todo, isLocalEntry {
                    OfflineEntryFormHeader(entityId: todo.id, title: todo.title, accessibilityPrefix: "Todo")
                }
                if let editBlockedReason { OfflineFormNotice(text: editBlockedReason) }
                Section("Titel") {
                    TextField("Todo eingeben", text: $title)
                }
                Section {
                    descriptionSection
                }
                Section("Zugehörige Topics") {
                    topicsSection
                }
                if todo != nil {
                    Section("Fortschritt") {
                        progressSection
                    }
                }
                // Positionierung vereinheitlicht mit `TopicFormView`: immer
                // direkt vor "Weitere Details" (Code-Review Fund 2).
                Section("Ansprechpartner") {
                    ContactAssignmentSection(
                        refType: "todo", refId: todo?.id, selection: $contactIds,
                        loaded: $assignmentsLoaded, userConfirmedSelection: $userConfirmedSelection,
                        loadError: assignmentsLoadError,
                        onRetryLoad: { Task { await loadContactAssignments() } },
                        disabledHint: relationsHint
                    )
                }
                Section {
                    DisclosureGroup(isExpanded: $detailsExpanded) {
                        detailsGroupContent
                    } label: {
                        Text(detailsHeaderText)
                            .accessibilityLabel(detailsHeaderText)
                    }
                }
                if let todo, isLocalEntry {
                    // Lokalen, nicht synchronisierten Eintrag verwerfen (UX Screen 7).
                    Section {
                        Button(OfflineTexts.discardButton, role: .destructive) {
                            discardRequest = offline.discardRequest(forEntityId: todo.id, title: title.isEmpty ? todo.title : title)
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(todo == nil ? "Neues Todo" : "Todo bearbeiten")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { handleCancelTapped() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") { save() }
                        .disabled(title.isEmpty || loading || progressComposer.isOverLimit || editBlockedReason != nil)
                }
            }
            .onAppear { populate() }
            // Verbindung zurück: bestehende Zuordnung nachladen (war offline übersprungen).
            .reloadWhenBackOnline(hasContent: assignmentsLoaded) { Task { await loadContactAssignments() } }
            .offlineDiscardDialog($discardRequest) { discardLocalTodo($0) }
            .interactiveDismissDisabled(progressComposer.isDirty)
            .confirmationDialog(
                "Zwischenstand verwerfen? Dein eingegebener Text ist noch nicht gespeichert.",
                isPresented: $showDiscardConfirm,
                titleVisibility: .visible
            ) {
                Button("Verwerfen", role: .destructive) {
                    progressComposer.discard(store: progressStore, refType: "todo", refId: todo?.id)
                    dismiss()
                }
                Button("Weiter bearbeiten", role: .cancel) {}
            }
            .sheet(isPresented: $showDescriptionEditor) {
                DescriptionEditorSheet(initialHTML: description, title: "Beschreibung bearbeiten") { newHTML in
                    description = newHTML
                }
            }
            .sheet(isPresented: $showTopicPicker) {
                KnowledgeTopicPickerSheet(
                    initialSelection: themeIds,
                    emptySelectionHint: "Ohne Topic-Zuordnung erscheint dieses Todo nicht in der Topic-Detailansicht."
                ) { selection in
                    themeIds = selection
                }
            }
            // Blocker-Fix: am NavigationStack-Root (nicht mehr innerhalb der
            // `Form`, siehe `ContactAssignmentSection`) — läuft dadurch immer
            // beim Öffnen des Formulars, unabhängig vom Scroll-/
            // Sichtbarkeitszustand der Ansprechpartner-Sektion.
            .task { await loadContactAssignments() }
        }
    }

    private func loadContactAssignments() async {
        // Offline/lokal: bestehende Zuordnung nicht ladbar -> kein Fehlerzustand, Feld ist deaktiviert.
        if todo != nil && relationsDisabled { return }
        switch await loadAssignedContactIds(state: state, refType: "todo", refId: todo?.id) {
        case .success(let ids):
            // Hoch-Fund (Code-Review, Fall c): ein (ggf. verspätet
            // zurückkommender) erfolgreicher Ladevorgang darf eine bereits
            // vom Nutzer aktiv im Picker bestätigte Auswahl NICHT mehr
            // kommentarlos überschreiben.
            if ContactAssignmentPickerLogic.shouldApplyLoadedSelection(userConfirmedSelection: userConfirmedSelection) {
                contactIds = ids
            }
            assignmentsLoaded = true
            assignmentsLoadError = nil
        case .failure(let message):
            assignmentsLoadError = message
        }
    }

    @ViewBuilder
    private var topicsSection: some View {
        topicsButton
        if let relationsHint {
            OfflineUnavailableHint(relationsHint)
        }
    }

    private var topicsButton: some View {
        Button {
            showTopicPicker = true
        } label: {
            HStack {
                Text(topicsSummaryText)
                    .foregroundStyle(themeIds.isEmpty ? .secondary : .primary)
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
        }
        .disabled(relationsDisabled)
        .accessibilityLabel("Zugehörige Topics: \(topicsSummaryText)")
        .accessibilityHint(relationsHint ?? "Öffnet die Topic-Auswahl.")
    }

    private var topicsSummaryText: String {
        guard !themeIds.isEmpty else { return "Keine Topics ausgewählt" }
        let titles = themeIds.compactMap { id in state.themes.first(where: { $0.id == id })?.title }
        return titles.isEmpty ? "\(themeIds.count) Topic(s)" : titles.joined(separator: ", ")
    }

    @ViewBuilder
    private var descriptionSection: some View {
        if todo == nil {
            // Neuanlage: sofort editierbar, kein Stift-Klick nötig (UX-Vorgabe).
            VStack(alignment: .leading, spacing: 6) {
                Text("Beschreibung").scaledFont(.footnote).foregroundStyle(.secondary)
                DescriptionRichTextEditor(controller: createDescriptionController)
            }
            .onChange(of: createDescriptionController.isReady) { _, ready in
                guard ready else { createDescriptionContentLoaded = false; return }
                Task {
                    await createDescriptionController.setContent("")
                    createDescriptionContentLoaded = true
                }
            }
        } else {
            DescriptionReadView(html: description) {
                showDescriptionEditor = true
            }
        }
    }

    @ViewBuilder
    private var detailsGroupContent: some View {
        Toggle("📅 Fälligkeitsdatum", isOn: $hasDueDate)
        if hasDueDate {
            DatePicker("Fällig am", selection: $dueDate,
                        displayedComponents: dueReminderEnabled ? [.date, .hourAndMinute] : [.date])
            Toggle("🔔 Erinnerung", isOn: $dueReminderEnabled)
            Text(dueReminderEnabled
                 ? "Erinnert dich per Benachrichtigung zu dieser Uhrzeit."
                 : "Todos mit Fälligkeit werden zuerst angezeigt — frühestes oben.")
                .scaledFont(.caption).foregroundStyle(.secondary)
        }
        Toggle("😴 Schlafen bis", isOn: $hasSnooze)
        if hasSnooze {
            DatePicker("Wacht auf am", selection: $snoozeDate, displayedComponents: .date)
            Text("Bis zu diesem Datum ausblenden.")
                .scaledFont(.caption).foregroundStyle(.secondary)
        }
        Toggle(isOn: $isPrivate) {
            Label("Privat", systemImage: "lock")
        }
        Text("Nur für dich — lässt sich in der Todos-Liste schnell ausblenden.")
            .scaledFont(.caption).foregroundStyle(.secondary)
    }

    // Wird nur im Bearbeiten-Modus gerendert (siehe Section-Bedingung in
    // `body`): beim Neuanlegen gibt es noch keinen Fortschritt zu zeigen,
    // das Todo existiert ja gerade erst.
    @ViewBuilder
    private var progressSection: some View {
        if let t = todo {
            ProgressTimelineView(refType: "todo", refId: t.id, store: progressStore, descriptionHTML: description) {
                ProgressEntryComposerView(composer: progressComposer, isFocused: $progressComposerFocused,
                                          showsOfflineQueueHint: true) {
                    Task { await commitProgressComposer(refId: t.id) }
                }
            } reentry: {
                ProgressReentryCardView(refType: "todo", refId: t.id, store: progressStore) {
                    progressComposerFocused = true
                }
            }
        }
    }

    private func commitProgressComposer(refId: String) async {
        await progressComposer.commit(store: progressStore, refType: "todo", refId: refId, hasSnooze: hasSnooze)
    }

    private func handleCancelTapped() {
        if progressComposer.isDirty {
            showDiscardConfirm = true
        } else {
            dismiss()
        }
    }

    private func populate() {
        if let presetThemeId, todo == nil {
            themeIds = [presetThemeId]
        }
        guard let t = todo else { return }
        title = t.title
        description = t.description
        isPrivate = t.isPrivate
        themeIds = Set(state.themeLinks(for: t.id).filter { $0.link.refType == "todo" }.map { $0.theme.id })
        if let s = t.snoozedUntil, !s.isEmpty, let d = parseFlexDate(s) {
            hasSnooze = true; snoozeDate = d
        }
        if let s = t.dueDate, !s.isEmpty {
            if s.count > 10, let d = parseFlexDate(s) {
                hasDueDate = true; dueDate = d; dueReminderEnabled = true
            } else if let d = Self.parseDate(s) {
                hasDueDate = true; dueDate = d
            }
        }
        detailsExpanded = TodoFormDetailsSummary.isExpandedByDefault(
            hasDueDate: hasDueDate, hasSnooze: hasSnooze, isPrivate: isPrivate
        )
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

    private static func formatDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// Liefert die zu speichernde Beschreibung als HTML. Im Anlegen-Modus
    /// wird sie aus dem inline eingebetteten Editor gelesen (`description`
    /// wird dort nie befüllt, da kein Sheet dafür existiert); im
    /// Bearbeiten-Modus ist `description` bereits aktuell (wird nur über
    /// `DescriptionEditorSheet.onSave` verändert).
    private func resolveDescriptionHTML() async -> String {
        guard todo == nil else { return description }
        guard createDescriptionController.isReady, createDescriptionContentLoaded else { return "" }
        return (try? await createDescriptionController.content()) ?? ""
    }

    private func save() {
        loading = true
        let snooze: String? = hasSnooze ? Self.formatDate(snoozeDate) : nil
        let due:    String? = hasDueDate
            ? (dueReminderEnabled ? ISO8601DateFormatter().string(from: dueDate) : Self.formatDate(dueDate))
            : nil
        let notificationTitle = title
        let fireAt: Date? = (hasDueDate && dueReminderEnabled) ? dueDate : nil
        Task {
            let descriptionHTML = await resolveDescriptionHTML()
            do {
                var savedId: String?
                switch TodoSaveTarget.resolve(existingTodoId: todo?.id, createdId: createdId) {
                case .update(let id) where todo?.id == id:
                    let t = todo! // sicher: id stammt hier nachweislich aus todo?.id
                    try await state.updateTodo(
                        id: t.id, title: title, description: descriptionHTML,
                        done: t.done, result: t.result, resultDate: t.resultDate,
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    savedId = t.id
                    NotificationScheduler.shared.reschedule(id: "todo-\(t.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                case .update(let existingId):
                    // Ein vorheriger Speicherversuch hat das Todo bereits
                    // angelegt (nur der Zwischenstand-Commit ist danach
                    // fehlgeschlagen) — jetzt updaten statt erneut anlegen.
                    try await state.updateTodo(
                        id: existingId, title: title, description: descriptionHTML,
                        done: false, result: "", resultDate: "",
                        snoozedUntil: snooze, dueDate: due, isPrivate: isPrivate
                    )
                    savedId = existingId
                    NotificationScheduler.shared.reschedule(id: "todo-\(existingId)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                case .create:
                    let created = try await state.createTodoReturning(title: title, description: descriptionHTML,
                                               snoozedUntil: snooze, dueDate: due,
                                               isPrivate: isPrivate)
                    savedId = created.id
                    createdId = created.id
                    NotificationScheduler.shared.reschedule(id: "todo-\(created.id)", title: notificationTitle, fireAt: fireAt, isPrivate: isPrivate, notificationTitle: "ThreadStack — Erinnerung")
                }
                // Topic-Zuordnung wird immer (Anlegen UND Bearbeiten) ueber
                // die Auswahl im Formular gesteuert - ersetzt das fruehere
                // Auto-Link-nur-bei-Neuanlage-aus-Topic-Kontext-Verhalten.
                // Lokale (offline eingereihte) Einträge: Zuordnung erst nach der Übertragung
                // möglich — kein Request (sonst pendingNotSynced), dafür ein Hinweis.
                var relationsSkipped = false
                if let savedId {
                    if OfflineGating.shouldCommitRelations(savedId: savedId) {
                        _ = try? await state.setTodoThemes(id: savedId, themeIds: Array(themeIds))
                    } else if !themeIds.isEmpty || !contactIds.isEmpty {
                        relationsSkipped = true
                    }
                }
                // Der Snooze/das Anlegen/Aktualisieren ist an dieser Stelle
                // bereits serverseitig erfolgt — ein Fehler beim optionalen
                // Zwischenstand darf ihn NICHT als fehlgeschlagen erscheinen
                // lassen, das Sheet bleibt aber offen (Text bleibt erhalten).
                let progressResult = await progressComposer.commit(
                    store: progressStore, refType: "todo", refId: savedId, hasSnooze: hasSnooze
                )
                // Zuständigkeit (Ansprechpartner) committen — Story 14
                // (Offline-/Fehlerfall): anders als die bestehende, bewusst
                // still verworfene Topic-Zuordnung oben MUSS ein Fehlschlag
                // hier sichtbar bleiben und die Auswahl darf nicht verloren
                // gehen. `savedId`/`createdId` bleiben dabei erhalten — ein
                // erneuter Tap auf "Speichern" durchläuft danach zwar erneut
                // den GESAMTEN `save()`-Ablauf (nicht nur diesen einen
                // Schritt), das ist aber harmlos: Update-Aufrufe und der
                // volle Ersatz-Request `setAssignments` sind beide idempotent.
                //
                // Blocker-Fix: nur committen, wenn die bestehende Zuordnung
                // nachweislich geladen wurde (oder der Nutzer aktiv im
                // Picker-Sheet bestätigt hat, siehe `assignmentsLoaded`) —
                // sonst würde ein Rendering-Timing-Problem oder ein
                // fehlgeschlagener Ladevorgang bestehende Ansprechpartner
                // stillschweigend löschen. Im Zweifel wird der Commit
                // einfach übersprungen, bestehende Zuordnungen bleiben
                // serverseitig unangetastet.
                var assignmentErrorText: String?
                if relationsSkipped { state.showToast(OfflineTexts.relationsSkippedToast) }
                if ContactAssignmentPickerLogic.shouldCommitAssignments(assignmentsLoaded: assignmentsLoaded), let savedId,
                   OfflineGating.shouldCommitRelations(savedId: savedId) {
                    do { try await state.setAssignments(refType: "todo", refId: savedId, contactIds: Array(contactIds)) }
                    catch { assignmentErrorText = friendlyAssignmentErrorMessage(error) }
                }
                loading = false
                if let assignmentErrorText {
                    self.error = assignmentErrorText
                } else if progressResult != .failed {
                    onSaved?()
                    dismiss()
                }
            } catch {
                self.error = error.localizedDescription
                loading = false
            }
        }
    }
}
