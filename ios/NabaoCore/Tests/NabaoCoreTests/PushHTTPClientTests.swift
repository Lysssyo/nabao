import Foundation
import XCTest
@testable import NabaoCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class PushHTTPClientTests: XCTestCase {
    private let backend = try! PushBackend("http://127.0.0.1:8080/nabao")
    private let secret = String(repeating: "a", count: 64)
    private let token = String(repeating: "1b", count: 32)

    func testRegistrationUsesOnlyAnonymousBodyAndKeepsHTTPStatusForStateConfirmation() async throws {
        let record = try PushInstallation(installationSecret: secret)
        let payload = try PushRegistrationPayload(installationId: record.installationId,
            installationSecret: secret, token: token, environment: .sandbox)
        let capture = CapturedRequest()
        let client = client(status: 503, body: Data("unavailable".utf8), capture: capture)
        let response = try await client.register(payload, backend: backend)
        XCTAssertEqual(response.status, 503)
        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:8080/nabao/api/v1/push-devices")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let body = try XCTUnwrap(capture.body)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(fields.keys), ["installationId", "installationSecret", "token", "environment"])
        XCTAssertEqual(fields["installationId"] as? String, record.installationId.uuidString)
        XCTAssertEqual(fields["token"] as? String, token)
        XCTAssertEqual(fields["installationSecret"] as? String, secret)
        XCTAssertEqual(fields["environment"] as? String, "sandbox")
    }

    func testDeletionUsesScopedIdentityInPathAndSecretHeaderWithoutBody() async throws {
        let record = try PushInstallation(installationSecret: secret)
        let capture = CapturedRequest()
        let client = client(status: 204, body: Data(), capture: capture)
        let status = try await client.unregister(record, backend: backend)
        XCTAssertEqual(status, 204)
        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.path, "/nabao/api/v1/push-devices/\(record.installationId.uuidString)")
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Installation-Key"), secret)
        XCTAssertNil(capture.body)
    }

    func testHealthRequiresHTTP200AndDecodableExplicitProviderReadiness() async throws {
        let body = Data(#"{"push":{"enabled":true,"status":"READY","environment":"sandbox"}}"#.utf8)
        let healthy = try await client(status: 200, body: body).health(backend: backend)
        XCTAssertTrue(healthy.push.canRegister(environment: .sandbox))
        XCTAssertFalse(healthy.push.canRegister(environment: .production))
        for status in [202, 301, 401, 503] {
            do {
                _ = try await client(status: status, body: body).health(backend: backend)
                XCTFail("Unconfirmed HTTP \(status) must not enable registration")
            } catch {}
        }
        do {
            _ = try await client(status: 200, body: Data(#"{"status":"ok"}"#.utf8)).health(backend: backend)
            XCTFail("Missing provider fields must not enable registration")
        } catch {}
    }

    func testOversizedResponsesAreRejected() async throws {
        let record = try PushInstallation(installationSecret: secret)
        do {
            _ = try await client(status: 204, body: Data(repeating: 0, count: 65_537))
                .unregister(record, backend: backend)
            XCTFail("Oversized response must not confirm deletion")
        } catch {}
    }

    private func client(status: Int, body: Data, capture: CapturedRequest = CapturedRequest()) -> PushHTTPClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushTestProtocol.self]
        // Per-client unique marker routes the test protocol without a global mutable handler.
        let id = UUID().uuidString
        PushTestProtocol.lock.lock()
        PushTestProtocol.responses[id] = (status, body, capture)
        PushTestProtocol.lock.unlock()
        configuration.httpAdditionalHeaders = ["X-Test-Response-ID": id]
        return PushHTTPClient(configuration: configuration)
    }
}

private final class CapturedRequest: @unchecked Sendable {
    var request: URLRequest?
    var body: Data?
}

private final class PushTestProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var responses: [String: (Int, Data, CapturedRequest)] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let stub = Self.responses.removeValue(forKey: request.value(forHTTPHeaderField: "X-Test-Response-ID") ?? "")
        Self.lock.unlock()
        guard let (status, body, capture) = stub else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        capture.request = request
        if let data = request.httpBody { capture.body = data }
        else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            capture.body = data
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
