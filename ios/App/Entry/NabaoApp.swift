import SwiftUI
import NabaoCore

@main
struct NabaoApp: App {
    @UIApplicationDelegateAdaptor(RemoteNotificationsDelegate.self) private var appDelegate
    @StateObject private var store = PlanStore()
    @StateObject private var notifications = NotificationRouter()
    @StateObject private var remotePush = RemotePushStore()
    @StateObject private var tables = DailyTableStore(cacheURL: URL.applicationSupportDirectory
        .appending(path: "nabao", directoryHint: .isDirectory).appending(path: "daily-table.json"))
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    @AppStorage("backendSetupDismissed") private var setupDismissed = false
    @State private var showingSetup = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            TabView(selection: $notifications.selectedTab) {
                PlansView()
                    .tabItem { Label("我的定投", systemImage: "list.bullet.rectangle") }
                    .tag(0)
                QuotasView()
                    .tabItem { Label("额度", systemImage: "chart.bar.xaxis") }
                    .tag(1)
                SettingsView()
                    .tabItem { Label("设置", systemImage: "slider.horizontal.3") }
                    .tag(2)
            }
            .tint(.indigo)
            .environmentObject(store)
            .environmentObject(remotePush)
            .environmentObject(tables)
            .onAppear {
                if !setupDismissed && AppConfiguration.needsConnectionSetup(address: baseURL) { showingSetup = true }
            }
            .sheet(isPresented: $showingSetup, onDismiss: { setupDismissed = true }) {
                BackendSetupView {
                    setupDismissed = true
                    showingSetup = false
                }
                .environmentObject(remotePush)
            }
            .task(id: "\(baseURL)|\(notifications.quotaRefreshID)") {
                if !baseURL.isEmpty { await tables.load(baseURL: baseURL) }
            }
            .onChange(of: baseURL) { _, value in tables.configure(baseURL: value) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && !tables.loading && !baseURL.isEmpty {
                    Task { await tables.load(baseURL: baseURL) }
                }
            }
            .task {
                appDelegate.pushStore = remotePush
                if !baseURL.isEmpty { await remotePush.resume(baseURL: baseURL) }
            }
        }
    }
}
