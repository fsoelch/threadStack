import SwiftUI

struct DigestView: View {
    @EnvironmentObject var state: AppState
    @State private var current: DigestResponse?
    @State private var archive: [DigestArchiveEntry] = []
    @State private var loading = false
    @State private var error: String?
    @State private var selected: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if loading && current == nil {
                    ProgressView("Lade …").frame(maxWidth: .infinity).padding(.top, 24)
                } else if let c = current?.content {
                    sections(c)
                } else if let error {
                    VStack(spacing: 8) {
                        Text(error).foregroundStyle(.red).font(.footnote)
                        Button("Erneut versuchen") { Task { await reload() } }
                    }.frame(maxWidth: .infinity).padding(.top, 24)
                } else {
                    empty
                }
            }
            .padding()
        }
        .navigationTitle("Wochen-Digest")
        .task { await reload() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("📊 Wochen-Digest").font(.title3).fontWeight(.semibold)
                Spacer()
            }
            HStack(spacing: 8) {
                Button { Task { await regenerate() } } label: {
                    Label("Neu erzeugen", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(loading)
                if archive.count > 1 {
                    Picker("Woche", selection: $selected) {
                        ForEach(archive) { a in
                            Text("\(a.week) — \(a.created_at.prefix(10))").tag(a.artifact_id)
                        }
                    }
                    .pickerStyle(.menu)
                    .onChange(of: selected) { _, new in
                        if let a = archive.first(where: { $0.artifact_id == new }) {
                            current = DigestResponse(artifact_id: a.artifact_id, content: a.content,
                                                     week: a.week, cached: true, cost_cents: 0)
                        }
                    }
                }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Text("📊").font(.largeTitle)
            Text("Noch kein Digest für diese Woche.").foregroundStyle(.secondary)
            Button { Task { await regenerate() } } label: { Label("Jetzt erzeugen", systemImage: "sparkles") }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(.top, 24)
    }

    @ViewBuilder private func sections(_ c: DigestContent) -> some View {
        if let w = current?.week {
            Text("Woche \(w)").font(.caption).foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("Zusammenfassung").font(.subheadline).fontWeight(.semibold)
            Text(c.summary).font(.callout)
        }
        .padding(12).background(DS.cardBg)
        .clipShape(RoundedRectangle(cornerRadius: 8))

        if let h = c.highlights, !h.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Highlights").font(.subheadline).fontWeight(.semibold)
                ForEach(Array(h.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(Color(hex: "#6366f1")).fontWeight(.bold)
                        Text(item).font(.callout)
                    }
                }
            }
            .padding(12).background(DS.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        if let f = c.focus_next, !f.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Fokus nächste Woche").font(.subheadline).fontWeight(.semibold)
                ForEach(Array(f.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("→").foregroundStyle(.green).fontWeight(.bold)
                        Text(item).font(.callout)
                    }
                }
            }
            .padding(12).background(DS.cardBg)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func reload() async {
        loading = true; error = nil
        do {
            current = try await state.aiDigestCurrent()
            archive = try await state.aiDigestArchive()
            selected = current?.artifact_id ?? ""
        } catch let e as APIAIError where e.budgetExceeded {
            error = "Monatsbudget erschöpft."
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func regenerate() async {
        loading = true; error = nil
        do {
            current = try await state.aiDigestRegenerate()
            archive = try await state.aiDigestArchive()
            selected = current?.artifact_id ?? ""
        } catch let e as APIAIError where e.needsConfirmation {
            do {
                current = try await state.aiDigestRegenerate(confirm: true)
                archive = try await state.aiDigestArchive()
                selected = current?.artifact_id ?? ""
            } catch { self.error = error.localizedDescription }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
