import UIKit

@MainActor
enum Clipboard {
    static func copyFund(name: String, code: String?) {
        UIPasteboard.general.string = [name, code].compactMap { $0 }.joined(separator: " ")
    }
}
