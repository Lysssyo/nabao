import Foundation
import Combine
import UserNotifications

@MainActor
final class LocalReminderStore: ObservableObject {
    @Published private(set) var notificationStatus = "尚未读取"
    @Published private(set) var scheduled = false
    @Published var reminderTime = Calendar.current.date(from: DateComponents(hour: 20, minute: 30)) ?? Date()
    @Published var message: String?
    private let reminderID = "nabao.daily-check"

    func disableDaily() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [reminderID])
        scheduled = false
    }

    private func requestPermission() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        let allowed = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        await refreshStatus()
        if !allowed { message = "通知权限未开启，可在系统设置中允许 nabao 发送通知。" }
        return allowed
    }

    func scheduleDaily() async {
        do {
            guard try await requestPermission() else { return }
            let content = UNMutableNotificationContent()
            content.title = "检查今天的定投额度"
            content.body = "打开 nabao 获取最新公开额度，核对本机记录的定投计划。"
            content.sound = .default
            content.userInfo = ["screen": "quotas"]
            let components = Calendar.current.dateComponents([.hour, .minute], from: reminderTime)
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(
                identifier: reminderID, content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
            ))
            scheduled = true
            message = "每日本地提醒已安排。"
        } catch { message = "安排提醒失败：\(error.localizedDescription)" }
    }

    func testNotification() async {
        do {
            guard try await requestPermission() else { return }
            let content = UNMutableNotificationContent()
            content.title = "nabao 测试提醒"
            content.body = "这是一条本地测试通知，不代表额度变化。"
            content.sound = .default
            content.userInfo = ["screen": "quotas"]
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(
                identifier: "nabao.local-test", content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
            ))
            message = "测试提醒将在 5 秒后送达，点击通知可打开额度页。"
        } catch { message = "安排提醒失败：\(error.localizedDescription)" }
    }

    func refreshStatus() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized: notificationStatus = "已允许"
        case .denied: notificationStatus = "未允许"
        case .notDetermined: notificationStatus = "尚未申请"
        case .provisional: notificationStatus = "临时授权"
        case .ephemeral: notificationStatus = "临时授权"
        @unknown default: notificationStatus = "待确认"
        }
        let pending = await center.pendingNotificationRequests()
        if let request = pending.first(where: { $0.identifier == reminderID }) {
            scheduled = true
            if let trigger = request.trigger as? UNCalendarNotificationTrigger,
               let date = Calendar.current.date(from: trigger.dateComponents) { reminderTime = date }
        } else { scheduled = false }
    }
}
