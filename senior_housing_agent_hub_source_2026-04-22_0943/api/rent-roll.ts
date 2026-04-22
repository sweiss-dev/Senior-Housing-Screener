import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as XLSX from "xlsx";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type NormalizedRentRollRow = {
  sourceSheet?: string;
  sourceRow?: number;
  resident?: string;
  unit?: string;
  rollupLabel?: string;
  serviceType: "IL" | "AL" | "MC" | "Unknown";
  unitType: "Shared" | "Studio" | "Studio Deluxe" | "1 BR" | "2 BR" | "Other" | "Unknown";
  occupancyType: "Private" | "Companion" | "Shared" | "Second Resident" | "Vacant" | "Unknown";
  includedInRollup: boolean;
  units: number;
  beds: number;
  residents: number;
  baseRent: number;
  careFees: number;
  totalRevenue: number;
  confidence: number;
  notes?: string;
  rawText?: string;
};

type SummaryRow = {
  serviceType: string;
  unitType: string;
  units: number;
  beds: number;
  residents: number;
  occupancy: number | null;
  baseRent: number;
  careFees: number;
  totalRevenue: number;
  averageBaseRent: number | null;
  averageCareFees: number | null;
  averageTotalRevenue: number | null;
};

type UnderwritingSummaryRow = SummaryRow & {
  label: string;
  unitCategory: string;
};

type StandardRollupBucket = {
  label: string;
  serviceType: "IL" | "AL" | "MC";
  unitCategory: string;
  match: (row: NormalizedRentRollRow) => boolean;
};

type ParsedInput = {
  rows: NormalizedRentRollRow[];
  sourceNotes: string[];
  detectedColumns?: Record<string, string | null>;
};

type ClassificationRule = {
  target: string;
  patterns: string[];
};

type ClassificationHints = {
  unitTypeRules: ClassificationRule[];
  serviceTypeRules: ClassificationRule[];
};

const SERVICE_ORDER = ["IL", "AL", "MC", "Unknown"];
const UNIT_ORDER = ["Shared", "Studio", "Studio Deluxe", "1 BR", "2 BR", "Other", "Unknown"];
const STANDARD_UNDERWRITING_BUCKETS: StandardRollupBucket[] = [
  { label: "IL Shared", serviceType: "IL", unitCategory: "Shared", match: (row) => isSharedRow(row) },
  { label: "IL Studio", serviceType: "IL", unitCategory: "Studio", match: (row) => isStudioRow(row) },
  { label: "IL 1 BR", serviceType: "IL", unitCategory: "1 BR", match: (row) => row.unitType === "1 BR" },
  { label: "IL 2 BR", serviceType: "IL", unitCategory: "2 BR", match: (row) => row.unitType === "2 BR" },
  { label: "AL Shared", serviceType: "AL", unitCategory: "Shared", match: (row) => isSharedRow(row) },
  { label: "AL Studio", serviceType: "AL", unitCategory: "Studio", match: (row) => isStudioRow(row) },
  { label: "AL 1 BR", serviceType: "AL", unitCategory: "1 BR", match: (row) => row.unitType === "1 BR" },
  { label: "AL 2 BR", serviceType: "AL", unitCategory: "2 BR", match: (row) => row.unitType === "2 BR" },
  { label: "MC Shared", serviceType: "MC", unitCategory: "Shared", match: (row) => isSharedRow(row) },
  { label: "MC Private", serviceType: "MC", unitCategory: "Private", match: (row) => !isSharedRow(row) },
];

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const fileName = String(req.body?.fileName ?? "").trim();
  const mimeType = String(req.body?.mimeType ?? "").trim();
  const dataBase64 = String(req.body?.dataBase64 ?? "").trim();
  const classificationHints = parseClassificationHints(String(req.body?.classificationHints ?? ""));

  if (!fileName || !dataBase64) {
    res.status(400).json({ error: "Upload a rent roll file to analyze." });
    return;
  }

  try {
    const buffer = Buffer.from(dataBase64, "base64");
    const parsed = await parseRentRoll(buffer, fileName, mimeType, classificationHints);
    const rows = parsed.rows;
    const rollupRows = rows.filter((row) => row.includedInRollup);
    const standardRows = getStandardRollupRows(rollupRows);
    const underwritingSummary = summarizeUnderwriting(rollupRows);
    const serviceSummary = summarize(standardRows, ["serviceType"]);
    const serviceUnitSummary = summarize(standardRows, ["serviceType", "unitType"]);
    const totals = aggregate(standardRows);
    const confidence = rows.length
      ? Number((rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length).toFixed(2))
      : 0;

    res.status(200).json({
      fileName,
      mimeType,
      generatedAt: new Date().toISOString(),
      totals,
      confidence,
      rowsParsed: rows.length,
      rowsIncluded: rollupRows.length,
      underwritingSummary,
      serviceSummary,
      serviceUnitSummary,
      detailRows: rows.slice(0, 500),
      detectedColumns: parsed.detectedColumns ?? {},
      notes: buildNotes(rows, rollupRows, standardRows, parsed.sourceNotes, classificationHints),
      methodology: [
        "The analyzer normalizes each occupied or vacant unit row into service type, unit type, occupancy type, units, beds, residents, base rent, care fees, and total revenue.",
        "The underwriting rollup follows the common operator rent-roll format: Total Units counts primary unit rows, Residents counts primary unit rows with in-place base rent, Occupancy equals Residents divided by Total Units, and Total Rent sums in-place total actual rent for those same primary unit rows.",
        "Second-resident rows are excluded from the underwriting rollup unless the uploaded rent roll assigns them a primary unit-type/service rollup label.",
        "Optional classification hints are applied before built-in heuristics so recurring operator-specific labels can be mapped into Shared, Studio, 1 BR, 2 BR, IL, AL, and MC buckets.",
        "Excel and CSV files are parsed from worksheet rows after detecting the most likely header row and mapping common rent-roll column names.",
        "PDF files are text-extracted and parsed with layout heuristics; scanned PDFs or highly formatted rent rolls may require Excel/CSV export for best accuracy.",
        "Companion/shared units are counted as two beds; private units are counted as one bed unless the row explicitly indicates a higher bed count.",
      ],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not analyze this rent roll. Try an Excel, CSV, or text-selectable PDF file." });
  }
}

async function parseRentRoll(buffer: Buffer, fileName: string, mimeType: string, hints: ClassificationHints): Promise<ParsedInput> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf") || mimeType.includes("pdf")) {
    return parsePdfRentRoll(buffer, hints);
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || mimeType.includes("csv") || mimeType.includes("text")) {
    return parseWorkbookRentRoll(buffer, fileName, true, hints);
  }
  if (/\.(xlsx|xls|xlsm|xlsb)$/i.test(fileName) || mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
    return parseWorkbookRentRoll(buffer, fileName, false, hints);
  }
  return parseWorkbookRentRoll(buffer, fileName, false, hints);
}

function parseWorkbookRentRoll(buffer: Buffer, fileName: string, forceCsv: boolean, hints: ClassificationHints): ParsedInput {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    raw: false,
    dense: false,
    WTF: false,
  });

  const rows: NormalizedRentRollRow[] = [];
  const sourceNotes: string[] = [];
  let bestDetectedColumns: Record<string, string | null> | undefined;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    if (!matrix.length) continue;

    const headerInfo = detectHeaderRow(matrix);
    if (!headerInfo) {
      sourceNotes.push(`Skipped sheet "${sheetName}" because no likely rent-roll header row was detected.`);
      continue;
    }
    if (!bestDetectedColumns) bestDetectedColumns = headerInfo.detectedColumns;

    for (let index = headerInfo.headerRowIndex + 1; index < matrix.length; index += 1) {
      const row = matrix[index] ?? [];
      if (isBlankRow(row)) continue;
      const record = rowToRecord(row, headerInfo.headers);
      const normalized = normalizeRecord(record, {
        sourceSheet: sheetName,
        sourceRow: index + 1,
        rawText: row.join(" | "),
      }, hints);
      if (shouldKeepRow(normalized, record)) rows.push(normalized);
    }
  }

  if (!rows.length && forceCsv) {
    sourceNotes.push(`No structured rows were detected in ${fileName}. Check whether the file has a header row with unit, service, rent, and fee columns.`);
  }

  return { rows, sourceNotes, detectedColumns: bestDetectedColumns };
}

async function parsePdfRentRoll(buffer: Buffer, hints: ClassificationHints): Promise<ParsedInput> {
  const { PDFParse } = require("pdf-parse") as { PDFParse: new (options: { data: Buffer }) => { getText: () => Promise<{ text?: string; total?: number }> } };
  const parser = new PDFParse({ data: buffer });
  const pdf = await parser.getText();
  const text = pdf.text || "";
  const rows: NormalizedRentRollRow[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 8);

  const tableRows = parseTextTableLines(lines, hints);
  if (tableRows.rows.length) {
    return {
      rows: tableRows.rows,
      sourceNotes: [
        `Extracted selectable text from ${pdf.total ?? "the"} PDF page(s).`,
        ...tableRows.sourceNotes,
      ],
      detectedColumns: tableRows.detectedColumns,
    };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeRecord({ raw: line, description: line }, {
      sourceSheet: "PDF text",
      sourceRow: index + 1,
      rawText: line,
    }, hints);
    if (shouldKeepRow(normalized, { raw: line })) rows.push(normalized);
  }

  return {
    rows,
    sourceNotes: [
      `Extracted selectable text from ${pdf.total ?? "the"} PDF page(s).`,
      "PDF rows were parsed from text lines because no clear fixed-width table header was detected.",
    ],
  };
}

function parseTextTableLines(lines: string[], hints: ClassificationHints): ParsedInput {
  const matrix = lines.map((line) => splitTextColumns(line));
  const headerInfo = detectHeaderRow(matrix);
  if (!headerInfo) return { rows: [], sourceNotes: [] };
  const rows: NormalizedRentRollRow[] = [];
  for (let index = headerInfo.headerRowIndex + 1; index < matrix.length; index += 1) {
    const row = matrix[index] ?? [];
    if (row.length < 2 || isBlankRow(row)) continue;
    const record = rowToRecord(row, headerInfo.headers);
    const normalized = normalizeRecord(record, {
      sourceSheet: "PDF table",
      sourceRow: index + 1,
      rawText: row.join(" | "),
    }, hints);
    if (shouldKeepRow(normalized, record)) rows.push(normalized);
  }
  return {
    rows,
    sourceNotes: ["Detected a likely table header in the PDF text extraction."],
    detectedColumns: headerInfo.detectedColumns,
  };
}

function splitTextColumns(line: string) {
  const columns = line.split(/\s{2,}|\t+/).map((value) => value.trim()).filter(Boolean);
  return columns.length > 1 ? columns : line.split(/\s+\|\s+/).map((value) => value.trim()).filter(Boolean);
}

function detectHeaderRow(matrix: string[][]) {
  let best: { index: number; score: number; headers: string[]; detectedColumns: Record<string, string | null> } | null = null;
  const maxRows = Math.min(matrix.length, 35);
  for (let index = 0; index < maxRows; index += 1) {
    const row = matrix[index] ?? [];
    const headers = row.map((value, colIndex) => cleanHeader(value) || `Column ${colIndex + 1}`);
    const score = headers.reduce((sum, header) => sum + headerScore(header), 0);
    const uniqueNonBlank = new Set(headers.filter((header) => !/^Column \d+$/.test(header))).size;
    const adjusted = score + Math.min(uniqueNonBlank, 8) * 0.2;
    if (!best || adjusted > best.score) {
      best = {
        index,
        score: adjusted,
        headers,
        detectedColumns: detectColumns(headers),
      };
    }
  }
  if (!best || best.score < 2.4) return null;
  return {
    headerRowIndex: best.index,
    headers: dedupeHeaders(best.headers),
    detectedColumns: best.detectedColumns,
  };
}

function headerScore(header: string) {
  const h = header.toLowerCase();
  let score = 0;
  if (/\b(unit|room|apt|apartment|suite)\b/.test(h)) score += 1.2;
  if (/\b(resident|tenant|occupant|name)\b/.test(h)) score += 0.8;
  if (/\b(service|care level|level of care|loc|product|program)\b/.test(h)) score += 1.2;
  if (/\b(unit type|room type|bed type|floor plan|accommodation)\b/.test(h)) score += 1.2;
  if (/\b(occupancy|private|companion|shared|bed)\b/.test(h)) score += 0.9;
  if (/\b(base rent|market rent|monthly rent|rent|rate)\b/.test(h)) score += 1.2;
  if (/\b(care|level fee|service fee|ancillary|ala carte|assessment)\b/.test(h)) score += 1.1;
  if (/\b(total|revenue|monthly charge|gross)\b/.test(h)) score += 1.0;
  if (/\b(move|lease|payor|payer|status)\b/.test(h)) score += 0.3;
  return score;
}

function detectColumns(headers: string[]) {
  return {
    resident: findHeader(headers, [/\bresident\b/, /\btenant\b/, /\boccupant\b/, /\bname\b/]),
    unit: findHeader(headers, [/\bunit\b/, /\broom\b/, /\bapt\b/, /\bapartment\b/, /\bsuite\b/]),
    serviceType: findHeader(headers, [/\bservice\b/, /\bcare level\b/, /\blevel of care\b/, /\bloc\b/, /\bprogram\b/, /\bproduct\b/]),
    unitType: findHeader(headers, [/\bunit type\b/, /\bunit\s+type\b/, /\broom type\b/, /\bfloor plan\b/, /\baccommodation\b/, /\bbed type\b/]),
    occupancyType: findHeader(headers, [/\boccupancy\b/, /\bocc\b/, /\bprivate\b/, /\bcompanion\b/, /\bshared\b/]),
    beds: findHeader(headers, [/\bbeds?\b/, /\bbed count\b/]),
    baseRent: findHeader(headers, [/\bbase\s+actual\s+rate\b/, /\bbase rent\b/, /\bbase rate\b/, /\bmarket rent\b/, /\bmonthly rent\b/, /^rent$/, /\brates?\b/]),
    careFees: findHeader(headers, [/\bcare\s+actual\s+rate\b/, /\bcare fee\b/, /\bcare\b/, /\bservice fee\b/, /\blevel fee\b/, /\bancillary\b/, /\bassessment\b/]),
    medicationFees: findHeader(headers, [/\bmedication\s+actual\s+rate\b/, /\bmed actual\b/, /\bmedication fee\b/]),
    continenceFees: findHeader(headers, [/\bcontinence\s+actual\s+rate\b/, /\bcontinence fee\b/]),
    otherFees: findHeader(headers, [/\bother\s+actual\s+rate\b/, /\bother recurring\b/]),
    totalRevenue: findHeader(headers, [/\btotal\s+actual\s+rate\b/, /\btotal revenue\b/, /\btotal rent\b/, /\bmonthly charge\b/, /\btotal charge\b/, /\bgross\b/, /\btotal\b/]),
  };
}

function findHeader(headers: string[], patterns: RegExp[]) {
  const found = headers.find((header) => patterns.some((pattern) => pattern.test(header.toLowerCase())));
  return found ?? null;
}

function rowToRecord(row: string[], headers: string[]) {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = stringify(row[index]);
  });
  return record;
}

function normalizeRecord(record: Record<string, string>, meta: Partial<NormalizedRentRollRow>, hints: ClassificationHints): NormalizedRentRollRow {
  const allText = Object.values(record).join(" ");
  const rollupLabel = valueFor(record, ["column 7"]) || valueFor(record, ["unit service type"]);
  const serviceText = valueFor(record, ["unit service type", "service type", "service", "level of care", "loc", "program", "product"]) || rollupLabel || allText;
  const unitTypeText = valueFor(record, ["unit type", "room type", "floor plan", "accommodation", "bed type"]) || rollupLabel || allText;
  const occupancyText = valueFor(record, ["private/semi-private indicator", "private", "semi-private", "occupancy", "occ", "status"]) || allText;
  const rentText = valueFor(record, ["base actual rate", "base rent", "base rate", "market rent", "monthly rent", "rent"]);
  const careActual = extractMoney(valueFor(record, ["care actual rate", "care fee", "service fee", "level fee", "assessment"])) ?? 0;
  const medicationActual = extractMoney(valueFor(record, ["medication actual rate", "med actual", "medication fee"])) ?? 0;
  const continenceActual = extractMoney(valueFor(record, ["continence actual rate", "continence fee"])) ?? 0;
  const otherActual = extractMoney(valueFor(record, ["other actual rate"])) ?? 0;
  const totalText = valueFor(record, ["total actual rate", "total revenue", "total rent", "monthly charge", "total charge", "gross", "total"]);
  const explicitBeds = asNumber(valueFor(record, ["beds", "bed count"]));
  const baseRent = extractMoney(rentText) ?? extractMoneyNear(allText, ["base actual rate", "base rent", "market rent", "rent"]);
  const careFees = careActual + medicationActual + continenceActual;
  const totalRevenue =
    extractMoney(totalText) ??
    extractMoneyNear(allText, ["total actual rate", "total revenue", "total rent", "monthly charge", "total"]) ??
    (baseRent || careFees || otherActual ? (baseRent ?? 0) + careFees + otherActual : 0);
  const serviceType = classifyService(serviceText, hints);
  const unitType = classifyUnitType(unitTypeText, hints);
  const occupancyType = classifyOccupancy(occupancyText);
  const resident = valueFor(record, ["resident", "tenant", "occupant", "resident id", "name"]) || undefined;
  const isVacant = isVacantResident(resident, occupancyText, allText, totalRevenue);
  const isSecondResident = occupancyType === "Second Resident";
  const includedInRollup = !isSecondResident;
  const units = includedInRollup ? 1 : 0;
  const residents = isVacant ? 0 : totalRevenue > 0 || resident ? 1 : 0;
  const beds = includedInRollup ? (explicitBeds ?? inferBeds(occupancyType, unitType, allText)) : 0;
  const confidence = calculateConfidence({ serviceType, unitType, occupancyType, baseRent, careFees, totalRevenue, allText });
  const notes = [];
  if (serviceType === "Unknown") notes.push("service type not detected");
  if (unitType === "Unknown") notes.push("unit type not detected");
  if (!baseRent && !careFees && !totalRevenue) notes.push("no rent or fee amount detected");
  if (isSecondResident) notes.push("second-resident row excluded from unit count");

  return {
    sourceSheet: meta.sourceSheet,
    sourceRow: meta.sourceRow,
    resident,
    unit: valueFor(record, ["unit", "room", "apt", "apartment", "suite"]) || undefined,
    rollupLabel: cleanRollupLabel(rollupLabel) || undefined,
    serviceType,
    unitType,
    occupancyType: isVacant ? "Vacant" : occupancyType,
    includedInRollup,
    units,
    beds,
    residents,
    baseRent: baseRent ?? 0,
    careFees: careFees ?? 0,
    totalRevenue,
    confidence,
    notes: notes.join("; ") || undefined,
    rawText: meta.rawText,
  };
}

function shouldKeepRow(row: NormalizedRentRollRow, record: Record<string, string>) {
  const text = Object.values(record).join(" ").toLowerCase();
  if (!text.trim()) return false;
  if (/subtotal|grand total|total occupied|total vacant|summary|average|weighted average/.test(text)) return false;
  if (text.length < 5) return false;
  const hasMoney = row.baseRent > 0 || row.careFees > 0 || row.totalRevenue > 0;
  const hasUnitSignal = Boolean(row.unit || row.resident || row.serviceType !== "Unknown" || row.unitType !== "Unknown");
  return hasMoney || hasUnitSignal;
}

function classifyService(value: string, hints: ClassificationHints): NormalizedRentRollRow["serviceType"] {
  const text = value.toLowerCase();
  const hinted = applyRules(text, hints.serviceTypeRules);
  if (hinted === "IL" || hinted === "AL" || hinted === "MC") return hinted;
  if (/\b(memory care|memory|mc|alzheimer|dementia)\b/.test(text)) return "MC";
  if (/\b(assisted living|assisted|al)\b/.test(text)) return "AL";
  if (/\b(independent living|independent|il)\b/.test(text)) return "IL";
  return "Unknown";
}

function classifyUnitType(value: string, hints: ClassificationHints): NormalizedRentRollRow["unitType"] {
  const text = value.toLowerCase();
  const hinted = applyRules(text, hints.unitTypeRules);
  if (hinted === "Shared" || hinted === "Studio" || hinted === "Studio Deluxe" || hinted === "1 BR" || hinted === "2 BR" || hinted === "Other") return hinted;
  if (/\b(shared|semi-private|semiprivate|companion|double occupancy)\b/.test(text)) return "Shared";
  if (/\b(stud[_\s-]*dlx|studio\s+deluxe|stud\s+deluxe)\b/.test(text)) return "Studio Deluxe";
  if (/\b(stud|studio|efficiency)\b/.test(text)) return "Studio";
  if (/\b(2\s*(br|bd|bed|bedroom)|two\s*(br|bd|bed|bedroom))\b/.test(text)) return "2 BR";
  if (/\b(1\s*(br|bd|bed|bedroom)|one\s*(br|bd|bed|bedroom))\b/.test(text)) return "1 BR";
  if (/\b(cottage|villa|deluxe|alcove)\b/.test(text)) return "Other";
  return "Unknown";
}

function classifyOccupancy(value: string): NormalizedRentRollRow["occupancyType"] {
  const text = value.toLowerCase();
  if (/\b(vacant|available|empty)\b/.test(text)) return "Vacant";
  if (/\b(second resident|second occupant|2nd resident|2nd occupant)\b/.test(text)) return "Second Resident";
  if (/\b(companion|double occupancy|semi-private|semiprivate)\b/.test(text)) return "Companion";
  if (/\b(shared)\b/.test(text)) return "Shared";
  if (/\b(private|single occupancy|single)\b/.test(text)) return "Private";
  return "Unknown";
}

function inferBeds(occupancyType: NormalizedRentRollRow["occupancyType"], unitType: NormalizedRentRollRow["unitType"], text: string) {
  const lower = text.toLowerCase();
  const explicit = lower.match(/\b([1-4])\s*beds?\b/);
  if (explicit) return Number(explicit[1]);
  if (occupancyType === "Companion" || occupancyType === "Shared" || unitType === "Shared") return 2;
  if (unitType === "2 BR" && /\bcompanion|shared|double\b/.test(lower)) return 2;
  return 1;
}

function calculateConfidence(input: {
  serviceType: string;
  unitType: string;
  occupancyType: string;
  baseRent: number | null | undefined;
  careFees: number | null | undefined;
  totalRevenue: number;
  allText: string;
}) {
  let score = 0.2;
  if (input.serviceType !== "Unknown") score += 0.2;
  if (input.unitType !== "Unknown") score += 0.2;
  if (input.occupancyType !== "Unknown") score += 0.1;
  if ((input.baseRent ?? 0) > 0) score += 0.15;
  if ((input.careFees ?? 0) > 0) score += 0.1;
  if (input.totalRevenue > 0) score += 0.15;
  if (/\bunit|room|apt|resident|tenant\b/i.test(input.allText)) score += 0.05;
  return Number(Math.min(1, score).toFixed(2));
}

function summarize(rows: NormalizedRentRollRow[], dimensions: Array<"serviceType" | "unitType">): SummaryRow[] {
  const groups = new Map<string, NormalizedRentRollRow[]>();
  for (const row of rows) {
    const key = dimensions.map((dimension) => row[dimension]).join("||");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const parts = key.split("||");
      const aggregateRow = aggregate(group);
      return {
        serviceType: parts[0] || "All",
        unitType: dimensions.includes("unitType") ? parts[1] || "All" : "All",
        ...aggregateRow,
      };
    })
    .sort((a, b) => {
      const serviceDelta = SERVICE_ORDER.indexOf(a.serviceType) - SERVICE_ORDER.indexOf(b.serviceType);
      if (serviceDelta) return serviceDelta;
      return UNIT_ORDER.indexOf(a.unitType) - UNIT_ORDER.indexOf(b.unitType);
    });
}

function summarizeUnderwriting(rows: NormalizedRentRollRow[]): UnderwritingSummaryRow[] {
  const output: UnderwritingSummaryRow[] = [];
  const subtotalRows: NormalizedRentRollRow[] = [];

  for (const serviceType of ["IL", "AL", "MC"] as const) {
    const buckets = STANDARD_UNDERWRITING_BUCKETS.filter((bucket) => bucket.serviceType === serviceType);
    const serviceBucketRows: NormalizedRentRollRow[] = [];
    for (const bucket of buckets) {
      const bucketRows = rows.filter((row) => row.serviceType === serviceType && bucket.match(row));
      serviceBucketRows.push(...bucketRows);
      output.push({
        ...aggregate(bucketRows),
        serviceType,
        unitType: bucket.unitCategory,
        label: bucket.label,
        unitCategory: bucket.unitCategory,
      });
    }
    subtotalRows.push(...serviceBucketRows);
    output.push({
      ...aggregate(serviceBucketRows),
      serviceType,
      unitType: "All",
      label: `${serviceType} Subtotal`,
      unitCategory: "Subtotal",
    });
  }
  output.push({
    ...aggregate(subtotalRows),
    serviceType: "All",
    unitType: "All",
    label: "Total",
    unitCategory: "Total",
  });
  return output;
}

function getStandardRollupRows(rows: NormalizedRentRollRow[]) {
  const matched = new Set<NormalizedRentRollRow>();
  for (const serviceType of ["IL", "AL", "MC"] as const) {
    for (const bucket of STANDARD_UNDERWRITING_BUCKETS.filter((item) => item.serviceType === serviceType)) {
      for (const row of rows) {
        if (row.serviceType === serviceType && bucket.match(row)) matched.add(row);
      }
    }
  }
  return [...matched];
}

function aggregate(rows: NormalizedRentRollRow[]) {
  const units = rows.reduce((sum, row) => sum + row.units, 0);
  const beds = rows.reduce((sum, row) => sum + row.beds, 0);
  const residents = rows.reduce((sum, row) => sum + row.residents, 0);
  const baseRent = rows.reduce((sum, row) => sum + row.baseRent, 0);
  const careFees = rows.reduce((sum, row) => sum + row.careFees, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.totalRevenue, 0);
  return {
    units,
    beds,
    residents,
    occupancy: units ? residents / units : null,
    baseRent,
    careFees,
    totalRevenue,
    averageBaseRent: units ? Math.round(baseRent / units) : null,
    averageCareFees: units ? Math.round(careFees / units) : null,
    averageTotalRevenue: residents ? Math.round(totalRevenue / residents) : null,
  };
}

function buildNotes(rows: NormalizedRentRollRow[], rollupRows: NormalizedRentRollRow[], standardRows: NormalizedRentRollRow[], sourceNotes: string[], hints: ClassificationHints) {
  const notes = [...sourceNotes];
  if (!rows.length) {
    notes.push("No analyzable rent roll rows were detected. Try uploading an Excel/CSV rent roll with clear column headers.");
    return notes;
  }
  const secondResidents = rows.filter((row) => row.occupancyType === "Second Resident").length;
  const unknownService = rows.filter((row) => row.serviceType === "Unknown").length;
  const unknownUnit = rows.filter((row) => row.unitType === "Unknown").length;
  const noRevenue = rows.filter((row) => !row.baseRent && !row.careFees && !row.totalRevenue).length;
  const unallocatedRows = rollupRows.filter((row) => !standardRows.includes(row));
  const hintCount = hints.serviceTypeRules.length + hints.unitTypeRules.length;
  if (hintCount) notes.push(`${hintCount} custom classification hint(s) were applied before built-in rules.`);
  if (unallocatedRows.length) {
    const examples = [...new Set(unallocatedRows.map((row) => row.rollupLabel || row.rawText || `${row.serviceType} ${row.unitType}`).filter(Boolean))]
      .slice(0, 6)
      .join("; ");
    notes.push(`${unallocatedRows.length} primary row(s) were classified by service type but not allocated to a standard summary row. Add classification hints for labels like: ${examples}.`);
  }
  if (secondResidents) notes.push(`${secondResidents} second-resident row(s) were excluded from the underwriting rollup because the rent roll did not assign them a primary unit-type/service rollup label.`);
  if (unknownService) notes.push(`${unknownService} row(s) could not be confidently classified as IL, AL, or MC.`);
  if (unknownUnit) notes.push(`${unknownUnit} row(s) could not be confidently classified by unit type.`);
  if (noRevenue) notes.push(`${noRevenue} row(s) had no detected base rent, care fee, or total revenue amount.`);
  notes.push("Review detail rows for any Unknown classifications before relying on totals in underwriting.");
  return notes;
}

function valueFor(record: Record<string, string>, keys: string[]) {
  const entries = Object.entries(record);
  for (const key of keys) {
    const found = entries.find(([header]) => header.toLowerCase().includes(key.toLowerCase()));
    if (found && String(found[1]).trim()) return String(found[1]).trim();
  }
  return "";
}

function parseClassificationHints(input: string): ClassificationHints {
  const hints: ClassificationHints = { unitTypeRules: [], serviceTypeRules: [] };
  for (const rawLine of input.split(/\r?\n|;/)) {
    const line = rawLine.trim();
    if (!line || !line.includes("=")) continue;
    const [targetRaw, patternsRaw] = line.split("=", 2).map((part) => part.trim());
    const target = normalizeHintTarget(targetRaw);
    const patterns = patternsRaw
      .split(/[,|]/)
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean);
    if (!target || !patterns.length) continue;
    if (target === "IL" || target === "AL" || target === "MC") {
      hints.serviceTypeRules.push({ target, patterns });
    } else {
      hints.unitTypeRules.push({ target, patterns });
    }
  }
  return hints;
}

function normalizeHintTarget(value: string) {
  const text = value.trim().toLowerCase();
  if (["il", "independent", "independent living"].includes(text)) return "IL";
  if (["al", "assisted", "assisted living"].includes(text)) return "AL";
  if (["mc", "memory", "memory care"].includes(text)) return "MC";
  if (["shared", "semi private", "semi-private", "semiprivate", "companion"].includes(text)) return "Shared";
  if (["studio", "stud", "efficiency"].includes(text)) return "Studio";
  if (["studio deluxe", "stud dlx", "stud_dlx", "deluxe studio"].includes(text)) return "Studio Deluxe";
  if (["1 br", "1br", "1 bd", "1bd", "one bedroom"].includes(text)) return "1 BR";
  if (["2 br", "2br", "2 bd", "2bd", "two bedroom"].includes(text)) return "2 BR";
  if (["other"].includes(text)) return "Other";
  return "";
}

function applyRules(text: string, rules: ClassificationRule[]) {
  const normalized = text.toLowerCase();
  const found = rules.find((rule) =>
    rule.patterns.some((pattern) => normalized.includes(pattern.toLowerCase())),
  );
  return found?.target;
}

function extractMoney(value?: string | null) {
  if (!value) return null;
  const text = String(value);
  const matches = [...text.matchAll(/\(?\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\)?/g)]
    .map((match) => {
      const raw = match[0];
      const number = Number(raw.replace(/[$,\s()]/g, ""));
      return raw.includes("(") && raw.includes(")") ? -number : number;
    })
    .filter((number) => Number.isFinite(number));
  if (!matches.length) return null;
  return matches[0];
}

function extractMoneyNear(text: string, labels: string[]) {
  for (const label of labels) {
    const regex = new RegExp(`${label.replace(/\s+/g, "\\s+")}[^0-9$()]{0,20}(\\(?\\$?\\s*[0-9][0-9,.]*\\)?)`, "i");
    const match = text.match(regex);
    if (match?.[1]) return extractMoney(match[1]);
  }
  return null;
}

function asNumber(value?: string | null) {
  if (!value) return null;
  const match = String(value).match(/[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[0]) : null;
}

function cleanHeader(value: unknown) {
  return stringify(value)
    .replace(/\s+/g, " ")
    .replace(/[:*]+$/g, "")
    .trim();
}

function dedupeHeaders(headers: string[]) {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count ? `${header} ${count + 1}` : header;
  });
}

function isBlankRow(row: unknown[]) {
  return row.every((value) => !stringify(value).trim());
}

function stringify(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function isVacantResident(resident: string | undefined, occupancyText: string, allText: string, totalRevenue: number) {
  const text = `${resident || ""} ${occupancyText} ${allText}`.toLowerCase();
  return /\*?vacant|available|empty/.test(text) && totalRevenue <= 0;
}

function cleanRollupLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function unitLabel(unitType: string) {
  if (unitType === "Studio") return "STUD";
  if (unitType === "Studio Deluxe") return "STUD_DLX";
  return unitType;
}

function serviceLabel(serviceType: string) {
  if (serviceType === "IL") return "Independent Living";
  if (serviceType === "AL") return "Assisted Living";
  if (serviceType === "MC") return "Memory Care";
  return serviceType;
}

function isSharedRow(row: NormalizedRentRollRow) {
  const label = (row.rollupLabel || "").toLowerCase();
  return (
    row.unitType === "Shared" ||
    row.occupancyType === "Companion" ||
    row.occupancyType === "Shared" ||
    /\b(shared|semi-private|semiprivate|companion|double occupancy)\b/.test(label)
  );
}

function isStudioRow(row: NormalizedRentRollRow) {
  return row.unitType === "Studio" || row.unitType === "Studio Deluxe";
}
