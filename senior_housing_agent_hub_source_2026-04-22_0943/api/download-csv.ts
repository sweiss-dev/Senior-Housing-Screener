import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const csv = typeof req.query.csv === "string" ? req.query.csv : "";
  const filename =
    typeof req.query.filename === "string" && req.query.filename.endsWith(".csv")
      ? req.query.filename
      : "senior-housing-comps.csv";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  res.status(200).send(csv);
}
