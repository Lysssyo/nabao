import Foundation
import Combine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One public table and comparison snapshot for every screen in the app.
/// Plan data is never accepted here, so a refresh cannot edit a local plan.
@MainActor
public final class DailyTableStore: ObservableObject {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    public struct RefreshResult: Equatable {
        public let completedAt: Date
        public let contentChanged: Bool
    }
    @Published public private(set) var table: DailyFundTable?
    @Published public private(set) var comparisonTable: DailyFundTable?
    @Published public private(set) var loading = false
    @Published public private(set) var message: String?
    @Published public private(set) var lastRefresh: RefreshResult?

    private let cache: DailyTableCache
    private let transport: Transport
    private let now: () -> Date
    private var loadedBackend: String?
    private var requestID = UUID()

    public convenience init(cacheURL: URL) {
        self.init(cacheURL: cacheURL, transport: { try await TableHTTP.session.data(for: $0) })
    }

    public init(cacheURL: URL, transport: @escaping Transport, now: @escaping () -> Date = Date.init) {
        cache = DailyTableCache(fileURL: cacheURL)
        self.transport = transport
        self.now = now
    }

    public func row(code: String?) -> DailyFundTable.Row? {
        guard let code else { return nil }
        return table?.rows.first { $0.fundCode == code }
    }

    public func previousRow(code: String) -> DailyFundTable.Row? {
        comparisonTable?.rows.first { $0.fundCode == code }
    }

    /// Call synchronously when settings change, before starting the new request.
    /// An invalid address also clears the old server's table and pending response.
    public func configure(baseURL: String) {
        let scope = try? PushBackend(baseURL).identityScope
        guard scope != loadedBackend else { return }
        requestID = UUID()
        loading = false
        table = nil
        comparisonTable = nil
        message = nil
        lastRefresh = nil
        loadedBackend = scope
        guard let scope else { return }
        // Broken cache must not prevent a fresh network request.
        let saved = try? cache.loadSnapshot(backend: scope)
        if let saved, !saved.table.rows.isEmpty {
            table = saved.table
            comparisonTable = saved.comparisonTable
        }
    }

    public func load(baseURL: String) async {
        guard !Task.isCancelled else { return }
        configure(baseURL: baseURL)
        let currentRequest = UUID()
        requestID = currentRequest
        loading = true
        message = nil
        defer { if requestID == currentRequest { loading = false } }
        do {
            let backend = try PushBackend(baseURL)
            let scope = backend.identityScope
            var request = URLRequest(url: backend.endpoint("api/v1/table"))
            request.timeoutInterval = 15
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await transport(request)
            guard requestID == currentRequest, !Task.isCancelled else { return }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let next = try DailyFundTable.decode(data)
            guard !next.rows.isEmpty else { throw DailyTableError.emptyTable }
            // A server's generated timestamp alone doesn't change the displayed
            // data. Keep refresh time distinct from the published table date.
            let changed = table?.dataDate != next.dataDate || table?.rows != next.rows || table?.notes != next.notes
            do {
                let saved = try cache.save(next, backend: scope)
                table = saved.table
                comparisonTable = saved.comparisonTable
            } catch {
                table = next
                comparisonTable = nil
                message = "额度表已更新，本地缓存保存失败。"
            }
            lastRefresh = RefreshResult(completedAt: now(), contentChanged: changed)
        } catch {
            guard requestID == currentRequest, !Task.isCancelled else { return }
            let prefix = table == nil ? "暂时无法获取额度表。" : "刷新未成功，仍显示上次取得的额度表。"
            let detail: String
            if error is DailyTableError {
                detail = error.localizedDescription
            } else if let network = error as? URLError, network.code == .timedOut {
                detail = "连接超时，请检查网络后重试。"
            } else {
                detail = "请检查网络与设置中的服务地址。"
            }
            message = prefix + detail
        }
    }
}

private enum TableHTTP {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 15
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }()
}
