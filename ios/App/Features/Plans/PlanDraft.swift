import Foundation
import NabaoCore

struct PlanDraft: Identifiable {
    var id = UUID()
    var fundName = ""
    var fundCode = ""
    var channel: Channel = .unknown
    var amount = ""
    var frequency = "每日"
    var nextDate = ""
    var status: PlanStatus = .active
    var notes: [String] = []
    var imageDigest: String?
    var selected = true

    init() {}

    init(plan: Plan) {
        id = plan.id
        fundName = plan.fundName
        fundCode = plan.fundCode ?? ""
        channel = plan.channel
        amount = Money.text(plan.amountMinor)
        frequency = plan.frequency
        nextDate = plan.nextExecutionDate ?? ""
        status = plan.status
    }

    init(parsed: ParsedPlan, digest: String) {
        fundName = parsed.fundName
        fundCode = parsed.fundCode ?? ""
        channel = parsed.channel
        amount = Money.text(parsed.amountMinor)
        frequency = parsed.frequency
        nextDate = parsed.nextExecutionDate ?? ""
        notes = parsed.notes
        imageDigest = digest
    }

    var isValid: Bool {
        validationMessage == nil
    }

    var validationMessage: String? {
        PlanBackupCodec.planValidationMessage(plan())
    }

    func plan() -> Plan {
        Plan(id: id, fundName: fundName.trimmingCharacters(in: .whitespaces),
             fundCode: fundCode.isEmpty ? nil : fundCode, channel: channel,
             amountMinor: Money.minorUnits(amount) ?? 0,
             frequency: frequency, nextExecutionDate: nextDate.isEmpty ? nil : nextDate,
             status: status, confirmedAt: Date())
    }
}

struct ReviewBatch: Identifiable {
    let id = UUID()
    var drafts: [PlanDraft]
    var messages: [String] = []
    var isEditing = false
}
