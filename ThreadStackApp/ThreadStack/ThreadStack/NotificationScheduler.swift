import UserNotifications

/// Plant/verwaltet lokale Systembenachrichtigungen für zeitbasierte Snoozes
/// (Todos/Themen). Rein geräteseitig — kein Server-Push, funktioniert aber
/// auch wenn die App im Hintergrund ist, da `UNCalendarNotificationTrigger`
/// vom Betriebssystem selbst ausgelöst wird.
@MainActor
final class NotificationScheduler {
    static let shared = NotificationScheduler()
    private init() {}

    func requestPermissionIfNeeded() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
    }

    /// Plant eine Benachrichtigung für `id` zur Zeit `fireAt`, oder storniert
    /// eine bestehende, falls `fireAt` nil bzw. in der Vergangenheit liegt.
    /// Aufruf ist idempotent (alter Request wird immer zuerst entfernt).
    func reschedule(id: String, title: String, fireAt: Date?) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        guard let fireAt, fireAt > Date() else { return }
        requestPermissionIfNeeded()
        let content = UNMutableNotificationContent()
        content.title = "ThreadStack — aufgewacht"
        content.body = title
        content.sound = .default
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    func cancel(id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }
}
