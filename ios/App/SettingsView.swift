import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var remotePush: RemotePushStore
    @AppStorage("backendBaseURL") private var baseURL = "http://127.0.0.1:8080"
    @State private var draftURL = ""
    @State private var notificationStatus = "尚未读取"
    @State private var message: String?
    @State private var scheduled = false
    @State private var reminderTime = Calendar.current.date(from: DateComponents(hour: 20, minute: 30)) ?? Date()
    private let reminderID = "nabao.daily-check"

    var body: some View {
        NavigationStack {
            Form {
                Section("额度变化通知") {
                    Toggle("接收公开额度更新", isOn: Binding(
                        get: { remotePush.isEnabled },
                        set: { enabled in
                            Task {
                                if enabled { await remotePush.enable(baseURL: baseURL) }
                                else { await remotePush.disable() }
                            }
                        }
                    ))
                    .disabled(remotePush.isBusy || (!remotePush.canEnable && !remotePush.isEnabled))
                    Text(remotePush.statusText).font(.footnote).foregroundStyle(.secondary)
                    if remotePush.isBusy { ProgressView("正在处理通知登记") }
                    if remotePush.canRetry {
                        Button("重试通知登记") { Task { await remotePush.enable(baseURL: baseURL) } }
                            .disabled(remotePush.isBusy || !remotePush.canEnable)
                    }
                    if remotePush.needsCleanup && !remotePush.isEnabled {
                        Button("关闭待确认订阅", role: .destructive) { Task { await remotePush.disable() } }
                            .disabled(remotePush.isBusy)
                    }
                    Button("重新检查通知服务") { Task { await remotePush.refresh(baseURL: baseURL) } }
                        .disabled(remotePush.isBusy)
                    Text("仅发送匿名设备登记信息，接收公开额度变化的通用提醒。点击后读取最新额度并在本机核对计划；个人截图、计划和金额不会上传。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("每日检查提醒") {
                    LabeledContent("系统通知权限", value: notificationStatus)
                    DatePicker("每日提醒时间", selection: $reminderTime, displayedComponents: .hourAndMinute)
                    Button(scheduled ? "更新每日提醒" : "开启每日检查提醒") {
                        Task { await scheduleDaily() }
                    }
                    if scheduled {
                        Button("关闭每日提醒", role: .destructive) {
                            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [reminderID])
                            scheduled = false
                        }
                    }
                    Button("发送 5 秒后测试提醒") { Task { await testNotification() } }
                    Text("按固定时间提醒你检查，不会自动获知新额度。打开 App 后可刷新查看。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("开发后端地址") {
                    TextField("http://127.0.0.1:8080", text: $draftURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("保存地址") {
                        let value = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            do {
                                let selected = try await remotePush.changeBackend(from: baseURL, to: value)
                                baseURL = selected
                                draftURL = selected
                                message = "后端地址已保存。额度变化通知可在新服务下单独开启。"
                            } catch { message = error.localizedDescription }
                        }
                    }
                    .disabled(remotePush.isBusy)
                    Text("模拟器使用 127.0.0.1。真机需使用 Mac 的局域网地址，并允许本地网络访问。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("切换地址前会先关闭旧后端通知订阅；关闭未确认时保留旧地址，便于重试。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("本地数据") {
                    Text("定投记录和图片指纹保存在当前设备。个人截图只在导入过程中读取，不上传到后端，也不另存原图。")
                    Text("当前不提供账号、跨设备同步和云端恢复。")
                        .foregroundStyle(.secondary)
                }
                Section("导入与渠道入口") {
                    Text("已支持支付宝投资计划与南方基金我的定投两种截图版式。")
                    Text("已支持的基金可打开支付宝基金详情，再通过“定投中 → 选择计划 → 管理”处理已有计划。其他基金或渠道可复制名称和代码，在对应 App 内查询。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("南方基金支持打开“我的定投”，再选择对应计划查看详情和管理入口。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("南方 I（021000）支持打开南方基金产品详情，核对直销额度及定投、购买条件。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
            .task {
                draftURL = baseURL
                await refreshStatus()
                await remotePush.refresh(baseURL: baseURL)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await refreshStatus(); await remotePush.refresh(baseURL: baseURL) }
                }
            }
            .alert("提示", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("知道了", role: .cancel) {}
            } message: { Text(message ?? "") }
        }
    }

    private func requestPermission() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        let allowed = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        await refreshStatus()
        if !allowed { message = "通知权限未开启，可在系统设置中允许 nabao 发送通知。" }
        return allowed
    }

    private func scheduleDaily() async {
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

    private func testNotification() async {
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

    private func refreshStatus() async {
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
