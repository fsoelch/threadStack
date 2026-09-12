//
//  MomentumAPITests.swift
//  ThreadStackTests
//
//  Arbeitspaket M5 (Sichtbarer Fortschritt - iOS): Decodierung der neuen
//  Momentum-Modelle, Netzwerkschicht (MomentumAPI.swift) sowie die
//  Toast-Warteschlange (AppState.toastQueue/showToast/dismissCurrentToast)
//  und die additive Erweiterung von completeTodo/completeTopic.
//
//  Netzwerk-Mocking: `makeMockAppState`/`mockJSONData`/`requestBodyJSON`
//  (siehe TestNetworkHelpers.swift) - keine zweite Mock-Infrastruktur.
//

import Testing
import Foundation
@testable import ThreadStack

// MARK: - Model-Decoding

struct MomentumModelDecodingTests {

    @Test func decodesOverviewWithDisabledStreakAndWeekAsNil() throws {
        let json = mockJSONData([
            "settings": ["completionToastEnabled": false, "streakEnabled": false, "weeklyReviewEnabled": false],
            "streak": NSNull(),
            "week": NSNull(),
        ])
        let decoded = try JSONDecoder().decode(MomentumOverview.self, from: json)
        #expect(decoded.settings.completionToastEnabled == false)
        #expect(decoded.streak == nil)
        #expect(decoded.week == nil)
    }

    @Test func decodesOverviewWithStreakAndWeekMilestones() throws {
        let json = mockJSONData([
            "settings": ["completionToastEnabled": true, "streakEnabled": true, "weeklyReviewEnabled": true],
            "streak": ["current": 4, "activeToday": true],
            "week": [
                "startDate": "2026-09-07", "endDate": "2026-09-13",
                "createdCount": 3, "completedCount": 2,
                "milestones": [["type": "topic", "id": "t1", "name": "Serverumzug"]],
            ],
        ])
        let decoded = try JSONDecoder().decode(MomentumOverview.self, from: json)
        #expect(decoded.streak?.current == 4)
        #expect(decoded.week?.milestones.first?.name == "Serverumzug")
    }

    @Test func decodesCompleteMutationResponseWithoutMomentumField() throws {
        // Alt-/Nicht-abgeschlossene Aufrufe (z.B. reines Titel-Update) liefern
        // KEIN `momentum`-Feld - darf nicht crashen.
        let json = mockJSONData(["ok": true])
        let decoded = try JSONDecoder().decode(CompleteMutationResponse.self, from: json)
        #expect(decoded.momentum == nil)
    }

    @Test func decodesCompleteMutationResponseWithMomentumField() throws {
        let json = mockJSONData([
            "ok": true,
            "momentum": ["weeklyCompletedCount": 5, "milestones": []],
        ])
        let decoded = try JSONDecoder().decode(CompleteMutationResponse.self, from: json)
        #expect(decoded.momentum?.weeklyCompletedCount == 5)
        #expect(decoded.momentum?.milestones.isEmpty == true)
    }
}

// MARK: - Netzwerkschicht (MomentumAPI.swift)

@MainActor
struct MomentumAPITests {

    @Test func momentumOverviewSendsUtcOffsetMinutesQueryParameter() async throws {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/momentum/overview")
            #expect(req.url?.query?.contains("utcOffsetMinutes=") == true)
            return (200, mockJSONData([
                "settings": ["completionToastEnabled": true, "streakEnabled": true, "weeklyReviewEnabled": true],
                "streak": NSNull(), "week": NSNull(),
            ]))
        }
        let overview = try await state.momentumOverview()
        #expect(overview.settings.streakEnabled == true)
    }

    @Test func momentumPauseDaysUnwrapsEnvelope() async throws {
        let state = makeMockAppState { req in
            #expect(req.url?.path == "/api/momentum/pause-days")
            return (200, mockJSONData(["pauseDays": ["2026-12-24"]]))
        }
        let days = try await state.momentumPauseDays()
        #expect(days == ["2026-12-24"])
    }

    @Test func momentumSaveSettingsSendsOnlyTheChangedField() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/momentum/settings")
            let body = requestBodyJSON(req)
            #expect(body["streakEnabled"] as? Bool == false)
            #expect(body.count == 1)
            return (200, mockJSONData(["completionToastEnabled": true, "streakEnabled": false, "weeklyReviewEnabled": true]))
        }
        let settings = try await state.momentumSaveSettings(["streakEnabled": false])
        #expect(settings.streakEnabled == false)
        #expect(box.wasCalled == true)
    }

    @Test func momentumAddPauseDaySendsDateInBodyAndOffsetInQuery() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path == "/api/momentum/pause-days")
            #expect(req.url?.query?.contains("utcOffsetMinutes=") == true)
            let body = requestBodyJSON(req)
            #expect(body["date"] as? String == "2026-12-24")
            return (201, mockJSONData(["date": "2026-12-24"]))
        }
        try await state.momentumAddPauseDay("2026-12-24")
        #expect(box.wasCalled == true)
    }

    @Test func momentumRemovePauseDayUsesExpectedPath() async throws {
        let state = makeMockAppState { req in
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path == "/api/momentum/pause-days/2026-12-24")
            return (200, mockJSONData(["ok": true, "removed": true]))
        }
        try await state.momentumRemovePauseDay("2026-12-24")
    }
}

// MARK: - Toast-Warteschlange

@MainActor
struct MomentumToastQueueTests {

    @Test func showToastAppendsToQueueAndCurrentToastIsTheFirst() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.showToast("Erledigt · diese Woche: 3")
        state.showToast("🎉 Meilenstein", emphasized: true)
        #expect(state.toastQueue.count == 2)
        #expect(state.currentToast?.text == "Erledigt · diese Woche: 3")
    }

    @Test func dismissCurrentToastAdvancesToNextEntry() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.showToast("A")
        state.showToast("B")
        let firstId = state.currentToast!.id
        state.dismissCurrentToast(id: firstId)
        #expect(state.currentToast?.text == "B")
    }

    @Test func dismissCurrentToastIgnoresStaleIdAfterAlreadyAdvanced() {
        // Ein verspäteter Auto-Dismiss-Timer für einen bereits entfernten
        // Toast darf NICHT versehentlich den inzwischen nachgerückten,
        // ANDEREN Toast wegwischen.
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.showToast("A")
        state.showToast("B")
        let staleId = state.currentToast!.id
        state.dismissCurrentToast(id: staleId) // A entfernt, B ist jetzt vorn
        state.dismissCurrentToast(id: staleId) // veraltete ID, darf B nicht entfernen
        #expect(state.currentToast?.text == "B")
    }

    @Test func presentMomentumToastsWithoutMilestonesShowsWeeklyCounterMessage() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.presentMomentumToasts(MomentumCompletionResult(weeklyCompletedCount: 7, milestones: []))
        #expect(state.toastQueue.count == 1)
        #expect(state.currentToast?.text.contains("7") == true)
        #expect(state.currentToast?.emphasized == false)
    }

    @Test func presentMomentumToastsWithMilestonesQueuesOneToastPerMilestone() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.presentMomentumToasts(MomentumCompletionResult(weeklyCompletedCount: 2, milestones: [
            MomentumMilestone(type: "topic", id: "t1", name: "Serverumzug"),
            MomentumMilestone(type: "contact", id: "c1", name: "Frau Meyer"),
        ]))
        #expect(state.toastQueue.count == 2)
        #expect(state.toastQueue[0].text.contains("Serverumzug") == true)
        #expect(state.toastQueue[0].text.contains("komplett abgeschlossen") == true)
        #expect(state.toastQueue[1].text.contains("Frau Meyer") == true)
        #expect(state.toastQueue.allSatisfy { $0.emphasized })
    }

    @Test func presentMomentumToastsWithNilResultDoesNothing() {
        let state = AppState(session: URLSession(configuration: .ephemeral))
        state.presentMomentumToasts(nil)
        #expect(state.toastQueue.isEmpty)
    }
}

// MARK: - completeTodo/completeTopic (additive utcOffsetMinutes + Toast-Anbindung)

@MainActor
struct MomentumCompletionWiringTests {

    @Test func completeTodoSendsUtcOffsetMinutesAndQueuesToastFromResponse() async throws {
        let box = HandlerCallBox()
        let state = makeMockAppState { req in
            box.record(req)
            #expect(req.httpMethod == "PUT")
            #expect(req.url?.path == "/api/todos/t1")
            let body = requestBodyJSON(req)
            #expect(body["done"] as? Bool == true)
            #expect(body["utcOffsetMinutes"] != nil)
            return (200, mockJSONData([
                "ok": true,
                "momentum": ["weeklyCompletedCount": 1, "milestones": []],
            ]))
        }
        state.todos = [try JSONDecoder().decode(TodoItem.self, from: mockJSONData([
            "id": "t1", "title": "A", "description": "", "done": false, "isPrivate": false,
            "result": "", "resultDate": "", "createdAt": "2026-09-01T00:00:00.000Z",
        ]))]
        try await state.completeTodo(id: "t1", result: "fertig", resultDate: "2026-09-11")
        #expect(box.wasCalled == true)
        #expect(state.todos.first?.done == true)
        #expect(state.currentToast?.text.contains("diese Woche: 1") == true)
    }

    @Test func completeTodoWithoutMomentumFieldInResponseDoesNotQueueAToast() async throws {
        // Server ohne dieses Feature (oder Fixture ohne `momentum`) darf
        // keinen Absturz UND keinen Toast auslösen.
        let state = makeMockAppState { _ in (200, mockJSONData(["ok": true])) }
        state.todos = [try JSONDecoder().decode(TodoItem.self, from: mockJSONData([
            "id": "t1", "title": "A", "description": "", "done": false, "isPrivate": false,
            "result": "", "resultDate": "", "createdAt": "2026-09-01T00:00:00.000Z",
        ]))]
        try await state.completeTodo(id: "t1", result: "", resultDate: "2026-09-11")
        #expect(state.currentToast == nil)
    }
}
