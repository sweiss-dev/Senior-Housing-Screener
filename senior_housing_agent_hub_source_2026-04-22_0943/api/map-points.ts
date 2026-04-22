import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildMapPoints } from "../server/routes.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const input = req.body?.input ?? {};
    const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
    const map = await buildMapPoints(input, comps);
    res.status(200).json(map);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Map points unavailable" });
  }
}
