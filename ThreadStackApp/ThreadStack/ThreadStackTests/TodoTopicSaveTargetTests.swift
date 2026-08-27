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
