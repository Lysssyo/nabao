import Foundation

public enum PushEnvironment: String, Codable, Sendable {
    case sandbox, production

    public init?(signedEnvironment: String?) {
        switch signedEnvironment {
        case "development": self = .sandbox
        case "production": self = .production
        default: return nil
        }
    }
}

public enum PushSubscriptionState: Sendable {
    case off, registering, enabled, pending, unavailable
}

public enum PushRegistrationError: Error, LocalizedError {
    case invalidBackend, invalidIdentity, invalidToken, unconfirmedResponse
    public var errorDescription: String? {
        switch self {
        case .invalidBackend: return "通知服务需使用有效 HTTPS 地址；本地开发可使用本机或局域网 HTTP 地址。"
        case .invalidIdentity: return "本机通知身份无效，已保留原记录，请先排查。"
        case .invalidToken: return "APNs 返回的设备标识格式不受支持。"
        case .unconfirmedResponse: return "后端未确认操作结果，记录已保留，可重试。"
        }
    }
}

public struct PushBackend: Equatable, Sendable {
    public let url: URL
    /// Keychain account scope. Different hosts, ports, schemes or base paths never share identities.
    public var identityScope: String { url.absoluteString }

    public init(_ input: String) throws {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let originalHost = parts.host, !originalHost.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else {
            throw PushRegistrationError.invalidBackend
        }
        let host = originalHost.lowercased()
        if scheme == "http" && !Self.isLocalHost(host) { throw PushRegistrationError.invalidBackend }
        if let port = parts.port, !(1...65535).contains(port) { throw PushRegistrationError.invalidBackend }
        if parts.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) {
            throw PushRegistrationError.invalidBackend
        }
        parts.scheme = scheme
        parts.host = host
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
        guard let normalized = parts.url else { throw PushRegistrationError.invalidBackend }
        url = normalized
    }

    public func endpoint(_ path: String) -> URL { url.appending(path: path) }

    private static func isLocalHost(_ host: String) -> Bool {
        if ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host) || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }),
              let a = Int(parts[0]), let b = Int(parts[1]),
              parts.allSatisfy({ Int($0).map { (0...255).contains($0) } == true }) else { return false }
        return a == 10 || a == 127 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
    }
}

public struct PushRegistrationPayload: Encodable, Sendable {
    public let installationId: UUID
    public let installationSecret: String
    public let token: String
    public let environment: PushEnvironment

    public init(installationId: UUID, installationSecret: String, token: String, environment: PushEnvironment) throws {
        guard installationSecret.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw PushRegistrationError.invalidIdentity
        }
        guard Self.isValidToken(token) else { throw PushRegistrationError.invalidToken }
        self.installationId = installationId
        self.installationSecret = installationSecret
        self.token = token
        self.environment = environment
    }

    public static func tokenHex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    public static func isValidToken(_ value: String) -> Bool {
        value.count.isMultiple(of: 2)
            && value.range(of: #"^[0-9a-f]{32,512}$"#, options: .regularExpression) != nil
    }
}

public struct PushRegistrationResponse: Decodable, Sendable {
    public let installationId: UUID
    public let status: String
    public let deliveryEnabled: Bool
    public let providerStatus: String
    public let environment: PushEnvironment
}

public struct PushHealth: Decodable, Sendable {
    public let push: Provider
    public struct Provider: Decodable, Sendable {
        public let status: String
        public let enabled: Bool
        public let environment: String?

        public func canRegister(environment expected: PushEnvironment) -> Bool {
            status == "READY" && enabled && environment == expected.rawValue
        }
    }
}

/// The record is stored only in Keychain. An unknown POST/DELETE result cannot erase
/// the credentials needed to retry or remove a possibly active server registration.
public struct PushInstallation: Codable, Equatable, Sendable {
    public let installationId: UUID
    public let installationSecret: String
    public var token: String?
    public private(set) var wanted = false
    public private(set) var mayBeRegistered = false
    public private(set) var deliveryConfirmed = false
    public var needsCleanup: Bool { wanted || mayBeRegistered || deliveryConfirmed }

    public init(installationId: UUID = UUID(), installationSecret: String) throws {
        guard installationSecret.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw PushRegistrationError.invalidIdentity
        }
        self.installationId = installationId
        self.installationSecret = installationSecret
    }

    public mutating func requestEnable() { wanted = true; deliveryConfirmed = false }

    /// Save the user's intent before DELETE. A timeout must not cause app startup
    /// to re-register the subscription the user just asked to stop.
    public mutating func requestDisable() {
        wanted = false
        deliveryConfirmed = false
    }

    public mutating func prepareRegistration(token: String, environment: PushEnvironment) throws -> PushRegistrationPayload {
        let payload = try PushRegistrationPayload(installationId: installationId,
            installationSecret: installationSecret, token: token, environment: environment)
        self.token = token
        wanted = true
        mayBeRegistered = true
        deliveryConfirmed = false
        return payload
    }

    @discardableResult
    public mutating func confirmRegistration(httpStatus: Int, data: Data, environment: PushEnvironment) throws -> Bool {
        guard wanted, mayBeRegistered, httpStatus == 200,
              let response = try? JSONDecoder().decode(PushRegistrationResponse.self, from: data),
              response.status == "REGISTERED", response.installationId == installationId,
              response.environment == environment,
              ["DISABLED", "NOT_CONFIGURED", "INVALID_CONFIGURATION", "READY", "ENVIRONMENT_MISMATCH"]
                .contains(response.providerStatus),
              !response.deliveryEnabled || response.providerStatus == "READY" else {
            throw PushRegistrationError.unconfirmedResponse
        }
        mayBeRegistered = true
        deliveryConfirmed = response.deliveryEnabled && response.providerStatus == "READY"
        return deliveryConfirmed
    }

    public mutating func confirmDeletion(httpStatus: Int) throws {
        guard httpStatus == 204 else { throw PushRegistrationError.unconfirmedResponse }
        wanted = false
        mayBeRegistered = false
        deliveryConfirmed = false
    }
}
