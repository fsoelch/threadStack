import Testing
import Foundation
@testable import ThreadStack

//  Paket P3, S-11: ConnectivityMonitor (Test-Seam ConnectivityPathSource).

@MainActor
final class FakePathSource {
    var onUpdate: ((Bool) -> Void)?
    var startCount = 0
    var stopCount = 0
    var source: ConnectivityPathSource {
        ConnectivityPathSource(start: { [self] cb in startCount += 1; onUpdate = cb },
                               stop: { [self] in stopCount += 1; onUpdate = nil })
    }
}

@MainActor @Suite(.serialized)
struct ConnectivityMonitorTests {
    @Test func startsSatisfiedAndReportsChanges() {
        let fake = FakePathSource()
        let m = ConnectivityMonitor(pathSource: fake.source)
        var events: [Bool] = []
        m.onPathChange = { events.append($0) }
        #expect(m.isPathSatisfied)
        m.start()
        #expect(fake.startCount == 1)
        fake.onUpdate?(false)
        #expect(!m.isPathSatisfied)
        fake.onUpdate?(true)
        #expect(m.isPathSatisfied)
        #expect(events == [false, true])
    }

    @Test func firstUpdateAfterStartIsAlwaysReportedEvenWhenUnchanged() {
        let fake = FakePathSource()
        let m = ConnectivityMonitor(pathSource: fake.source)
        var events: [Bool] = []
        m.onPathChange = { events.append($0) }
        m.start()
        fake.onUpdate?(true)    // gleich dem Startwert: trotzdem Ausloeser fuer eine Probe
        fake.onUpdate?(true)    // Wiederholung: kein weiteres Ereignis
        #expect(events == [true])
    }

    @Test func startIsIdempotent() {
        let fake = FakePathSource()
        let m = ConnectivityMonitor(pathSource: fake.source)
        m.start(); m.start()
        #expect(fake.startCount == 1)
    }

    @Test func stopStopsSourceAndIgnoresLateUpdates() {
        let fake = FakePathSource()
        let m = ConnectivityMonitor(pathSource: fake.source)
        var events: [Bool] = []
        m.onPathChange = { events.append($0) }
        m.start()
        let late = fake.onUpdate
        m.stop()
        #expect(fake.stopCount == 1)
        late?(false)            // verspaetete Meldung nach stop()
        #expect(events.isEmpty)
        #expect(m.isPathSatisfied)
        m.stop()                // zweites stop ist harmlos
        #expect(fake.stopCount == 1)
    }

    @Test func canBeRestartedAndReportsFirstUpdateAgain() {
        let fake = FakePathSource()
        let m = ConnectivityMonitor(pathSource: fake.source)
        var events: [Bool] = []
        m.onPathChange = { events.append($0) }
        m.start(); fake.onUpdate?(true)
        m.stop(); m.start()
        fake.onUpdate?(true)
        #expect(fake.startCount == 2)
        #expect(events == [true, true])
    }

    @Test func productionSourceCanBeCreatedStartedAndStopped() {
        // Smoke-Test der Network.framework-Quelle: darf weder abstuerzen noch haengen.
        let m = ConnectivityMonitor()
        m.start()
        m.stop()
    }
}
