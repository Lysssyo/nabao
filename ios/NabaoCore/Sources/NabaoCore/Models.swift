import Foundation

public enum Channel: String, Codable, CaseIterable, Identifiable, Sendable {
    case alipay, southern, jd, unknown
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .alipay: return "支付宝"
        case .southern: return "南方基金"
        case .jd: return "京东金融"
        case .unknown: return "待确认渠道"
        }
    }
}

public enum PlanStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case active, paused, terminated, unknown
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .active: return "进行中"
        case .paused: return "已暂停"
        case .terminated: return "已终止"
        case .unknown: return "待确认"
        }
    }
}

public struct Plan: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var fundName: String
    public var fundCode: String?
    public var channel: Channel
    public var amountMinor: Int64
    public var frequency: String
    public var nextExecutionDate: String?
    public var status: PlanStatus
    public var confirmedAt: Date

    public init(
        id: UUID = UUID(), fundName: String, fundCode: String? = nil,
        channel: Channel, amountMinor: Int64, frequency: String,
        nextExecutionDate: String? = nil, status: PlanStatus = .active,
        confirmedAt: Date = Date()
    ) {
        self.id = id
        self.fundName = fundName
        self.fundCode = fundCode
        self.channel = channel
        self.amountMinor = amountMinor
        self.frequency = frequency
        self.nextExecutionDate = nextExecutionDate
        self.status = status
        self.confirmedAt = confirmedAt
    }
}

/// Integer cents only: rejects ambiguous or malformed input instead of silently rounding.
public enum Money {
    public static func minorUnits(_ input: String) -> Int64? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.range(of: #"^[0-9]+(?:\.[0-9]{1,2})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = text.split(separator: ".")
        guard let whole = Int64(parts[0]), whole <= (Int64.max - 99) / 100 else { return nil }
        let fraction = parts.count == 2 ? String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0) : "00"
        return whole * 100 + (Int64(fraction) ?? 0)
    }

    public static func text(_ minor: Int64) -> String {
        String(format: "%lld.%02lld", minor / 100, minor % 100)
    }
}

public enum KnownFund {
    // Screenshot names share the directory's company/share matching rules.
    public static func code(for name: String) -> String? {
        FundCatalog.uniqueMatch(name: name)?.code
    }

    public static func alipayDetailURL(for code: String?) -> URL? {
        // Exact public fund123 product identifiers. The nested route keeps its
        // two encoding layers so the product query stays inside the detail URL.
        guard let code, let productID = [
            "016452": "20221103000230030000000000141045",
            "016453": "20221103000230030000000000141044",
            "019172": "20230825000230030000000001247900",
            "539001": "20150718000230030000000000003391"
        ][code] else { return nil }
        return URL(string: "https://ds.alipay.com/?scheme=alipays%3A%2F%2Fplatformapi%2FstartApp%3FappId%3D20000793%26pullRefresh%3DNO%26url%3D%252Fwww%252Fdetail.html%253FproductId%253D\(productID)")
    }

    public static func southernInvestmentURL() -> URL? {
        URL(string: "https://m.nffund.com/cache/dl/index.html?route=MyInvestment&isLogin=1")
    }

    public static func southernDetailURL(for code: String?) -> URL? {
        guard code == "021000" else { return nil }
        return URL(string: "https://m.nffund.com/cache/dl/index.html?route=FundsDetails&fundcode=021000")
    }
}
