import type { DailyTableExtraction } from "./daily-table.js";
import type { SourceTable, UnitContexts } from "./daily-table-voting.js";
import type { NoteCapture } from "./types.js";

/** Preserve verified unit evidence only when its exact note, image and cell are unchanged. */
export function retainUnitContexts(previous: SourceTable | undefined, capture: NoteCapture,
  extraction: DailyTableExtraction): UnitContexts {
  const contexts: UnitContexts = structuredClone(extraction.unitContexts ?? {});
  if (!previous?.validationVersion || !extraction.table || !previous.capture.revision
    || previous.capture.revision !== capture.revision || previous.capture.authorId !== capture.authorId
    || previous.capture.noteId !== capture.noteId || previous.table.dataDate !== extraction.table.dataDate) return contexts;
  for (const [code, fields] of Object.entries(previous.unitContexts ?? {})) {
    const oldRow = previous.table.rows.find(r => r.fundCode === code);
    const row = extraction.table.rows.find(r => r.fundCode === code);
    if (!oldRow || !row) continue;
    for (const field of ["distributorLimit", "directLimit"] as const) {
      const context = fields[field];
      if (!context || contexts[code]?.[field] || oldRow[field] !== row[field] || extraction.withdrawnFields?.[code]?.includes(field)) continue;
      const image = capture.images.find(i => i.ordinal === context.imageOrdinal);
      if (!image || image.sha256 !== context.imageSha256 || !/单日|每日|每(?:个)?交易日/.test(context.text)
        || !/元/.test(context.text) || /美元|美金|USD|港元|欧元/.test(context.text)) continue;
      const codes: string[] = context.text.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
      if (codes.length && !codes.includes(code)) continue;
      if (field === "directLimit" && /代销/.test(context.text) && !/直销/.test(context.text)) continue;
      if (field === "distributorLimit" && /直销/.test(context.text) && !/代销/.test(context.text)) continue;
      contexts[code] ??= {}; contexts[code]![field] = structuredClone(context);
    }
  }
  return contexts;
}
