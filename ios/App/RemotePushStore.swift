import Foundation
import Security
import UIKit
import UserNotifications
import NabaoCore

final class RemoteNotificationsDelegate: NSObject, UIApplicationDelegate {
    weak var pushStore: RemotePushStore?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in pushStore?.receivedToken(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in pushStore?.registrationFailed() }
    }
}

@MainActor
final class RemotePushStore: ObservableObject {
    @Published private(set) var state: PushSubscriptionState = .off
    @Published private(set) var statusText = "未开启"
    @Published private(set) var canEnable = false
    @Published private(set) var isBusy = false
    @Published private(set) var needsCleanup = false
    var isEnabled: Bool { state == .enabled }
    var canRetry: Bool { installation?.wanted == true && !isEnabled }

    private var backend: PushBackend?
    private var installation: PushInstallation?
    private var pendingToken: String?
    private var awaitingAPNs = false
    private var timeout: Task<Void, Never>?
    private let client = PushHTTPClient()
    private var environment: PushEnvironment? {
        PushEnvironment(signedEnvironment: Bundle.main.object(forInfoDictionaryKey: "NabaoAPNSEnvironment") as? String)
    }

    func resume(baseURL: String) async {
        guard beginOperation() else { return }
        await refreshLocked(baseURL: baseURL)
        let handedOff = canEnable && installation?.wanted == true ? await enableLocked() : false
        if !handedOff { finishOperation() }
    }

    func refresh(baseURL: String) async {
        guard beginOperation() else { return }
        await refreshLocked(baseURL: baseURL)
        finishOperation()
    }

    private func select(_ selected: PushBackend) throws {
        // Do not change the in-memory scope until its Keychain read succeeds.
        let saved = try PushKeychain.load(backend: selected)
        backend = selected
        installation = saved
        needsCleanup = saved?.needsCleanup == true
    }

    /// The caller holds isBusy across every await, including switching the old
    /// subscription off. APNs callbacks queue their token until that operation ends.
    private func refreshLocked(baseURL: String) async {
        canEnable = false
        do {
            let selected = try PushBackend(baseURL)
            if let current = backend, current != selected, installation?.needsCleanup == true {
                throw PushClientError.oldSubscriptionPending
            }
            try select(selected)
            guard let environment else {
                state = needsCleanup ? .pending : .unavailable
                statusText = "当前构建尚未配置 APNs，额度变化通知暂不可用。"
                return
            }
            let provider = try await client.health(backend: selected).push
            canEnable = provider.canRegister(environment: environment)
            guard canEnable else {
                state = needsCleanup ? .pending : .unavailable
                statusText = providerMessage(provider, expected: environment)
                return
            }
            let permission = await UNUserNotificationCenter.current().notificationSettings()
            if ![.authorized, .provisional, .ephemeral].contains(permission.authorizationStatus) {
                state = needsCleanup ? .pending : .unavailable
                statusText = "系统通知权限尚未允许。已登记的订阅可在下方关闭。"
            } else if installation?.wanted == true && installation?.deliveryConfirmed == true {
                state = .enabled
                statusText = "已登记额度变化通知；实际送达由系统和网络决定。"
            } else {
                state = needsCleanup ? .pending : .off
                statusText = needsCleanup ? "通知操作尚未确认，可重试或关闭待确认订阅。" : "未开启"
            }
        } catch {
            canEnable = false
            state = needsCleanup ? .pending : .unavailable
            if case PushClientError.keychain = error {
                statusText = environment == nil
                    ? "当前构建尚未配置 APNs，额度变化通知暂不可用。通知登记信息也暂无法读取，原记录未改动。"
                    : "无法安全读取本机通知登记，请检查应用签名；原记录未改动。"
            } else {
                statusText = "无法确认通知服务状态，已有登记信息仍保留。"
            }
        }
    }

    func enable(baseURL: String) async {
        guard beginOperation() else { return }
        await refreshLocked(baseURL: baseURL)
        let handedOff = canEnable ? await enableLocked() : false
        if !handedOff { finishOperation() }
    }

    private func enableLocked() async -> Bool {
        guard let backend, environment != nil else { return false }
        state = .registering
        statusText = "正在申请通知权限和 APNs 设备标识…"
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            guard allowed else {
                state = needsCleanup ? .pending : .unavailable
                statusText = "系统通知权限未允许，未开通额度变化通知。"
                return false
            }
            var record = try installation ?? PushInstallation(installationSecret: PushKeychain.randomSecret())
            record.requestEnable()
            try persist(record, backend: backend)
            pendingToken = nil
            awaitingAPNs = true
            timeout?.cancel()
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                guard let self, self.awaitingAPNs else { return }
                self.awaitingAPNs = false
                self.state = .pending
                self.statusText = "尚未取得 APNs 设备标识，可重试或关闭待确认订阅。"
                self.finishOperation()
            }
            UIApplication.shared.registerForRemoteNotifications()
            return true
        } catch {
            state = needsCleanup ? .pending : .unavailable
            statusText = "未能保存或完成本机通知登记，请重试；已有信息未删除。"
            return false
        }
    }

    func receivedToken(_ data: Data) {
        let token = PushRegistrationPayload.tokenHex(data)
        guard PushRegistrationPayload.isValidToken(token) else { registrationFailed(); return }
        pendingToken = token
        if awaitingAPNs {
            timeout?.cancel()
            awaitingAPNs = false
            Task { await publishPendingTokens() }
        } else if !isBusy {
            drainPendingToken()
        }
    }

    func registrationFailed() {
        guard awaitingAPNs else { return }
        timeout?.cancel()
        awaitingAPNs = false
        state = needsCleanup ? .pending : .unavailable
        statusText = "APNs 注册未成功，请检查签名和推送权限后重试。"
        finishOperation()
    }

    private func publishPendingTokens() async {
        defer { finishOperation() }
        while let token = pendingToken, let backend, let environment, var record = installation,
              record.wanted && canEnable {
            pendingToken = nil
            state = .registering
            statusText = "正在向通知服务登记…"
            do {
                let payload = try record.prepareRegistration(token: token, environment: environment)
                // A timeout may occur after the backend accepted POST. Save the
                // cleanup credentials before sending, including on token rotation.
                try persist(record, backend: backend)
                let response = try await client.register(payload, backend: backend)
                let enabled = try record.confirmRegistration(httpStatus: response.status, data: response.data, environment: environment)
                try persist(record, backend: backend)
                state = enabled ? .enabled : .pending
                statusText = enabled ? "已登记额度变化通知；实际送达由系统和网络决定。"
                    : "设备已登记，但后端推送暂不可用。可重试或关闭待确认订阅。"
            } catch {
                state = .pending
                statusText = "后端尚未确认通知登记，信息已保留，可重试或关闭待确认订阅。"
            }
            if pendingToken == token { pendingToken = nil }
        }
    }

    @discardableResult
    func disable() async -> Bool {
        guard beginOperation() else { return false }
        defer { finishOperation() }
        return await disableLocked()
    }

    private func disableLocked() async -> Bool {
        guard let backend, var record = installation, record.needsCleanup else {
            state = .off
            statusText = "未开启"
            return true
        }
        statusText = "正在关闭后端通知订阅…"
        do {
            record.requestDisable()
            try persist(record, backend: backend)
            if record.mayBeRegistered {
                let status = try await client.unregister(record, backend: backend)
                try record.confirmDeletion(httpStatus: status)
                try persist(record, backend: backend)
            }
            pendingToken = nil
            timeout?.cancel()
            awaitingAPNs = false
            state = .off
            statusText = "额度变化通知已关闭。"
            return true
        } catch {
            pendingToken = nil
            state = .pending
            statusText = "尚未确认关闭，旧订阅可能仍有效。请重试，登记信息已保留。"
            return false
        }
    }

    func changeBackend(from oldURL: String, to newURL: String) async throws -> String {
        guard beginOperation() else { throw PushClientError.busy }
        defer { finishOperation() }
        let old = try PushBackend(oldURL)
        let next = try PushBackend(newURL)
        if old != next {
            // Retain the selected old scope on failure; the caller saves a new URL
            // only after this operation succeeds.
            try select(old)
            if needsCleanup {
                guard await disableLocked() else { throw PushClientError.oldSubscriptionPending }
            }
            try select(next)
        }
        await refreshLocked(baseURL: next.identityScope)
        return next.identityScope
    }

    private func beginOperation() -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        return true
    }

    private func finishOperation() {
        isBusy = false
        drainPendingToken()
    }

    private func drainPendingToken() {
        guard !isBusy, pendingToken != nil else { return }
        guard installation?.wanted == true, canEnable, environment != nil else {
            pendingToken = nil
            return
        }
        isBusy = true
        Task { await publishPendingTokens() }
    }

    private func persist(_ record: PushInstallation, backend: PushBackend) throws {
        try PushKeychain.save(record, backend: backend)
        installation = record
        needsCleanup = record.needsCleanup
    }

    private func providerMessage(_ provider: PushHealth.Provider, expected: PushEnvironment) -> String {
        switch provider.status {
        case "DISABLED": return "后端额度变化通知已停用，暂不可用。"
        case "NOT_CONFIGURED": return "后端尚未配置 APNs，额度变化通知暂不可用。"
        case "INVALID_CONFIGURATION": return "后端 APNs 配置无效，额度变化通知暂不可用。"
        case "READY" where provider.environment != expected.rawValue: return "当前构建与后端 APNs 环境不一致，暂不可用。"
        default: return "后端推送状态未确认，额度变化通知暂不可用。"
        }
    }
}

private enum PushClientError: Error, LocalizedError {
    case keychain, random, busy, oldSubscriptionPending
    var errorDescription: String? {
        switch self {
        case .keychain, .random: return "无法安全读取或保存本机通知身份，原记录已保留。"
        case .busy: return "通知登记正在处理中，请稍后重试。"
        case .oldSubscriptionPending: return "旧后端订阅尚未确认关闭，后端地址未切换。请先重试关闭。"
        }
    }
}

private enum PushKeychain {
    private static let service = "nabao.push.installations"
    private static func query(_ backend: PushBackend) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: backend.identityScope, kSecAttrSynchronizable as String: false]
    }

    static func load(backend: PushBackend) throws -> PushInstallation? {
        var request = query(backend)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        #if DEBUG
        NSLog("[nabao.push] Keychain read completed, OSStatus=%d", status)
        #endif
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            NSLog("[nabao.push] Keychain read failed, OSStatus=%d", status)
            throw PushClientError.keychain
        }
        guard let data = result as? Data,
              let record = try? JSONDecoder().decode(PushInstallation.self, from: data) else {
            NSLog("[nabao.push] Keychain record could not be decoded; retained unchanged")
            throw PushClientError.keychain
        }
        _ = try PushInstallation(installationId: record.installationId, installationSecret: record.installationSecret)
        if let token = record.token, !PushRegistrationPayload.isValidToken(token) { throw PushClientError.keychain }
        return record
    }

    static func save(_ record: PushInstallation, backend: PushBackend) throws {
        let data = try JSONEncoder().encode(record)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(backend) as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw PushClientError.keychain }
        guard SecItemAdd(query(backend).merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else {
            throw PushClientError.keychain
        }
    }

    static func randomSecret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PushClientError.random }
        return PushRegistrationPayload.tokenHex(Data(bytes))
    }
}

