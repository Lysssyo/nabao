import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "./storage.js";
import { reviewedFundAliases } from "./fund-aliases.js";

export interface Fund { code: string; name: string }
export interface FundCatalog { fetchedAt: string; source: string; funds: Fund[] }
const source = "https://fund.eastmoney.com/js/fundcode_search.js";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

function verifiedFunds(input: unknown): Fund[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("CATALOG_FORMAT_INVALID");
  const result = new Map<string, Fund>();
  for (const item of input) {
    if (!item || typeof item !== "object" || typeof item.code !== "string" || !/^\d{6}$/.test(item.code)
      || typeof item.name !== "string" || !item.name.trim() || item.name.length > 300) {
      throw new Error("CATALOG_ROW_INVALID");
    }
    if (result.has(item.code) && result.get(item.code)!.name !== item.name) throw new Error("CATALOG_DUPLICATE_CODE");
    result.set(item.code, { code: item.code, name: item.name });
  }
  return [...result.values()];
}

export function parseFundCatalog(text: string): Fund[] {
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error("CATALOG_TOO_LARGE");
  const match = text.trim().match(/^var\s+r\s*=\s*(\[[\s\S]*\]);?$/);
  if (!match) throw new Error("CATALOG_FORMAT_INVALID");
  const data: unknown = JSON.parse(match[1]!);
  if (!Array.isArray(data)) throw new Error("CATALOG_FORMAT_INVALID");
  return verifiedFunds(data.map((item: unknown) => {
    if (!Array.isArray(item)) throw new Error("CATALOG_ROW_INVALID");
    return { code: item[0], name: item[2] };
  }));
}

export async function loadFundCatalog(directory: string): Promise<FundCatalog> {
  const path = join(directory, "fund-catalog.json");
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES) throw new Error("CATALOG_TOO_LARGE");
    const saved = JSON.parse(raw) as FundCatalog;
    const age = Date.now() - Date.parse(saved.fetchedAt);
    if (saved.source === source && Number.isFinite(age) && age >= 0 && age < 24 * 3600_000) {
      return { ...saved, funds: verifiedFunds(saved.funds) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const response = await fetch(source, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`CATALOG_HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CATALOG_EMPTY");
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_CATALOG_BYTES) { await reader.cancel(); throw new Error("CATALOG_TOO_LARGE"); }
    chunks.push(Buffer.from(next.value));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const catalog: FundCatalog = { source, fetchedAt: new Date().toISOString(), funds: parseFundCatalog(text) };
  await writeJson(path, catalog);
  return catalog;
}

type NameCurrency = "CNY" | "USD" | "USD_REMITTANCE" | "USD_CASH" | null;
function fundNameParts(value: string): { key: string; currency: NameCurrency } {
  let key = value.normalize("NFKC").toUpperCase().replace(/\s|[-—·()（）]/g, "");
  const currency: NameCurrency = /美元现钞|美元钞|美钞/.test(key) ? "USD_CASH"
    : /美元现汇|美元汇|美汇/.test(key) ? "USD_REMITTANCE"
    : /美元|美金|USD/.test(key) ? "USD"
    : /人民币|CNY|RMB/.test(key) ? "CNY" : null;
  key = key.replace(/美元现钞|美元现汇|美元汇|美元钞|人民币|美元|美金|美汇|美钞|CNY|RMB|USD/g, "")
    .replace(/QDIILOF|QDII|LOF/g, "")
    .replace(/发起式|发起|指数型|指数/g, "")
    .replace(/纳指100/g, "纳斯达克100")
    .replace(/([ACIDEF])(?:类|份额)$/, "$1");
  // ETF/联接/科技/生物科技/等权重 and the share-class letters remain
  // significant: removing them would turn related products into the same fund.
  return { key, currency };
}

export function canonicalFundName(value: string): string {
  const parts = fundNameParts(value);
  return `${parts.key}|${parts.currency ?? "UNSPECIFIED"}`;
}

export function resolveFund(
  code: string | null, name: string | null, funds: Fund[], currency: "CNY" | "USD" | "UNSPECIFIED" = "UNSPECIFIED",
): Fund | null {
  const reported = name ? fundNameParts(name) : null;
  if ((!reported?.key && !code) || (code !== null && !/^\d{6}$/.test(code))) return null;
  if (reported?.currency && currency !== "UNSPECIFIED"
    && (reported.currency === "CNY" ? "CNY" : "USD") !== currency) return null;
  const matches = funds.filter((fund) => {
    if (code && fund.code !== code) return false;
    const candidate = fundNameParts(fund.name);
    if (reported?.key && reported.key !== candidate.key) {
      const alias = code && name && reviewedFundAliases.some((reviewed) => reviewed.code === code
        && reviewed.sourceName.normalize("NFKC").replace(/\s/g, "") === name.normalize("NFKC").replace(/\s/g, "")
        && reviewed.catalogName === fund.name);
      if (!alias) return false;
    }
    if (currency === "CNY" && candidate.currency?.startsWith("USD")) return false;
    if (currency === "USD" && !candidate.currency?.startsWith("USD")) return false;
    if (reported?.currency === "CNY" && candidate.currency?.startsWith("USD")) return false;
    if (reported?.currency?.startsWith("USD")) {
      if (!candidate.currency?.startsWith("USD")) return false;
      if (reported.currency !== "USD" && reported.currency !== candidate.currency) return false;
    }
    return true;
  });
  // A missing currency must not silently choose the CNY share over a USD
  // alternative. An explicit six-digit code can disambiguate those products.
  if (matches.length !== 1) return null;
  const only = matches[0]!;
  // Some catalogs omit the share-class suffix on a USD product while its CNY
  // alternatives are named A/C. A short unsuffixed source name must not
  // accidentally resolve to that sole exact USD match.
  if (!code && currency === "UNSPECIFIED" && !reported?.currency
    && fundNameParts(only.name).currency?.startsWith("USD")) return null;
  return only;
}
