/**
 * server/deal-extract.ts
 *
 * Heavy-lift deal processing: PDF/XLSX text extraction + Claude call.
 * Used by /api/deal-process (async background invocation) and shared
 * helpers used by /api/deal-intake.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Few-shot example & system prompt
// (Kept identical to the original deal-intake.ts to preserve behavior.)
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
// File text extraction
// ---------------------------------------------------------------------------

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdf = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
  const result = await pdf(buffer);
  return result.text ?? "";
}

export function extractTextFromXlsx(buffer: Buffer): string {
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
// Main entry — given raw text, return parsed Claude output.
// ---------------------------------------------------------------------------

export type ClaudeExtraction = {
  extracted: Record<string, unknown>;
  computed: Record<string, unknown>;
  verdict: string;
  verdict_label: string;
  headline: string;
  memo_markdown: string;
  next_steps: string[];
};

export async function callClaudeForDeal(rawText: string): Promise<ClaudeExtraction> {
  // Cap prompt to keep latency bounded.
  const MAX_PROMPT_CHARS = 200_000;
  const promptText =
    rawText.length > MAX_PROMPT_CHARS
      ? rawText.slice(0, MAX_PROMPT_CHARS) + "\n\n[...truncated for length...]"
      : rawText;

  const tClaude = Date.now();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(promptText) }],
  });
  console.log(`[deal-extract] Claude responded in ${Date.now() - tClaude}ms`);

  const rawJson = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  const jsonStr = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: ClaudeExtraction;
  try {
    parsed = JSON.parse(jsonStr) as ClaudeExtraction;
  } catch (e) {
    console.error("[deal-extract] Claude returned invalid JSON:", jsonStr.slice(0, 400));
    throw new Error("MODEL_INVALID_JSON");
  }
  return parsed;
}
