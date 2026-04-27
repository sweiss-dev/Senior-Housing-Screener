/**
 * /api/deal-intake.ts
 *
 * POST  multipart/form-data  OR  application/json
 *
 * Fields:
 *   pasted_text  string   (optional) — email body, notes, links
 *   files[]      File[]   (optional) — PDF and/or XLSX uploads
 *   source       string   "paste" | "upload" | "email"
 *
 * Returns: { deal_id, ...full_record }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";
import { nanoid } from "nanoid";
import {
  ensureSchema,
  insertDeal,
  insertDealFile,
} from "../server/db.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Vercel function config — allow large uploads
// ---------------------------------------------------------------------------
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "20mb",
  },
};

// ---------------------------------------------------------------------------
// Claude client
// ---------------------------------------------------------------------------
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Castle Lanterra memo — few-shot reference for Claude
// ---------------------------------------------------------------------------
const CASTLE_LANTERRA_EXAMPLE = `
## Castle Lanterra / Diamond Oaks Village — Deal Review

### The Ask
Castle Lanterra (Elie Rieder) requesting a $35mm non-recourse debt on Diamond Oaks Village, a 160-unit senior housing community at 24110 S Tamiami Trl, Bonita Springs, FL. Operated by Discovery Senior Living. Use of proceeds: $31.5mm refi + ~$3.5mm DSR (2 years). Sponsor basis ~$90mm (bought Q1 2022 for $70.7mm + invested capital).

### Price Per Unit
| Metric | $ / Unit |
|---|---|
| Total loan $35mm | $218,750 |
| Refi-only $31.5mm | $196,875 |
| Sponsor all-in basis $90mm | $562,500 |
| Original 2022 purchase $70.7mm | $441,875 |

### Debt Yield
| Period | NOI | DY on $35mm | DY on $31.5mm |
|---|---|---|---|
| FY 2024 | $909k | 2.60% | 2.89% |
| T12 Dec-25 | $763k | 2.18% | 2.42% |
| Year 1 Projection | $1.76mm | 5.03% | 5.58% |
| Year 2 Projection | $2.60mm | 7.44% | 8.26% |
| Stabilized | $3.24mm | 9.26% | 10.29% |

Going-in debt yield ~2.2% — unfinanceable on its own. Deal only works on underwritten growth.

### Bottom Line
This is a story deal, not a credit deal. The going-in metrics are deeply challenged — a 2.18% T12 debt yield sits well below any reasonable credit threshold, and the sponsor's all-in basis of $562,500/unit implies a recovery value that requires stabilization at roughly $100+ occupancy to make lenders whole. Discovery is a nationally recognized operator, which is a genuine positive, but operator quality alone cannot paper over a 160-unit community that is performing at roughly 67% economic occupancy trailing twelve months.

The credit thesis is entirely forward-looking: management is projecting a rapid ramp from sub-$800k T12 NOI to $3.24mm stabilized, driven by a claimed occupancy rebound and rate compression on care fees. The $3.5mm debt service reserve partially cushions the near-term burn, but a two-year DSR is thin if occupancy recovery stalls. At stabilized NOI and a 7.50% cap rate, the implied value ($43.2mm) covers the $35mm loan at ~81% LTV — acceptable if you believe the projection, but not a margin of safety.

Verdict: Amber. Will not pass credit committee without (1) updated T12 rent roll and occupancy trend, (2) operator's management agreement and any cure/termination provisions, (3) third-party valuation with stabilized hold assumption, and (4) sponsor guaranty structure (non-recourse carve-outs at minimum). If occupancy is trending above 80% in the most recent 90 days, the trajectory narrative holds. If flat or declining, pass.
`.trim();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a senior debt analyst at Bloomfield Capital, a specialty finance firm focused on senior housing bridge lending.

Bloomfield credit box:
- Loan size: $4–30 million
- Asset types: Independent Living (IL), Assisted Living (AL), Memory Care (MC), and occasionally Skilled Nursing Facility (SNF)
- NO ground-up construction
- Prefer experienced, institutional operators with track records
- Markets: continental US, prefer primary/secondary markets

Your job is to read raw deal submissions (emails, OMs, rent rolls, broker teaser text) and return a structured JSON object with extracted facts, computed underwriting metrics, an analyst verdict, and a full analyst memo.

CRITICAL: Return ONLY valid JSON. No markdown fences, no prose outside the JSON object. The JSON must exactly match the schema described in the user message.

Compute cap-rate sensitivity at these JLL Q4 2025 benchmark rates: 5.97%, 6.20%, 7.00%, 7.50%.
Compute bridge-rate DSCR sensitivity at: 8%, 9%, 10%, 11%.
If a NOI period is missing from the submission, omit that row — do not guess.

Style reference for memo_markdown — write at this quality level:

${CASTLE_LANTERRA_EXAMPLE}`;

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------
function buildUserPrompt(rawText: string): string {
  return `Analyze the following deal submission and return a single JSON object matching this exact schema:

{
  "extracted": {
    "property_name": string | null,
    "address": string | null,
    "city": string | null,
    "state": string | null,
    "units": number | null,
    "vintage": string | null,
    "sponsor": string | null,
    "operator": string | null,
    "broker_firm": string | null,
    "broker_contact": string | null,
    "ask_amount": number | null,
    "sponsor_basis": number | null,
    "purchase_price": number | null,
    "purpose": string | null,
    "noi_t12": number | null,
    "noi_y1": number | null,
    "noi_y2": number | null,
    "noi_stab": number | null,
    "occupancy": string | null
  },
  "computed": {
    "per_unit": {
      "total_loan": number | null,
      "refi_only": number | null,
      "sponsor_basis": number | null,
      "purchase": number | null
    },
    "debt_yield": [
      { "period": string, "noi": number, "dy_total": number, "dy_refi": number | null }
    ],
    "implied_value": [
      { "cap_rate": number, "y2_value": number | null, "stab_value": number | null, "y2_per_unit": number | null, "stab_per_unit": number | null }
    ],
    "ltv_on_ask": [
      { "cap_rate": number, "stab_ltv": number | null, "y2_ltv": number | null }
    ],
    "dscr_io": [
      { "rate": number, "period": string, "annual_interest": number, "dscr": number }
    ],
    "credit_box_fit": {
      "in_size_range": boolean,
      "is_senior_housing": boolean,
      "is_not_construction": boolean,
      "notes": string
    }
  },
  "verdict": "green" | "amber" | "red",
  "verdict_label": string,
  "headline": string,
  "memo_markdown": string,
  "next_steps": string[]
}

Rules:
- verdict_label: 3–6 words describing the credit situation
- headline: one sentence, 18–24 words, third-person analyst voice
- memo_markdown: full analyst memo, 600–900 words, ## section headers, markdown tables for per-unit pricing and debt yield, third-person (no "you" / "we")
- next_steps: 2–4 concrete diligence asks
- All dollar amounts as plain numbers (no $ signs, no commas). Use null if data is absent.
- Compute implied_value and ltv_on_ask at cap rates: 5.97, 6.20, 7.00, 7.50
- Compute dscr_io at rates: 8, 9, 10, 11 (as percent, e.g. 0.08) for each NOI period available
- omit debt_yield rows where NOI is not provided

Deal submission:
---
${rawText}
---`;
}

// ---------------------------------------------------------------------------
// File parsing helpers
// ---------------------------------------------------------------------------

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdf = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
  const result = await pdf(buffer);
  return result.text ?? "";
}

function extractTextFromXlsx(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    parts.push(`=== Sheet: ${sheetName} ===`);
    for (const row of matrix) {
      const cells = (row as (string | number | null)[])
        .map((c) => (c === null || c === undefined ? "" : String(c)))
        .filter((c) => c !== "");
      if (cells.length) parts.push(cells.join("\t"));
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Blob upload (optional)
// ---------------------------------------------------------------------------

async function uploadToBlob(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { put } = await import("@vercel/blob");
    const result = await put(`deal-files/${nanoid(8)}-${filename}`, buffer, {
      access: "public",
      contentType,
    });
    return result.url;
  } catch (err) {
    console.warn("[deal-intake] Blob upload failed (non-fatal):", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multipart parser (using formidable)
// ---------------------------------------------------------------------------

type ParsedForm = {
  fields: Record<string, string>;
  files: Array<{
    filename: string;
    mimetype: string;
    buffer: Buffer;
  }>;
};

async function parseMultipart(req: VercelRequest): Promise<ParsedForm> {
  const formidable = (await import("formidable")).default;
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 20 * 1024 * 1024 });
    form.parse(req as Parameters<typeof form.parse>[0], (err, fields, files) => {
      if (err) return reject(err);
      const flatFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        flatFields[k] = Array.isArray(v) ? v[0] : (v as string);
      }
      const flatFiles: ParsedForm["files"] = [];
      for (const [, fileOrArr] of Object.entries(files)) {
        const arr = Array.isArray(fileOrArr) ? fileOrArr : [fileOrArr];
        for (const f of arr) {
          if (!f) continue;
          // formidable v3 stores file at f.filepath
          const filepath = (f as { filepath: string }).filepath;
          if (!filepath) continue;
          const fs = require("node:fs") as typeof import("fs");
          const buffer = fs.readFileSync(filepath);
          flatFiles.push({
            filename: f.originalFilename ?? "upload",
            mimetype: f.mimetype ?? "application/octet-stream",
            buffer,
          });
        }
      }
      resolve({ fields: flatFields, files: flatFiles });
    });
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Allow the Gmail Chrome extension (and any other browser-context client)
// to POST attachments here. We accept any origin because the route is
// idempotent-ish (it creates a deal record) and is already protected by
// the Anthropic key on the server side; tighten if needed.
function setCorsHeaders(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await ensureSchema();

    const contentType = req.headers["content-type"] ?? "";
    let pastedText = "";
    let source = "paste";
    let uploadedFiles: ParsedForm["files"] = [];

    if (contentType.includes("multipart/form-data")) {
      const parsed = await parseMultipart(req);
      pastedText = parsed.fields.pasted_text ?? "";
      source = parsed.fields.source ?? "upload";
      uploadedFiles = parsed.files;
    } else {
      // JSON body
      const body = req.body as {
        pasted_text?: string;
        source?: string;
      };
      pastedText = body?.pasted_text ?? "";
      source = body?.source ?? "paste";
    }

    // ------------------------------------------------------------------
    // 1. Extract text from uploaded files + upload to Blob
    // ------------------------------------------------------------------
    const dealId = nanoid(12);
    const extractedTexts: string[] = [];
    const fileRecords: Array<{ filename: string; blobUrl: string | null; kind: string }> = [];

    for (const file of uploadedFiles) {
      const lower = file.filename.toLowerCase();
      let text = "";
      let kind = "other";

      try {
        if (lower.endsWith(".pdf") || file.mimetype.includes("pdf")) {
          text = await extractTextFromPdf(file.buffer);
          kind = "pdf";
        } else if (/\.(xlsx|xls|xlsm|xlsb|csv)$/i.test(lower) || file.mimetype.includes("spreadsheet") || file.mimetype.includes("excel") || file.mimetype.includes("csv")) {
          text = extractTextFromXlsx(file.buffer);
          kind = "xlsx";
        }
        if (text) extractedTexts.push(`=== File: ${file.filename} ===\n${text}`);
      } catch (e) {
        console.warn(`[deal-intake] Could not parse ${file.filename}:`, e);
      }

      // Upload to Vercel Blob
      const blobUrl = await uploadToBlob(file.buffer, file.filename, file.mimetype);
      fileRecords.push({ filename: file.filename, blobUrl, kind });
    }

    // ------------------------------------------------------------------
    // 2. Build raw_text
    // ------------------------------------------------------------------
    const rawParts: string[] = [];
    if (pastedText) rawParts.push(pastedText);
    rawParts.push(...extractedTexts);
    const rawText = rawParts.join("\n\n---\n\n");

    if (!rawText.trim()) {
      return res.status(400).json({ error: "No content provided — paste text or upload a file." });
    }

    // ------------------------------------------------------------------
    // 3. Call Claude
    // ------------------------------------------------------------------
    const msg = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(rawText) }],
    });

    const rawJson = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");

    // Strip any accidental markdown fences
    const jsonStr = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed: {
      extracted: Record<string, unknown>;
      computed: Record<string, unknown>;
      verdict: string;
      verdict_label: string;
      headline: string;
      memo_markdown: string;
      next_steps: string[];
    };

    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("[deal-intake] Claude returned invalid JSON:", jsonStr.slice(0, 400));
      return res.status(502).json({ error: "Model returned malformed JSON. Please try again." });
    }

    const ext = parsed.extracted ?? {};

    // ------------------------------------------------------------------
    // 4. Insert deal
    // ------------------------------------------------------------------
    const deal = await insertDeal({
      source,
      property_name: (ext.property_name as string | null) ?? null,
      address: (ext.address as string | null) ?? null,
      city: (ext.city as string | null) ?? null,
      state: (ext.state as string | null) ?? null,
      units: ext.units != null ? Number(ext.units) : null,
      vintage: (ext.vintage as string | null) ?? null,
      sponsor: (ext.sponsor as string | null) ?? null,
      operator: (ext.operator as string | null) ?? null,
      broker_firm: (ext.broker_firm as string | null) ?? null,
      broker_contact: (ext.broker_contact as string | null) ?? null,
      ask_amount: ext.ask_amount != null ? Number(ext.ask_amount) : null,
      sponsor_basis: ext.sponsor_basis != null ? Number(ext.sponsor_basis) : null,
      purchase_price: ext.purchase_price != null ? Number(ext.purchase_price) : null,
      purpose: (ext.purpose as string | null) ?? null,
      noi_t12: ext.noi_t12 != null ? Number(ext.noi_t12) : null,
      noi_y1: ext.noi_y1 != null ? Number(ext.noi_y1) : null,
      noi_y2: ext.noi_y2 != null ? Number(ext.noi_y2) : null,
      noi_stab: ext.noi_stab != null ? Number(ext.noi_stab) : null,
      occupancy: (ext.occupancy as string | null) ?? null,
      verdict: parsed.verdict ?? null,
      verdict_label: parsed.verdict_label ?? null,
      headline: parsed.headline ?? null,
      memo_markdown: parsed.memo_markdown ?? null,
      computed_metrics: parsed.computed ?? null,
      raw_text: rawText.slice(0, 100000),
      status: "new",
      id: dealId,
    });

    // ------------------------------------------------------------------
    // 5. Insert file records
    // ------------------------------------------------------------------
    for (const fr of fileRecords) {
      await insertDealFile({
        deal_id: deal.id,
        filename: fr.filename,
        blob_url: fr.blobUrl,
        kind: fr.kind,
      });
    }

    return res.json({
      deal_id: deal.id,
      deal,
      computed: parsed.computed,
      next_steps: parsed.next_steps ?? [],
    });
  } catch (err) {
    console.error("[deal-intake]", err);
    return res.status(500).json({ error: "Deal intake failed. See server logs." });
  }
}
