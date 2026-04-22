/**
 * /api/deal-inbox.ts
 *
 * POST — Email-forward webhook (SendGrid Inbound Parse / Cloudflare Email Workers shape)
 *
 * Body shape:
 * {
 *   from: string,
 *   subject: string,
 *   text: string,
 *   html: string,
 *   attachments: [{ filename: string, content_base64: string }]
 * }
 *
 * TODO (DNS setup — complete in Vercel/provider dashboard):
 *   1. Pick SendGrid Inbound Parse OR Cloudflare Email Workers
 *   2. Create an MX record on a subdomain, e.g.  deals.bloomfieldcapital.com
 *      MX  10  mx.sendgrid.net   (SendGrid)
 *      OR  route to Cloudflare Email Workers
 *   3. In SendGrid: Settings → Inbound Parse → Add Host & URL
 *      Host: deals.bloomfieldcapital.com
 *      URL:  https://<your-app>.vercel.app/api/deal-inbox
 *      ☑ POST the raw, full MIME message
 *   4. In Cloudflare: Workers → Email → Route to worker that forwards to this endpoint
 *   5. Set DEAL_INBOX_SECRET env var and pass it as X-Inbox-Secret header for HMAC validation
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";
import {
  ensureSchema,
  insertDeal,
  insertDealFile,
} from "../server/db.js";

const require = createRequire(import.meta.url);

// Re-use the same extraction logic as deal-intake
// (duplicated inline to keep functions self-contained per Vercel convention)

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
This is a story deal, not a credit deal. The going-in metrics are deeply challenged.
`.trim();

const SYSTEM_PROMPT = `You are a senior debt analyst at Bloomfield Capital, a specialty finance firm focused on senior housing bridge lending.

Bloomfield credit box: $4–30M loans, US senior housing (IL/AL/MC, sometimes SNF), no ground-up construction, prefer experienced operators.

Return ONLY valid JSON matching the schema in the user message. No markdown fences, no prose outside the JSON.

Compute cap-rate sensitivity at: 5.97%, 6.20%, 7.00%, 7.50%.
Compute bridge-rate DSCR sensitivity at: 8%, 9%, 10%, 11%.
Omit rows where NOI is absent.

Style reference:
${CASTLE_LANTERRA_EXAMPLE}`;

function buildUserPrompt(rawText: string): string {
  return `Analyze the following deal submission and return a single JSON object matching this exact schema:

{
  "extracted": {
    "property_name": string | null, "address": string | null, "city": string | null,
    "state": string | null, "units": number | null, "vintage": string | null,
    "sponsor": string | null, "operator": string | null, "broker_firm": string | null,
    "broker_contact": string | null, "ask_amount": number | null, "sponsor_basis": number | null,
    "purchase_price": number | null, "purpose": string | null, "noi_t12": number | null,
    "noi_y1": number | null, "noi_y2": number | null, "noi_stab": number | null,
    "occupancy": string | null
  },
  "computed": {
    "per_unit": { "total_loan": number|null, "refi_only": number|null, "sponsor_basis": number|null, "purchase": number|null },
    "debt_yield": [{ "period": string, "noi": number, "dy_total": number, "dy_refi": number|null }],
    "implied_value": [{ "cap_rate": number, "y2_value": number|null, "stab_value": number|null, "y2_per_unit": number|null, "stab_per_unit": number|null }],
    "ltv_on_ask": [{ "cap_rate": number, "stab_ltv": number|null, "y2_ltv": number|null }],
    "dscr_io": [{ "rate": number, "period": string, "annual_interest": number, "dscr": number }],
    "credit_box_fit": { "in_size_range": boolean, "is_senior_housing": boolean, "is_not_construction": boolean, "notes": string }
  },
  "verdict": "green"|"amber"|"red",
  "verdict_label": string,
  "headline": string,
  "memo_markdown": string,
  "next_steps": string[]
}

verdict_label: 3–6 words. headline: 18–24 words, third-person analyst voice.
memo_markdown: 600–900 words, ## sections, markdown tables.

Deal submission:
---
${rawText}
---`;
}

type InboxPayload = {
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content_base64: string }>;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Respond 200 immediately per webhook best practice; process async
  // (Vercel serverless doesn't truly background, but this signals success quickly)
  res.status(200).json({ ok: true, message: "Deal received — processing in background." });

  try {
    await ensureSchema();

    const body = req.body as InboxPayload;
    const from = body.from ?? "";
    const subject = body.subject ?? "";
    const bodyText = body.text ?? body.html ?? "";
    const attachments = body.attachments ?? [];

    // Build raw text
    const parts: string[] = [
      `From: ${from}`,
      `Subject: ${subject}`,
      bodyText,
    ];

    const dealId = nanoid(12);
    const fileRecords: Array<{ filename: string; blobUrl: string | null; kind: string }> = [];

    for (const att of attachments) {
      const filename = att.filename ?? "attachment";
      const lower = filename.toLowerCase();
      const buffer = Buffer.from(att.content_base64, "base64");
      let extractedText = "";
      let kind = "other";

      try {
        if (lower.endsWith(".pdf")) {
          extractedText = await extractTextFromPdf(buffer);
          kind = "pdf";
        } else if (/\.(xlsx|xls|csv)$/i.test(lower)) {
          extractedText = extractTextFromXlsx(buffer);
          kind = "xlsx";
        }
        if (extractedText) parts.push(`=== Attachment: ${filename} ===\n${extractedText}`);
      } catch (e) {
        console.warn(`[deal-inbox] Could not parse ${filename}:`, e);
      }

      // TODO: upload to Blob when BLOB_READ_WRITE_TOKEN is provisioned
      fileRecords.push({ filename, blobUrl: null, kind });
    }

    const rawText = parts.join("\n\n---\n\n");
    if (!rawText.trim()) return;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(rawText) }],
    });

    const rawJson = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

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
      parsed = JSON.parse(rawJson);
    } catch {
      console.error("[deal-inbox] Claude returned invalid JSON");
      return;
    }

    const ext = parsed.extracted ?? {};

    const deal = await insertDeal({
      source: "email",
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

    for (const fr of fileRecords) {
      await insertDealFile({
        deal_id: deal.id,
        filename: fr.filename,
        blob_url: fr.blobUrl,
        kind: fr.kind,
      });
    }

    console.log(`[deal-inbox] Created deal ${deal.id} from email — ${from} — ${subject}`);
  } catch (err) {
    console.error("[deal-inbox] Background processing error:", err);
  }
}
