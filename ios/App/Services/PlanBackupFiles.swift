import Foundation
import SwiftUI
import UniformTypeIdentifiers
import NabaoCore

/// System file-picker adapter. No plan state is written until PlanStore restores a reviewed preview.
enum PlanBackupFiles {
    static var directory: URL {
        URL.documentsDirectory.appending(path: "备份", directoryHint: .isDirectory)
    }

    static var defaultFilename: String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return "nabao-plans-\(formatter.string(from: Date()))"
    }

    static func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    static func read(_ url: URL) async throws -> Data {
        try await Task.detached(priority: .userInitiated) { try PlanBackupFileReader.read(url) }.value
    }
}

struct PlanBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else { throw PlanBackupError.invalidFile }
        guard contents.count <= PlanBackupCodec.maximumBytes else { throw PlanBackupError.tooLarge }
        data = contents
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

private enum PlanBackupFileReader {
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard attributes.isRegularFile == true, let size = attributes.fileSize, size >= 0 else { throw PlanBackupError.invalidFile }
        guard size <= PlanBackupCodec.maximumBytes else { throw PlanBackupError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        // Also bound reads if the file grows after checking its metadata.
        var data = Data()
        while true {
            let limit = min(64 * 1_024, PlanBackupCodec.maximumBytes + 1 - data.count)
            guard let chunk = try handle.read(upToCount: limit), !chunk.isEmpty else { break }
            data.append(chunk)
            guard data.count <= PlanBackupCodec.maximumBytes else { throw PlanBackupError.tooLarge }
        }
        return data
    }
}
