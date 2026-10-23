import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct PushHTTPResponse: Sendable {
    public let status: Int
    public let data: Data
}

/// Shared by the app and local integration verification. Redirects are refused so
/// installation credentials never follow a backend redirect to another origin.
public final class PushHTTPClient: @unchecked Sendable {
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        let isolated = configuration.copy() as! URLSessionConfiguration
        isolated.urlCredentialStorage = nil
        isolated.httpCookieStorage = nil
        isolated.httpShouldSetCookies = false
        isolated.urlCache = nil
        isolated.timeoutIntervalForRequest = 20
        isolated.timeoutIntervalForResource = 20
        session = URLSession(configuration: isolated, delegate: RejectRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    public func health(backend: PushBackend) async throws -> PushHealth {
        let response = try await send(URLRequest(url: backend.endpoint("api/v1/health")))
        guard response.status == 200 else { throw PushRegistrationError.unconfirmedResponse }
        return try JSONDecoder().decode(PushHealth.self, from: response.data)
    }

    public func register(_ payload: PushRegistrationPayload, backend: PushBackend) async throws -> PushHTTPResponse {
        var request = URLRequest(url: backend.endpoint("api/v1/push-devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)
        return try await send(request)
    }

    public func unregister(_ record: PushInstallation, backend: PushBackend) async throws -> Int {
        var request = URLRequest(url: backend.endpoint("api/v1/push-devices/\(record.installationId.uuidString)"))
        request.httpMethod = "DELETE"
        request.setValue(record.installationSecret, forHTTPHeaderField: "X-Installation-Key")
        return try await send(request).status
    }

    private func send(_ original: URLRequest) async throws -> PushHTTPResponse {
        var request = original
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 65_536 else { throw PushRegistrationError.unconfirmedResponse }
        return PushHTTPResponse(status: http.statusCode, data: data)
    }

}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
