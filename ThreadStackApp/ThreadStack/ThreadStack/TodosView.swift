import SwiftUI

struct TodosView: View {
    @EnvironmentObject var state: AppState
    @State private var search = ""
    @State private var showNew = false
    @State private var error: String?

    private var filtered: [TodoItem] {
        guard !search.isEmpty else { return state.todos }
        return state.todos.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            $0.description.localizedCaseInsensitiveContains(search)
        }
    }

    private var openTodos:    [TodoItem] { filtered.filter { !$0.done && !$0.isSnoozed } }
    private var snoozedTodos: [TodoItem] { filtered.filter { !$0.done &&  $0.isSnoozed } }
    private var doneTodos:    [TodoItem] { filtered.filter {  $0.done }.sorted { $0.resultDate > $1.resultDate } }

    var body: some View {
        List {
            #if os(macOS)
            Section {
                TextField("Todos suchen", text: $search)
                    .textFieldStyle(.roundedBorder)
            }
            #endif

            if !openTodos.isEmpty {
                Section(header: sectionHeader("Offen", count: openTodos.count, color: .indigo)) {
                    ForEach(openTodos) { t in TodoRowView(todo: t) }
                        .onDelete { deleteTodo(from: openTodos, at: $0) }
                }
            }
            if !snoozedTodos.isEmpty {
                Section(header: sectionHeader("😴 Schlafend", count: snoozedTodos.count, color: .gray)) {
                    ForEach(snoozedTodos) { t in TodoRowView(todo: t) }
                }
            }
            if !doneTodos.isEmpty {
                Section(header: sectionHeader("Erledigt", count: doneTodos.count, color: .green)) {
                    ForEach(doneTodos) { t in TodoRowView(todo: t) }
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
        }
        #endif
        .sheet(isPresented: $showNew) { TodoFormView() }
        .alert("Fehler", isPresented: Binding(
            get: { error != nil }, set: { if !$0 { error = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func sectionHeader(_ label: String, count: Int, color: Color) -> some View {
        HStack {
            Text(label).foregroundStyle(color)
            Text("(\(count))").foregroundStyle(.secondary)
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
    @EnvironmentObject var state: AppState
    @State private var showEdit = false
    @State private var showComplete = false
    @State private var showMove = false
    @State private var showThemes = false
    @State private var showSnooze = false
    @State private var error: String?

    private var themeLinks: [(theme: Theme, link: ThemeLink)] { state.themeLinks(for: todo.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                statusIcon
                VStack(alignment: .leading, spacing: 3) {
                    Text(todo.title)
                        .scaledFont(.subheadline).fontWeight(.medium)
                        .strikethrough(todo.done)
                        .foregroundStyle(todo.done ? .secondary : .primary)

                    if !todo.description.isEmpty {
                        Text(stripHTML(todo.description))
                            .scaledFont(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }

                    if todo.isSnoozed, let wake = todo.snoozeWakeFormatted {
                        Label("Wacht auf am \(wake)", systemImage: "moon.zzz")
                            .scaledFont(.caption2).foregroundStyle(.secondary)
                    }

                    if !themeLinks.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 4) {
                                ForEach(themeLinks, id: \.link.id) { tl in themeChip(tl.theme.title) }
                            }
                        }
                    }
                }
                Spacer()
            }

            if todo.done && !todo.result.isEmpty {
                Text(stripHTML(todo.result))
                    .scaledFont(.caption).foregroundStyle(.green).padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .opacity(todo.isSnoozed ? 0.7 : 1)
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
                Label(todo.isSnoozed ? "Wecken" : "Schlafen", systemImage: "moon.zzz")
            }.tint(.indigo)
        }
        .contextMenu {
            Button { showEdit    = true } label: { Label("Bearbeiten", systemImage: "pencil") }
            Button { showThemes  = true } label: { Label("Topic zuweisen", systemImage: "tag") }
            Button { showMove    = true } label: { Label("In Meeting verschieben", systemImage: "arrow.right") }
            Divider()
            Button { showSnooze = true } label: {
                Label(todo.isSnoozed ? "Wecken" : "Schlafen legen", systemImage: "moon.zzz")
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
            Circle().stroke(Color.green, lineWidth: 1.5).frame(width: 16, height: 16)
        }
    }

    private func themeChip(_ title: String) -> some View {
        Text("🏷️ \(title)")
            .scaledFont(.caption2).fontWeight(.medium)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.purple.opacity(0.1))
            .foregroundStyle(.purple)
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
