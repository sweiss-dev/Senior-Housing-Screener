/**
 * /api/deal-update-status.ts
 * POST — update deal pipeline status
 * Body: { id: string, status: "new"|"reviewing"|"termsheet"|"passed"|"closed" }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ensureSchema, updateDealStatus } from "../server/db.js";

const VALID_STATUSES = ["new", "reviewing", "termsheet", "passed", "closed"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { id, status } = req.body as { id?: string; status?: string };
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "id is required" });
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  try {
    await ensureSchema();
    await updateDealStatus(id, status);
    return res.json({ ok: true, id, status });
  } catch (err) {
    console.error("[deal-update-status]", err);
    return res.status(500).json({ error: "Could not update deal status." });
  }
}
