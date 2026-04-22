import type { VercelRequest, VercelResponse } from "@vercel/node";
import { googleMapsApiKey } from "../server/google-key.ts";
import { buildMapResult, stitchTilesToPng } from "../server/routes.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const input = req.body?.input ?? {};
    const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
    const map = await buildMapResult(input, comps);
    const image = map.staticImage ?? stitchTilesToPng(map);
    res.status(200).json({
      points: map.points,
      mapsUrl: map.mapsUrl,
      zoom: map.tileZoom,
      bounds: map.bounds,
      provider: map.provider,
      attribution: map.attribution,
      requiresGoogleKey: !googleMapsApiKey(),
      image: image ? `data:image/png;base64,${image.toString("base64")}` : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Map image unavailable" });
  }
}
