import Foundation
import UserNotifications
import NabaoCore

/// Exercises the real app state machine with in-memory identities and controlled
/// async responses. Never reads Keychain, contacts a backend, or requests permission.
@main
struct RemotePushSettingsChecks {
    @MainActor static func main() async throws {
        try await slowStartupCheckDoesNotBlockSave()
        try await staleChecksCannotReplaceNewStatus()
        try await failedCleanupRetainsOldScope()
        try await successfulCleanupPrecedesSwitchAndSerializesSaves()
        try await keychainFailureDoesNotBypassCleanup()
        try await noAPNsCanSaveWithoutNetwork()
        try await invalidAddressKeepsCurrentCheck()
        try await firstConnectionDoesNotRequireAnOldAddress()
        print("RemotePushStore settings checks passed (8 scenarios)")
    }

    @MainActor static func slowStartupCheckDoesNotBlockSave() async throws {
        let fake = FakePush()
        let store = RemotePushStore(dependencies: fake.dependencies)
        let initial = Task { await store.resume(baseURL: fake.old.identityScope) }
        try await until { fake.healthCalls.count == 1 }
        try require(store.isCheckingService && !store.isBusy, "Startup read-only check blocked settings")
        let selected = try await store.changeBackend(from: fake.old.identityScope, to: " HTTP://Admin.local:18081/ ")
        try require(selected == fake.next.identityScope, "Address was not normalized")
        try require(fake.healthCalls.count == 1 && !store.isCheckingService, "Save awaited new health or failed to cancel old check")
        let savedStatus = store.statusText
        // The fake deliberately ignores cancellation, as a late framework callback can.
        fake.completeHealth(0, status: "READY")
        await initial.value
        try require(store.statusText == savedStatus && !store.canEnable && !store.isBusy,
                    "Late startup check overwrote the newly selected backend")
    }

    @MainActor static func staleChecksCannotReplaceNewStatus() async throws {
        let fake = FakePush()
        let store = RemotePushStore(dependencies: fake.dependencies)
        let oldCheck = Task { await store.refresh(baseURL: fake.old.identityScope) }
        try await until { fake.healthCalls.count == 1 }
        let newCheck = Task { await store.refresh(baseURL: fake.next.identityScope) }
        try await until { fake.healthCalls.count == 2 }
        fake.completeHealth(1, status: "DISABLED")
        await newCheck.value
        let status = store.statusText
        fake.completeHealth(0, status: "READY")
        await oldCheck.value
        try require(!store.canEnable && !store.isCheckingService && store.statusText == status,
                    "Old response changed a newer service check")
    }

    @MainActor static func failedCleanupRetainsOldScope() async throws {
        let fake = FakePush()
        fake.records[fake.old.identityScope] = try registeredRecord()
        fake.deleteStatus = 503
        let store = RemotePushStore(dependencies: fake.dependencies)
        do {
            _ = try await store.changeBackend(from: fake.old.identityScope, to: fake.next.identityScope)
            throw CheckFailure(message: "Failed cleanup incorrectly committed a new address")
        } catch is CheckFailure { throw CheckFailure(message: "Failed cleanup incorrectly committed a new address") }
        catch {}
        let retained = fake.records[fake.old.identityScope]
        try require(retained?.mayBeRegistered == true && retained?.wanted == false,
                    "Unconfirmed deletion lost identity or retained auto-enable intent")
        try require(fake.loads == [fake.old.identityScope] && store.needsCleanup && !store.isBusy,
                    "Failed cleanup selected the new scope or left the store locked")
        try require(fake.healthCalls.isEmpty, "Cleanup attempted unrelated health calls")
    }

    @MainActor static func successfulCleanupPrecedesSwitchAndSerializesSaves() async throws {
        let fake = FakePush()
        fake.records[fake.old.identityScope] = try registeredRecord()
        fake.holdDeletion = true
        let store = RemotePushStore(dependencies: fake.dependencies)
        let first = Task { try await store.changeBackend(from: fake.old.identityScope, to: fake.next.identityScope) }
        try await until { fake.deletions.count == 1 }
        try require(store.isBusy && fake.loads == [fake.old.identityScope], "New scope selected before old deletion completed")
        do {
            _ = try await store.changeBackend(from: fake.old.identityScope, to: "http://other.local:18081")
            throw CheckFailure(message: "Concurrent save bypassed subscription serialization")
        } catch is CheckFailure { throw CheckFailure(message: "Concurrent save bypassed subscription serialization") }
        catch {}
        fake.deletionContinuation?.resume(returning: 204)
        fake.deletionContinuation = nil
        let selected = try await first.value
        try require(selected == fake.next.identityScope && fake.loads.last == fake.next.identityScope,
                    "Confirmed deletion did not allow switch")
        try require(fake.records[fake.old.identityScope]?.needsCleanup == false && !store.isBusy,
                    "Confirmed cleanup was not persisted")
        try require(fake.deletions.count == 1 && fake.healthCalls.isEmpty, "Duplicate mutation or health-gated save")
    }

    @MainActor static func keychainFailureDoesNotBypassCleanup() async throws {
        let fake = FakePush()
        fake.failLoad = true
        let store = RemotePushStore(dependencies: fake.dependencies)
        do {
            _ = try await store.changeBackend(from: fake.old.identityScope, to: fake.next.identityScope)
            throw CheckFailure(message: "Unreadable identity was bypassed")
        } catch is CheckFailure { throw CheckFailure(message: "Unreadable identity was bypassed") }
        catch {}
        try require(fake.saves.isEmpty && fake.deletions.isEmpty && !store.isBusy,
                    "Identity read failure mutated records or left a lock")
    }

    @MainActor static func noAPNsCanSaveWithoutNetwork() async throws {
        let fake = FakePush()
        fake.environment = nil
        let store = RemotePushStore(dependencies: fake.dependencies)
        await store.resume(baseURL: fake.old.identityScope)
        let selected = try await store.changeBackend(from: fake.old.identityScope, to: fake.next.identityScope)
        try require(selected == fake.next.identityScope && fake.healthCalls.isEmpty && !store.isBusy,
                    "Basic address saving required APNs or network health")
        try require(fake.loads.contains(fake.old.identityScope) && fake.loads.contains(fake.next.identityScope),
                    "No-APNs path bypassed scoped identity reads")
    }

    @MainActor static func invalidAddressKeepsCurrentCheck() async throws {
        let fake = FakePush()
        let store = RemotePushStore(dependencies: fake.dependencies)
        let check = Task { await store.refresh(baseURL: fake.old.identityScope) }
        try await until { fake.healthCalls.count == 1 }
        do {
            _ = try await store.changeBackend(from: fake.old.identityScope, to: "not a URL")
            throw CheckFailure(message: "Invalid address accepted")
        } catch is CheckFailure { throw CheckFailure(message: "Invalid address accepted") }
        catch {}
        try require(store.isCheckingService && !store.isBusy && fake.saves.isEmpty,
                    "Invalid input changed state or stopped current service check")
        fake.completeHealth(0, status: "DISABLED")
        await check.value
    }

    @MainActor static func firstConnectionDoesNotRequireAnOldAddress() async throws {
        let fake = FakePush()
        fake.environment = nil
        let store = RemotePushStore(dependencies: fake.dependencies)
        let selected = try await store.changeBackend(from: "", to: fake.next.identityScope)
        try require(selected == fake.next.identityScope && fake.loads == [fake.next.identityScope],
                    "First connection required a fabricated old backend")
        try require(fake.healthCalls.isEmpty && fake.deletions.isEmpty && !store.isBusy,
                    "First connection unexpectedly contacted push services")
    }

    static func registeredRecord() throws -> PushInstallation {
        var record = try PushInstallation(installationSecret: String(repeating: "a", count: 64))
        _ = try record.prepareRegistration(token: String(repeating: "1b", count: 32), environment: .sandbox)
        return record
    }

    @MainActor static func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<10_000 {
            if predicate() { return }
            await Task.yield()
        }
        throw CheckFailure(message: "Controlled async operation did not start")
    }

    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw CheckFailure(message: message) }
    }
}

private struct CheckFailure: Error { let message: String }

@MainActor
private final class FakePush {
    let old = try! PushBackend("http://127.0.0.1:8080")
    let next = try! PushBackend("http://admin.local:18081")
    var environment: PushEnvironment? = .sandbox
    var records: [String: PushInstallation] = [:]
    var loads: [String] = []
    var saves: [String] = []
    var deletions: [String] = []
    var healthCalls: [String] = []
    var healthContinuations: [Int: CheckedContinuation<PushHealth.Provider, Error>] = [:]
    var failLoad = false
    var deleteStatus = 204
    var holdDeletion = false
    var deletionContinuation: CheckedContinuation<Int, Never>?

    var dependencies: RemotePushDependencies {
        RemotePushDependencies(
            environment: { self.environment },
            load: {
                self.loads.append($0.identityScope)
                if self.failLoad { throw URLError(.cannotOpenFile) }
                return self.records[$0.identityScope]
            },
            save: { self.records[$1.identityScope] = $0; self.saves.append($1.identityScope) },
            randomSecret: { String(repeating: "b", count: 64) },
            health: { backend in
                let index = self.healthCalls.count
                self.healthCalls.append(backend.identityScope)
                return try await withCheckedThrowingContinuation { self.healthContinuations[index] = $0 }
            },
            authorizationStatus: { .authorized },
            requestAuthorization: { true },
            registerForRemoteNotifications: {},
            register: { _, _ in throw URLError(.unsupportedURL) },
            unregister: { _, backend in
                self.deletions.append(backend.identityScope)
                if self.holdDeletion {
                    return await withCheckedContinuation { self.deletionContinuation = $0 }
                }
                return self.deleteStatus
            }
        )
    }

    func completeHealth(_ index: Int, status: String) {
        let json = Data("{\"push\":{\"enabled\":true,\"status\":\"\(status)\",\"environment\":\"sandbox\"}}".utf8)
        let provider = try! JSONDecoder().decode(PushHealth.self, from: json).push
        healthContinuations.removeValue(forKey: index)?.resume(returning: provider)
    }
}
