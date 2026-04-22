/**
 * /api/deal-get.ts
 * GET ?id=<deal_id>
 * Returns full deal record + files + module_runs
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureSchema,
  getDeal,
  getDealFiles,
  getDealModuleRuns,
} from "../server/db.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id) {
    return res.status(400).json({ error: "id query parameter is required" });
  }
  try {
    await ensureSchema();
    const deal = await getDeal(id);
    if (!deal) {
      return res.status(404).json({ error: "Deal not found" });
    }
    const [files, module_runs] = await Promise.all([
      getDealFiles(id),
      getDealModuleRuns(id),
    ]);
    return res.json({ deal, files, module_runs });
  } catch (err) {
    console.error("[deal-get]", err);
    return res.status(500).json({ error: "Could not load deal." });
  }
}
