import Foundation
import XCTest
@testable import NabaoCore

final class ChannelLinkTests: XCTestCase {
    func testEachFundDecodesToItsOwnProductInsideTheNestedDetailRoute() throws {
        // Product identifiers independently checked against the public fund123
        // pages; decoding each layer catches accidental query flattening.
        let expected = [
            "016452": "20221103000230030000000000141045",
            "016453": "20221103000230030000000000141044",
            "019172": "20230825000230030000000001247900",
            "539001": "20150718000230030000000000003391"
        ]
        var generatedLinks = Set<URL>()
        for (code, productID) in expected {
            let url = try XCTUnwrap(KnownFund.alipayDetailURL(for: code))
            generatedLinks.insert(url)
            let envelope = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            XCTAssertEqual(envelope.scheme, "https")
            XCTAssertEqual(envelope.host, "ds.alipay.com")
            XCTAssertEqual(envelope.queryItems?.map(\.name), ["scheme"])
            let routeText = try XCTUnwrap(envelope.queryItems?.first?.value)
            let route = try XCTUnwrap(URLComponents(string: routeText))
            XCTAssertEqual(route.scheme, "alipays")
            XCTAssertEqual(route.host, "platformapi")
            XCTAssertEqual(route.path, "/startApp")
            let routeItems = try XCTUnwrap(route.queryItems)
            XCTAssertEqual(Set(routeItems.map(\.name)), Set(["appId", "pullRefresh", "url"]))
            XCTAssertEqual(routeItems.first(where: { $0.name == "appId" })?.value, "20000793")
            XCTAssertEqual(routeItems.first(where: { $0.name == "pullRefresh" })?.value, "NO")
            let detailText = try XCTUnwrap(routeItems.first(where: { $0.name == "url" })?.value)
            let detail = try XCTUnwrap(URLComponents(string: detailText))
            XCTAssertEqual(detail.path, "/www/detail.html")
            XCTAssertEqual(detail.queryItems, [URLQueryItem(name: "productId", value: productID)])
            XCTAssertNil(detail.fragment)
        }
        XCTAssertEqual(generatedLinks.count, expected.count)
    }

    func testUnknownMalformedAndUnconfirmedSharesHaveNoAlipayEntry() {
        let inputs: [String?] = [nil, "", "000001", "021000", "019173", "01645",
                                " 019172", "019172\n", "019172&productId=other"]
        for code in inputs {
            XCTAssertNil(KnownFund.alipayDetailURL(for: code))
        }
    }

    func testSouthernUsesTheVerifiedHTTPSInvestmentBridge() throws {
        let url = try XCTUnwrap(KnownFund.southernInvestmentURL())
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "m.nffund.com")
        XCTAssertEqual(components.path, "/cache/dl/index.html")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "route", value: "MyInvestment"),
            URLQueryItem(name: "isLogin", value: "1")
        ])
        XCTAssertNil(components.fragment)
    }

    func testSouthernDetailUsesOnlyTheVerifiedIShare() throws {
        let url = try XCTUnwrap(KnownFund.southernDetailURL(for: "021000"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "m.nffund.com")
        XCTAssertEqual(components.path, "/cache/dl/index.html")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "route", value: "FundsDetails"),
            URLQueryItem(name: "fundcode", value: "021000")
        ])
        let unverified: [String?] = [nil, "", "016452", "016453", "019172", "021000&route=other"]
        for code in unverified {
            XCTAssertNil(KnownFund.southernDetailURL(for: code))
        }
    }
}
