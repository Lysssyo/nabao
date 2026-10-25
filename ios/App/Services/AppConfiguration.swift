import Foundation
import NabaoCore

enum AppConfiguration {
    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    static var defaultBackendURL: String { BackendAddress.defaultURL(isSimulator: isSimulator) }

    static func needsConnectionSetup(address: String) -> Bool {
        UserDefaults.standard.string(forKey: "backendBaseURL") == nil || address.isEmpty
            || (!isSimulator && BackendAddress.isLoopback(address))
    }
}
