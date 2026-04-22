/**
 * /api/module-launch.ts
 * POST — returns pre-filled inputs for a module based on a deal record
 *
 * Body: { deal_id: string, module: "rent-roll"|"demographics"|"sales-comp"|"memo-pdf" }
 * Returns: { module, deal_id, inputs, run_id }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ensureSchema,
  getDeal,
  getDealFiles,
  insertModuleRun,
} from "../server/db.js";

type ModuleInputs = Record<string, unknown>;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { deal_id, module: moduleName } = req.body as {
    deal_id?: string;
    module?: string;
  };

  if (!deal_id || typeof deal_id !== "string") {
    return res.status(400).json({ error: "deal_id is required" });
  }
  if (!moduleName || typeof moduleName !== "string") {
    return res.status(400).json({ error: "module is required" });
  }

  try {
    await ensureSchema();

    const deal = await getDeal(deal_id);
    if (!deal) {
      return res.status(404).json({ error: "Deal not found" });
    }

    const files = await getDealFiles(deal_id);
    let inputs: ModuleInputs = {};

    switch (moduleName) {
      case "rent-roll": {
        // Return the blob URL of any XLSX file attached to the deal
        const xlsxFile = files.find((f) => f.kind === "xlsx");
        inputs = {
          blob_url: xlsxFile?.blob_url ?? null,
          filename: xlsxFile?.filename ?? null,
          property_name: deal.property_name,
        };
        break;
      }

      case "demographics": {
        const addressParts = [deal.address, deal.city, deal.state].filter(Boolean);
        inputs = {
          address: addressParts.join(", ") || null,
          property_name: deal.property_name,
        };
        break;
      }

      case "sales-comp": {
        const addressParts = [deal.address, deal.city, deal.state].filter(Boolean);
        inputs = {
          address: addressParts.join(", ") || null,
          units: deal.units,
          vintage: deal.vintage,
          property_name: deal.property_name,
          state: deal.state,
          majority_type: deal.operator ? "AL" : "AL", // default to AL; user can adjust
        };
        break;
      }

      case "memo-pdf": {
        inputs = {
          memo_markdown: deal.memo_markdown,
          property_name: deal.property_name,
          address: deal.address,
          city: deal.city,
          state: deal.state,
          units: deal.units,
          vintage: deal.vintage,
          ask_amount: deal.ask_amount,
          sponsor: deal.sponsor,
          operator: deal.operator,
          verdict: deal.verdict,
          verdict_label: deal.verdict_label,
          headline: deal.headline,
          computed_metrics: deal.computed_metrics,
        };
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown module: ${moduleName}` });
    }

    // Write module run record
    const run = await insertModuleRun({
      deal_id,
      module: moduleName,
      inputs_json: inputs,
      output_json: null,
    });

    return res.json({
      module: moduleName,
      deal_id,
      inputs,
      run_id: run.id,
    });
  } catch (err) {
    console.error("[module-launch]", err);
    return res.status(500).json({ error: "Could not launch module." });
  }
}
