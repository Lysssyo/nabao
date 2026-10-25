import Foundation
import Combine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum BackendAddress {
    public static func defaultURL(isSimulator: Bool) -> String {
        isSimulator ? "http://127.0.0.1:18081" : ""
    }

    public static func isLoopback(_ address: String) -> Bool {
        guard let host = URLComponents(string: address)?.host?.lowercased() else { return false }
        return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "[::1]"
            || host == "0.0.0.0" || host == "::" || host == "[::]" || host.hasPrefix("127.")
    }

    public static func validated(_ address: String, allowLoopback: Bool) throws -> PushBackend {
        let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if !allowLoopback && isLoopback(value) { throw BackendConnectionError.loopback }
        guard let backend = try? PushBackend(value) else { throw BackendConnectionError.invalidAddress }
        return backend
    }
}

public enum BackendConnectionError: LocalizedError {
    case loopback, invalidAddress, invalidResponse, http(Int)
    public var errorDescription: String? {
        switch self {
        case .loopback: return "此地址指向手机本身。请填写 Mac 的局域网地址，例如 http://Admin.local:18081。"
        case .invalidAddress: return "请输入完整服务地址，例如 http://Admin.local:18081。远程服务请使用 HTTPS。"
        case .invalidResponse: return "这个地址没有返回纳宝额度表，请检查服务地址和端口。"
        case .http(let status): return "服务返回 HTTP \(status)，请检查纳宝后端是否已启动。"
        }
    }
}

/// Tests the public table independently of APNs, current selection and cache.
@MainActor
public final class BackendConnectionStore: ObservableObject {
    public struct Result: Equatable {
        public let address: String
        public let dataDate: String
        public let rowCount: Int
    }
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    @Published public private(set) var checking = false
    @Published public private(set) var result: Result?
    @Published public private(set) var error: String?
    private let transport: Transport
    private var requestID = UUID()

    public init(transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }) {
        self.transport = transport
    }

    public func reset() {
        requestID = UUID()
        checking = false
        result = nil
        error = nil
    }

    @discardableResult
    public func check(_ address: String, allowLoopback: Bool) async -> Result? {
        guard !Task.isCancelled else { return nil }
        reset()
        let currentID = requestID
        checking = true
        defer { if currentID == requestID { checking = false } }
        do {
            let backend = try BackendAddress.validated(address, allowLoopback: allowLoopback)
            var request = URLRequest(url: backend.endpoint("api/v1/table"))
            request.timeoutInterval = 10
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.httpShouldHandleCookies = false
            let (data, response) = try await transport(request)
            guard currentID == requestID, !Task.isCancelled else { return nil }
            guard let http = response as? HTTPURLResponse else { throw BackendConnectionError.invalidResponse }
            guard http.statusCode == 200 else { throw BackendConnectionError.http(http.statusCode) }
            guard data.count <= 5 * 1_024 * 1_024, let table = try? DailyFundTable.decode(data) else {
                throw BackendConnectionError.invalidResponse
            }
            let success = Result(address: backend.identityScope, dataDate: table.dataDate, rowCount: table.rows.count)
            result = success
            return success
        } catch {
            guard currentID == requestID, !Task.isCancelled else { return nil }
            if let network = error as? URLError {
                switch network.code {
                case .timedOut: self.error = "连接超时，请确认 Mac 和手机在同一 Wi-Fi，且后端已启动。"
                case .notConnectedToInternet: self.error = "当前没有网络连接。请连接 Wi-Fi 后重试。"
                case .appTransportSecurityRequiresSecureConnection: self.error = "系统阻止了这个地址。局域网请使用 Mac 的 .local 名称，远程服务请使用 HTTPS。"
                default: self.error = "无法连接。请检查地址、同一 Wi-Fi 和纳宝的本地网络权限。"
                }
            } else { self.error = error.localizedDescription }
            return nil
        }
    }
}
