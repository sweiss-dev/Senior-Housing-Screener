import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildMemoPdf } from "../server/routes.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await buildMemoPdf(res as any, req.body ?? {});
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "Memo PDF generation failed" });
  }
}
