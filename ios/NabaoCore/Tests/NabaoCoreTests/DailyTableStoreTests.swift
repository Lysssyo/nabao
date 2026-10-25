import XCTest
@testable import NabaoCore

final class DailyTableStoreTests: XCTestCase {
    @MainActor
    func testRefreshesShareExactRowsAndKeepUsefulCacheOnFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cacheURL = directory.appendingPathComponent("table.json")
        let transport = TableTransport()
        let store = DailyTableStore(cacheURL: cacheURL, transport: { try await transport.send($0) })
        let first = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture(limit: "10"))
        await first.value
        XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "10")
        XCTAssertNil(store.row(code: nil))
        XCTAssertNil(store.row(code: "019442"))

        let next = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture(limit: "5", date: "2026-10-24"))
        await next.value
        XCTAssertEqual(store.table?.dataDate, "2026-10-24")
        XCTAssertEqual(DailyFundTable.limitChange(from: store.previousRow(code: "019441")?.distributorLimit,
                                                 to: store.row(code: "019441")!.distributorLimit), "10 → 5")
        let saved = try Data(contentsOf: cacheURL)
        for (body, status) in [(Data("broken".utf8), 200), (try fixture(empty: true), 200), (Data(), 503)] {
            let refresh = Task { await store.load(baseURL: "https://one.test") }
            await transport.succeed(await transport.nextRequest(), data: body, status: status)
            await refresh.value
            XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "5")
            XCTAssertNotNil(store.message)
            XCTAssertFalse(store.loading)
            XCTAssertEqual(try Data(contentsOf: cacheURL), saved)
        }
        let restart = DailyTableStore(cacheURL: cacheURL, transport: { try await transport.send($0) })
        restart.configure(baseURL: "https://one.test/")
        XCTAssertEqual(restart.table, store.table)
        XCTAssertEqual(restart.comparisonTable, store.comparisonTable)
    }

    @MainActor
    func testOlderConcurrentResponseCannotReplaceLatestTableOrCache() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let transport = TableTransport()
        let store = DailyTableStore(cacheURL: url, transport: { try await transport.send($0) })
        let old = Task { await store.load(baseURL: "https://one.test") }
        let oldID = await transport.nextRequest()
        let new = Task { await store.load(baseURL: "https://one.test") }
        let newID = await transport.nextRequest()
        await transport.succeed(newID, data: try fixture(limit: "20"))
        await new.value
        await transport.succeed(oldID, data: try fixture(limit: "10"))
        await old.value
        XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "20")
        XCTAssertEqual(try DailyTableCache(fileURL: url).load(backend: "https://one.test")?.rows[0].distributorLimit, "20")
        XCTAssertFalse(store.loading)
    }

    @MainActor
    func testBackendChangeClearsDisplayAndRejectsOldResponseIncludingInvalidAddress() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let transport = TableTransport()
        let store = DailyTableStore(cacheURL: url, transport: { try await transport.send($0) })
        let initial = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture())
        await initial.value
        let old = Task { await store.load(baseURL: "https://one.test") }
        let oldID = await transport.nextRequest()
        store.configure(baseURL: "invalid")
        XCTAssertNil(store.table)
        XCTAssertNil(store.comparisonTable)
        XCTAssertNil(store.lastRefresh)
        await store.load(baseURL: "invalid")
        XCTAssertNotNil(store.message)
        await transport.succeed(oldID, data: try fixture(limit: "999"))
        await old.value
        XCTAssertNil(store.table)

        let different = Task { await store.load(baseURL: "https://two.test") }
        let differentID = await transport.nextRequest()
        XCTAssertNil(store.table)
        await transport.succeed(differentID, data: try fixture(limit: "30"))
        await different.value
        XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "30")
        XCTAssertNil(store.comparisonTable)
        XCTAssertNil(store.message)
        XCTAssertNil(try DailyTableCache(fileURL: url).load(backend: "https://one.test"))
    }

    @MainActor
    func testCorruptCacheRecoversAndCancelledResponseIsIgnored() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("broken".utf8).write(to: url)
        let transport = TableTransport()
        let store = DailyTableStore(cacheURL: url, transport: { try await transport.send($0) })
        let initial = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture())
        await initial.value
        let completedRefresh = store.lastRefresh
        let cancelled = Task { await store.load(baseURL: "https://one.test") }
        let cancelledID = await transport.nextRequest()
        cancelled.cancel()
        await transport.succeed(cancelledID, data: try fixture(limit: "900"))
        await cancelled.value
        XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "5")
        XCTAssertFalse(store.loading)
        XCTAssertEqual(store.lastRefresh, completedRefresh)
        // A cancelled view task must not switch scope before it even requests data.
        let neverStarted = Task { await store.load(baseURL: "https://two.test") }
        neverStarted.cancel()
        await neverStarted.value
        XCTAssertEqual(store.row(code: "019441")?.distributorLimit, "5")
    }

    @MainActor
    func testEverySuccessfulRefreshReportsCompletionEvenWhenTableIsUnchanged() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let transport = TableTransport()
        var clock = Date(timeIntervalSince1970: 1_000)
        let store = DailyTableStore(cacheURL: url, transport: { try await transport.send($0) }, now: { clock })
        let first = Task { await store.load(baseURL: "https://one.test") }
        let firstID = await transport.nextRequest()
        XCTAssertTrue(store.loading)
        XCTAssertNil(store.lastRefresh)
        await transport.succeed(firstID, data: try fixture())
        await first.value
        XCTAssertEqual(store.lastRefresh?.completedAt, clock)
        XCTAssertEqual(store.lastRefresh?.contentChanged, true)

        clock = Date(timeIntervalSince1970: 1_100)
        let second = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture(updatedAt: "2026-10-25T08:00:00Z"))
        await second.value
        XCTAssertEqual(store.lastRefresh?.completedAt, clock)
        XCTAssertEqual(store.lastRefresh?.contentChanged, false)
        XCTAssertEqual(store.table?.dataDate, "2026-10-23")
        XCTAssertNil(store.message)
        XCTAssertFalse(store.loading)

        clock = Date(timeIntervalSince1970: 1_200)
        let changed = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture(limit: "20"))
        await changed.value
        XCTAssertEqual(store.lastRefresh?.contentChanged, true)
        XCTAssertEqual(store.lastRefresh?.completedAt, clock)
    }

    @MainActor
    func testTimeoutShowsFailureKeepsTableAndCanRetry() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let transport = TableTransport()
        let store = DailyTableStore(cacheURL: url, transport: { try await transport.send($0) })
        let first = Task { await store.load(baseURL: "https://one.test") }
        await transport.succeed(await transport.nextRequest(), data: try fixture())
        await first.value
        let completed = store.lastRefresh
        let timeout = Task { await store.load(baseURL: "https://one.test") }
        await transport.fail(await transport.nextRequest(), error: URLError(.timedOut))
        await timeout.value
        XCTAssertEqual(store.lastRefresh, completed)
        XCTAssertEqual(store.table?.rows.first?.distributorLimit, "5")
        XCTAssertTrue(store.message?.contains("连接超时") == true)
        XCTAssertFalse(store.loading)

        let retry = Task { await store.load(baseURL: "https://one.test") }
        let retryID = await transport.nextRequest()
        XCTAssertTrue(store.loading)
        XCTAssertNil(store.message)
        await transport.succeed(retryID, data: try fixture())
        await retry.value
        XCTAssertFalse(store.loading)
        XCTAssertNil(store.message)
        XCTAssertEqual(store.lastRefresh?.contentChanged, false)
    }

    private func fixture(limit: String = "5", date: String = "2026-10-23", empty: Bool = false,
                         updatedAt: String = "2026-10-23T07:00:00Z") throws -> Data {
        let row: [String: Any] = ["fundCode": "019441", "fundName": "万家纳斯达克100指数发起式(QDII)A",
                                  "distributorLimit": limit, "directLimit": "100"]
        return try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "dataDate": date,
            "updatedAt": updatedAt, "source": ["name": "公开额度", "url": "https://example.test"],
            "rows": empty ? [] : [row]])
    }
}

/// In-memory HTTP boundary: each test decides the exact response completion order.
private actor TableTransport {
    private var counter = 0
    private var pending: [Int: (URLRequest, CheckedContinuation<(Data, URLResponse), Error>)] = [:]
    private var arrivals: [Int] = []
    private var waiters: [CheckedContinuation<Int, Never>] = []

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            counter += 1
            pending[counter] = (request, continuation)
            if waiters.isEmpty { arrivals.append(counter) }
            else { waiters.removeFirst().resume(returning: counter) }
        }
    }

    func nextRequest() async -> Int {
        if !arrivals.isEmpty { return arrivals.removeFirst() }
        return await withCheckedContinuation { waiters.append($0) }
    }

    func succeed(_ id: Int, data: Data, status: Int = 200) {
        guard let (request, continuation) = pending.removeValue(forKey: id) else { return }
        continuation.resume(returning: (data, HTTPURLResponse(url: request.url!, statusCode: status,
                                                              httpVersion: nil, headerFields: nil)!))
    }

    func fail(_ id: Int, error: Error) {
        pending.removeValue(forKey: id)?.1.resume(throwing: error)
    }
}
