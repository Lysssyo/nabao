import SwiftUI
import NabaoCore

struct BackendSetupView: View {
    let onFinish: () -> Void
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("连接后查看每日额度", systemImage: "network")
                        .font(.headline)
                    Text("使用 Mac 服务时，手机和 Mac 连接同一 Wi-Fi，并允许纳宝访问本地网络。")
                        .foregroundStyle(.secondary)
                    Text("还没准备好也可以先记录定投，稍后在设置中连接。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                BackendConnectionSection(saving: $saving, isSetup: true, onConnected: onFinish)
            }
            .navigationTitle("连接纳宝")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("稍后设置", action: onFinish).disabled(saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }
}

struct BackendConnectionSection: View {
    @EnvironmentObject private var remotePush: RemotePushStore
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    @Binding var saving: Bool
    var isSetup = false
    var onConnected: (() -> Void)?
    @StateObject private var connection = BackendConnectionStore()
    @State private var draftURL = ""
    @State private var saveMessage: String?
    @State private var saveError: String?
    @State private var checkTask: Task<Void, Never>?
    @FocusState private var addressFocused: Bool

    var body: some View {
        Section {
            TextField("http://Admin.local:18081", text: $draftURL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(.URL).submitLabel(.done)
                .focused($addressFocused)
                .disabled(saving)
                .onSubmit { saveAddress(requireTest: isSetup) }
                .accessibilityIdentifier("backendAddressField")
            if isSetup {
                Button { saveAddress(requireTest: true) } label: {
                    HStack {
                        Text(saving ? "正在连接…" : "连接并开始")
                        if saving { ProgressView() }
                    }
                }
                .disabled(saving || draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("connectBackend")
            } else {
                HStack {
                    Button {
                        addressFocused = false
                        saveMessage = nil
                        saveError = nil
                        checkTask?.cancel()
                        checkTask = Task { await connection.check(draftURL, allowLoopback: AppConfiguration.isSimulator) }
                    } label: {
                        if connection.checking { ProgressView("正在测试") }
                        else { Label("测试连接", systemImage: "network") }
                    }
                    .disabled(saving || connection.checking || draftURL.isEmpty)
                    .accessibilityIdentifier("testBackendConnection")
                    Spacer()
                    Button(saving ? "正在保存…" : "保存地址") { saveAddress(requireTest: false) }
                        .disabled(saving || draftURL.isEmpty)
                        .accessibilityIdentifier("saveBackendAddress")
                }
                .buttonStyle(.borderless)
            }
            if let result = connection.result {
                Label("连接成功", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                Text(result.rowCount == 0 ? "服务已连接，尚未发布额度表。" : "数据日期 \(result.dataDate) · \(result.rowCount) 个份额")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error = saveError ?? connection.error {
                Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red)
            }
            if let saveMessage {
                Label(saveMessage, systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.secondary)
            }
            if !isSetup && !baseURL.isEmpty {
                Text("当前地址：\(baseURL)").font(.footnote).foregroundStyle(.secondary)
            }
            if remotePush.needsCleanup {
                Text("切换地址前会先关闭旧服务的通知订阅。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("服务地址")
        } footer: {
            Text("Mac 服务示例：http://Admin.local:18081。手机不能用 127.0.0.1 连接 Mac。这里只需要服务地址，无需管理密钥。")
        }
        .task {
            draftURL = isSetup && !AppConfiguration.isSimulator && BackendAddress.isLoopback(baseURL) ? "" : baseURL
        }
        .onChange(of: draftURL) { _, _ in
            checkTask?.cancel()
            connection.reset()
            saveMessage = nil
            saveError = nil
        }
        .onDisappear { checkTask?.cancel(); connection.reset() }
    }

    private func saveAddress(requireTest: Bool) {
        guard !saving else { return }
        saving = true
        addressFocused = false
        saveMessage = nil
        saveError = nil
        checkTask?.cancel()
        connection.reset()
        let value = draftURL
        Task {
            defer { saving = false }
            do {
                let next = try BackendAddress.validated(value, allowLoopback: AppConfiguration.isSimulator)
                if requireTest {
                    guard await connection.check(value, allowLoopback: AppConfiguration.isSimulator) != nil else { return }
                }
                let selected = try await remotePush.changeBackend(from: baseURL, to: next.identityScope)
                baseURL = selected
                // Keep the editable spelling so its change handler doesn't clear success.
                saveMessage = requireTest ? "已连接，可以查看额度了。" : "地址已保存。可测试连接，或前往额度页刷新。"
                if requireTest { onConnected?() }
                Task { await remotePush.refresh(baseURL: selected) }
            } catch { saveError = error.localizedDescription }
        }
    }
}
