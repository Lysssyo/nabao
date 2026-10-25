import XCTest
@testable import NabaoCore

final class FundCatalogTests: XCTestCase {
    func testDirectoryExactlyMatchesVerifiedCollectorIdentities() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let source = try String(contentsOf: root.appendingPathComponent("collector/src/daily-fund-catalog.ts"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "= [")?.upperBound)
        let end = try XCTUnwrap(source.range(of: "];", options: .backwards)?.lowerBound)
        let data = Data(("[" + source[start..<end] + "]").utf8)
        let verified = try JSONDecoder().decode([Identity].self, from: data)
        XCTAssertEqual(verified.count, 41)
        XCTAssertEqual(FundCatalog.all.count, 41)
        XCTAssertEqual(Set(FundCatalog.all.map(\.code)).count, 41)
        XCTAssertEqual(FundCatalog.all.map { Identity(code: $0.code, name: $0.name) }, verified)
        XCTAssertTrue(FundCatalog.all.allSatisfy { $0.currency == "人民币" })
        XCTAssertTrue(FundCatalog.all.allSatisfy { !$0.name.contains("人民币") && !$0.name.contains("()") })
    }

    func testLiteralSearchDistinguishesSharesAndCurrency() {
        XCTAssertEqual(FundCatalog.search("南方 I").map(\.code), ["021000"])
        XCTAssertEqual(FundCatalog.search("华泰柏瑞 C").map(\.code), ["019525"])
        XCTAssertEqual(FundCatalog.search(" 南方 c 人民币 ").map(\.code), ["016453"])
        XCTAssertEqual(FundCatalog.search("022664").map(\.shareClass), ["I"])
        XCTAssertEqual(FundCatalog.search("万家").map(\.code), ["019441", "019442"])
        XCTAssertEqual(FundCatalog.search("I").map(\.code), ["021000", "022664", "024237", "021838"])
        XCTAssertEqual(FundCatalog.search("D").map(\.code), ["023422", "022525"])
        XCTAssertEqual(FundCatalog.search("F").map(\.code), ["021778"])
        XCTAssertEqual(FundCatalog.search("E").map(\.code), ["021773"])
        XCTAssertTrue(FundCatalog.search("美元").isEmpty)
        XCTAssertTrue(FundCatalog.search("南坊").isEmpty)
        XCTAssertEqual(FundCatalog.search("  ").count, 41)
        XCTAssertNil(FundCatalog.fund(code: "160213")?.shareClass)
    }

    func testLookupRequiresExactCodeAndNeverRepairsOldPlan() {
        let plan = Plan(fundName: "南方纳斯达克100指数发起(QDII)I", channel: .southern,
                        amountMinor: 10_000, frequency: "每日")
        XCTAssertNil(FundCatalog.fund(code: plan.fundCode))
        XCTAssertNil(FundCatalog.fund(code: "21000"))
        XCTAssertNil(FundCatalog.fund(code: "021000 "))
        XCTAssertNil(FundCatalog.fund(code: "999999"))
        XCTAssertNil(plan.fundCode)
        XCTAssertEqual(plan.amountMinor, 10_000)
        XCTAssertNotEqual(FundCatalog.fund(code: "016452"), FundCatalog.fund(code: "016453"))
    }

    func testCompanyAndShareMatchWithoutFullNameOrSpaces() throws {
        for name in ["南方 I", "南方I", "南方基金 i类", "南方纳指I", "南方纳斯达克100指数发起（QDII）I",
                     "南方纳斯达克100指数型发起式证券投资基金（QDII）I类"] {
            XCTAssertEqual(FundCatalog.search(name).map(\.code), ["021000"], name)
            XCTAssertEqual(FundCatalog.uniqueMatch(name: name)?.code, "021000", name)
            XCTAssertTrue(FundCatalog.name(name, matches: try XCTUnwrap(FundCatalog.fund(code: "021000"))))
        }
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "华泰柏瑞I")?.code, "022664")
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "建信D")?.code, "023422")
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "嘉实 C")?.code, "016533")
    }

    func testCurrencyAndProductDescriptorsAreOptional() {
        for fund in FundCatalog.all {
            XCTAssertEqual(FundCatalog.uniqueMatch(name: fund.name)?.code, fund.code)
            XCTAssertEqual(FundCatalog.uniqueMatch(name: fund.name + "（人民币）")?.code, fund.code)
        }
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "摩根纳指100人民币A")?.code, "019172")
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "广发纳斯达克100ETF联接人民币(QDII)C")?.code, "006479")
        XCTAssertEqual(FundCatalog.uniqueMatch(name: "易方达纳斯达克100ETF联接(QDII-LOF)C(人民币)")?.code, "012870")
    }

    func testAbbreviationsDoNotSelectAnAmbiguousOrDifferentShare() throws {
        XCTAssertEqual(FundCatalog.search("南方").count, 3)
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方QDII"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方ETF"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "I"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方 A/C"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方标普500I"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方纳指50I"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方纳指科技I"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "南方 I 016453"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "摩根纳指美元A"))
        XCTAssertNil(FundCatalog.uniqueMatch(name: "摩根纳指 USD A"))
        XCTAssertFalse(FundCatalog.name("南方C", matches: try XCTUnwrap(FundCatalog.fund(code: "021000"))))
        XCTAssertFalse(FundCatalog.name("博时I", matches: try XCTUnwrap(FundCatalog.fund(code: "021000"))))
    }

    private struct Identity: Decodable, Equatable {
        let code: String
        let name: String
    }
}
