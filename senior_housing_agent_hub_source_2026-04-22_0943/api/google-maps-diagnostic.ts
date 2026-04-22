import type { VercelRequest, VercelResponse } from "@vercel/node";
import { googleMapsApiKey, googleMapsKeyLabel } from "../server/google-key.ts";

async function readResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return null;
  }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const key = googleMapsApiKey();
  const keyLabel = googleMapsKeyLabel();

  if (!key) {
    res.status(200).json({
      keyPresent: false,
      result: `${keyLabel} is not set in this Vercel deployment.`,
    });
    return;
  }

  const geocodeUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  geocodeUrl.searchParams.set("address", "2950 NW 5th Ave, Boca Raton, FL");
  geocodeUrl.searchParams.set("key", key);

  const staticUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
  staticUrl.searchParams.set("size", "640x360");
  staticUrl.searchParams.set("scale", "1");
  staticUrl.searchParams.set("maptype", "roadmap");
  staticUrl.searchParams.append("markers", "color:0x01696F|label:S|26.3683,-80.1289");
  staticUrl.searchParams.set("key", key);

  const [geocodeResponse, staticResponse] = await Promise.all([
    fetch(geocodeUrl, { headers: { Accept: "application/json" } }),
    fetch(staticUrl, { headers: { Accept: "image/png,image/*,*/*" } }),
  ]);

  const geocodeBody = await readResponse(geocodeResponse);
  const staticBody = await readResponse(staticResponse);

  res.status(200).json({
    keyPresent: true,
    keySource: keyLabel,
    geocode: {
      httpStatus: geocodeResponse.status,
      contentType: geocodeResponse.headers.get("content-type"),
      googleStatus: typeof geocodeBody === "object" && geocodeBody ? (geocodeBody as { status?: string }).status : null,
      errorMessage: typeof geocodeBody === "object" && geocodeBody ? (geocodeBody as { error_message?: string }).error_message ?? null : null,
    },
    staticMap: {
      httpStatus: staticResponse.status,
      contentType: staticResponse.headers.get("content-type"),
      isImage: (staticResponse.headers.get("content-type") ?? "").startsWith("image/"),
      bodyPreview: typeof staticBody === "string" ? staticBody : null,
    },
  });
}
