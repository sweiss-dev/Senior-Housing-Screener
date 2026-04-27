/**
 * server/deal-extract.ts
 *
 * Heavy-lift deal processing: PDF/XLSX text extraction + Claude call.
 * Used by /api/deal-process (async background invocation) and shared
 * helpers used by /api/deal-intake.
 *
 * Claude extracts raw facts only. All derived metrics (per-unit, debt yield,
 * implied value, LTV, DSCR) are computed deterministically in computeMetrics().
 */

import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// JLL Q4 2025 benchmark cap rates
const CAP_RATES = [0.0597, 0.062, 0.07, 0.075] as const;

// Bridge rate DSCR sensitivity range
const BRIDGE_RATES = [0.08, 0.09, 0.1, 0.11] as const;

const MIN_LOAN_SIZE = 4_000_000;
const MAX_LOAN_SIZE = 30_000_000;

const NOI_PERIODS = [
  { key: "noi_t12" as const, label: "T12" },
  { key: "noi_y1" as const, label: "Year 1" },
  { key: "noi_y2" as const, label: "Year 2" },
  { key: "noi_stab" as const, label: "Stabilized" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Raw facts Claude returns — no derived math
export type ExtractedInputs = {
  // Property
  property_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  units: number | null;
  vintage: string | null;
  // Parties
  sponsor: string | null;
  operator: string | null;
  broker_firm: string | null;
  broker_contact: string | null;
  // Capital stack
  ask_amount: number | null;     // total loan amount requested
  refi_amount: number | null;    // refi-only component if stated separately; null if none broken out
  sponsor_basis: number | null;  // all-in sponsor basis
  purchase_price: number | null; // original purchase price if different from sponsor_basis
  purpose: string | null;
  // Financials
  noi_t12: number | null;
  noi_y1: number | null;
  noi_y2: number | null;
  noi_stab: number | null;
  occupancy: string | null;
  // Semantic credit box flags — require reading the document, not arithmetic
  is_senior_housing: boolean;
  is_not_construction: boolean;
  credit_box_notes: string;      // 1–2 sentences on credit box fit
  // Audit trail for missing data
  data_gaps: string[];           // field names (and a brief reason) for every value left null due to absence in the source
};

export type ComputedMetrics = {
  per_unit: {
    total_loan: number | null;
    refi_only: number | null;
    sponsor_basis: number | null;
    purchase: number | null;
  };
  debt_yield: Array<{
    period: string;
    noi: number;
    dy_total: number;
    dy_refi: number | null;
  }>;
  implied_value: Array<{
    cap_rate: number;
    y2_value: number | null;
    stab_value: number | null;
    y2_per_unit: number | null;
    stab_per_unit: number | null;
  }>;
  ltv_on_ask: Array<{
    cap_rate: number;
    stab_ltv: number | null;
    y2_ltv: number | null;
  }>;
  dscr_io: Array<{
    rate: number;
    period: string;
    annual_interest: number;
    dscr: number;
  }>;
  credit_box_fit: {
    in_size_range: boolean;
    is_senior_housing: boolean;
    is_not_construction: boolean;
    notes: string;
  };
};

// Shape Claude returns (no computed section)
type ClaudeRawResponse = {
  extracted: ExtractedInputs;
  verdict: string;
  verdict_label: string;
  headline: string;
  memo_markdown: string;
  next_steps: string[];
};

// Shape returned to callers — preserves existing interface
export type ClaudeExtraction = {
  extracted: Record<string, unknown>;
  computed: Record<string, unknown>;
  verdict: string;
  verdict_label: string;
  headline: string;
  memo_markdown: string;
  next_steps: string[];
};

// ---------------------------------------------------------------------------
// Server-side metric computation
// ---------------------------------------------------------------------------

function r0(n: number): number { return Math.round(n); }
function r2(n: number): number { return Math.round(n * 100) / 100; }
function r4(n: number): number { return Math.round(n * 10000) / 10000; }

export function computeMetrics(e: ExtractedInputs): ComputedMetrics {
  const { units, ask_amount, refi_amount, sponsor_basis, purchase_price } = e;

  const per_unit = {
    total_loan:    ask_amount    && units ? r0(ask_amount    / units) : null,
    refi_only:     refi_amount   && units ? r0(refi_amount   / units) : null,
    sponsor_basis: sponsor_basis && units ? r0(sponsor_basis / units) : null,
    purchase:      purchase_price && units ? r0(purchase_price / units) : null,
  };

  const debt_yield = ask_amount
    ? NOI_PERIODS.flatMap(({ key, label }) => {
        const noi = e[key];
        if (noi == null) return [];
        return [{
          period:   label,
          noi,
          dy_total: r4(noi / ask_amount),
          dy_refi:  refi_amount ? r4(noi / refi_amount) : null,
        }];
      })
    : [];

  const implied_value = CAP_RATES.map((cr) => {
    const y2_value   = e.noi_y2   != null ? r0(e.noi_y2   / cr) : null;
    const stab_value = e.noi_stab != null ? r0(e.noi_stab / cr) : null;
    return {
      cap_rate:      cr,
      y2_value,
      stab_value,
      y2_per_unit:   y2_value   && units ? r0(y2_value   / units) : null,
      stab_per_unit: stab_value && units ? r0(stab_value / units) : null,
    };
  });

  const ltv_on_ask = CAP_RATES.map((cr) => {
    const y2_value   = e.noi_y2   != null ? e.noi_y2   / cr : null;
    const stab_value = e.noi_stab != null ? e.noi_stab / cr : null;
    return {
      cap_rate: cr,
      stab_ltv: stab_value && ask_amount ? r4(ask_amount / stab_value) : null,
      y2_ltv:   y2_value   && ask_amount ? r4(ask_amount / y2_value)   : null,
    };
  });

  const dscr_io = ask_amount
    ? BRIDGE_RATES.flatMap((rate) => {
        const annual_interest = r0(ask_amount * rate);
        return NOI_PERIODS.flatMap(({ key, label }) => {
          const noi = e[key];
          if (noi == null) return [];
          return [{ rate, period: label, annual_interest, dscr: r2(noi / annual_interest) }];
        });
      })
    : [];

  const credit_box_fit = {
    in_size_range:      ask_amount != null && ask_amount >= MIN_LOAN_SIZE && ask_amount <= MAX_LOAN_SIZE,
    is_senior_housing:  e.is_senior_housing,
    is_not_construction: e.is_not_construction,
    notes:              e.credit_box_notes,
  };

  return { per_unit, debt_yield, implied_value, ltv_on_ask, dscr_io, credit_box_fit };
}

// ---------------------------------------------------------------------------
// Few-shot example & system prompt
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

Your job is to read raw deal submissions (emails, OMs, rent rolls, broker teaser text) and return a structured JSON object with extracted facts, an analyst verdict, and a full analyst memo. Derived metrics (per-unit pricing, debt yield, implied value, LTV, DSCR) are computed server-side — do not calculate them.

CRITICAL: Return ONLY valid JSON. No markdown fences, no prose outside the JSON object. The JSON must exactly match the schema described in the user message.

If a value is not stated in the submission, return null — do not infer or estimate.

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
    "units": number | null,          // total residential units across all care levels (IL+AL+MC+SNF); if licensed vs. in-service are both stated, use the licensed count
    "vintage": string | null,
    "sponsor": string | null,
    "operator": string | null,
    "broker_firm": string | null,
    "broker_contact": string | null,
    "ask_amount": number | null,     // total loan proceeds requested, inclusive of all components (refi payoff, reserves, escrows, financed fees); if a range is given, use the maximum
    "refi_amount": number | null,    // portion of ask_amount earmarked to retire existing debt, if the submission explicitly breaks out uses of proceeds (e.g. "$31.5mm refi + $3.5mm DSR"); null if no split is stated or if the entire loan is a simple refi with no reserve carved out
    "sponsor_basis": number | null,  // sponsor's all-in cost in the asset — original acquisition price plus all invested capital to date (capex, carry, closing costs) — as represented in the submission; use the stated figure, do not sum components
    "purchase_price": number | null, // price paid at original acquisition, if stated as a distinct figure from the current all-in basis; null if only one composite basis number is provided
    "purpose": string | null,
    "noi_t12": number | null,        // net operating income for the trailing twelve months ending at or near the submission date — total revenues minus all operating expenses including management fees, before debt service, depreciation, and capex; use the figure labeled "T12," "TTM," or "trailing 12 months" — not an annualized, adjusted, or underwritten figure
    "noi_y1": number | null,         // projected NOI for Year 1 of the loan term, as labeled "Year 1," "Y1," "FY1," or equivalent in the sponsor's pro forma; do not use a partial-year figure
    "noi_y2": number | null,         // projected NOI for Year 2 of the loan term, as labeled "Year 2," "Y2," "FY2," or equivalent
    "noi_stab": number | null,       // projected NOI at full stabilization — the terminal ramp endpoint explicitly labeled "stabilized," "stabilized NOI," or "stabilized run rate"; if a numbered year (e.g. Year 3) is also described as stabilized, use it; if two stabilized figures appear at different occupancy assumptions, use the lower
    "occupancy": string | null,
    "is_senior_housing": boolean,
    "is_not_construction": boolean,
    "credit_box_notes": string,
    "data_gaps": string[]        // one entry per null field: the field name plus a brief reason it could not be found (e.g. "noi_y2 — no Year 2 projection in submission"); omit a field from this list only if its value is populated
  },
  "verdict": "green" | "amber" | "red",
  "verdict_label": string,
  "headline": string,
  "memo_markdown": string,
  "next_steps": string[]
}

Rules:
- NULL AND DATA GAPS: If a value is not stated explicitly in the source documents, set it to null and add it to data_gaps. Do not infer, estimate, interpolate, or carry forward a value from a related field. A number that can be derived from other numbers in the submission is still null unless the submission states it directly. data_gaps must be an exhaustive list — every null field must have a corresponding entry.
- is_senior_housing / is_not_construction: your semantic read of the submission; not arithmetic.
- credit_box_notes: 1–2 sentences on how the deal fits (or doesn't fit) Bloomfield's credit box.
- verdict_label: 3–6 words describing the credit situation.
- headline: one sentence, 18–24 words, third-person analyst voice.
- memo_markdown: full analyst memo, 600–900 words, ## section headers, third-person (no "you" / "we").
- next_steps: 2–4 concrete diligence asks.
- All dollar amounts as plain numbers (no $ signs, no commas).

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
// Main entry — call Claude, compute metrics, return assembled result.
// ---------------------------------------------------------------------------

export async function callClaudeForDeal(rawText: string): Promise<ClaudeExtraction> {
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

  // Tolerant JSON extraction. Claude usually returns clean JSON, but sometimes
  // wraps it in ```json fences or prefixes it with a sentence. Strategy:
  //   1. Strip ```json / ``` fences anywhere in the string.
  //   2. Try a direct parse.
  //   3. Fallback: locate the first '{' and the matching last '}' and parse
  //      that slice. This handles "Here is the analysis: { ... }" preambles.
  const fenced = rawJson.replace(/```(?:json)?/gi, "").trim();

  function extractJsonObject(s: string): string | null {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    return s.slice(first, last + 1);
  }

  let raw: ClaudeRawResponse;
  try {
    raw = JSON.parse(fenced) as ClaudeRawResponse;
  } catch {
    const slice = extractJsonObject(fenced);
    if (!slice) {
      console.error("[deal-extract] No JSON object found in Claude output:", fenced.slice(0, 400));
      throw new Error(`MODEL_INVALID_JSON: no { ... } block found. Preview: ${fenced.slice(0, 200)}`);
    }
    try {
      raw = JSON.parse(slice) as ClaudeRawResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[deal-extract] Claude returned invalid JSON:", slice.slice(0, 400));
      throw new Error(`MODEL_INVALID_JSON: ${msg}. Preview: ${slice.slice(0, 200)}`);
    }
  }

  const computed = computeMetrics(raw.extracted);

  return {
    extracted: raw.extracted as Record<string, unknown>,
    computed:  computed      as Record<string, unknown>,
    verdict:       raw.verdict,
    verdict_label: raw.verdict_label,
    headline:      raw.headline,
    memo_markdown: raw.memo_markdown,
    next_steps:    raw.next_steps,
  };
}
