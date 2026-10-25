import XCTest
@testable import NabaoCore

final class BackendConnectionTests: XCTestCase {
    func testDefaultsAndPhoneLoopbackValidation() throws {
        XCTAssertEqual(BackendAddress.defaultURL(isSimulator: true), "http://127.0.0.1:18081")
        XCTAssertEqual(BackendAddress.defaultURL(isSimulator: false), "")
        for address in ["http://localhost:18081", "http://127.0.0.1:18081", "http://127.0.0.2", "http://[::1]", "http://0.0.0.0"] {
            XCTAssertThrowsError(try BackendAddress.validated(address, allowLoopback: false))
        }
        XCTAssertNoThrow(try BackendAddress.validated("http://127.0.0.1:18081", allowLoopback: true))
        XCTAssertEqual(try BackendAddress.validated(" HTTP://Admin.local:18081/ ", allowLoopback: false).identityScope,
                       "http://admin.local:18081")
        XCTAssertThrowsError(try BackendAddress.validated("https://user:secret@example.test", allowLoopback: false))
    }

    @MainActor func testCheckReadsActualPublicTableAndRetainsItsDate() async throws {
        let body = try fixture()
        let store = BackendConnectionStore { request in
            XCTAssertEqual(request.url?.absoluteString, "http://admin.local:18081/api/v1/table")
            XCTAssertEqual(request.timeoutInterval, 10)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Internal-Key"))
            return (body, self.response(request))
        }
        let result = await store.check("http://Admin.local:18081", allowLoopback: false)
        XCTAssertEqual(result?.dataDate, "2026-10-23")
        XCTAssertEqual(result?.rowCount, 1)
        XCTAssertEqual(result?.address, "http://admin.local:18081")
        XCTAssertNil(store.error)
        XCTAssertFalse(store.checking)
    }

    @MainActor func testMalformedWrongServiceAndServerErrorsNeverReportSuccess() async throws {
        let valid = try fixture()
        for (body, status) in [(Data("<html>Other app</html>".utf8), 200), (valid, 404), (valid, 503),
                               (Data(repeating: 32, count: 5 * 1_024 * 1_024 + 1), 200)] {
            let store = BackendConnectionStore { request in (body, self.response(request, status: status)) }
            let result = await store.check("https://example.test", allowLoopback: false)
            XCTAssertNil(result)
            XCTAssertNil(store.result)
            XCTAssertNotNil(store.error)
            XCTAssertFalse(store.checking)
        }
    }

    @MainActor func testValidEmptyTableIsConnectedWithoutInventingRows() async throws {
        let body = try fixture(empty: true)
        let store = BackendConnectionStore { request in (body, self.response(request)) }
        let result = await store.check("https://example.test", allowLoopback: false)
        XCTAssertEqual(result?.rowCount, 0)
        XCTAssertNil(store.error)
    }

    @MainActor func testTimeoutAndInvalidPhoneAddressGiveActionableErrors() async {
        let store = BackendConnectionStore { _ in throw URLError(.timedOut) }
        _ = await store.check("https://example.test", allowLoopback: false)
        XCTAssertTrue(store.error?.contains("连接超时") == true)
        _ = await store.check("http://127.0.0.1:18081", allowLoopback: false)
        XCTAssertTrue(store.error?.contains("手机本身") == true)
    }

    @MainActor func testEditingAddressInvalidatesLateSuccessfulResponse() async throws {
        let transport = DelayedConnection()
        let store = BackendConnectionStore { try await transport.send($0) }
        let check = Task { await store.check("https://old.test", allowLoopback: false) }
        await transport.started()
        store.reset()
        await transport.finish(try fixture())
        let result = await check.value
        XCTAssertNil(result)
        XCTAssertNil(store.result)
        XCTAssertNil(store.error)
        XCTAssertFalse(store.checking)
    }

    private func response(_ request: URLRequest, status: Int = 200) -> HTTPURLResponse {
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    private func fixture(empty: Bool = false) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "dataDate": "2026-10-23",
            "updatedAt": "2026-10-23T01:00:00Z", "source": ["name": "投票结果", "url": "https://example.test"],
            "rows": empty ? [] : [["fundCode": "016452", "fundName": "南方纳指100A", "distributorLimit": "10", "directLimit": "10"]]])
    }
}

private actor DelayedConnection {
    private var pending: (URLRequest, CheckedContinuation<(Data, URLResponse), Error>)?
    private var waiter: CheckedContinuation<Void, Never>?

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation {
            pending = (request, $0)
            waiter?.resume(); waiter = nil
        }
    }
    func started() async {
        if pending != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func finish(_ data: Data) {
        guard let (request, continuation) = pending else { return }
        pending = nil
        continuation.resume(returning: (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!))
    }
}
