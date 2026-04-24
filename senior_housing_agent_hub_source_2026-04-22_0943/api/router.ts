/**
 * /api/router.ts
 *
 * Consolidated router for simple endpoints to stay under Vercel Hobby's
 * 12-function cap. Dispatches on `_action` query param (set by vercel.json
 * rewrites) so the public URLs (/api/deal-get, /api/health, etc.) are
 * unchanged for all existing callers.
 *
 * Actions handled here:
 *   deal-get, deals-list, deal-update-status, module-launch, deal-review,
 *   rent-roll-hints, saved-searches, health, map-points, map-image
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  ensureSchema,
  getDeal,
  getDealFiles,
  getDealModuleRuns,
  listDeals,
  updateDealStatus,
  insertModuleRun,
} from "../server/db.js";
import {
  driveHintsConfigStatus,
  driveHintsConfigured,
  normalizeLibrary,
  readDriveHintLibrary,
  writeDriveHintLibrary,
} from "../server/drive-hints.ts";
import { googleMapsApiKey } from "../server/google-key.ts";
import {
  buildMapPoints,
  buildMapResult,
  stitchTilesToPng,
  cleanSavedSearch,
  readSavedSearches,
  writeSavedSearches,
} from "../server/routes.ts";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

const VALID_STATUSES = ["new", "reviewing", "termsheet", "passed", "closed"];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getAction(req: VercelRequest): string {
  // Prefer explicit _action, but also infer from the original URL path.
  if (typeof req.query._action === "string" && req.query._action.trim()) {
    return req.query._action.trim();
  }
  const url = typeof req.url === "string" ? req.url.split("?")[0] : "";
  const match = url.match(/\/api\/([A-Za-z0-9_-]+)/);
  if (match && match[1] !== "router") return match[1];
  return "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = getAction(req);

  try {
    switch (action) {
      // ---------- health ----------
      case "health": {
        return res.status(200).json({ ok: true, runtime: "vercel" });
      }

      // ---------- deals ----------
      case "deal-get": {
        if (req.method !== "GET") {
          return res.status(405).json({ error: "Method not allowed" });
        }
        const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
        if (!id) {
          return res.status(400).json({ error: "id query parameter is required" });
        }
        await ensureSchema();
        const deal = await getDeal(id);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const [files, module_runs] = await Promise.all([
          getDealFiles(id),
          getDealModuleRuns(id),
        ]);
        return res.json({ deal, files, module_runs });
      }

      case "deals-list": {
        if (req.method !== "GET") {
          return res.status(405).json({ error: "Method not allowed" });
        }
        await ensureSchema();
        const deals = await listDeals();
        return res.json({ deals });
      }

      case "deal-update-status": {
        if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
        }
        const { id, status } = (req.body ?? {}) as { id?: string; status?: string };
        if (!id || typeof id !== "string") {
          return res.status(400).json({ error: "id is required" });
        }
        if (!status || !VALID_STATUSES.includes(status)) {
          return res
            .status(400)
            .json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
        }
        await ensureSchema();
        await updateDealStatus(id, status);
        return res.json({ ok: true, id, status });
      }

      case "module-launch": {
        if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
        }
        const { deal_id, module: moduleName } = (req.body ?? {}) as {
          deal_id?: string;
          module?: string;
        };
        if (!deal_id || typeof deal_id !== "string") {
          return res.status(400).json({ error: "deal_id is required" });
        }
        if (!moduleName || typeof moduleName !== "string") {
          return res.status(400).json({ error: "module is required" });
        }
        await ensureSchema();
        const deal = await getDeal(deal_id);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const files = await getDealFiles(deal_id);
        let inputs: Record<string, unknown> = {};
        switch (moduleName) {
          case "rent-roll": {
            const xlsxFile = files.find((f: any) => f.kind === "xlsx");
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
              majority_type: "AL",
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
        const run = await insertModuleRun({
          deal_id,
          module: moduleName,
          inputs_json: inputs,
          output_json: null,
        });
        return res.json({ module: moduleName, deal_id, inputs, run_id: run.id });
      }

      case "deal-review": {
        if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
        }
        const { prompt } = (req.body ?? {}) as { prompt?: string };
        if (!prompt || typeof prompt !== "string") {
          return res.status(400).json({ error: "prompt is required" });
        }
        const msg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        });
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        return res.json({ text });
      }

      // ---------- rent-roll-hints (Google Drive library) ----------
      case "rent-roll-hints": {
        if (req.method === "GET") {
          if (!driveHintsConfigured()) {
            return res.status(200).json({
              ok: false,
              mode: "local-fallback",
              library: {},
              status: driveHintsConfigStatus(),
              message:
                "Google Drive hints backend is not configured. Using browser fallback.",
            });
          }
          const { library, fileId } = await readDriveHintLibrary();
          return res
            .status(200)
            .json({ ok: true, mode: "google-drive", library, fileId, status: driveHintsConfigStatus() });
        }
        if (req.method === "POST") {
          if (!driveHintsConfigured()) {
            return res.status(501).json({
              ok: false,
              mode: "local-fallback",
              status: driveHintsConfigStatus(),
              message: "Google Drive hints backend is not configured.",
            });
          }
          const incomingLibrary = normalizeLibrary(req.body?.library ?? {});
          const { fileId } = await writeDriveHintLibrary(incomingLibrary);
          return res
            .status(200)
            .json({ ok: true, mode: "google-drive", library: incomingLibrary, fileId });
        }
        if (req.method === "DELETE") {
          if (!driveHintsConfigured()) {
            return res.status(501).json({
              ok: false,
              mode: "local-fallback",
              status: driveHintsConfigStatus(),
              message: "Google Drive hints backend is not configured.",
            });
          }
          const operatorName = String(req.query.operatorName ?? "").trim();
          const { library } = await readDriveHintLibrary();
          if (operatorName) delete library[operatorName];
          const { fileId } = await writeDriveHintLibrary(library);
          return res.status(200).json({ ok: true, mode: "google-drive", library, fileId });
        }
        res.setHeader("Allow", "GET, POST, DELETE");
        return res.status(405).json({ ok: false, error: "Method not allowed" });
      }

      // ---------- saved searches ----------
      case "saved-searches": {
        if (req.method === "GET") {
          const searches = await readSavedSearches();
          return res.status(200).json({ searches });
        }
        if (req.method === "POST") {
          const search = cleanSavedSearch(req.body);
          if (!search) {
            return res.status(400).json({ error: "Invalid saved search" });
          }
          const existing = await readSavedSearches();
          const deduped = existing.filter((item: any) => item.label !== search.label);
          const searches = [search, ...deduped].slice(0, 12);
          await writeSavedSearches(searches);
          return res.status(200).json({ search, searches });
        }
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ error: "Method not allowed" });
      }

      // ---------- map endpoints ----------
      case "map-points": {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return res.status(405).json({ error: "Method not allowed" });
        }
        const input = req.body?.input ?? {};
        const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
        const map = await buildMapPoints(input, comps);
        return res.status(200).json(map);
      }

      case "map-image": {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return res.status(405).json({ error: "Method not allowed" });
        }
        const input = req.body?.input ?? {};
        const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
        const map = await buildMapResult(input, comps);
        const image = map.staticImage ?? stitchTilesToPng(map);
        return res.status(200).json({
          points: map.points,
          mapsUrl: map.mapsUrl,
          zoom: map.tileZoom,
          bounds: map.bounds,
          provider: map.provider,
          attribution: map.attribution,
          requiresGoogleKey: !googleMapsApiKey(),
          image: image ? `data:image/png;base64,${image.toString("base64")}` : null,
        });
      }

      default:
        return res
          .status(404)
          .json({ error: `Unknown action: ${action || "(none)"}` });
    }
  } catch (err) {
    console.error(`[router:${action}]`, err);
    return res
      .status(500)
      .json({ error: "Request failed", action, message: err instanceof Error ? err.message : "Unknown error" });
  }
}
