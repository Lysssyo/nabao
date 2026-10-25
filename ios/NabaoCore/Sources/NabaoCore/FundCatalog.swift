import Foundation

/// The same 41 verified identities as collector/src/daily-fund-catalog.ts.
/// This local directory has no prices or quotas. Name matching is limited to its listed identities.
public enum FundCatalog {
    public struct Fund: Identifiable, Equatable, Sendable {
        public var id: String { code }
        public let code: String
        public let name: String
        public let shareClass: String?
        // These exact share codes are the catalog's RMB shares; USD shares are excluded.
        public var currency: String { "人民币" }
        public var shareDescription: String { shareClass.map { "\($0) 份额" } ?? "名称未标注份额" }

        fileprivate init(code: String, name: String, shareClass: String?) {
            self.code = code
            self.name = name
            self.shareClass = shareClass
        }

        fileprivate var company: String { String(name.prefix { $0 != "纳" }) }

        fileprivate func matches(_ terms: [String]) -> Bool {
            let searchable = "\(code) \(FundCatalog.searchableName(name))"
            return terms.allSatisfy { term in
                if ["A", "C", "D", "E", "F", "I"].contains(term.uppercased()) {
                    return shareClass == term.uppercased()
                }
                return searchable.contains(term)
            }
        }
    }

    public static let all: [Fund] = [
        Fund(code: "021000", name: "南方纳斯达克100指数发起(QDII)I", shareClass: "I"),
        Fund(code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", shareClass: "A"),
        Fund(code: "019442", name: "万家纳斯达克100指数发起式(QDII)C", shareClass: "C"),
        Fund(code: "000834", name: "大成纳斯达克100ETF联接(QDII)A", shareClass: "A"),
        Fund(code: "008971", name: "大成纳斯达克100ETF联接(QDII)C", shareClass: "C"),
        Fund(code: "539001", name: "建信纳斯达克100指数(QDII)A", shareClass: "A"),
        Fund(code: "012752", name: "建信纳斯达克100指数(QDII)C", shareClass: "C"),
        Fund(code: "016452", name: "南方纳斯达克100指数发起(QDII)A", shareClass: "A"),
        Fund(code: "016453", name: "南方纳斯达克100指数发起(QDII)C", shareClass: "C"),
        Fund(code: "019736", name: "宝盈纳斯达克100指数发起(QDII)A", shareClass: "A"),
        Fund(code: "019737", name: "宝盈纳斯达克100指数发起(QDII)C", shareClass: "C"),
        Fund(code: "023422", name: "建信纳斯达克100指数(QDII)D", shareClass: "D"),
        Fund(code: "019172", name: "摩根纳斯达克100指数(QDII)A", shareClass: "A"),
        Fund(code: "019173", name: "摩根纳斯达克100指数(QDII)C", shareClass: "C"),
        Fund(code: "019524", name: "华泰柏瑞纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "019525", name: "华泰柏瑞纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "022664", name: "华泰柏瑞纳斯达克100ETF发起式联接(QDII)I", shareClass: "I"),
        Fund(code: "022525", name: "天弘纳斯达克100指数发起(QDII)D", shareClass: "D"),
        Fund(code: "040046", name: "华安纳斯达克100ETF联接(QDII)A", shareClass: "A"),
        Fund(code: "014978", name: "华安纳斯达克100ETF联接(QDII)C", shareClass: "C"),
        Fund(code: "160213", name: "国泰纳斯达克100指数", shareClass: nil),
        Fund(code: "018043", name: "天弘纳斯达克100指数发起(QDII)A", shareClass: "A"),
        Fund(code: "018044", name: "天弘纳斯达克100指数发起(QDII)C", shareClass: "C"),
        Fund(code: "021778", name: "广发纳指100ETF联接(QDII)F", shareClass: "F"),
        Fund(code: "270042", name: "广发纳斯达克100ETF联接(QDII)A", shareClass: "A"),
        Fund(code: "006479", name: "广发纳斯达克100ETF联接(QDII)C", shareClass: "C"),
        Fund(code: "019547", name: "招商纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "019548", name: "招商纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "161130", name: "易方达纳斯达克100ETF联接(QDII-LOF)A", shareClass: "A"),
        Fund(code: "012870", name: "易方达纳斯达克100ETF联接(QDII-LOF)C", shareClass: "C"),
        Fund(code: "018966", name: "汇添富纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "018967", name: "汇添富纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "021773", name: "汇添富纳斯达克100ETF发起式联接(QDII)E", shareClass: "E"),
        Fund(code: "015299", name: "华夏纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "015300", name: "华夏纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "016055", name: "博时纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "016057", name: "博时纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "024237", name: "博时纳斯达克100ETF发起式联接(QDII)I", shareClass: "I"),
        Fund(code: "016532", name: "嘉实纳斯达克100ETF发起式联接(QDII)A", shareClass: "A"),
        Fund(code: "016533", name: "嘉实纳斯达克100ETF发起式联接(QDII)C", shareClass: "C"),
        Fund(code: "021838", name: "嘉实纳斯达克100ETF发起式联接(QDII)I", shareClass: "I"),
    ]

    /// Exact code only. Never infer a share or currency from a saved name.
    public static func fund(code: String?) -> Fund? {
        guard let code else { return nil }
        return all.first { $0.code == code }
    }

    /// Company, share, name fragments and codes can be combined, with or without spaces.
    /// Currency labels and common product descriptors are optional, e.g. 南方I / 南方 纳指 I.
    public static func search(_ query: String) -> [Fund] {
        let normalized = searchableName(query)
        let terms = tokens(in: normalized)
        let companies = Set(all.map(\.company)).filter { normalized.contains($0) }
        if companies.count == 1, let company = companies.first {
            let shares = Set(terms.filter { shareClasses.contains($0) })
            let isShortName = terms.allSatisfy { $0 == company || shareClasses.contains($0) }
            let hasIndexName = normalized.contains("纳指")
            let hasOtherLetters = terms.contains { $0.range(of: #"^[A-Z]+$"#, options: .regularExpression) != nil && !shareClasses.contains($0) }
            let foreignOrOtherIndex = ["美元", "美金", "港币", "欧元", "科技", "综合", "标普", "沪深", "中证", "债券"]
                .contains { normalized.contains($0) }
            if !foreignOrOtherIndex && !hasOtherLetters && (isShortName || hasIndexName) {
                if let index = normalized.range(of: "纳指") {
                    let number = normalized[index.upperBound...].prefix(while: \.isNumber)
                    if !number.isEmpty && number != "100" { return [] }
                }
                let suppliedCodes = terms.filter { $0.count == 6 && $0.allSatisfy(\.isNumber) }
                return all.filter { fund in
                    fund.company == company
                        && (shares.isEmpty || shares.count == 1 && fund.shareClass == shares.first)
                        && suppliedCodes.allSatisfy { $0 == fund.code }
                }
            }
        }
        return all.filter { $0.matches(terms) }
    }

    /// Only a unique company + explicit share (or a full code) supplies a code for a new import.
    /// Missing shares, another product/index and explicit foreign currency are not guessed.
    public static func uniqueMatch(name: String) -> Fund? {
        let query = searchableName(name)
        let candidates = search(name)
        guard candidates.count == 1, let candidate = candidates.first else { return nil }
        if query == candidate.code { return candidate }
        guard query.contains(candidate.company) else { return nil }
        if let share = candidate.shareClass {
            guard tokens(in: query).contains(share) else { return nil }
        } else if !query.contains("纳指") {
            return nil
        }
        return candidate
    }

    /// Avoid full-name equality checks when reviewing a known code and an abbreviated name.
    public static func name(_ name: String, matches fund: Fund) -> Bool {
        search(name).contains { $0.code == fund.code }
    }

    private static func searchableName(_ name: String) -> String {
        var value = name.precomposedStringWithCompatibilityMapping.uppercased()
            .replacingOccurrences(of: "纳斯达克", with: "纳指")
        for descriptor in ["人民币", "QDII", "LOF", "ETF", "发起式", "发起", "指数", "联接", "基金", "份额", "类"] {
            value = value.replacingOccurrences(of: descriptor, with: "")
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let shareClasses: Set<String> = ["A", "C", "D", "E", "F", "I"]
    private static let tokenPattern = try! NSRegularExpression(pattern: #"[A-Z]+|[\p{Han}\p{N}]+"#)
    private static func tokens(in value: String) -> [String] {
        let text = value as NSString
        return tokenPattern.matches(in: value, range: NSRange(location: 0, length: text.length))
            .map { text.substring(with: $0.range) }
    }
}
