//
//  ContactAPITests.swift
//  ThreadStackTests
//
//  Arbeitspaket A1 ("Erweiterung Ansprechpartner-Konzept"): Decodierung der
//  neuen Contact-Modelle (inkl. Altserver-Toleranz bei fehlenden neuen
//  Feldern), strukturiertes Fehler-Mapping (Konflikt-/In-Use-/Limit-Codes)
//  und reine Logikbausteine der neuen Views.
//
//  Netzwerk-Mocking: nutzt das bereits bestehende `KnowledgeMockURLProtocol`
//  (siehe `KnowledgeAPITests.swift`) wieder, statt eine zweite, ähnliche
//  URLProtocol-Stub-Klasse zu bauen (CLAUDE.md "Wiederverwendung vor
//  Neuentwicklung"). Da alle neuen Contact-Methoden direkt in `AppState.swift`
//  liegen (im Gegensatz zu `ProgressAPI.swift`), wird hier — wie in
//  `KnowledgeAPITests.swift` — `AppState(session:)` direkt verwendet, keine
//  zusätzliche Test-Seam nötig.
//
//  `makeMockAppState`/`mockJSONData`/`requestBodyJSON`/`HandlerCallBox`: siehe
//  `TestNetworkHelpers.swift` (Fund 3, Code-Review — zuvor hier UND in
//  `ContactAssignmentLoadTimingTests.swift` wörtlich dupliziert und bereits
//  auseinandergelaufen; jetzt EINE gemeinsame Implementierung).
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Model-Decoding (Altserver-Toleranz)

struct ContactModelDecodingTests {

    @Test func decodesContactWithoutNewFieldsForLegacyServer() throws {
        // Alte Server-Antwort ohne `categories`/`infoBlockCount`/`snippet` —
        // darf die Dekodierung NICHT zum Absturz bringen (alle drei Felder
        // sind additiv-optional, siehe `Models.swift`).
        let json = mockJSONData([
            "id": "c1", "name": "Anna Müller", "role": "PL", "email": "a@x.de",
            "description": "<p>alt</p>", "createdAt": "2026-01-01T00:00:00.000Z"
        ])
        let decoded = try JSONDecoder().decode(Contact.self, from: json)
        #expect(decoded.name == "Anna Müller")
        #expect(decoded.categories == nil)
        #expect(decoded.infoBlockCount == nil)
        #expect(decoded.snippet == nil)
    }

    @Test func decodesContactWithNewFields() throws {
        let json = mockJSONData([
            "id": "c1", "name": "Anna Müller", "role": "PL", "email": "a@x.de",
            "description": "", "createdAt": "2026-01-01T00:00:00.000Z",
            "categories": [["id": "cat1", "label": "Allgemein", "isDefault": true, "sortOrder": 0, "usageCount": 2]],
            "infoBlockCount": 2, "snippet": "<p>Kurzvorschau</p>"
        ])
        let decoded = try JSONDecoder().decode(Contact.self, from: json)
        #expect(decoded.categories?.count == 1)
        #expect(decoded.categories?.first?.label == "Allgemein")
        #expect(decoded.categories?.first?.isDefault == true)
        #expect(decoded.infoBlockCount == 2)
        #expect(decoded.snippet == "<p>Kurzvorschau</p>")
    }

    @Test func decodesContactInfoBlock() throws {
        let json = mockJSONData([
            "id": "b1", "contactId": "c1", "categoryId": "cat1", "categoryLabel": "Allgemein",
            "bodyHtml": "<p>x</p>", "excerpt": "x", "sortOrder": 0,
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
        ])
        let decoded = try JSONDecoder().decode(ContactInfoBlock.self, from: json)
        #expect(decoded.categoryLabel == "Allgemein")
        #expect(decoded.isLegacyDescription == nil)
    }

    @Test func decodesAssignedContact() throws {
        let json = mockJSONData([
            "contactId": "c1", "name": "Anna", "role": "PL", "email": "a@x.de",
            "assignedAt": "2026-01-01T00:00:00.000Z"
        ])
        let decoded = try JSONDecoder().decode(AssignedContact.self, from: json)
        #expect(decoded.id == "c1")
    }

    @Test func decodesAssignmentTargetWithOptionalMeetingFields() throws {
        let json = mockJSONData([
            "refType": "todo", "refId": "t1", "title": "Aufgabe", "done": false,
            "meetingId": NSNull(), "meetingTitle": NSNull(), "assignedAt": "2026-01-01T00:00:00.000Z"
        ])
        let decoded = try JSONDecoder().decode(AssignmentTarget.self, from: json)
        #expect(decoded.id == "todo:t1")
        #expect(decoded.meetingId == nil)
    }
}

// MARK: - Contact-Rubriken: Erfolgs-/Fehlerpfade

@MainActor
struct ContactCategoryAPITests {

    @Test func loadContactCategoriesPopulatesPublishedState() async {
        // Server-Vertrag (verifiziert per Lesen von `lib/contacts/routes.js`,
        // `GET /contact-categories`): Envelope `{categories:[...]}`, kein
        // flaches Array.
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/contact-categories")
            return (200, mockJSONData(["categories": [["id": "cat1", "label": "Allgemein"]]]))
        }
        await state.loadContactCategories()
        #expect(state.contactCategories.count == 1)
    }

    @Test func loadContactCategoriesToleratesLegacyServer404() async {
        let state = makeMockAppState { _ in (404, Data()) }
        await state.loadContactCategories()
        #expect(state.contactCategories.isEmpty)
    }

    @Test func createContactCategoryAppendsToPublishedState() async throws {
        // Server-Vertrag (`POST /contact-categories`, `routes.js`): Erfolgsfall
        // antwortet mit `{category:{...}}`, kein flaches Objekt.
        let state = makeMockAppState { req in
            #expect(req.httpMethod == "POST")
            return (200, mockJSONData(["category": ["id": "cat2", "label": "Interessen"]]))
        }
        let created = try await state.createContactCategory(label: "Interessen")
        #expect(created.label == "Interessen")
        #expect(state.contactCategories.contains(where: { $0.id == "cat2" }))
    }

    @Test func deleteContactCategoryThrowsInUseErrorWithUsageCountOn409() async throws {
        let state = makeMockAppState { _ in
            (409, mockJSONData(["error": "Rubrik wird verwendet", "code": "category_in_use", "usageCount": 3]))
        }
        do {
            try await state.deleteContactCategory(id: "cat1")
            Issue.record("expected ContactCategoryInUseError")
        } catch let e as ContactCategoryInUseError {
            #expect(e.usageCount == 3)
            #expect(e.errorDescription?.contains("3") == true)
        }
    }

    @Test func deleteContactCategorySucceedsAndRemovesFromState() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.wasCalled = true
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path == "/api/contact-categories/cat1")
            return (200, mockJSONData(["ok": true]))
        }
        // Vorher befüllen, damit die im Testnamen behauptete Entfernung aus
        // `state.contactCategories` tatsächlich beobachtbar ist (Fund 3,
        // Code-Review: der Test prüfte das zuvor gar nicht).
        state.contactCategories = [
            ContactCategory(id: "cat1", label: "Allgemein", isDefault: nil, sortOrder: 0, usageCount: nil)
        ]
        try await state.deleteContactCategory(id: "cat1")
        #expect(box.wasCalled == true)
        #expect(state.contactCategories.isEmpty)
    }
}

// MARK: - Kontakt-Detail (Envelope): reloadContact(id:)

@MainActor
struct ContactDetailReloadAPITests {

    /// Server-Vertrag (`GET /contacts/:contactId`, `routes.js`): Envelope
    /// `{contact, infoBlocks, categories, themeLinks}`, kein flacher `Contact`.
    /// Regressionstest für den Security-Review-Fund "iOS-Client spricht ein
    /// anderes API-Format" (2026-09-06) — vorher dekodierte `reloadContact`
    /// die Antwort direkt als `Contact` und scheiterte an jedem echten Server.
    @Test func reloadContactUnwrapsEnvelopeAndUpdatesPublishedState() async throws {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/contacts/c1")
            return (200, mockJSONData([
                "contact": [
                    "id": "c1", "name": "Anna Müller", "role": "PL", "email": "a@x.de",
                    "description": "", "createdAt": "2026-01-01T00:00:00.000Z"
                ],
                "infoBlocks": [],
                "categories": [],
                "themeLinks": []
            ]))
        }
        state.contacts = [
            Contact(id: "c1", name: "Alt", role: "", email: "", description: "", sortOrder: nil,
                    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: nil, categories: nil, infoBlockCount: nil, snippet: nil)
        ]
        let fresh = await state.reloadContact(id: "c1")
        #expect(fresh?.name == "Anna Müller")
        #expect(state.contacts.first(where: { $0.id == "c1" })?.name == "Anna Müller")
    }

    /// Ein unerwartet abweichender Body (z.B. ein flacher `Contact` ohne
    /// Envelope, wie es der frühere — fehlerhafte — Vertrag lieferte) darf
    /// nicht crashen, sondern `reloadContact` gibt `nil` zurück und
    /// `contacts` bleibt unverändert (kein stiller Datenverlust).
    @Test func reloadContactReturnsNilOnMalformedEnvelope() async throws {
        let state = makeMockAppState { _ in
            (200, mockJSONData([
                "id": "c1", "name": "Anna Müller", "role": "PL", "email": "a@x.de",
                "description": "", "createdAt": "2026-01-01T00:00:00.000Z"
            ]))
        }
        let original = Contact(id: "c1", name: "Alt", role: "", email: "", description: "", sortOrder: nil,
                                createdAt: "2026-01-01T00:00:00.000Z", updatedAt: nil, categories: nil, infoBlockCount: nil, snippet: nil)
        state.contacts = [original]
        let fresh = await state.reloadContact(id: "c1")
        #expect(fresh == nil)
        #expect(state.contacts == [original])
    }
}

// MARK: - Contact-Infoblöcke: Erfolgs-/Konfliktpfade

@MainActor
struct ContactInfoBlockAPITests {

    @Test func loadContactInfoBlocksBuildsExpectedPath() async throws {
        // Server-Vertrag (`GET .../info-blocks`, `routes.js`): Envelope
        // `{blocks:[...], categories:[...]}`, kein flaches Array.
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/contacts/c1/info-blocks")
            return (200, mockJSONData(["blocks": [], "categories": []]))
        }
        let blocks = try await state.loadContactInfoBlocks(contactId: "c1")
        #expect(blocks.isEmpty)
    }

    @Test func createContactInfoBlockSendsExpectedBody() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.wasCalled = true
            #expect(req.httpMethod == "POST")
            let body = requestBodyJSON(req)
            #expect(body["categoryId"] as? String == "cat1")
            // Server-Vertrag (`planBody()` in `routes.js`): das Feld heißt
            // `body`, NICHT `bodyHtml` — und der Server liest kein
            // `categoryLabel` aus dem Request (wird aus `categoryId`
            // serverseitig aufgelöst).
            #expect(body["body"] as? String == "<p>x</p>")
            #expect(body["categoryLabel"] == nil)
            #expect(body["bodyHtml"] == nil)
            // Erfolgsfall antwortet mit `{block:{...}}`, kein flaches Objekt.
            return (200, mockJSONData(["block": [
                "id": "b1", "contactId": "c1", "categoryId": "cat1", "categoryLabel": "Allgemein",
                "bodyHtml": "<p>x</p>", "excerpt": "x", "sortOrder": 0,
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
            ]]))
        }
        let block = try await state.createContactInfoBlock(contactId: "c1", categoryId: "cat1", categoryLabel: "Allgemein", bodyHtml: "<p>x</p>")
        #expect(block.id == "b1")
        #expect(box.wasCalled == true)
    }

    @Test func updateContactInfoBlockThrowsConflictErrorWithCurrentBlockOn409() async throws {
        let currentBlockJSON: [String: Any] = [
            "id": "b1", "contactId": "c1", "categoryId": "cat1", "categoryLabel": "Allgemein",
            "bodyHtml": "<p>server-stand</p>", "excerpt": "server-stand", "sortOrder": 0,
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-02T00:00:00.000Z"
        ]
        let state = makeMockAppState { _ in
            (409, mockJSONData(["error": "Konflikt", "code": "block_conflict", "block": currentBlockJSON]))
        }
        do {
            _ = try await state.updateContactInfoBlock(
                contactId: "c1", blockId: "b1", categoryId: "cat1", categoryLabel: "Allgemein",
                bodyHtml: "<p>meine version</p>", expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
            )
            Issue.record("expected ContactInfoBlockConflictError")
        } catch let e as ContactInfoBlockConflictError {
            #expect(e.currentBlock.bodyHtml == "<p>server-stand</p>")
            #expect(e.currentBlock.updatedAt == "2026-01-02T00:00:00.000Z")
        }
    }

    @Test func updateContactInfoBlockSucceedsWithoutConflict() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.wasCalled = true
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/contacts/c1/info-blocks/b1")
            // `expectedUpdatedAt` ist der Wert, an dem das gesamte
            // 409-Konflikt-Handling hängt (Fund 3, Code-Review) — muss also
            // nachweislich im Request landen, nicht nur clientseitig geprüft
            // werden.
            let body = requestBodyJSON(req)
            #expect(body["expectedUpdatedAt"] as? String == "2026-01-01T00:00:00.000Z")
            #expect(body["categoryId"] as? String == "cat1")
            // Server-Vertrag: Feld heißt `body`, nicht `bodyHtml`.
            #expect(body["body"] as? String == "<p>neu</p>")
            #expect(body["bodyHtml"] == nil)
            // Erfolgsfall antwortet mit `{block:{...}}`, kein flaches Objekt.
            return (200, mockJSONData(["block": [
                "id": "b1", "contactId": "c1", "categoryId": "cat1", "categoryLabel": "Allgemein",
                "bodyHtml": "<p>neu</p>", "excerpt": "neu", "sortOrder": 0,
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-03T00:00:00.000Z"
            ]]))
        }
        let block = try await state.updateContactInfoBlock(
            contactId: "c1", blockId: "b1", categoryId: "cat1", categoryLabel: "Allgemein",
            bodyHtml: "<p>neu</p>", expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
        )
        #expect(block.bodyHtml == "<p>neu</p>")
        #expect(box.wasCalled == true)
    }

    @Test func reorderContactInfoBlocksSendsExpectedPathAndBody() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.wasCalled = true
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/contacts/c1/info-blocks/reorder")
            let body = requestBodyJSON(req)
            #expect(body["categoryId"] as? String == "cat1")
            #expect(body["orderedIds"] as? [String] == ["b2", "b1"])
            // Server-Vertrag (`PUT .../info-blocks/reorder`, `routes.js`):
            // Antwort ist `{blocks:[...]}` — wird von
            // `reorderContactInfoBlocks` aktuell nicht ausgewertet (nur der
            // Statuscode zählt), der Mock bildet trotzdem das reale Format ab.
            return (200, mockJSONData(["blocks": []]))
        }
        try await state.reorderContactInfoBlocks(contactId: "c1", categoryId: "cat1", orderedIds: ["b2", "b1"])
        #expect(box.wasCalled == true)
    }

    @Test func deleteContactInfoBlockSucceeds() async throws {
        let state = makeMockAppState { req in
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path == "/api/contacts/c1/info-blocks/b1")
            return (200, mockJSONData(["ok": true]))
        }
        try await state.deleteContactInfoBlock(contactId: "c1", blockId: "b1")
    }
}

// MARK: - Zuständigkeit (Assignments): Erfolgs-/Limit-/Offline-Pfade

@MainActor
struct ContactAssignmentAPITests {

    @Test func loadAssignmentsBuildsExpectedPath() async throws {
        // Server-Vertrag (`GET /assignments/:refType/:refId`,
        // `assignments/router.js`): Envelope `{contacts:[...], limit}`, kein
        // flaches Array.
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/assignments/todo/t1")
            return (200, mockJSONData(["contacts": [], "limit": 20]))
        }
        let list = try await state.loadAssignments(refType: "todo", refId: "t1")
        #expect(list.isEmpty)
    }

    @Test func setAssignmentsSendsContactIdsAndDecodesResult() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.wasCalled = true
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/assignments/todo/t1")
            let body = requestBodyJSON(req)
            #expect(body["contactIds"] as? [String] == ["c1"])
            // Server-Vertrag: `PUT` antwortet mit `{contacts:[...]}` (ohne
            // `limit`), ebenfalls kein flaches Array.
            return (200, mockJSONData([
                "contacts": [["contactId": "c1", "name": "Anna", "role": "", "email": "", "assignedAt": "2026-01-01T00:00:00.000Z"]]
            ]))
        }
        let result = try await state.setAssignments(refType: "todo", refId: "t1", contactIds: ["c1"])
        #expect(result.count == 1)
        #expect(box.wasCalled == true)
    }

    @Test func setAssignmentsThrowsLimitErrorOn409() async throws {
        let state = makeMockAppState { _ in
            (409, mockJSONData(["error": "Limit erreicht", "code": "assignment_limit_reached"]))
        }
        do {
            _ = try await state.setAssignments(refType: "todo", refId: "t1", contactIds: Array(repeating: "c", count: 21))
            Issue.record("expected ContactAssignmentLimitError")
        } catch is ContactAssignmentLimitError {
            // erwartet
        }
    }

    @Test func loadContactAssignmentsIncludesQueryParams() async throws {
        // Server-Vertrag (`GET /contacts/:contactId/assignments`,
        // `assignments/router.js`): Envelope `{items:[...], page:{...},
        // counts:{...}}`, kein flaches Array.
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/contacts/c1/assignments")
            #expect(req.url?.query?.contains("limit=20") == true)
            #expect(req.url?.query?.contains("status=open") == true)
            return (200, mockJSONData([
                "items": [],
                "page": ["limit": 20, "offset": 0, "total": 0, "hasMore": false],
                "counts": ["open": 0, "done": 0]
            ]))
        }
        let list = try await state.loadContactAssignments(contactId: "c1", status: "open")
        #expect(list.isEmpty)
    }

    @Test func removeContactAssignmentUsesExpectedPath() async throws {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/contacts/c1/assignments/topic/t9")
            return (200, mockJSONData(["ok": true]))
        }
        try await state.removeContactAssignment(contactId: "c1", refType: "topic", refId: "t9")
    }

    /// Reiner Transportfehler (kein Handler registriert -> `URLError`) wird
    /// von `isTransportFailure` (siehe `Extensions.swift`) erkannt — das ist
    /// die Grundlage für die Story-14-Offline-Meldungen in allen neuen
    /// Contact-Sheets.
    @Test func transportFailureIsRecognizedByIsTransportFailure() async {
        let host = "contact-mock-unregistered-\(UUID().uuidString).invalid"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [KnowledgeMockURLProtocol.self]
        let state = AppState(session: URLSession(configuration: cfg))
        state.serverURL = "https://\(host)"
        do {
            _ = try await state.loadAssignments(refType: "todo", refId: "t1")
            Issue.record("expected a thrown error")
        } catch {
            #expect(isTransportFailure(error) == true)
        }
    }

    @Test func serverErrorIsNotClassifiedAsTransportFailure() async {
        let state = makeMockAppState { _ in (500, mockJSONData(["error": "Interner Fehler"])) }
        do {
            _ = try await state.loadAssignments(refType: "todo", refId: "t1")
            Issue.record("expected a thrown error")
        } catch {
            #expect(isTransportFailure(error) == false)
        }
    }
}

// MARK: - Reine Logik: ContactDetailView (Gruppierung/Privates)

struct ContactDetailLogicTests {

    @Test func groupsBlocksByServerProvidedCategoryOrder() {
        let cats = [
            ContactCategory(id: "cat2", label: "B", isDefault: nil, sortOrder: 1, usageCount: nil),
            ContactCategory(id: "cat1", label: "A", isDefault: nil, sortOrder: 0, usageCount: nil)
        ]
        let blocks = [
            ContactInfoBlock(id: "b1", contactId: "c1", categoryId: "cat1", categoryLabel: "A", bodyHtml: "", excerpt: "", sortOrder: 0, isLegacyDescription: nil, createdAt: "", updatedAt: ""),
            ContactInfoBlock(id: "b2", contactId: "c1", categoryId: "cat2", categoryLabel: "B", bodyHtml: "", excerpt: "", sortOrder: 0, isLegacyDescription: nil, createdAt: "", updatedAt: "")
        ]
        let grouped = ContactDetailLogic.grouped(infoBlocks: blocks, categories: cats)
        // Reihenfolge folgt `cats` (Server-Reihenfolge: cat2 zuerst), NICHT
        // alphabetisch/eigen-sortiert.
        #expect(grouped.map(\.category.id) == ["cat2", "cat1"])
    }

    @Test func skipsCategoriesWithoutVisibleBlocks() {
        let cats = [ContactCategory(id: "cat1", label: "A", isDefault: nil, sortOrder: 0, usageCount: nil)]
        let grouped = ContactDetailLogic.grouped(infoBlocks: [], categories: cats)
        #expect(grouped.isEmpty)
    }

    @Test func ungroupedFindsBlocksWithUnknownCategory() {
        let cats = [ContactCategory(id: "cat1", label: "A", isDefault: nil, sortOrder: 0, usageCount: nil)]
        let blocks = [
            ContactInfoBlock(id: "b1", contactId: "c1", categoryId: "cat-unknown", categoryLabel: "?", bodyHtml: "", excerpt: "", sortOrder: 0, isLegacyDescription: nil, createdAt: "", updatedAt: "")
        ]
        let ungrouped = ContactDetailLogic.ungrouped(infoBlocks: blocks, categories: cats)
        #expect(ungrouped.count == 1)
    }

    @Test func detectsPrivateCategoryCaseAndWhitespaceInsensitive() {
        #expect(ContactDetailLogic.isPrivateCategory("Privates") == true)
        #expect(ContactDetailLogic.isPrivateCategory("  privates  ") == true)
        #expect(ContactDetailLogic.isPrivateCategory("Allgemein") == false)
    }

    private func makeBlock(_ id: String, _ categoryId: String) -> ContactInfoBlock {
        ContactInfoBlock(id: id, contactId: "c1", categoryId: categoryId, categoryLabel: categoryId,
                          bodyHtml: "", excerpt: "", sortOrder: 0, isLegacyDescription: nil, createdAt: "", updatedAt: "")
    }

    @Test func applyReorderReordersOnlyTheAffectedCategory() {
        let blocks = [makeBlock("b1", "cat1"), makeBlock("b2", "cat1"), makeBlock("b3", "cat1")]
        let reordered = ContactDetailLogic.applyReorder(infoBlocks: blocks, categoryId: "cat1", orderedIds: ["b3", "b1", "b2"])
        #expect(reordered.map(\.id) == ["b3", "b1", "b2"])
    }

    /// Rubrik-Isolation: Blöcke ANDERER Rubriken bleiben an ihrer bisherigen
    /// Position, auch wenn sie zwischen den umsortierten Blöcken liegen.
    @Test func applyReorderKeepsOtherCategoriesUntouchedAndAtTheirPosition() {
        let blocks = [makeBlock("a1", "catA"), makeBlock("b1", "cat1"), makeBlock("a2", "catA"), makeBlock("b2", "cat1")]
        let reordered = ContactDetailLogic.applyReorder(infoBlocks: blocks, categoryId: "cat1", orderedIds: ["b2", "b1"])
        #expect(reordered.map(\.id) == ["a1", "b2", "a2", "b1"])
    }

    /// Längen-/Mengen-Mismatch (z.B. eine `orderedIds`-ID gehört nicht mehr
    /// zu dieser Rubrik, oder es fehlt eine) — defensiv: `infoBlocks` bleibt
    /// unverändert statt Blöcke stillschweigend zu verlieren/duplizieren.
    @Test func applyReorderReturnsUnchangedOnLengthMismatch() {
        let blocks = [makeBlock("b1", "cat1"), makeBlock("b2", "cat1")]
        let reordered = ContactDetailLogic.applyReorder(infoBlocks: blocks, categoryId: "cat1", orderedIds: ["b1"])
        #expect(reordered.map(\.id) == ["b1", "b2"])
    }

    @Test func applyReorderReturnsUnchangedOnUnknownIdInOrderedIds() {
        let blocks = [makeBlock("b1", "cat1"), makeBlock("b2", "cat1")]
        let reordered = ContactDetailLogic.applyReorder(infoBlocks: blocks, categoryId: "cat1", orderedIds: ["b1", "b-does-not-exist"])
        #expect(reordered.map(\.id) == ["b1", "b2"])
    }
}

// MARK: - Reine Logik: ContactAssignmentPickerSheet (Limit/Suche)

struct ContactAssignmentPickerLogicTests {

    private func makeContact(_ id: String, _ name: String, role: String = "") -> Contact {
        Contact(id: id, name: name, role: role, email: "", description: "", sortOrder: nil, createdAt: "", updatedAt: nil,
                categories: nil, infoBlockCount: nil, snippet: nil)
    }

    @Test func canSelectAllowsAlreadySelectedEvenAtLimit() {
        #expect(ContactAssignmentPickerLogic.canSelect(currentCount: 20, alreadySelected: true) == true)
    }

    @Test func canSelectBlocksNewSelectionAtLimit() {
        #expect(ContactAssignmentPickerLogic.canSelect(currentCount: 20, alreadySelected: false) == false)
    }

    @Test func canSelectAllowsNewSelectionBelowLimit() {
        #expect(ContactAssignmentPickerLogic.canSelect(currentCount: 19, alreadySelected: false) == true)
    }

    @Test func filterMatchesNameRoleOrEmailCaseInsensitive() {
        let contacts = [makeContact("1", "Anna Müller", role: "Projektleitung"), makeContact("2", "Ben Schmidt")]
        let byName = ContactAssignmentPickerLogic.filter(contacts, query: "anna")
        #expect(byName.map(\.id) == ["1"])
        let byRole = ContactAssignmentPickerLogic.filter(contacts, query: "projekt")
        #expect(byRole.map(\.id) == ["1"])
    }

    @Test func filterWithEmptyQueryReturnsAllUnchanged() {
        let contacts = [makeContact("1", "Anna"), makeContact("2", "Ben")]
        #expect(ContactAssignmentPickerLogic.filter(contacts, query: "  ").count == 2)
    }

    @Test func sortedOrdersCaseInsensitiveByName() {
        let contacts = [makeContact("1", "berta"), makeContact("2", "Anna")]
        #expect(ContactAssignmentPickerLogic.sorted(contacts).map(\.id) == ["2", "1"])
    }
}

// MARK: - Reine Logik: ContactInfoBlockSheet (Speichern-Button-Zustand)

struct ContactInfoBlockSaveLogicTests {

    @Test func disabledWhileLoading() {
        #expect(ContactInfoBlockSaveLogic.isSaveDisabled(categoryId: "cat1", loading: true) == true)
    }

    @Test func disabledWithoutCategorySelection() {
        #expect(ContactInfoBlockSaveLogic.isSaveDisabled(categoryId: "", loading: false) == true)
        #expect(ContactInfoBlockSaveLogic.isSaveDisabled(categoryId: "   ", loading: false) == true)
    }

    @Test func enabledWithCategoryAndNotLoading() {
        #expect(ContactInfoBlockSaveLogic.isSaveDisabled(categoryId: "cat1", loading: false) == false)
    }
}
