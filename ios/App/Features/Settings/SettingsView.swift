import SwiftUI

struct SettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var remotePush: RemotePushStore
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    @StateObject private var reminders = LocalReminderStore()
    @State private var isSavingAddress = false

    var body: some View {
        NavigationStack {
            Form {
                BackendConnectionSection(saving: $isSavingAddress)
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
                    else if remotePush.isCheckingService { ProgressView("正在检查通知服务") }
                    if remotePush.canRetry {
                        Button("重试通知登记") { Task { await remotePush.enable(baseURL: baseURL) } }
                            .disabled(remotePush.isBusy || !remotePush.canEnable)
                    }
                    if remotePush.needsCleanup && !remotePush.isEnabled {
                        Button("关闭待确认订阅", role: .destructive) { Task { await remotePush.disable() } }
                            .disabled(remotePush.isBusy)
                    }
                    Button("重新检查通知服务") { Task { if !baseURL.isEmpty { await remotePush.refresh(baseURL: baseURL) } } }
                        .disabled(remotePush.isBusy || baseURL.isEmpty)
                    Text("仅发送匿名设备登记信息，接收公开额度变化的通用提醒。点击后读取最新额度并在本机核对计划；个人截图、计划和金额不会上传。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("每日检查提醒") {
                    LabeledContent("系统通知权限", value: reminders.notificationStatus)
                    DatePicker("每日提醒时间", selection: $reminders.reminderTime, displayedComponents: .hourAndMinute)
                    Button(reminders.scheduled ? "更新每日提醒" : "开启每日检查提醒") {
                        Task { await reminders.scheduleDaily() }
                    }
                    if reminders.scheduled {
                        Button("关闭每日提醒", role: .destructive) {
                            reminders.disableDaily()
                        }
                    }
                    Button("发送 5 秒后测试提醒") { Task { await reminders.testNotification() } }
                    Text("按固定时间提醒你检查，不会自动获知新额度。打开 App 后可刷新查看。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("本地数据") {
                    NavigationLink {
                        PlanBackupView()
                    } label: {
                        Label("计划备份与恢复", systemImage: "externaldrive")
                    }
                    .accessibilityIdentifier("planBackupEntry")
                    Text("定投记录和图片指纹保存在当前设备。个人截图只在导入过程中读取，不上传到后端，也不另存原图。")
                    Text("可手动导出备份文件并恢复到本机；当前不提供账号或自动跨设备同步。")
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
                await reminders.refreshStatus()
                if !baseURL.isEmpty { await remotePush.refresh(baseURL: baseURL) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await reminders.refreshStatus(); if !baseURL.isEmpty { await remotePush.refresh(baseURL: baseURL) } }
                }
            }
            .alert("提示", isPresented: Binding(get: { reminders.message != nil }, set: { if !$0 { reminders.message = nil } })) {
                Button("知道了", role: .cancel) {}
            } message: { Text(reminders.message ?? "") }
        }
    }

}
