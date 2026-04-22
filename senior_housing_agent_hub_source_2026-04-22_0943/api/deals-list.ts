/**
 * /api/deals-list.ts
 * GET — returns all deals ordered by created_at desc
 * Columns: id, property_name, city, state, verdict, verdict_label, headline, status, created_at, ask_amount, units
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ensureSchema, listDeals } from "../server/db.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    await ensureSchema();
    const deals = await listDeals();
    return res.json({ deals });
  } catch (err) {
    console.error("[deals-list]", err);
    return res.status(500).json({ error: "Could not load deals." });
  }
}
