//
//  SidebarMoreGroupTests.swift
//  ThreadStackTests
//
//  Unit tests für die einklappbare "Mehr"-Gruppe (Wochen-Digest/Fortschritt/
//  Archiv) in SidebarView.swift — reine Entscheidungslogik, analog zum
//  Testmuster von ArchiveConflictTopicsTextTests in ArchiveTests.swift.
//

import Testing
@testable import ThreadStack

struct IsMoreGroupActiveTests {

    @Test func digestMomentumAndArchiveActivateTheGroup() {
        #expect(ThreadStack.isMoreGroupActive(.digest) == true)
        #expect(ThreadStack.isMoreGroupActive(.momentum) == true)
        #expect(ThreadStack.isMoreGroupActive(.archive) == true)
    }

    @Test func otherSidebarItemsDoNotActivateTheGroup() {
        #expect(ThreadStack.isMoreGroupActive(.meetings) == false)
        #expect(ThreadStack.isMoreGroupActive(.todos) == false)
        #expect(ThreadStack.isMoreGroupActive(.themes) == false)
        #expect(ThreadStack.isMoreGroupActive(.knowledge) == false)
        #expect(ThreadStack.isMoreGroupActive(.contacts) == false)
        #expect(ThreadStack.isMoreGroupActive(.graph) == false)
    }
}

struct MoreGroupHeaderTextTests {

    @Test func collapsedWithoutStreakShowsPlainLabel() {
        #expect(ThreadStack.moreGroupHeaderText(expanded: false, momentumStreakBadge: nil) == "Mehr")
    }

    @Test func collapsedWithStreakAppendsBadgeToLabel() {
        #expect(ThreadStack.moreGroupHeaderText(expanded: false, momentumStreakBadge: "🔥5") == "Mehr – 🔥5")
    }

    @Test func expandedNeverShowsTheAggregatedBadgeEvenWithStreak() {
        #expect(ThreadStack.moreGroupHeaderText(expanded: true, momentumStreakBadge: "🔥5") == "Mehr")
    }

    @Test func expandedWithoutStreakShowsPlainLabel() {
        #expect(ThreadStack.moreGroupHeaderText(expanded: true, momentumStreakBadge: nil) == "Mehr")
    }
}
