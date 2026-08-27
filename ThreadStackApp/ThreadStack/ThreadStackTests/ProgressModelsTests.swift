//
//  ProgressModelsTests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 ("App-Datenschicht Progress"): Decodierungstests für die
//  Progress-Modelle gegen die im Server-Vertrag (Paket S1) angegebenen
//  JSON-Beispiele, inkl. Randfälle (null-Felder, unbekannter `badgeEmphasis`).
//
//  Redesign-Update (Todo/Task-Übersicht, Arbeitspaket A1): Zielbild entfällt
//  vollständig aus der App-UI — `ProgressDetail.goal`/`goalUpdatedAt` sind
//  jetzt DEPRECATED und optional (Bugfix, siehe `ProgressModels.swift`).
//  `decodesDetailWithMissingDeprecatedGoalKeysEntirely` deckt zusätzlich den
//  Fall ab, dass der Server den Schlüssel künftig komplett weglässt (nicht
//  nur `null` liefert) — genau der im Auftrag beschriebene Bug.
//

import Testing
import Foundation
@testable import ThreadStack

struct ProgressSummaryDecodingTests {

    @Test func decodesFullSummary() throws {
        let json = """
        { "entryCount":3, "lastEntryAt":"2026-07-30T10:00:00.000Z", "stale":true, "staleDays":24,
          "dormant":true, "dormantSince":"2026-07-30T10:00:00.000Z", "orderKey":"2026-07-30T10:00:00.000Z",
          "undocumented":true, "nextStep":"Rückmeldung von X einholen",
          "badgeLabel":"3 Zwischenstände · vor 24 Tagen", "badgeEmphasis":"stale" }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(ProgressSummary.self, from: json)
        #expect(s.entryCount == 3)
        #expect(s.lastEntryAt == "2026-07-30T10:00:00.000Z")
        #expect(s.stale == true)
        #expect(s.staleDays == 24)
        #expect(s.dormant == true)
        #expect(s.undocumented == true)
        #expect(s.nextStep == "Rückmeldung von X einholen")
        #expect(s.badgeLabel == "3 Zwischenstände · vor 24 Tagen")
        #expect(s.badgeEmphasis == "stale")
        #expect(s.badgeEmphasisKind == .stale)
    }

    @Test func decodesSummaryWithNullOptionalFields() throws {
        let json = """
        { "entryCount":0, "lastEntryAt":null, "stale":false, "staleDays":null,
          "dormant":false, "dormantSince":null, "orderKey":null,
          "undocumented":false, "nextStep":null,
          "badgeLabel":null, "badgeEmphasis":"normal" }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(ProgressSummary.self, from: json)
        #expect(s.lastEntryAt == nil)
        #expect(s.staleDays == nil)
        #expect(s.dormantSince == nil)
        #expect(s.orderKey == nil)
        #expect(s.nextStep == nil)
        #expect(s.badgeLabel == nil)
        #expect(s.badgeEmphasisKind == .normal)
    }

    /// Robustheit: ein zukünftiger, unbekannter Server-Wert für `badgeEmphasis`
    /// darf die Decodierung des ganzen Objekts nicht zum Absturz bringen
    /// (siehe Vertrag: `badgeEmphasis` bewusst als `String` modelliert).
    @Test func unknownBadgeEmphasisDoesNotFailDecodingAndMapsToUnknownKind() throws {
        let json = """
        { "entryCount":1, "lastEntryAt":null, "stale":false, "staleDays":null,
          "dormant":false, "dormantSince":null, "orderKey":null,
          "undocumented":false, "nextStep":null,
          "badgeLabel":null, "badgeEmphasis":"future-value" }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(ProgressSummary.self, from: json)
        #expect(s.badgeEmphasis == "future-value")
        #expect(s.badgeEmphasisKind == .unknown)
    }
}

struct ProgressEntryDecodingTests {

    @Test func decodesEntryWithNullEditedAt() throws {
        let json = """
        { "id":"k3f", "refType":"todo", "refId":"a1", "kind":"note",
          "source":"manual", "bodyHtml":"<p>Text</p>", "excerpt":"Plaintext, max 280 Zeichen",
          "createdAt":"2026-08-23T09:12:00.000Z", "editedAt":null,
          "gapDaysBefore":12, "showDormancyMarker":true, "editable":true }
        """.data(using: .utf8)!
        let e = try JSONDecoder().decode(ProgressEntry.self, from: json)
        #expect(e.id == "k3f")
        #expect(e.refType == "todo")
        #expect(e.refId == "a1")
        #expect(e.kind == "note")
        #expect(e.source == "manual")
        #expect(e.bodyHtml == "<p>Text</p>")
        #expect(e.excerpt == "Plaintext, max 280 Zeichen")
        #expect(e.editedAt == nil)
        #expect(e.gapDaysBefore == 12)
        #expect(e.showDormancyMarker == true)
        #expect(e.editable == true)
    }

    @Test func decodesEntryWithNonNullEditedAt() throws {
        let json = """
        { "id":"e2", "refType":"topic", "refId":"t9", "kind":"result",
          "source":"ai", "bodyHtml":"<p>x</p>", "excerpt":"x",
          "createdAt":"2026-08-01T00:00:00.000Z", "editedAt":"2026-08-02T00:00:00.000Z",
          "gapDaysBefore":0, "showDormancyMarker":false, "editable":false }
        """.data(using: .utf8)!
        let e = try JSONDecoder().decode(ProgressEntry.self, from: json)
        #expect(e.editedAt == "2026-08-02T00:00:00.000Z")
        #expect(e.editable == false)
    }
}

struct ProgressDetailDecodingTests {

    @Test func decodesFullDetailWithEntriesAndPage() throws {
        let json = """
        { "ref": { "type":"todo","id":"a1","title":"Titel","done":false,"exists":true },
          "goal":"Ziel", "goalUpdatedAt":"2026-08-01T00:00:00.000Z",
          "nextStep":"Nächster Schritt", "nextStepUpdatedAt":"2026-08-02T00:00:00.000Z",
          "stats": { "entryCount":12,"firstEntryAt":"2026-01-01T00:00:00.000Z","lastEntryAt":"2026-08-01T00:00:00.000Z",
                     "lastActivityAt":"2026-08-01T00:00:00.000Z",
                     "dormant":true,"dormantDays":21,"stale":true,"staleDays":21 },
          "reentry": { "show":true, "dormantSince":"2026-08-02T00:00:00.000Z", "dormantLabel":"3 Wochen",
                       "empty":false, "ai": { "available":true, "frameId":"f7" } },
          "entries":[
            { "id":"k3f", "refType":"todo", "refId":"a1", "kind":"note",
              "source":"manual", "bodyHtml":"<p>x</p>", "excerpt":"x",
              "createdAt":"2026-08-23T09:12:00.000Z", "editedAt":null,
              "gapDaysBefore":12, "showDormancyMarker":true, "editable":true }
          ],
          "page": { "limit":20, "hasMore":true, "nextCursor":"2026-07-01T10:00:00.000Z|k3f" } }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(ProgressDetail.self, from: json)
        #expect(d.ref.type == "todo")
        #expect(d.ref.id == "a1")
        #expect(d.ref.exists == true)
        #expect(d.goal == "Ziel")
        #expect(d.nextStep == "Nächster Schritt")
        #expect(d.stats.entryCount == 12)
        #expect(d.stats.dormantDays == 21)
        #expect(d.reentry.show == true)
        #expect(d.reentry.dormantSince == "2026-08-02T00:00:00.000Z")
        #expect(d.reentry.ai.available == true)
        #expect(d.reentry.ai.frameId == "f7")
        #expect(d.entries.count == 1)
        #expect(d.entries[0].id == "k3f")
        #expect(d.page.limit == 20)
        #expect(d.page.hasMore == true)
        #expect(d.page.nextCursor == "2026-07-01T10:00:00.000Z|k3f")
    }

    /// Randfall: leere Historie, keine Wiedereinstiegs-KI verfügbar, keine
    /// weitere Seite — alle Optionals konsequent `null`/leer.
    @Test func decodesDetailWithEmptyHistoryAndNoAI() throws {
        let json = """
        { "ref": { "type":"topic","id":"t1","title":"T","done":false,"exists":true },
          "goal":"", "goalUpdatedAt":null,
          "nextStep":"", "nextStepUpdatedAt":null,
          "stats": { "entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                     "dormant":false,"dormantDays":null,"stale":false,"staleDays":null },
          "reentry": { "show":false, "dormantSince":null, "dormantLabel":null,
                       "empty":true, "ai": { "available":false, "frameId":null } },
          "entries":[],
          "page": { "limit":20, "hasMore":false, "nextCursor":null } }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(ProgressDetail.self, from: json)
        #expect(d.goalUpdatedAt == nil)
        #expect(d.stats.dormantDays == nil)
        #expect(d.reentry.show == false)
        #expect(d.reentry.dormantSince == nil)
        #expect(d.reentry.ai.available == false)
        #expect(d.reentry.ai.frameId == nil)
        #expect(d.entries.isEmpty)
        #expect(d.page.hasMore == false)
        #expect(d.page.nextCursor == nil)
    }

    /// Bugfix-Regressionstest (Auftrag: "aktuelle Bug ... goal ist heute
    /// nicht-optional String"): der Server könnte die DEPRECATED-Schlüssel
    /// `goal`/`goalUpdatedAt` künftig komplett weglassen statt nur `null` zu
    /// liefern — beides muss die Dekodierung des gesamten `ProgressDetail`
    /// unverändert erfolgreich durchlaufen lassen.
    @Test func decodesDetailWithMissingDeprecatedGoalKeysEntirely() throws {
        let json = """
        { "ref": { "type":"todo","id":"a1","title":"Titel","done":false,"exists":true },
          "nextStep":"Nächster Schritt", "nextStepUpdatedAt":null,
          "stats": { "entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                     "dormant":false,"dormantDays":null,"stale":false,"staleDays":null },
          "reentry": { "show":false, "dormantSince":null, "dormantLabel":null,
                       "empty":true, "ai": { "available":false, "frameId":null } },
          "entries":[],
          "page": { "limit":20, "hasMore":false, "nextCursor":null } }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(ProgressDetail.self, from: json)
        #expect(d.goal == nil)
        #expect(d.goalUpdatedAt == nil)
        #expect(d.nextStep == "Nächster Schritt")
    }

    /// `exists:false` (Ref serverseitig gelöscht, Detail aber noch abrufbar) —
    /// muss decodierbar bleiben, UI-Entscheidung liegt bei A2/A3.
    @Test func decodesRefWithExistsFalse() throws {
        let json = """
        { "ref": { "type":"todo","id":"gone","title":"Weg","done":true,"exists":false },
          "goal":"", "goalUpdatedAt":null, "nextStep":"", "nextStepUpdatedAt":null,
          "stats": { "entryCount":0,"firstEntryAt":null,"lastEntryAt":null,"lastActivityAt":null,
                     "dormant":false,"dormantDays":null,"stale":false,"staleDays":null },
          "reentry": { "show":false, "dormantSince":null, "dormantLabel":null,
                       "empty":true, "ai": { "available":false, "frameId":null } },
          "entries":[], "page": { "limit":20, "hasMore":false, "nextCursor":null } }
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(ProgressDetail.self, from: json)
        #expect(d.ref.exists == false)
        #expect(d.ref.done == true)
    }
}

struct ProgressEntriesPageDecodingTests {

    @Test func decodesEntriesPage() throws {
        let json = """
        { "entries": [], "page": { "limit":20, "hasMore":false, "nextCursor":null } }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(ProgressEntriesPage.self, from: json)
        #expect(p.entries.isEmpty)
        #expect(p.page.hasMore == false)
    }
}

struct ProgressMetaDecodingTests {

    @Test func decodesPartialMetaWithOnlyGoal() throws {
        let json = """
        { "goal":"Neues Ziel", "goalUpdatedAt":"2026-08-01T00:00:00.000Z",
          "nextStep":null, "nextStepUpdatedAt":null }
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ProgressMeta.self, from: json)
        #expect(m.goal == "Neues Ziel")
        #expect(m.nextStep == nil)
    }
}
