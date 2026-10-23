import SwiftUI
import UserNotifications

@main
struct NabaoApp: App {
    @UIApplicationDelegateAdaptor(RemoteNotificationsDelegate.self) private var appDelegate
    @StateObject private var store = PlanStore()
    @StateObject private var notifications = NotificationRouter()
    @StateObject private var remotePush = RemotePushStore()
    var body: some Scene {
        WindowGroup {
            TabView(selection: $notifications.selectedTab) {
                PlansView()
                    .tabItem { Label("我的定投", systemImage: "list.bullet.rectangle") }
                    .tag(0)
                QuotasView(refreshID: notifications.quotaRefreshID)
                    .tabItem { Label("额度", systemImage: "chart.bar.xaxis") }
                    .tag(1)
                SettingsView()
                    .tabItem { Label("设置", systemImage: "slider.horizontal.3") }
                    .tag(2)
            }
            .tint(.indigo)
            .environmentObject(store)
            .environmentObject(remotePush)
            .task {
                appDelegate.pushStore = remotePush
                await remotePush.resume(baseURL: UserDefaults.standard.string(forKey: "backendBaseURL") ?? "http://127.0.0.1:8080")
            }
        }
    }
}

@MainActor
final class NotificationRouter: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var selectedTab = 0
    @Published var quotaRefreshID = UUID()

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           response.notification.request.content.userInfo["screen"] as? String == "quotas" {
            Task { @MainActor in
                self.quotaRefreshID = UUID()
                self.selectedTab = 1
            }
        }
        completionHandler()
    }
}
