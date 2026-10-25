import SwiftUI
import UniformTypeIdentifiers
import NabaoCore

struct PlanBackupView: View {
    @EnvironmentObject private var store: PlanStore
    @State private var exportDocument: PlanBackupDocument?
    @State private var exporting = false
    @State private var importing = false
    @State private var reading = false
    @State private var preview: PlanBackupPreview?
    @State private var message: String?
    @State private var restoredMessage: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("本机计划", value: "\(store.plans.count) 条")
                LabeledContent("图片指纹", value: "\(store.importedDigests.count) 个")
                Text("备份包含计划和用于避免重复导入的图片指纹，不含截图原图、通知登记信息或凭据。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error = store.storageError {
                Section("原记录需要检查") {
                    Text(error).foregroundStyle(.red)
                    Text("为保留原文件，已停用导出和恢复。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("导出备份") {
                Button {
                    do {
                        try PlanBackupFiles.prepareDirectory()
                        exportDocument = PlanBackupDocument(data: try store.exportBackup())
                        exporting = true
                    } catch { message = error.localizedDescription }
                } label: { Label("导出计划备份", systemImage: "square.and.arrow.up") }
                .disabled(!store.canWrite || reading)
                .accessibilityIdentifier("exportPlanBackup")
                Text("由你选择文件保存位置。nabao 不会将备份发送到后端；请妥善保管包含个人计划的文件。")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("无需云盘，可保存到“我的 iPhone → nabao → 备份”。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("恢复备份") {
                Button {
                    do {
                        try PlanBackupFiles.prepareDirectory()
                        importing = true
                    } catch { message = error.localizedDescription }
                } label: {
                    Label("选择备份文件", systemImage: "square.and.arrow.down")
                }
                .disabled(!store.canWrite || reading)
                .accessibilityIdentifier("importPlanBackup")
                if reading { ProgressView("正在读取备份") }
                Text("先预览新增、相同和冲突的记录，确认后才写入本机。相同记录会跳过；冲突默认保留本机内容，可逐条选择更新。恢复不会删除其他计划。")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("支持 nabao 备份 JSON 文件，最大 5 MB、5,000 条计划。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("计划备份与恢复")
        .accessibilityIdentifier("planBackupView")
        .task {
            do { try PlanBackupFiles.prepareDirectory() }
            catch { message = "无法创建本机备份目录：\(error.localizedDescription)" }
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json,
                      defaultFilename: PlanBackupFiles.defaultFilename) { result in
            switch result {
            case .success: message = "计划备份已导出。恢复时请选择此 JSON 文件。"
            case .failure(let error): if !isCancellation(error) { message = "导出失败：\(error.localizedDescription)" }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                reading = true
                Task {
                    defer { reading = false }
                    do {
                        let data = try await PlanBackupFiles.read(url)
                        preview = try store.previewRestore(data)
                    } catch { message = error.localizedDescription }
                }
            case .failure(let error): if !isCancellation(error) { message = "读取失败：\(error.localizedDescription)" }
            }
        }
        .fileDialogDefaultDirectory(PlanBackupFiles.directory)
        .sheet(item: $preview, onDismiss: {
            if let restoredMessage {
                message = restoredMessage
                self.restoredMessage = nil
            }
        }) { selected in
            PlanRestorePreviewView(preview: selected) { result in
                restoredMessage = "恢复完成：新增 \(result.addedCount) 条，更新 \(result.updatedCount) 条，相同跳过 \(result.identicalCount) 条，冲突保留本机 \(result.keptConflictCount) 条。"
                preview = nil
            }
        }
        .alert("计划备份", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("知道了", role: .cancel) {}
        } message: { Text(message ?? "").accessibilityIdentifier("planBackupResult") }
    }

    private func isCancellation(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == NSCocoaErrorDomain && value.code == NSUserCancelledError
    }


}

private struct PlanRestorePreviewView: View {
    @EnvironmentObject private var store: PlanStore
    @Environment(\.dismiss) private var dismiss
    let preview: PlanBackupPreview
    let onRestored: (PlanBackupMergeResult) -> Void
    @State private var replacements: Set<UUID> = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section("恢复预览") {
                    LabeledContent("新增", value: "\(preview.addedCount) 条")
                    LabeledContent("相同 · 将跳过", value: "\(preview.identicalCount) 条")
                    LabeledContent("冲突 · 默认保留本机", value: "\(preview.conflicts.count) 条")
                    LabeledContent("备份时间", value: preview.archive.exportedAt.formatted(date: .abbreviated, time: .shortened))
                    Text("按每条计划的独立标识核对。同名、同金额的不同计划会分别保留。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if preview.addedCount > 0 {
                    Section("将新增") {
                        ForEach(preview.entries.filter { $0.kind == .added }) { entry in
                            PlanBackupSummary(plan: entry.incoming)
                        }
                    }
                }
                if !preview.conflicts.isEmpty {
                    Section("逐条核对冲突") {
                        ForEach(preview.conflicts) { entry in
                            VStack(alignment: .leading, spacing: 12) {
                                if let existing = entry.existing {
                                    Text("本机内容").font(.caption).foregroundStyle(.secondary)
                                    PlanBackupSummary(plan: existing)
                                }
                                Divider()
                                Text("备份内容").font(.caption).foregroundStyle(.secondary)
                                PlanBackupSummary(plan: entry.incoming)
                                Toggle("用备份内容更新这条记录", isOn: Binding(
                                    get: { replacements.contains(entry.id) },
                                    set: { if $0 { replacements.insert(entry.id) } else { replacements.remove(entry.id) } }
                                ))
                                .accessibilityIdentifier("restoreConflict-\(entry.id.uuidString)")
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
                if preview.identicalCount > 0 {
                    Section("相同 · 不重复添加") {
                        ForEach(preview.entries.filter { $0.kind == .identical }) { entry in
                            PlanBackupSummary(plan: entry.incoming)
                        }
                    }
                }
            }
            .navigationTitle("确认恢复")
            .accessibilityIdentifier("planBackupPreview")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.accessibilityIdentifier("cancelPlanRestore")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("确认恢复") {
                        do { onRestored(try store.restore(preview, replacing: replacements)) }
                        catch { self.error = error.localizedDescription }
                    }
                    .accessibilityIdentifier("confirmPlanRestore")
                }
            }
            .alert("未能恢复", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }
}

private struct PlanBackupSummary: View {
    let plan: Plan
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(plan.fundName).font(.headline)
            Text("\(plan.fundCode ?? "未填代码") · \(plan.channel.title) · \(plan.status.title)")
            Text("¥\(Money.text(plan.amountMinor)) · \(plan.frequency)")
            if let date = plan.nextExecutionDate { Text("下次执行：\(date)") }
            Text("确认于 \(plan.confirmedAt.formatted(date: .abbreviated, time: .standard))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
