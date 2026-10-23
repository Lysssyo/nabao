import Foundation
import XCTest
@testable import NabaoCore

final class PushRegistrationTests: XCTestCase {
    private let secret = String(repeating: "a", count: 64)
    private let token = String(repeating: "1b", count: 32)

    func testBackendIdentityScopeCanonicalizesOnlyEquivalentAddresses() throws {
        let canonical = try PushBackend("https://api.example.com")
        XCTAssertEqual(try PushBackend(" HTTPS://API.EXAMPLE.COM:443/// ").identityScope, canonical.identityScope)
        XCTAssertNotEqual(try PushBackend("https://other.example.com").identityScope, canonical.identityScope)
        XCTAssertNotEqual(try PushBackend("https://api.example.com:8443").identityScope, canonical.identityScope)
        XCTAssertNotEqual(try PushBackend("https://api.example.com/nabao").identityScope, canonical.identityScope)
        XCTAssertEqual(try PushBackend("https://api.example.com/nabao/")
            .endpoint("api/v1/push-devices").absoluteString, "https://api.example.com/nabao/api/v1/push-devices")
    }

    func testBackendRejectsCredentialBearingAmbiguousAndPublicPlaintextURLs() throws {
        for value in ["ftp://example.com", "https://user:secret@example.com", "https://example.com?secret=abc",
                      "https://example.com#fragment", "http://example.com", "http://8.8.8.8",
                      "https://example.com/../other", "https://example.com/%2e%2e/other", "https://example.com:99999"] {
            XCTAssertThrowsError(try PushBackend(value), value)
        }
        for value in ["http://127.0.0.1:8080", "http://192.168.1.2:8080", "http://10.0.0.1",
                      "http://172.16.0.1", "http://mac.local:8080", "https://example.com"] {
            XCTAssertNoThrow(try PushBackend(value), value)
        }
    }

    func testPerBackendIdentitySelectionDoesNotReuseAnotherInstallation() throws {
        let first = try PushBackend("https://one.example.com")
        let second = try PushBackend("https://two.example.com")
        let a = try PushInstallation(installationSecret: secret)
        let b = try PushInstallation(installationSecret: String(repeating: "b", count: 64))
        let records = [first.identityScope: a, second.identityScope: b]
        XCTAssertNotEqual(a.installationId, b.installationId)
        XCTAssertEqual(records[try PushBackend("https://ONE.example.com:443/").identityScope], a)
        XCTAssertEqual(records[second.identityScope], b)
    }

    func testRegistrationEncodesOnlyAnonymousFieldsAndValidatesVariableLengthTokens() throws {
        for bytes in [16, 32, 64, 256] {
            let hex = PushRegistrationPayload.tokenHex(Data(repeating: 0xab, count: bytes))
            XCTAssertEqual(hex.count, bytes * 2)
            XCTAssertTrue(PushRegistrationPayload.isValidToken(hex))
        }
        for bad in ["", String(repeating: "0", count: 31), String(repeating: "0", count: 33),
                    String(repeating: "A", count: 64), String(repeating: "0", count: 514), "<\(token)>"] {
            XCTAssertFalse(PushRegistrationPayload.isValidToken(bad))
        }
        XCTAssertThrowsError(try PushInstallation(installationSecret: "short"))
        let payload = try PushRegistrationPayload(installationId: UUID(), installationSecret: secret,
                                                  token: token, environment: .sandbox)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
        XCTAssertEqual(Set(encoded.keys), Set(["installationId", "installationSecret", "token", "environment"]))
        XCTAssertEqual(encoded["environment"] as? String, "sandbox")
    }

    func testSigningAndBackendReadinessMustAgree() throws {
        XCTAssertNil(PushEnvironment(signedEnvironment: nil))
        XCTAssertNil(PushEnvironment(signedEnvironment: ""))
        XCTAssertNil(PushEnvironment(signedEnvironment: "sandbox"))
        XCTAssertEqual(PushEnvironment(signedEnvironment: "development"), .sandbox)
        XCTAssertEqual(PushEnvironment(signedEnvironment: "production"), .production)
        for status in ["DISABLED", "NOT_CONFIGURED", "INVALID_CONFIGURATION", "CONFIGURED", "UNKNOWN"] {
            XCTAssertFalse(try health(status: status, enabled: true, environment: "sandbox")
                .push.canRegister(environment: .sandbox))
        }
        XCTAssertFalse(try health(status: "READY", enabled: false, environment: "sandbox")
            .push.canRegister(environment: .sandbox))
        XCTAssertFalse(try health(status: "READY", enabled: true, environment: "production")
            .push.canRegister(environment: .sandbox))
        XCTAssertTrue(try health(status: "READY", enabled: true, environment: "sandbox")
            .push.canRegister(environment: .sandbox))
    }

    func testUnknownHTTPOrBodyNeverConfirmsRegistrationAndKeepsCleanupCredentials() throws {
        var record = try PushInstallation(installationSecret: secret)
        _ = try record.prepareRegistration(token: token, environment: .sandbox)
        let pending = record
        for status in [202, 204, 301, 400, 401, 429, 500] {
            XCTAssertThrowsError(try record.confirmRegistration(httpStatus: status,
                data: response(record), environment: .sandbox))
            XCTAssertEqual(record, pending)
        }
        for overrides: [String: Any] in [
            ["status": "QUEUED"], ["installationId": UUID().uuidString],
            ["environment": "production"], ["providerStatus": "DISABLED", "deliveryEnabled": true]
        ] {
            XCTAssertThrowsError(try record.confirmRegistration(httpStatus: 200,
                data: response(record, overrides: overrides), environment: .sandbox))
            XCTAssertEqual(record, pending)
        }
        XCTAssertThrowsError(try record.confirmRegistration(httpStatus: 200,
            data: Data(#"{"status":"REGISTERED"}"#.utf8), environment: .sandbox))
        XCTAssertTrue(record.needsCleanup)
        XCTAssertEqual(record.token, token)
        XCTAssertFalse(record.deliveryConfirmed)
    }

    func testRegisteredButDeliveryDisabledStaysPendingUntilExplicitReadyReply() throws {
        var record = try PushInstallation(installationSecret: secret)
        _ = try record.prepareRegistration(token: token, environment: .sandbox)
        XCTAssertFalse(try record.confirmRegistration(httpStatus: 200,
            data: response(record, overrides: ["deliveryEnabled": false, "providerStatus": "NOT_CONFIGURED"]),
            environment: .sandbox))
        XCTAssertTrue(record.wanted)
        XCTAssertTrue(record.mayBeRegistered)
        XCTAssertFalse(record.deliveryConfirmed)
        XCTAssertTrue(try record.confirmRegistration(httpStatus: 200, data: response(record), environment: .sandbox))
        XCTAssertTrue(record.deliveryConfirmed)
    }

    func testDeleteFailurePreservesIdentityAndOnly204ConfirmsClosure() throws {
        var record = try PushInstallation(installationSecret: secret)
        _ = try record.prepareRegistration(token: token, environment: .sandbox)
        _ = try record.confirmRegistration(httpStatus: 200, data: response(record), environment: .sandbox)
        let enabled = record
        for status in [200, 202, 301, 401, 404, 500] {
            XCTAssertThrowsError(try record.confirmDeletion(httpStatus: status))
            XCTAssertEqual(record, enabled)
        }
        try record.confirmDeletion(httpStatus: 204)
        XCTAssertFalse(record.needsCleanup)
        XCTAssertFalse(record.deliveryConfirmed)
        XCTAssertEqual(record.installationId, enabled.installationId)
        XCTAssertEqual(record.installationSecret, enabled.installationSecret)
        XCTAssertEqual(record.token, enabled.token)
    }

    func testDisableIntentSurvivesRestartAndUnknownDeletionCannotResubscribe() throws {
        var record = try PushInstallation(installationSecret: secret)
        _ = try record.prepareRegistration(token: token, environment: .sandbox)
        _ = try record.confirmRegistration(httpStatus: 200, data: response(record), environment: .sandbox)
        record.requestDisable()
        record = try JSONDecoder().decode(PushInstallation.self, from: JSONEncoder().encode(record))
        XCTAssertFalse(record.wanted)
        XCTAssertFalse(record.deliveryConfirmed)
        XCTAssertTrue(record.mayBeRegistered)
        XCTAssertTrue(record.needsCleanup)
        XCTAssertThrowsError(try record.confirmDeletion(httpStatus: 503))
        // A late successful POST response must not override the saved stop intent.
        XCTAssertThrowsError(try record.confirmRegistration(httpStatus: 200,
            data: response(record), environment: .sandbox))
        XCTAssertFalse(record.wanted)
        XCTAssertTrue(record.needsCleanup)
        try record.confirmDeletion(httpStatus: 204)
        XCTAssertFalse(record.needsCleanup)
    }

    func testDisableBeforeAnyPOSTNeedsNoServerCleanupAndTokenRotationRetainsIdentity() throws {
        var record = try PushInstallation(installationSecret: secret)
        record.requestEnable()
        record.requestDisable()
        XCTAssertFalse(record.needsCleanup)
        let initialID = record.installationId
        _ = try record.prepareRegistration(token: token, environment: .sandbox)
        _ = try record.confirmRegistration(httpStatus: 200, data: response(record), environment: .sandbox)
        _ = try record.prepareRegistration(token: String(repeating: "2c", count: 32), environment: .sandbox)
        XCTAssertEqual(record.installationId, initialID)
        XCTAssertEqual(record.installationSecret, secret)
        XCTAssertFalse(record.deliveryConfirmed)
        XCTAssertTrue(record.needsCleanup)
    }

    private func response(_ record: PushInstallation, overrides: [String: Any] = [:]) throws -> Data {
        var fields: [String: Any] = ["installationId": record.installationId.uuidString, "status": "REGISTERED",
            "deliveryEnabled": true, "providerStatus": "READY", "environment": "sandbox"]
        fields.merge(overrides) { _, new in new }
        return try JSONSerialization.data(withJSONObject: fields)
    }

    private func health(status: String, enabled: Bool, environment: String) throws -> PushHealth {
        let data = try JSONSerialization.data(withJSONObject: ["push": [
            "status": status, "enabled": enabled, "environment": environment
        ]] as [String: Any])
        return try JSONDecoder().decode(PushHealth.self, from: data)
    }
}
