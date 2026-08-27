//
//  TodoTopicSaveTargetTests.swift
//  ThreadStackTests
//
//  Security Review (Mittel, Fund 1) nach Merge der UX-Nachbesserung "Zielbild
//  und Fortschrittsverlauf inline" (`TodoFormView.swift`/`TopicFormView.swift`):
//  ohne Zustandsübergang create->edit hätte ein zweiter Klick auf "Speichern"
//  nach einem fehlgeschlagenen Composer-Commit (Todo/Topic bereits angelegt,
//  aber Sheet bleibt wegen `.failed` offen) erneut den Create-Zweig
//  durchlaufen und ein Duplikat angelegt.
//
//  Tests für die reinen, aus `save()` extrahierten Entscheidungsfunktionen
//  `TodoSaveTarget.resolve`/`TopicSaveTarget.resolve` (siehe
//  `TodoFormView.swift`/`TopicFormView.swift`) — bewusst ohne SwiftUI-
//  Kontext, analog zu `ProgressViewLogicTests.swift`.
//

import Testing
import Foundation
@testable import ThreadStack

struct TodoSaveTargetTests {
    @Test func createWhenNeitherExistingNorCreatedIdIsSet() {
        let target = TodoSaveTarget.resolve(existingTodoId: nil, createdId: nil)
        #expect(target == .create)
    }

    @Test func updatesExistingTodoWhenEditingAPreExistingTodo() {
        let target = TodoSaveTarget.resolve(existingTodoId: "todo-1", createdId: nil)
        #expect(target == .update(id: "todo-1"))
    }

    /// Kernfall des Fundes: erster Speicherversuch im Anlegen-Modus hat das
    /// Todo bereits angelegt (`createdId` gesetzt), nur der Composer-Commit
    /// ist fehlgeschlagen — ein zweiter Versuch MUSS ein Update sein.
    @Test func updatesPreviouslyCreatedTodoOnRetryAfterFailedComposerCommit() {
        let target = TodoSaveTarget.resolve(existingTodoId: nil, createdId: "todo-just-created")
        #expect(target == .update(id: "todo-just-created"))
    }

    /// Falls beide gesetzt wären (sollte in der Praxis nicht vorkommen, da
    /// `todo` und `createdId` sich gegenseitig ausschliessen), hat das von
    /// aussen übergebene, bestehende Todo Vorrang.
    @Test func existingTodoIdTakesPrecedenceOverCreatedId() {
        let target = TodoSaveTarget.resolve(existingTodoId: "todo-existing", createdId: "todo-created")
        #expect(target == .update(id: "todo-existing"))
    }
}

struct TopicSaveTargetTests {
    @Test func createWhenNeitherExistingNorCreatedIdIsSet() {
        let target = TopicSaveTarget.resolve(existingTopicId: nil, createdId: nil)
        #expect(target == .create)
    }

    @Test func updatesExistingTopicWhenEditingAPreExistingTopic() {
        let target = TopicSaveTarget.resolve(existingTopicId: "topic-1", createdId: nil)
        #expect(target == .update(id: "topic-1"))
    }

    /// Kernfall des Fundes: erster Speicherversuch im Anlegen-Modus hat das
    /// Thema bereits angelegt (`createdId` gesetzt), nur der Composer-Commit
    /// ist fehlgeschlagen — ein zweiter Versuch MUSS ein Update sein.
    @Test func updatesPreviouslyCreatedTopicOnRetryAfterFailedComposerCommit() {
        let target = TopicSaveTarget.resolve(existingTopicId: nil, createdId: "topic-just-created")
        #expect(target == .update(id: "topic-just-created"))
    }

    @Test func existingTopicIdTakesPrecedenceOverCreatedId() {
        let target = TopicSaveTarget.resolve(existingTopicId: "topic-existing", createdId: "topic-created")
        #expect(target == .update(id: "topic-existing"))
    }
}

// MARK: - "Weitere Details"-Gruppierung (TodoFormDetailsSummary/TopicFormDetailsSummary)
//
// UX-Vorgabe: selten genutzte Felder (Fällig am + Erinnerung, Schlafen bis +
// Aufwach-Uhrzeit, Privat) werden in einer einklappbaren, beschrifteten
// Gruppe zusammengefasst, die bei bereits befüllten Werten automatisch
// aufgeklappt startet und den Zustand in der Überschrift zusammenfasst.

struct TodoFormDetailsSummaryTests {

    @Test func summaryIsNilWhenNothingSet() {
        let text = TodoFormDetailsSummary.summaryText(
            hasDueDate: false, dueDateText: "12.9.", hasSnooze: false, snoozeDateText: "1.1.", isPrivate: false
        )
        #expect(text == nil)
    }

    @Test func summaryListsOnlyActiveFields() {
        let text = TodoFormDetailsSummary.summaryText(
            hasDueDate: true, dueDateText: "12.9.", hasSnooze: false, snoozeDateText: "1.1.", isPrivate: true
        )
        #expect(text == "Fällig am 12.9., Privat")
    }

    @Test func summaryListsAllActiveFieldsInOrder() {
        let text = TodoFormDetailsSummary.summaryText(
            hasDueDate: true, dueDateText: "12.9.", hasSnooze: true, snoozeDateText: "1.1.", isPrivate: true
        )
        #expect(text == "Fällig am 12.9., Schlafen bis 1.1., Privat")
    }

    @Test func expandedByDefaultOnlyWhenAnyFieldSet() {
        #expect(TodoFormDetailsSummary.isExpandedByDefault(hasDueDate: false, hasSnooze: false, isPrivate: false) == false)
        #expect(TodoFormDetailsSummary.isExpandedByDefault(hasDueDate: true, hasSnooze: false, isPrivate: false) == true)
        #expect(TodoFormDetailsSummary.isExpandedByDefault(hasDueDate: false, hasSnooze: true, isPrivate: false) == true)
        #expect(TodoFormDetailsSummary.isExpandedByDefault(hasDueDate: false, hasSnooze: false, isPrivate: true) == true)
    }

    @Test func shortGermanDateFormatsDayDotMonthDot() {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 9; comps.day = 12
        let calendar = Calendar(identifier: .gregorian)
        let date = calendar.date(from: comps)!
        #expect(TodoFormDetailsSummary.shortGermanDate(date) == "12.9.")
    }
}

struct TopicFormDetailsSummaryTests {

    @Test func summaryIsNilWhenSnoozeNotSet() {
        #expect(TopicFormDetailsSummary.summaryText(hasSnooze: false, snoozeDateText: "1.1.") == nil)
    }

    @Test func summaryShowsSnoozeDateWhenSet() {
        #expect(TopicFormDetailsSummary.summaryText(hasSnooze: true, snoozeDateText: "1.1.") == "Schlafen bis 1.1.")
    }

    @Test func expandedByDefaultReflectsSnooze() {
        #expect(TopicFormDetailsSummary.isExpandedByDefault(hasSnooze: false) == false)
        #expect(TopicFormDetailsSummary.isExpandedByDefault(hasSnooze: true) == true)
    }
}
