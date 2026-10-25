import SwiftUI
import NabaoCore

struct QuotasView: View {
    @EnvironmentObject private var store: PlanStore
    @EnvironmentObject private var tables: DailyTableStore
    @AppStorage("backendBaseURL") private var baseURL = AppConfiguration.defaultBackendURL
    private var table: DailyFundTable? { tables.table }
    private var comparisonTable: DailyFundTable? { tables.comparisonTable }
    private var loading: Bool { tables.loading }
    private var message: String? { tables.message }
    @State private var search = ""
    @State private var filter: TableFilter = .all
    @State private var showingSetup = false
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight = FundMetricsLine.rowHeight
    @ScaledMetric(relativeTo: .caption) private var headerHeight = FundMetricsLine.headerHeight

    private enum TableFilter: String, CaseIterable {
        case all = "全部", available = "有额度", mine = "我的定投"
    }

    private var rows: [DailyFundTable.Row] {
        DailyTableOrdering.distributorDescending(table?.rows.filter { row in
            guard row.matches(search) else { return false }
            switch filter {
            case .all: return true
            case .available: return row.hasPositiveLimit
            case .mine: return row.isInPlans(store.plans)
            }
        } ?? [])
    }
    private var plansWithoutCode: [Plan] {
        store.plans.filter { $0.fundCode?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true }
    }

    private func previousRow(for row: DailyFundTable.Row) -> DailyFundTable.Row? {
        comparisonTable?.rows.first { $0.fundCode == row.fundCode }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                tableSummary
                if table != nil { tableFilters }
                if let message {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(message, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                        Button("检查连接设置") { showingSetup = true }
                    }
                    .font(.footnote)
                    .padding(.horizontal).padding(.bottom, 10)
                }
                if loading && table == nil {
                    Spacer()
                    ProgressView("正在获取额度表").frame(maxWidth: .infinity)
                    Spacer()
                } else if table == nil {
                    ContentUnavailableView {
                        Label(baseURL.isEmpty ? "连接后查看额度" : "暂无额度表", systemImage: "tablecells")
                    } description: {
                        Text(baseURL.isEmpty ? "连接纳宝服务，获取每日额度投票结果。" : "可刷新重试，或检查服务地址。")
                    } actions: {
                        Button("设置服务地址") { showingSetup = true }.buttonStyle(.borderedProminent)
                    }
                } else if rows.isEmpty {
                    if !search.isEmpty {
                        ContentUnavailableView.search(text: search)
                    } else {
                        ContentUnavailableView(filter == .mine ? "暂无匹配的定投" : "暂无明确正数额度",
                            systemImage: filter == .mine ? "list.bullet.rectangle" : "tablecells",
                            description: Text(filter == .mine ? "根据本机定投中已填写的基金代码匹配。" : "有附加条件或待更新的额度请在全部表格中查看。"))
                    }
                } else {
                    // Both sides live inside one vertical scroll. The numeric
                    // side uses one horizontal scroll, so rows cannot drift.
                    GeometryReader { geometry in
                        let tableWidth = max(0, geometry.size.width - 24)
                        let tableHeight = headerHeight + CGFloat(rows.count) * rowHeight
                        ScrollViewReader { reader in
                            VStack(spacing: 0) {
                                columnNavigation(reader)
                                ScrollView(.vertical) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        HStack(alignment: .top, spacing: 0) {
                                            VStack(spacing: 0) {
                                                FundIdentityCell(row: nil)
                                                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                                    NavigationLink { detail(for: row) } label: {
                                                        FundIdentityCell(row: row).background(rowBackground(index))
                                                    }
                                                    .buttonStyle(.plain)
                                                }
                                            }
                                            .frame(width: FundIdentityCell.width, height: tableHeight, alignment: .top)
                                            // An overlay Divider has no HStack axis and can
                                            // become a horizontal rule through the names.
                                            .overlay(alignment: .trailing) {
                                                Color(.separator).opacity(0.24).frame(width: 0.5)
                                            }
                                            .zIndex(1)

                                            ScrollView(.horizontal) {
                                                VStack(spacing: 0) {
                                                    FundMetricsLine(row: nil, previous: nil)
                                                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                                        NavigationLink { detail(for: row) } label: {
                                                            FundMetricsLine(row: row, previous: previousRow(for: row))
                                                                .background(rowBackground(index))
                                                        }
                                                        .buttonStyle(.plain)
                                                    }
                                                }
                                                .frame(width: FundMetricsLine.width)
                                                .fixedSize(horizontal: false, vertical: true)
                                            }
                                            .scrollIndicators(.visible)
                                            .frame(width: max(0, tableWidth - FundIdentityCell.width), height: tableHeight)
                                        }
                                        .frame(width: tableWidth, height: tableHeight, alignment: .topLeading)
                                        .background(Color(.secondarySystemGroupedBackground))
                                        .clipShape(RoundedRectangle(cornerRadius: 16))
                                        .overlay {
                                            RoundedRectangle(cornerRadius: 16)
                                                .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 0.5)
                                        }
                                        .padding(.horizontal, 12)
                                        if let notes = table?.notes, !notes.isEmpty {
                                            DisclosureGroup("表格说明") {
                                                VStack(alignment: .leading, spacing: 8) {
                                                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                                                        Text(note).font(.caption).foregroundStyle(.secondary)
                                                            .frame(maxWidth: .infinity, alignment: .leading)
                                                    }
                                                }
                                                .padding(.top, 8)
                                            }
                                            .font(.caption.weight(.medium))
                                            .tint(.secondary)
                                            .padding()
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                    }
                                    .frame(width: geometry.size.width, alignment: .leading)
                                    .padding(.bottom, 12)
                                }
                                .refreshable { await load() }
                                .accessibilityIdentifier("dailyFundTable")
                            }
                        }
                    }
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("纳指额度")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "基金名称或代码")
            .sheet(isPresented: $showingSetup) {
                BackendSetupView { showingSetup = false }
            }
            .toolbar {
                Button { Task { await load() } } label: {
                    if loading { ProgressView("刷新中") }
                    else { Label("刷新", systemImage: "arrow.clockwise").labelStyle(.titleAndIcon) }
                }
                .disabled(loading)
                .accessibilityLabel("刷新额度表")
                .accessibilityIdentifier("refreshDailyTable")
            }
        }
    }

    private var tableSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Label(table?.dataDate ?? "等待发布", systemImage: "calendar")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let table {
                    Text(rows.count == table.rows.count ? "\(table.rows.count) 个份额" : "\(rows.count) / \(table.rows.count) 份额")
                        .font(.caption.weight(.medium)).monospacedDigit()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                }
            }
            if table != nil {
                if let table, !table.isCurrent() {
                    Text("非今日数据").font(.caption).foregroundStyle(.orange)
                }
            }
            if loading {
                Label("正在刷新额度表…", systemImage: "arrow.clockwise")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("quotaRefreshStatus")
            } else if let refresh = tables.lastRefresh, message == nil {
                Label {
                    Text(refresh.contentChanged ? "刷新成功 · " : "已刷新，内容无变化 · ")
                        + Text(refresh.completedAt, format: .dateTime.hour().minute().second())
                } icon: {
                    Image(systemName: "checkmark.circle").foregroundStyle(.green)
                }
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("quotaRefreshStatus")
            }
        }
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
    }

    private func columnNavigation(_ reader: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            Text("投票结果")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer()
            Button("额度") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    reader.scrollTo("fund-table-header-column-0", anchor: .leading)
                }
            }
                .accessibilityLabel("查看代销和直销额度列")
                .accessibilityIdentifier("showQuotaColumns")
            Button("费率 / 表现") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    reader.scrollTo("fund-table-header-column-4", anchor: .trailing)
                }
            }
                .accessibilityLabel("查看费率、跟踪误差和近一年列")
                .accessibilityIdentifier("showPerformanceColumns")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .font(.caption.weight(.medium))
        .padding(.horizontal, 16).padding(.bottom, 6)
    }

    private var tableFilters: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("额度筛选", selection: $filter) {
                ForEach(TableFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("fundTableFilter")
            if filter == .available {
                Text("至少一栏为明确正数额度；部分渠道、脚注条件请在全部中核对。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if filter == .mine && !plansWithoutCode.isEmpty {
                NavigationLink {
                    List(plansWithoutCode) { plan in
                        NavigationLink { PlanDetailView(planID: plan.id) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(plan.fundName)
                                Text("\(plan.channel.title) · 请核对并补充基金代码")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .navigationTitle("补充基金代码")
                } label: {
                    Label("\(plansWithoutCode.count) 笔定投未填代码，点此补充", systemImage: "info.circle")
                        .font(.caption)
                }
                .accessibilityIdentifier("plansMissingFundCode")
            }
        }
        .padding(.horizontal).padding(.bottom, 6)
    }

    private func detail(for row: DailyFundTable.Row) -> some View {
        FundTableDetailView(fundCode: row.fundCode)
    }

    private func rowBackground(_ index: Int) -> Color {
        index.isMultiple(of: 2) ? Color(.secondarySystemGroupedBackground) : Color(.tertiarySystemGroupedBackground)
    }

    @MainActor private func load() async {
        guard !baseURL.isEmpty else { showingSetup = true; return }
        await tables.load(baseURL: baseURL)
    }
}
