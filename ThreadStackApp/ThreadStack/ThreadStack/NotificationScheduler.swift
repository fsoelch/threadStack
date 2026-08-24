import UserNotifications

/// Plant/verwaltet lokale Systembenachrichtigungen für Todo-Fälligkeits-
/// Erinnerungen und zeitbasierte Themen-Snoozes. Rein geräteseitig — kein Server-Push, funktioniert aber
/// auch wenn die App im Hintergrund ist, da `UNCalendarNotificationTrigger`
/// vom Betriebssystem selbst ausgelöst wird.
@MainActor
final class NotificationScheduler {
    static let shared = NotificationScheduler()
    private init() {}

    func requestPermissionIfNeeded() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error {
                    print("[NotificationScheduler] Berechtigungsanfrage fehlgeschlagen: \(error.localizedDescription)")
                } else if !granted {
                    print("[NotificationScheduler] Benachrichtigungen vom Nutzer abgelehnt.")
                }
            }
        }
    }

    /// Plant eine Benachrichtigung für `id` zur Zeit `fireAt`, oder storniert
    /// eine bestehende, falls `fireAt` nil bzw. in der Vergangenheit liegt.
    /// Aufruf ist idempotent (alter Request wird immer zuerst entfernt).
    /// `isPrivate`: bei true wird ein generischer, inhaltsloser Text angezeigt
    /// statt des Todo-/Themen-Titels (Vorschau auf Sperrbildschirm/geteiltem Gerät).
    /// `notificationTitle`: Überschrift der Systembenachrichtigung — Aufrufer
    /// passen sie an den Auslöser an (z. B. Fälligkeits-Erinnerung vs. Snooze-Wecker).
    func reschedule(id: String, title: String, fireAt: Date?, isPrivate: Bool = false,
                     notificationTitle: String = "ThreadStack — aufgewacht") {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        guard let fireAt, fireAt > Date() else { return }
        requestPermissionIfNeeded()
        let content = UNMutableNotificationContent()
        content.title = notificationTitle
        content.body = isPrivate ? "Ein privates Todo ist fällig" : title
        content.sound = .default
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { error in
            if let error { print("[NotificationScheduler] Einplanen fehlgeschlagen (\(id)): \(error.localizedDescription)") }
        }
    }

    func cancel(id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }

    /// Entfernt alle geplanten UND bereits zugestellten Benachrichtigungen —
    /// muss beim Logout aufgerufen werden, da sie Inhalte des vorherigen
    /// Nutzers tragen und diesen nicht überleben dürfen.
    func cancelAll() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }
}
