/**
 * /api/deal-process.ts
 *
 * Internal endpoint invoked by /api/deal-intake to run Claude on an already-
 * persisted deal. Has its own 60s function budget so Claude can take its time.
 *
 * Body: { deal_id: string }
 * Auth: optional shared secret in `x-deal-process-secret` header,
 *       set DEAL_PROCESS_SECRET env var to require it.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { getDeal, updateDeal } from "../server/db.js";
import { callClaudeForDeal } from "../server/deal-extract.js";

export const maxDuration = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requiredSecret = process.env.DEAL_PROCESS_SECRET;
  if (requiredSecret) {
    const provided = req.headers["x-deal-process-secret"];
    if (provided !== requiredSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Parse JSON body (Vercel's default body parser handles application/json)
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as
    | { deal_id?: string }
    | undefined;
  const dealId = body?.deal_id;
  if (!dealId) {
    return res.status(400).json({ error: "deal_id is required" });
  }

  // Two modes:
  //   - ?ack=1 (default for /api/deal-intake dispatch): respond 202 immediately
  //     and run Claude in background via waitUntil so the function isn't frozen.
  //   - sync (no ack): run Claude inline and respond when finished. Useful for
  //     manual debugging via curl.
  const ackOnly = req.query?.ack === "1";

  const work = (async () => {
    const deal = await getDeal(dealId);
    if (!deal) {
      console.error(`[deal-process] Deal not found: ${dealId}`);
      return { ok: false, status: "not_found" as const };
    }
    if (deal.status === "new" || (deal.verdict && deal.verdict !== null)) {
      console.log(`[deal-process] Deal ${dealId} already processed; skipping.`);
      return { ok: true, status: "already_processed" as const };
    }

    const rawText = deal.raw_text ?? "";
    if (!rawText.trim()) {
      await updateDeal(dealId, { status: "error", headline: "No deal content found." });
      return { ok: false, status: "error" as const, reason: "empty raw_text" };
    }

    let parsed;
    try {
      parsed = await callClaudeForDeal(rawText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[deal-process] Claude failed for ${dealId}:`, e);
      await updateDeal(dealId, {
        status: "error",
        headline: "Claude extraction failed — open this deal to see raw text and retry.",
      });
      return { ok: false, status: "error" as const, reason: msg };
    }

    const ext = parsed.extracted ?? {};
    const num = (v: unknown) => (v == null ? null : Number(v));

    await updateDeal(dealId, {
      property_name: (ext.property_name as string | null) ?? null,
      address: (ext.address as string | null) ?? null,
      city: (ext.city as string | null) ?? null,
      state: (ext.state as string | null) ?? null,
      units: num(ext.units),
      vintage: (ext.vintage as string | null) ?? null,
      sponsor: (ext.sponsor as string | null) ?? null,
      operator: (ext.operator as string | null) ?? null,
      broker_firm: (ext.broker_firm as string | null) ?? null,
      broker_contact: (ext.broker_contact as string | null) ?? null,
      ask_amount: num(ext.ask_amount),
      sponsor_basis: num(ext.sponsor_basis),
      purchase_price: num(ext.purchase_price),
      purpose: (ext.purpose as string | null) ?? null,
      noi_t12: num(ext.noi_t12),
      noi_y1: num(ext.noi_y1),
      noi_y2: num(ext.noi_y2),
      noi_stab: num(ext.noi_stab),
      occupancy: (ext.occupancy as string | null) ?? null,
      verdict: parsed.verdict ?? null,
      verdict_label: parsed.verdict_label ?? null,
      headline: parsed.headline ?? null,
      memo_markdown: parsed.memo_markdown ?? null,
      computed_metrics: parsed.computed ?? null,
      status: "new",
    });

    console.log(`[deal-process] Completed ${dealId}`);
    return { ok: true, status: "completed" as const };
  })().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deal-process] Unexpected error for ${dealId}:`, err);
    try {
      await updateDeal(dealId, { status: "error" });
    } catch {
      /* ignore */
    }
    return { ok: false as const, status: "error" as const, reason: msg };
  });

  if (ackOnly) {
    waitUntil(work);
    return res.status(202).json({ ok: true, deal_id: dealId, status: "started" });
  }

  const result = await work;
  return res.status(result.ok ? 200 : 500).json({ deal_id: dealId, ...result });
}
