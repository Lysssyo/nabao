import Foundation
import NabaoCore

// Local integration driver. Its fixture contains only generated test identities.
private struct Fixture: Decodable {
    let backendURL: String
    let installationId: UUID
    let installationSecret: String
    let token: String
    let environment: String
}

@main
struct VerifyPushClient {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "VerifyPushClient", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Usage: VerifyPushClient fixture.json register|delete"])
        }
        let fixture = try JSONDecoder().decode(Fixture.self,
            from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let backend = try PushBackend(fixture.backendURL)
        guard let environment = PushEnvironment(rawValue: fixture.environment) else {
            throw NSError(domain: "VerifyPushClient", code: 2)
        }
        let client = PushHTTPClient()
        var installation = try PushInstallation(installationId: fixture.installationId,
            installationSecret: fixture.installationSecret)
        switch CommandLine.arguments[2] {
        case "register":
            let health = try await client.health(backend: backend)
            guard health.push.canRegister(environment: environment) else {
                throw NSError(domain: "VerifyPushClient", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Local mock provider must be ready."])
            }
            installation.requestEnable()
            let payload = try installation.prepareRegistration(token: fixture.token, environment: environment)
            let response = try await client.register(payload, backend: backend)
            let confirmed = try installation.confirmRegistration(httpStatus: response.status,
                data: response.data, environment: environment)
            guard confirmed else { throw NSError(domain: "VerifyPushClient", code: 4) }
            print("Swift shared client registration confirmed.")
        case "delete":
            let response = try await client.unregister(installation, backend: backend)
            try installation.confirmDeletion(httpStatus: response)
            guard !installation.needsCleanup else { throw NSError(domain: "VerifyPushClient", code: 5) }
            print("Swift shared client deletion confirmed.")
        default:
            throw NSError(domain: "VerifyPushClient", code: 6)
        }
    }
}
