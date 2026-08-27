import SwiftUI

// MARK: - Reine Logik (testbar ohne SwiftUI-View-Rendering)

/// Sichtbarkeitslogik für die Kompakt-Karten in Übersicht (`TodosView`) und
/// Meeting-Detail (`MeetingDetailView`), getrennt vom View-Body (analog
/// `ProgressBadgeLogic`), damit sie ohne Rendering unit-testbar ist (siehe
/// `TodoOverviewLogicTests`). Regel laut Vertrag: erledigte Vorhaben zeigen
/// weder Fortschrittszeile noch Composer noch KI-Zusammenfassung; archivierte
/// Meeting-Themen (`isReadOnly`) zusätzlich keinen Composer/keine
/// KI-Zusammenfassung (bestehender Schreibschutz) — die Fortschrittszeile
/// selbst bleibt dort aber sichtbar (reiner Lesezugriff bleibt erlaubt).
enum TodoOverviewLogic {
    static func showsProgressBadge(done: Bool) -> Bool { !done }

    static func showsInlineComposer(done: Bool, isReadOnly: Bool) -> Bool {
        !done && !isReadOnly
    }

    static func showsAISummary(done: Bool, isReadOnly: Bool) -> Bool {
        !done && !isReadOnly
    }

    /// Ob für eine sichtbare Karte Polling gestartet werden sollte: nur wenn
    /// die Karte überhaupt eine KI-Zusammenfassung anbieten würde UND
    /// mindestens einer der beiden möglichen Status `pending` ist.
    static func shouldStartPolling(done: Bool, isReadOnly: Bool, pair: AISummaryPair?) -> Bool {
        guard showsAISummary(done: done, isReadOnly: isReadOnly) else { return false }
        return pair?.progress?.kind == .pending || pair?.description?.kind == .pending
    }
}

struct TodosView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var progressStore: ProgressStore
    // Zentrale, app-weite Instanz (analog `progressStore` oben), registriert
    // in `ThreadStackApp.swift` und über `.environmentObject(...)` injiziert.
    @EnvironmentObject var summaryStore: SummaryStore
    @State private var search = ""
    @State private var showNew = false
    @State private var hidePrivate = false
    @State private var error: String?
    // Story 9 ("Ruhende Vorhaben gezielt wiederfinden") — bislang nur im Web
    // vorhanden (Tester-Fund), hier analog nachgezogen. Auswahl bleibt nur
    // fuer die Sitzung erhalten (kein Persistieren gefordert).
    @State private var sortOldestProgressFirst = false
    @State private var showOnlyUndocumented = false

    private var hasPrivate: Bool { state.todos.contains { $0.isPrivate } }

    private var filtered: [TodoItem] {
        var base = state.todos
        if hidePrivate { base = base.filter { !$0.isPrivate } }
        guard !search.isEmpty else { return base }
        return base.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            stripHTML($0.description).localizedCaseInsensitiveContains(search)
        }
    }

    private func sortByDue(_ list: [TodoItem]) -> [TodoItem] {
        list.sorted { a, b in
            if a.dueSortKey != b.dueSortKey { return a.dueSortKey < b.dueSortKey }
            return (a.sortOrder ?? 0) < (b.sortOrder ?? 0)
        }
    }

    // Identisch zum Web-Comparator TSProgress.compareByProgress (public/progress.js):
    // Vorhaben ohne Zwischenstand (orderKey==nil) werden ans Ende gestellt,
    // ansonsten aufsteigend nach Alter des letzten Zwischenstands (aeltester zuerst).
    private func sortByOldestProgress(_ list: [TodoItem]) -> [TodoItem] {
        list.sorted { a, b in
            let aKey = a.progress?.orderKey
            let bKey = b.progress?.orderKey
            if (aKey == nil) != (bKey == nil) { return aKey != nil }
            guard let ak = aKey, let bk = bKey else { return false }
            return ak < bk
        }
    }

    private var openTodosBase: [TodoItem] {
        var list = filtered.filter { !$0.done && !$0.isSnoozed }
        if showOnlyUndocumented { list = list.filter { $0.progress?.undocumented == true } }
        return list
    }
    private var openTodos: [TodoItem] {
        sortOldestProgressFirst ? sortByOldestProgress(openTodosBase) : sortByDue(openTodosBase)
    }
    private var snoozedTodos: [TodoItem] { sortByDue(filtered.filter { !$0.done &&  $0.isSnoozed }) }
    private var doneTodos:    [TodoItem] { filtered.filter {  $0.done }.sorted { $0.resultDate > $1.resultDate } }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Todos suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            #endif

            Section {
                Picker("Sortierung", selection: $sortOldestProgressFirst) {
                    Text("Standard (Fälligkeit)").tag(false)
                    Text("Ältester Stand zuerst").tag(true)
                }
                Toggle("Länger nicht dokumentiert", isOn: $showOnlyUndocumented)
            }

            if openTodos.isEmpty && showOnlyUndocumented {
                Section {
                    Text("✓ Alles aktuell dokumentiert")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            } else if !openTodos.isEmpty {
                Section(header: sectionHeader("Offen", count: openTodos.count, color: DS.accent)) {
                    ForEach(openTodos) { t in
                        TodoRowView(todo: t, progressStore: progressStore, summaryStore: summaryStore)
                    }
                    .onDelete { deleteTodo(from: openTodos, at: $0) }
                }
            }
            if !snoozedTodos.isEmpty {
                Section(header: sectionHeader("Schlafend", count: snoozedTodos.count,
                                              color: .gray, icon: "moon.zzz.fill")) {
                    ForEach(snoozedTodos) { t in
                        TodoRowView(todo: t, progressStore: progressStore, summaryStore: summaryStore)
                    }
                }
            }
            if !doneTodos.isEmpty {
                Section(header: sectionHeader("Erledigt", count: doneTodos.count, color: .secondary)) {
                    ForEach(doneTodos) { t in
                        TodoRowView(todo: t, progressStore: progressStore, summaryStore: summaryStore)
                    }
                    .onDelete { deleteTodo(from: doneTodos, at: $0) }
                }
            }
            #if os(macOS)
            Section {
                Button { showNew = true } label: {
                    Label("Neues Todo", systemImage: "plus.circle").foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
            #endif

            if state.todos.isEmpty {
                Section {
                    Text("Noch keine Todos — tippe auf + um das erste hinzuzufügen.")
                        .foregroundStyle(.secondary).font(.subheadline)
                        .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .navigationTitle("Meine Todos")
        #if os(iOS)
        .searchable(text: $search, prompt: "Todos suchen")
        #endif
        #if os(iOS)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .navigationBarTrailing) { EditButton() }
            if hasPrivate {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        hidePrivate.toggle()
                    } label: {
                        Image(systemName: hidePrivate ? "lock.fill" : "lock")
                            .foregroundStyle(hidePrivate ? .primary : .secondary)
                    }
                    .help(hidePrivate ? "Private Todos einblenden" : "Private Todos ausblenden")
                }
            }
        }
        #endif
        .sheet(isPresented: $showNew) { TodoFormView() }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
        .onAppear {
            summaryStore.ingest(from: Self.summaryIngestItems(state.todos))
        }
        .onChange(of: state.todos) { _, newValue in
            summaryStore.ingest(from: Self.summaryIngestItems(newValue))
        }
    }

    // Additive KI-Zusammenfassungs-Anreicherung aus der bereits geladenen
    // Liste (kein zusätzlicher Netzwerk-Request, siehe SummaryStore.ingest).
    // Todos ohne `aiSummary` (z.B. Feature deaktiviert) werden ausgelassen -
    // `SummaryStore.pair(for:)` liefert dafür bereits korrekt `nil`.
    private static func summaryIngestItems(_ items: [TodoItem]) -> [(refKey: String, pair: AISummaryPair)] {
        items.compactMap { item in
            guard let pair = item.aiSummary else { return nil }
            return (refKey: "todo:\(item.id)", pair: pair)
        }
    }

    private func sectionHeader(_ label: String, count: Int, color: Color,
                                icon: String? = nil) -> some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon).scaledFont(.caption2).foregroundStyle(color)
            }
            Text(label).foregroundStyle(color)
            Text("· \(count)").foregroundStyle(.secondary)
        }.scaledFont(.footnote).fontWeight(.semibold)
    }

    private func deleteTodo(from list: [TodoItem], at offsets: IndexSet) {
        let ids = offsets.map { list[$0].id }
        Task {
            for id in ids {
                do { try await state.deleteTodo(id: id) }
                catch { self.error = error.localizedDescription }
            }
        }
    }
}

// MARK: - Todo Row

struct TodoRowView: View {
    let todo: TodoItem
    // A3: Fortschritt/KI-Zusammenfassung/Inline-Composer nutzen dieselben,
    // von `TodosView` gehaltenen Store-Instanzen — keine eigenen pro Zeile.
    @ObservedObject var progressStore: ProgressStore
    @ObservedObject var summaryStore: SummaryStore
    @EnvironmentObject var state: AppState
    @State private var showEdit = false
    @State private var showComplete = false
    @State private var showMove = false
    @State private var showThemes = false
    @State private var showSnooze = false
    @State private var showPush   = false
    @State private var error: String?

    private var themeLinks: [(theme: Theme, link: ThemeLink)] { state.themeLinks(for: todo.id) }
    private var summaryRef: String { "todo:\(todo.id)" }
    private var aiSummary: AISummaryPair? { summaryStore.pair(for: summaryRef) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                statusIcon
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(todo.title)
                            .scaledFont(.subheadline).fontWeight(.medium)
                            .strikethrough(todo.done)
                            .foregroundStyle(todo.done ? .secondary : .primary)
                        if todo.isPrivate {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                        }
                    }

                    if !todo.description.isEmpty {
                        Text(htmlAttributedString(todo.description))
                            .scaledFont(.caption).lineLimit(2)
                    }

                    if !todo.done, let due = todo.dueDateFormatted {
                        dueBadge(text: due, status: todo.dueStatus)
                    }
                    // Erledigte Todos: keine Fortschrittszeile (Vertrag) —
                    // schlafende Todos behalten sie weiterhin sichtbar.
                    if TodoOverviewLogic.showsProgressBadge(done: todo.done) {
                        ProgressBadgeView(summary: todo.progress) // A3
                    }
                    if todo.isSnoozed, let wake = todo.snoozeWakeFormatted {
                        Label("Wacht auf am \(wake)", systemImage: "moon.zzz.fill")
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }
                    // Hinweis (siehe Abschlussbericht Paket A3): eine "Aus
                    // Meetings"-Gruppe (Topics mit `isTodo == true` aus allen
                    // Meetings) existiert in `TodosView.swift`/`state.todos`
                    // nicht — `state.todos` liefert ausschließlich
                    // eigenständige `TodoItem`s (`GET /api/todos`). Die
                    // bestehende Herkunfts-Kennzeichnung für aus Themen
                    // stammende Todos lebt in `ThemeDetailScreen`
                    // (`ThemesView.swift`, außerhalb dieser Datei-
                    // Eigentümerschaft) — hier daher bewusst NICHT dupliziert.
                    if !themeLinks.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(themeLinks, id: \.link.id) { tl in themeChip(tl.theme.title) }
                            }
                        }
                    }
                    if TodoOverviewLogic.showsAISummary(done: todo.done, isReadOnly: false) {
                        AISummaryCardView(kind: .progress, summary: aiSummary?.progress,
                                          refType: "todo", refId: todo.id, store: summaryStore,
                                          onShowAllEntries: { showEdit = true })
                        AISummaryCardView(kind: .description, summary: aiSummary?.description,
                                          refType: "todo", refId: todo.id, store: summaryStore)
                    }
                }
                Spacer()
            }

            // Story 6: Zwischenstand direkt in der Zeile erfassen — kein
            // Angebot bei erledigten Todos (Vertrag).
            if TodoOverviewLogic.showsInlineComposer(done: todo.done, isReadOnly: false) {
                InlineEntryComposerView(refType: "todo", refId: todo.id, hasSnooze: todo.isSnoozed,
                                        store: progressStore)
            }

            if todo.done && !todo.result.isEmpty {
                Text(htmlAttributedString(todo.result))
                    .scaledFont(.caption).padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .opacity(todo.isSnoozed ? 0.7 : 1)
        .onAppear {
            if TodoOverviewLogic.shouldStartPolling(done: todo.done, isReadOnly: false, pair: aiSummary) {
                Task { await summaryStore.poll(refs: [summaryRef]) }
            }
        }
        .onDisappear {
            summaryStore.cancelPolling(for: summaryRef)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { do { try await state.deleteTodo(id: todo.id) }
                      catch { self.error = error.localizedDescription } }
            } label: { Label("Löschen", systemImage: "trash") }

            if !todo.done {
                Button { showComplete = true } label: {
                    Label("Erledigt", systemImage: "checkmark.circle")
                }.tint(.green)
            } else {
                Button {
                    Task { do { try await state.reopenTodo(id: todo.id) }
                          catch { self.error = error.localizedDescription } }
                } label: { Label("Öffnen", systemImage: "arrow.uturn.left") }
            }
        }
        .swipeActions(edge: .leading) {
            Button { showSnooze = true } label: {
                Label(todo.isSnoozed ? "Wecken" : "Schlafen", systemImage: "moon.zzz.fill")
            }.tint(DS.accent)
        }
        .contentShape(Rectangle())
        .onTapGesture { showEdit = true }
        .contextMenu {
            Button { showEdit    = true } label: { Label("Bearbeiten", systemImage: "pencil") }
            Button { showThemes  = true } label: { Label("Topic zuweisen", systemImage: "tag") }
            Button { showMove    = true } label: { Label("In Meeting verschieben", systemImage: "arrow.right") }
            if !todo.done {
                Button { showPush = true } label: { Label("Auf Stack legen", systemImage: "square.stack.3d.up") }
            }
            Divider()
            Button { showSnooze = true } label: {
                Label(todo.isSnoozed ? "Wecken" : "Schlafen legen", systemImage: "moon.zzz.fill")
            }
            Divider()
            if !todo.done {
                Button { showComplete = true } label: {
                    Label("Als erledigt markieren", systemImage: "checkmark.circle")
                }
            } else {
                Button {
                    Task { do { try await state.reopenTodo(id: todo.id) }
                          catch { self.error = error.localizedDescription } }
                } label: { Label("Wieder öffnen", systemImage: "arrow.uturn.left") }
            }
            Divider()
            Button(role: .destructive) {
                Task { do { try await state.deleteTodo(id: todo.id) }
                      catch { self.error = error.localizedDescription } }
            } label: { Label("Löschen", systemImage: "trash") }
        }
        .sheet(isPresented: $showEdit)     { TodoFormView(todo: todo) }
        .sheet(isPresented: $showComplete) { TodoCompleteSheet(todo: todo) }
        .sheet(isPresented: $showMove)     { MoveItemSheet(type: .todo(id: todo.id)) }
        .sheet(isPresented: $showThemes)   { ThemeLinkSheet(refType: "todo", refId: todo.id, title: todo.title) }
        .sheet(isPresented: $showSnooze)   {
            SnoozeSheet(onSnooze: { until in
                Task { do { try await state.snoozeTodo(id: todo.id, until: until) }
                      catch { self.error = error.localizedDescription } }
            }, onWake: todo.isSnoozed ? {
                Task { do { try await state.snoozeTodo(id: todo.id, until: nil) }
                      catch { self.error = error.localizedDescription } }
            } : nil)
        }
        .sheet(isPresented: $showPush) {
            StackPushSheet(target: PushTarget(refType: "todo", refId: todo.id, title: todo.title,
                                               nextStep: todo.progress?.nextStep)) // A3: Vorbelegung
        }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    @ViewBuilder private var statusIcon: some View {
        if todo.done {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).scaledFont(.subheadline)
        } else if todo.isSnoozed {
            Image(systemName: "moon.zzz.fill").foregroundStyle(.gray).scaledFont(.subheadline)
        } else {
            Circle().stroke(DS.green, lineWidth: 1.5).frame(width: 16, height: 16)
        }
    }

    @ViewBuilder
    private func dueBadge(text: String, status: DueStatus) -> some View {
        let (bg, fg, label): (Color, Color, String) = {
            switch status {
            case .overdue: return (Color(hex: "#fee2e2"), Color(hex: "#b91c1c"), "Überfällig: \(text)")
            case .today:   return (Color(hex: "#fef3c7"), Color(hex: "#92400e"), "Heute: \(text)")
            default:       return (DS.accentLight, DS.accentDark, "Fällig: \(text)")
            }
        }()
        HStack(spacing: 3) {
            Image(systemName: "calendar").font(.system(size: 9))
            Text(label)
        }
        .scaledFont(.caption2).fontWeight(.medium)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(bg)
        .foregroundStyle(fg)
        .clipShape(Capsule())
    }

    private func themeChip(_ title: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "tag.fill").font(.system(size: 8))
            Text(title)
        }
        .scaledFont(.caption2).fontWeight(.medium)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(DS.purple.opacity(0.1))
        .foregroundStyle(DS.purple)
        .clipShape(Capsule())
    }
}

// MARK: - Todo Complete Sheet

struct TodoCompleteSheet: View {
    let todo: TodoItem
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) var dismiss
    @State private var result = ""
    @State private var resultDate = Date()
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Ergebnis") { TextEditor(text: $result).frame(minHeight: 80) }
                Section("Datum") {
                    DatePicker("Erledigt am", selection: $resultDate, displayedComponents: .date)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle("Als erledigt markieren")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Erledigt") { save() }.disabled(loading)
                }
            }
        }
    }

    private func save() {
        loading = true
        let fmt = ISO8601DateFormatter(); fmt.formatOptions = [.withFullDate]
        Task {
            do {
                try await state.completeTodo(id: todo.id, result: result,
                                             resultDate: fmt.string(from: resultDate))
                dismiss()
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
