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
 * Behavior (async):
 *   1. Accept upload, parse multipart, upload files to Vercel Blob.
 *   2. Insert a deal row in `processing` status with raw_text built from
 *      pasted_text + each file's extracted text. (Text extraction is cheap.)
 *   3. Fire-and-forget POST to /api/deal-process to run Claude in a separate
 *      invocation that has its own 60-second budget.
 *   4. Return immediately with the deal_id so the client can redirect.
 *
 * Returns: { deal_id, status: "processing" }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import { insertDeal, insertDealFile, ensureSchema } from "../server/db.js";
import { extractTextFromPdf, extractTextFromXlsx } from "../server/deal-extract.js";

const require = createRequire(import.meta.url);

// Allow large uploads. The text-extraction + Blob upload is cheap; this
// endpoint should comfortably finish well under 60s for typical CIMs.
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "20mb",
  },
};

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function setCorsHeaders(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ---------------------------------------------------------------------------
// Multipart parser
// ---------------------------------------------------------------------------

type ParsedForm = {
  fields: Record<string, string>;
  files: Array<{ filename: string; mimetype: string; buffer: Buffer }>;
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
// Vercel Blob upload (optional)
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
// Fire-and-forget dispatch to /api/deal-process
//
// We can't `await` this — the whole point is to return to the user before
// Claude runs. We swallow errors locally; deal-process will log its own
// failures and the deal will stay in "processing" status as a signal.
// ---------------------------------------------------------------------------

function dispatchProcess(req: VercelRequest, dealId: string): void {
  // Reconstruct the public origin so the second invocation goes through the
  // public URL (and gets its own serverless function instance).
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const origin = `${proto}://${host}`;
  const url = `${origin}/api/deal-process?ack=1`;

  // Use an internal shared secret to prevent random callers from triggering
  // expensive Claude calls. Set DEAL_PROCESS_SECRET in Vercel env vars; if
  // not set we skip auth (acceptable for early-stage internal app).
  const secret = process.env.DEAL_PROCESS_SECRET;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-deal-process-secret"] = secret;

  // Use waitUntil so Vercel keeps this function alive long enough to flush the
  // outbound request. deal-process responds 202 quickly via its own waitUntil,
  // so this fetch resolves in well under a second.
  waitUntil(
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ deal_id: dealId }),
    })
      .then(async (r) => {
        const text = await r.text().catch(() => "");
        console.log(`[deal-intake] dispatch → ${r.status} ${text.slice(0, 200)}`);
      })
      .catch((e) => {
        console.warn("[deal-intake] Could not dispatch deal-process:", e);
      }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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
      const body = req.body as { pasted_text?: string; source?: string };
      pastedText = body?.pasted_text ?? "";
      source = body?.source ?? "paste";
    }

    // ------------------------------------------------------------------
    // 1. Process all files in parallel: extract text + upload to Blob.
    // ------------------------------------------------------------------
    const dealId = nanoid(12);
    const t0 = Date.now();
    const perFile = await Promise.all(
      uploadedFiles.map(async (file) => {
        const lower = file.filename.toLowerCase();
        let text = "";
        let kind = "other";

        const parsePromise = (async () => {
          try {
            if (lower.endsWith(".pdf") || file.mimetype.includes("pdf")) {
              text = await extractTextFromPdf(file.buffer);
              kind = "pdf";
            } else if (
              /\.(xlsx|xls|xlsm|xlsb|csv)$/i.test(lower) ||
              file.mimetype.includes("spreadsheet") ||
              file.mimetype.includes("excel") ||
              file.mimetype.includes("csv")
            ) {
              text = extractTextFromXlsx(file.buffer);
              kind = "xlsx";
            }
          } catch (e) {
            console.warn(`[deal-intake] Could not parse ${file.filename}:`, e);
          }
        })();

        const blobPromise = uploadToBlob(file.buffer, file.filename, file.mimetype).catch((e) => {
          console.warn(`[deal-intake] Blob upload failed for ${file.filename}:`, e);
          return null;
        });

        const [, blobUrl] = await Promise.all([parsePromise, blobPromise]);
        return {
          extractedText: text ? `=== File: ${file.filename} ===\n${text}` : "",
          fileRecord: { filename: file.filename, blobUrl, kind },
        };
      })
    );
    console.log(
      `[deal-intake] Processed ${uploadedFiles.length} file(s) in ${Date.now() - t0}ms`
    );

    const extractedTexts = perFile.map((p) => p.extractedText).filter(Boolean);
    const fileRecords = perFile.map((p) => p.fileRecord);

    const rawParts: string[] = [];
    if (pastedText) rawParts.push(pastedText);
    rawParts.push(...extractedTexts);
    const rawText = rawParts.join("\n\n---\n\n");

    if (!rawText.trim()) {
      return res
        .status(400)
        .json({ error: "No content provided — paste text or upload a file." });
    }

    // ------------------------------------------------------------------
    // 2. Insert deal row in 'processing' status. Claude runs separately.
    // ------------------------------------------------------------------
    const deal = await insertDeal({
      id: dealId,
      source,
      property_name: null,
      address: null,
      city: null,
      state: null,
      units: null,
      vintage: null,
      sponsor: null,
      operator: null,
      broker_firm: null,
      broker_contact: null,
      ask_amount: null,
      sponsor_basis: null,
      purchase_price: null,
      purpose: null,
      noi_t12: null,
      noi_y1: null,
      noi_y2: null,
      noi_stab: null,
      occupancy: null,
      verdict: null,
      verdict_label: null,
      headline: "Processing — extracting deal metrics…",
      memo_markdown: null,
      computed_metrics: null,
      raw_text: rawText.slice(0, 100000),
      status: "processing",
    });

    for (const fr of fileRecords) {
      await insertDealFile({
        deal_id: deal.id,
        filename: fr.filename,
        blob_url: fr.blobUrl,
        kind: fr.kind,
      });
    }

    // ------------------------------------------------------------------
    // 3. Fire-and-forget Claude processing on a separate invocation.
    // ------------------------------------------------------------------
    dispatchProcess(req, deal.id);

    return res.json({
      deal_id: deal.id,
      status: "processing",
      message:
        "Deal received. Claude is extracting metrics in the background — refresh the deal page in 30–60 seconds.",
    });
  } catch (err) {
    console.error("[deal-intake]", err);
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    return res.status(500).json({
      error: "Deal intake failed. See server logs.",
      detail: message,
      stack: stack.split("\n").slice(0, 6).join("\n"),
    });
  }
}
