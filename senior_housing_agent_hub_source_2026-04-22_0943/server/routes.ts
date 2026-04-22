import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { promises as fs } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { PNG } from "pngjs";
import { googleMapsApiKey as getGoogleMapsApiKey } from "./google-key.ts";

type MemoInput = {
  name?: string;
  address?: string;
  majorityType?: string;
  state?: string;
  yearBuilt?: string;
  totalUnits?: string;
};

type MemoComp = {
  rank?: number;
  propertyName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  majorityType?: string | null;
  unitMix?: string | null;
  totalUnits?: number | null;
  yearBuilt?: number | null;
  salePrice?: number | null;
  saleDate?: string | null;
  pricePerUnit?: number | null;
  operator?: string | null;
  buyer?: string | null;
  seller?: string | null;
  broker?: string | null;
  geographyTier?: number | null;
};

type MemoStats = {
  compCount?: number;
  ppuMin?: number | null;
  ppuMax?: number | null;
  ppuMedian?: number | null;
  saleDateMin?: string | null;
  saleDateMax?: string | null;
  impliedValue?: number | null;
};

type SavedSearch = {
  id: number;
  label: string;
  input: MemoInput & { topN?: string };
  createdAt: string;
};

const bundledSavedSearchesPath = path.join(process.cwd(), "saved-searches.json");
const savedSearchesPath = process.env.VERCEL ? path.join("/tmp", "saved-searches.json") : bundledSavedSearchesPath;

export async function readSavedSearches(): Promise<SavedSearch[]> {
  try {
    const raw = await fs.readFile(savedSearchesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    try {
      const raw = await fs.readFile(bundledSavedSearchesPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
    } catch {
      return [];
    }
  }
}

export async function writeSavedSearches(searches: SavedSearch[]) {
  await fs.writeFile(savedSearchesPath, JSON.stringify(searches.slice(0, 50), null, 2));
}

export function cleanSavedSearch(body: unknown): SavedSearch | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Partial<SavedSearch>;
  if (!candidate.input || typeof candidate.input !== "object") return null;
  const input = candidate.input;
  const label =
    typeof candidate.label === "string" && candidate.label.trim()
      ? candidate.label.trim()
      : `${text(input.majorityType)} in ${text(input.state)}, built ${text(input.yearBuilt)}`;
  return {
    id: typeof candidate.id === "number" ? candidate.id : Date.now(),
    label,
    input: {
      name: text(input.name) === "N/A" ? "" : text(input.name),
      address: text(input.address) === "N/A" ? "" : text(input.address),
      majorityType: text(input.majorityType),
      state: text(input.state),
      yearBuilt: text(input.yearBuilt),
      totalUnits: text(input.totalUnits),
      topN: text(input.topN) === "N/A" ? "10" : text(input.topN),
    },
    createdAt: typeof candidate.createdAt === "string" && candidate.createdAt ? candidate.createdAt : new Date().toLocaleString("en-US"),
  };
}

function currency(value?: number | null) {
  if (!value) return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function date(value?: string | null) {
  if (!value) return "N/A";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "N/A";
  return parsed.toLocaleDateString("en-US");
}

function text(value?: string | number | null) {
  if (value === null || value === undefined || value === "") return "N/A";
  return String(value);
}

function fitText(doc: PDFKit.PDFDocument, value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions = {}) {
  doc.text(value.length > 60 ? `${value.slice(0, 57)}...` : value, x, y, options);
}

type GeoPoint = {
  label: string;
  address: string;
  lat: number;
  lon: number;
  isSubject: boolean;
};

type MapResult = {
  points: GeoPoint[];
  mapsUrl: string;
  tiles: MapTile[];
  tileZoom: number;
  bounds?: MapBounds;
  staticImage?: Buffer | null;
  provider: "google" | "osm" | "none";
  attribution: string;
};

type MapTile = {
  x: number;
  y: number;
  z: number;
  image: Buffer;
};

type MapBounds = {
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  scale: number;
};

const geocodeCache = new Map<string, GeoPoint | null>();
const googleMapsApiKey = getGoogleMapsApiKey();

function compAddress(comp: MemoComp) {
  return [comp.address, comp.city, comp.state].map((part) => text(part)).filter((part) => part !== "N/A").join(", ");
}

function subjectAddress(input: MemoInput) {
  const raw = input.address?.trim();
  if (!raw) return `Subject address not provided (${text(input.state)})`;
  const state = text(input.state);
  return state !== "N/A" && !new RegExp(`\\b${state}\\b`, "i").test(raw) ? `${raw}, ${state}` : raw;
}

function mapsRouteUrl(subjectAddress: string, comps: MemoComp[]) {
  const compAddresses = comps.map(compAddress).filter(Boolean);
  if (compAddresses.length === 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(subjectAddress)}`;
  }

  const origin = subjectAddress && !subjectAddress.startsWith("Subject address not provided") ? subjectAddress : compAddresses[0];
  const destination = compAddresses[compAddresses.length - 1];
  const waypoints = compAddresses.slice(origin === compAddresses[0] ? 1 : 0, -1);
  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
  });

  if (waypoints.length > 0) {
    params.set("waypoints", waypoints.join("|"));
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function mapZoom(points: GeoPoint[]) {
  if (points.length <= 1) return 11;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons));
  if (span > 18) return 4;
  if (span > 8) return 5;
  if (span > 4) return 6;
  if (span > 2) return 7;
  if (span > 1) return 8;
  if (span > 0.45) return 9;
  if (span > 0.2) return 10;
  return 11;
}

function lonToTileX(lon: number, zoom: number) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTileY(lat: number, zoom: number) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** zoom;
}

async function fetchMapTiles(points: GeoPoint[], maxTiles = 12): Promise<{ tiles: MapTile[]; tileZoom: number; bounds?: MapBounds }> {
  if (points.length === 0) return { tiles: [], tileZoom: 0 };
  let zoom = Math.min(10, Math.max(4, mapZoom(points)));

  while (zoom >= 4) {
    const tileXs = points.map((point) => lonToTileX(point.lon, zoom));
    const tileYs = points.map((point) => latToTileY(point.lat, zoom));
    const minTileX = Math.floor(Math.min(...tileXs)) - 1;
    const maxTileX = Math.floor(Math.max(...tileXs)) + 1;
    const minTileY = Math.floor(Math.min(...tileYs)) - 1;
    const maxTileY = Math.floor(Math.max(...tileYs)) + 1;
    const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
    if (tileCount <= maxTiles || zoom === 4) {
      const tiles: MapTile[] = [];
      for (let tx = minTileX; tx <= maxTileX; tx += 1) {
        for (let ty = minTileY; ty <= maxTileY; ty += 1) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
              headers: { "User-Agent": "PerplexityComputerSeniorHousingCompScreener/1.0" },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (response.ok) {
              tiles.push({ x: tx, y: ty, z: zoom, image: Buffer.from(await response.arrayBuffer()) });
            }
          } catch {
            // Ignore individual tile failures; the vector background still renders.
          }
        }
      }
      return {
        tiles,
        tileZoom: zoom,
        bounds: {
          minTileX,
          maxTileX,
          minTileY,
          maxTileY,
          scale: 256,
        },
      };
    }
    zoom -= 1;
  }

  return { tiles: [], tileZoom: zoom };
}

export function stitchTilesToPng(map: Pick<MapResult, "tiles" | "bounds">): Buffer | null {
  if (!map.bounds || map.tiles.length === 0) return null;
  const tileCols = map.bounds.maxTileX - map.bounds.minTileX + 1;
  const tileRows = map.bounds.maxTileY - map.bounds.minTileY + 1;
  const output = new PNG({ width: tileCols * 256, height: tileRows * 256 });

  map.tiles.forEach((tile) => {
    const png = PNG.sync.read(tile.image);
    const offsetX = (tile.x - map.bounds!.minTileX) * 256;
    const offsetY = (tile.y - map.bounds!.minTileY) * 256;
    PNG.bitblt(png, output, 0, 0, png.width, png.height, offsetX, offsetY);
  });

  return PNG.sync.write(output);
}

async function fetchGoogleStaticMap(points: GeoPoint[]): Promise<Buffer | null> {
  if (!googleMapsApiKey || points.length === 0) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("size", "960x520");
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "roadmap");
  url.searchParams.set("key", googleMapsApiKey);

  const subject = points.find((point) => point.isSubject);
  if (subject) {
    url.searchParams.append("markers", `color:0xA84B2F|label:S|${subject.lat},${subject.lon}`);
  }

  const comps = points.filter((point) => !point.isSubject).slice(0, 10);
  comps.forEach((point) => {
    url.searchParams.append("markers", `color:0x01696F|label:${point.label}|${point.lat},${point.lon}`);
  });

  points.forEach((point) => {
    url.searchParams.append("visible", `${point.lat},${point.lon}`);
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    const response = await fetch(url, {
      headers: { Accept: "image/png,image/*" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function geocode(label: string, address: string, isSubject: boolean): Promise<GeoPoint | null> {
  if (!address || address.startsWith("Subject address not provided")) return null;
  const cacheKey = `${label}|${address}`.toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;

  try {
    if (googleMapsApiKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6500);
      const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
      url.searchParams.set("address", address);
      url.searchParams.set("key", googleMapsApiKey);
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        const data = (await response.json()) as {
          status?: string;
          results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
        };
        const location = data.results?.[0]?.geometry?.location;
        const lat = Number(location?.lat);
        const lon = Number(location?.lng);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const point = { label, address, lat, lon, isSubject };
          geocodeCache.set(cacheKey, point);
          return point;
        }
      }
    }

    const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
    const queries = [address];
    if (parts.length >= 2) queries.push(parts.slice(-2).join(", "));

    for (const query of queries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6500);
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "PerplexityComputerSeniorHousingCompScreener/1.0",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const data = (await response.json()) as Array<{ lat?: string; lon?: string }>;
      const first = data[0];
      const lat = Number(first?.lat);
      const lon = Number(first?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const point = { label, address, lat, lon, isSubject };
        geocodeCache.set(cacheKey, point);
        return point;
      }
    }
    geocodeCache.set(cacheKey, null);
    return null;
  } catch {
    geocodeCache.set(cacheKey, null);
    return null;
  }
}

const STATE_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  AL: { lat: 32.8067, lon: -86.7911 },
  AK: { lat: 61.3707, lon: -152.4044 },
  AZ: { lat: 33.7298, lon: -111.4312 },
  AR: { lat: 34.9697, lon: -92.3731 },
  CA: { lat: 36.1162, lon: -119.6816 },
  CO: { lat: 39.0598, lon: -105.3111 },
  CT: { lat: 41.5978, lon: -72.7554 },
  DE: { lat: 39.3185, lon: -75.5071 },
  FL: { lat: 27.7663, lon: -81.6868 },
  GA: { lat: 33.0406, lon: -83.6431 },
  HI: { lat: 21.0943, lon: -157.4983 },
  IA: { lat: 42.0115, lon: -93.2105 },
  ID: { lat: 44.2405, lon: -114.4788 },
  IL: { lat: 40.3495, lon: -88.9861 },
  IN: { lat: 39.8494, lon: -86.2583 },
  KS: { lat: 38.5266, lon: -96.7265 },
  KY: { lat: 37.6681, lon: -84.6701 },
  LA: { lat: 31.1695, lon: -91.8678 },
  MA: { lat: 42.2302, lon: -71.5301 },
  MD: { lat: 39.0639, lon: -76.8021 },
  ME: { lat: 44.6939, lon: -69.3819 },
  MI: { lat: 43.3266, lon: -84.5361 },
  MN: { lat: 45.6945, lon: -93.9002 },
  MO: { lat: 38.4561, lon: -92.2884 },
  MS: { lat: 32.7416, lon: -89.6787 },
  MT: { lat: 46.9219, lon: -110.4544 },
  NC: { lat: 35.6301, lon: -79.8064 },
  ND: { lat: 47.5289, lon: -99.784 },
  NE: { lat: 41.1254, lon: -98.2681 },
  NH: { lat: 43.4525, lon: -71.5639 },
  NJ: { lat: 40.2989, lon: -74.521 },
  NM: { lat: 34.8405, lon: -106.2485 },
  NV: { lat: 38.3135, lon: -117.0554 },
  NY: { lat: 42.1657, lon: -74.9481 },
  OH: { lat: 40.3888, lon: -82.7649 },
  OK: { lat: 35.5653, lon: -96.9289 },
  OR: { lat: 44.572, lon: -122.0709 },
  PA: { lat: 40.5908, lon: -77.2098 },
  RI: { lat: 41.6809, lon: -71.5118 },
  SC: { lat: 33.8569, lon: -80.945 },
  SD: { lat: 44.2998, lon: -99.4388 },
  TN: { lat: 35.7478, lon: -86.6923 },
  TX: { lat: 31.0545, lon: -97.5635 },
  UT: { lat: 40.15, lon: -111.8624 },
  VA: { lat: 37.7693, lon: -78.17 },
  VT: { lat: 44.0459, lon: -72.7107 },
  WA: { lat: 47.4009, lon: -121.4905 },
  WI: { lat: 44.2685, lon: -89.6165 },
  WV: { lat: 38.4912, lon: -80.9545 },
  WY: { lat: 42.756, lon: -107.3025 },
  DC: { lat: 38.9072, lon: -77.0369 },
};

function fallbackGeoPoint(label: string, address: string, isSubject: boolean): GeoPoint | null {
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  const stateMatch = address.match(/\b[A-Z]{2}\b/g);
  const state = stateMatch?.at(-1);
  const base = state ? STATE_CENTROIDS[state] : undefined;
  if (!base) return null;
  const city = parts.length >= 2 ? parts.at(-2) ?? "" : parts[0] ?? "";
  const key = `${city}|${state}|${label}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const angle = ((hash % 360) * Math.PI) / 180;
  const radius = 0.6 + ((hash % 100) / 100) * 1.8;
  return {
    label,
    address,
    lat: base.lat + Math.sin(angle) * radius,
    lon: base.lon + Math.cos(angle) * radius,
    isSubject,
  };
}

export async function buildMapPoints(input: MemoInput, comps: MemoComp[]) {
  const sAddress = subjectAddress(input);
  const mapsUrl = mapsRouteUrl(sAddress, comps);
  const addresses = [
    { label: "S", address: sAddress, isSubject: true },
    ...comps.map((comp, idx) => ({ label: String(idx + 1), address: compAddress(comp), isSubject: false })),
  ];

  const points: GeoPoint[] = [];
  for (const item of addresses) {
    const point = (await geocode(item.label, item.address, item.isSubject)) ?? fallbackGeoPoint(item.label, item.address, item.isSubject);
    if (point) points.push(point);
  }

  return { points, mapsUrl };
}

export async function buildMapResult(input: MemoInput, comps: MemoComp[]): Promise<MapResult> {
  const { points, mapsUrl } = await buildMapPoints(input, comps);
  const staticImage = await fetchGoogleStaticMap(points);
  if (staticImage) {
    return {
      points,
      mapsUrl,
      tiles: [],
      tileZoom: mapZoom(points),
      staticImage,
      provider: "google",
      attribution: "Map data © Google",
    };
  }
  const tileResult = await fetchMapTiles(points);
  return {
    points,
    mapsUrl,
    ...tileResult,
    staticImage: null,
    provider: tileResult.tiles.length > 0 ? "osm" : "none",
    attribution: tileResult.tiles.length > 0 ? "Map tiles © OpenStreetMap contributors" : "Coordinate plot from accepted comp addresses",
  };
}

function drawVectorMap(doc: PDFKit.PDFDocument, map: MapResult, x: number, y: number, w: number, h: number) {
  const points = map.points;
  doc.roundedRect(x, y, w, h, 6).fillAndStroke("#EEF3F0", "#D4D1CA");

  if (map.staticImage) {
    doc.save();
    doc.rect(x + 1, y + 1, w - 2, h - 2).clip();
    doc.image(map.staticImage, x, y, { width: w, height: h });
    doc.restore();
    doc.fillColor("#6D6B65").fontSize(5.8).font("Helvetica").text(map.attribution, x + 6, y + h - 11, {
      width: w - 12,
      align: "right",
    });
    return;
  }

  if (points.length === 0) {
    doc.fillColor("#6D6B65").fontSize(7).font("Helvetica").text("Map preview unavailable. Addresses are listed in the detailed comp section.", x + 10, y + h / 2 - 8, {
      width: w - 20,
      align: "center",
    });
    return;
  }

  const pad = 22;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLon = Math.min(...lons);
  let maxLon = Math.max(...lons);
  if (Math.abs(maxLat - minLat) < 0.05) {
    minLat -= 0.05;
    maxLat += 0.05;
  }
  if (Math.abs(maxLon - minLon) < 0.05) {
    minLon -= 0.05;
    maxLon += 0.05;
  }

  doc.save();
  doc.rect(x + 1, y + 1, w - 2, h - 2).clip();
  if (map.tiles.length > 0 && map.bounds) {
    const tileCols = map.bounds.maxTileX - map.bounds.minTileX + 1;
    const tileRows = map.bounds.maxTileY - map.bounds.minTileY + 1;
    const tileW = w / tileCols;
    const tileH = h / tileRows;
    map.tiles.forEach((tile) => {
      doc.image(tile.image, x + (tile.x - map.bounds!.minTileX) * tileW, y + (tile.y - map.bounds!.minTileY) * tileH, {
        width: tileW + 0.5,
        height: tileH + 0.5,
      });
    });
  } else {
    doc.strokeColor("#D9E2DE").lineWidth(0.5);
    for (let i = 1; i < 5; i += 1) {
      const gx = x + pad + ((w - pad * 2) * i) / 5;
      const gy = y + pad + ((h - pad * 2) * i) / 5;
      doc.moveTo(gx, y + pad / 2).lineTo(gx, y + h - pad / 2).stroke();
      doc.moveTo(x + pad / 2, gy).lineTo(x + w - pad / 2, gy).stroke();
    }
  }

  const plotted = points.map((point) => {
    if (map.bounds) {
      const tileX = lonToTileX(point.lon, map.tileZoom);
      const tileY = latToTileY(point.lat, map.tileZoom);
      const tileCols = map.bounds.maxTileX - map.bounds.minTileX + 1;
      const tileRows = map.bounds.maxTileY - map.bounds.minTileY + 1;
      return {
        ...point,
        px: x + ((tileX - map.bounds.minTileX) / tileCols) * w,
        py: y + ((tileY - map.bounds.minTileY) / tileRows) * h,
      };
    }
    return {
      ...point,
      px: x + pad + ((point.lon - minLon) / (maxLon - minLon)) * (w - pad * 2),
      py: y + pad + ((maxLat - point.lat) / (maxLat - minLat)) * (h - pad * 2),
    };
  });

  const clustered = plotted.map((point, idx, all) => {
    const nearby = all.filter((other) => Math.hypot(other.px - point.px, other.py - point.py) < 13);
    if (nearby.length <= 1) return point;
    const position = nearby.findIndex((other) => other.label === point.label && other.isSubject === point.isSubject);
    const angle = (-Math.PI / 2) + (position * Math.PI * 2) / nearby.length;
    const radius = Math.min(20, 9 + nearby.length * 1.5);
    return {
      ...point,
      px: Math.min(x + w - 13, Math.max(x + 13, point.px + Math.cos(angle) * radius)),
      py: Math.min(y + h - 13, Math.max(y + 13, point.py + Math.sin(angle) * radius)),
      clusterSize: nearby.length,
    };
  });

  clustered
    .filter((point) => !point.isSubject)
    .forEach((point) => {
      doc.circle(point.px, point.py, 7).fillAndStroke("#01696F", "#FFFFFF");
      doc.fillColor("#FFFFFF").fontSize(6).font("Helvetica-Bold").text(point.label, point.px - 5, point.py - 3, {
        width: 10,
        align: "center",
      });
    });

  clustered
    .filter((point) => point.isSubject)
    .forEach((point) => {
      doc.circle(point.px, point.py, 8).fillAndStroke("#A84B2F", "#FFFFFF");
      doc.fillColor("#FFFFFF").fontSize(6).font("Helvetica-Bold").text("S", point.px - 5, point.py - 3, {
        width: 10,
        align: "center",
      });
    });

  doc.restore();
  const stateList = Array.from(new Set(points.map((point) => point.address.split(",").at(-1)?.trim()).filter(Boolean))).slice(0, 4).join(", ");
  const attribution = map.tiles.length > 0 ? map.attribution : `${map.attribution}${stateList ? ` (${stateList})` : ""}`;
  doc.fillColor("#6D6B65").fontSize(5.8).font("Helvetica").text(attribution, x + 6, y + h - 11, {
    width: w - 12,
    align: "right",
  });
}

function drawKpi(doc: PDFKit.PDFDocument, x: number, y: number, w: number, label: string, value: string) {
  doc.roundedRect(x, y, w, 45, 7).fillAndStroke("#F9F8F5", "#D4D1CA");
  doc.fillColor("#6D6B65").fontSize(7).font("Helvetica-Bold").text(label.toUpperCase(), x + 8, y + 8, { width: w - 16 });
  doc.fillColor("#01696F").fontSize(12).font("Helvetica-Bold").text(value, x + 8, y + 22, { width: w - 16 });
}

function drawMapPanel(doc: PDFKit.PDFDocument, input: MemoInput, comps: MemoComp[], map: MapResult, x: number, y: number, w: number, h: number) {
  doc.roundedRect(x, y, w, h, 8).fillAndStroke("#FBFBF9", "#D4D1CA");
  doc.fillColor("#01696F").fontSize(9).font("Helvetica-Bold").text("Accepted Comp Map", x + 10, y + 9);
  doc.fillColor("#6D6B65").fontSize(7).font("Helvetica").text("Subject and accepted comps are mapped below; numbered pins correspond to the comp list.", x + 10, y + 22, {
    width: w - 20,
  });

  const mapX = x + 10;
  const mapY = y + 39;
  const mapW = w - 20;
  const mapH = 145;
  drawVectorMap(doc, map, mapX, mapY, mapW, mapH);

  const legendY = y + h - 33;
  doc.fillColor("#28251D").fontSize(6.2).font("Helvetica-Bold").text("Pins:", x + 10, legendY);
  doc.font("Helvetica").fillColor("#6D6B65").text(`S Subject  |  ${comps.map((_comp, idx) => idx + 1).join(", ")} Accepted comps`, x + 35, legendY, {
    width: w - 45,
  });
  doc.fillColor("#01696F").fontSize(6.4).font("Helvetica-Bold").text("Open larger interactive map", x + 10, y + h - 16, {
    link: map.mapsUrl,
    underline: true,
  });
}

function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, x: number, y: number, w: number) {
  doc.fillColor("#01696F").fontSize(9).font("Helvetica-Bold").text(title.toUpperCase(), x, y, { characterSpacing: 0.7, width: w });
  doc.moveTo(x, y + 14).lineTo(x + w, y + 14).strokeColor("#D4D1CA").lineWidth(0.8).stroke();
}

function geoLabel(tier?: number | null) {
  if (tier === 0) return "Same state";
  if (tier === 1) return "Same region";
  return "Out of region";
}

function sizeBand(units?: number | null) {
  if (!units) return "Size N/A";
  return units > 50 ? ">50-unit band" : "<=50-unit band";
}

function writeField(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, w: number) {
  doc.fillColor("#6D6B65").fontSize(6).font("Helvetica-Bold").text(label.toUpperCase(), x, y, { width: w });
  doc.fillColor("#28251D").fontSize(7.2).font("Helvetica").text(value, x, y + 9, { width: w, height: 18 });
}

function drawCompCard(doc: PDFKit.PDFDocument, comp: MemoComp, idx: number, x: number, y: number, w: number, h: number) {
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(idx % 2 === 0 ? "#FBFBF9" : "#F9F8F5", "#D4D1CA");
  doc.fillColor("#01696F").fontSize(8).font("Helvetica-Bold").text(`#${idx + 1}`, x + 10, y + 10, { width: 24 });
  doc.fillColor("#28251D").fontSize(10).font("Helvetica-Bold").text(text(comp.propertyName), x + 38, y + 9, { width: w - 48, height: 13 });
  doc.fillColor("#6D6B65").fontSize(7).font("Helvetica").text(`${text(comp.address)} · ${text(comp.city)}, ${text(comp.state)} · ${geoLabel(comp.geographyTier)}`, x + 38, y + 23, {
    width: w - 48,
    height: 10,
  });

  const colW = (w - 36) / 3;
  const boxY = y + 42;
  doc.roundedRect(x + 10, boxY, colW, 42, 6).fillAndStroke("#EAF5F6", "#C9E1E4");
  writeField(doc, "Sale metrics", `${currency(comp.pricePerUnit)} / unit\n${date(comp.saleDate)} | ${currency(comp.salePrice)}`, x + 18, boxY + 8, colW - 16);
  doc.roundedRect(x + 18 + colW, boxY, colW, 42, 6).fillAndStroke("#F7F6F2", "#D4D1CA");
  writeField(doc, "Asset mix", `${text(comp.totalUnits)} units · built ${text(comp.yearBuilt)}`, x + 26 + colW, boxY + 8, colW - 16);
  doc.roundedRect(x + 26 + colW * 2, boxY, colW, 42, 6).fillAndStroke("#F7F6F2", "#D4D1CA");
  writeField(doc, "Parties", `Operator: ${text(comp.operator)}\nBuyer: ${text(comp.buyer)}`, x + 34 + colW * 2, boxY + 8, colW - 16);

  doc.fillColor("#6D6B65").fontSize(6.5).font("Helvetica").text(`Property unit mix: ${text(comp.unitMix)}   |   Seller: ${text(comp.seller)}   |   Broker: ${text(comp.broker)}`, x + 10, y + h - 17, {
    width: w - 20,
    height: 10,
  });
}

export async function buildMemoPdf(res: Response, payload: { input?: MemoInput; comps?: MemoComp[]; stats?: MemoStats; rejectedCount?: number }) {
  const input = payload.input ?? {};
  const comps = (payload.comps ?? []).slice(0, 10);
  const stats = payload.stats ?? {};
  const map = await buildMapResult(input, comps);

  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margin: 26,
    info: {
      Title: "Senior Housing Sales Comp Memo",
      Author: "Perplexity Computer",
    },
  });

  const filename = `senior-housing-comp-memo-${text(input.state)}-${text(input.yearBuilt)}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageW = doc.page.width;
  const margin = 26;
  const contentW = pageW - margin * 2;

  doc.fillColor("#01696F").fontSize(8).font("Helvetica-Bold").text("BLOOMFIELD CAPITAL", margin, 24, { characterSpacing: 1.2 });
  doc.fillColor("#28251D").fontSize(18).text("Senior Housing Sales Comp Memo", margin, 38);
  doc
    .fontSize(8.5)
    .font("Helvetica")
    .fillColor("#6D6B65")
    .text(
      `${text(input.name) === "N/A" ? "Subject Property" : text(input.name)} | ${text(input.majorityType)} | ${text(input.state)} | ${text(input.totalUnits)} units | Built ${text(input.yearBuilt)}${input.address ? ` | ${input.address}` : ""}`,
      margin,
      60,
      { width: contentW - 120 },
    );
  doc.fillColor("#6D6B65").fontSize(8).text(`Prepared ${new Date().toLocaleDateString("en-US")}`, pageW - margin - 95, 39, { width: 95, align: "right" });
  doc.moveTo(margin, 78).lineTo(pageW - margin, 78).lineWidth(1.5).strokeColor("#01696F").stroke();

  const kpiY = 88;
  const kpiW = (contentW - 24) / 4;
  drawKpi(doc, margin, kpiY, kpiW, "Accepted comps", text(stats.compCount ?? comps.length));
  drawKpi(doc, margin + kpiW + 8, kpiY, kpiW, "Price / unit range", `${currency(stats.ppuMin)} - ${currency(stats.ppuMax)}`);
  drawKpi(doc, margin + (kpiW + 8) * 2, kpiY, kpiW, "Median value / unit", currency(stats.ppuMedian));
  drawKpi(doc, margin + (kpiW + 8) * 3, kpiY, kpiW, "Implied subject value", currency(stats.impliedValue));

  doc.roundedRect(margin, 141, contentW, 31, 7).fillAndStroke("#F9F8F5", "#D4D1CA");
  doc
    .fillColor("#28251D")
    .fontSize(8)
    .font("Helvetica")
    .text(`Sale date spread: ${date(stats.saleDateMin)} - ${date(stats.saleDateMax)}   |   Rejected comps: ${payload.rejectedCount ?? 0}`, margin + 10, 151, {
      width: contentW - 20,
    });

  const tableX = margin;
  const tableY = 188;
  const mapX = margin + 525;
  drawMapPanel(doc, input, comps, map, mapX, tableY, contentW - 525, 230);

  const headers = ["#", "Comp", "Loc.", "Units/Built", "Sale Date", "PPU", "Sale Price"];
  const widths = [20, 178, 75, 70, 63, 70, 76];
  let x = tableX;
  doc.fillColor("#01696F").rect(tableX, tableY, 515, 17).fill();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7);
  headers.forEach((header, idx) => {
    doc.text(header, x + 4, tableY + 5, { width: widths[idx] - 8 });
    x += widths[idx];
  });

  let y = tableY + 19;
  comps.forEach((comp, idx) => {
    const rowH = 28;
    if (idx % 2 === 0) doc.fillColor("#F9F8F5").rect(tableX, y - 2, 515, rowH).fill();
    doc.fillColor("#28251D").font("Helvetica").fontSize(7);
    x = tableX;
    doc.text(String(idx + 1), x + 4, y + 4, { width: widths[0] - 8 });
    x += widths[0];
    fitText(doc, text(comp.propertyName), x + 4, y + 4, { width: widths[1] - 8 });
    doc.fillColor("#6D6B65").fontSize(6.3).text(text(comp.operator), x + 4, y + 14, { width: widths[1] - 8 });
    x += widths[1];
    doc.fillColor("#28251D").fontSize(7).text(`${text(comp.city)}, ${text(comp.state)}`, x + 4, y + 4, { width: widths[2] - 8 });
    x += widths[2];
    doc.text(`${text(comp.totalUnits)} / ${text(comp.yearBuilt)}`, x + 4, y + 4, { width: widths[3] - 8 });
    x += widths[3];
    doc.text(date(comp.saleDate), x + 4, y + 4, { width: widths[4] - 8 });
    x += widths[4];
    doc.font("Helvetica-Bold").text(currency(comp.pricePerUnit), x + 4, y + 4, { width: widths[5] - 8 });
    x += widths[5];
    doc.font("Helvetica").text(currency(comp.salePrice), x + 4, y + 4, { width: widths[6] - 8 });
    y += rowH;
  });

  doc.addPage({ size: "LETTER", layout: "landscape", margin: 26 });
  doc.fillColor("#01696F").fontSize(8).font("Helvetica-Bold").text("BLOOMFIELD CAPITAL", margin, 24, { characterSpacing: 1.2 });
  doc.fillColor("#28251D").fontSize(16).font("Helvetica-Bold").text("Accepted Comp Detail", margin, 39);
  doc.fillColor("#6D6B65").fontSize(8).font("Helvetica").text("Comp cards mirror the screener display: sale metrics, asset mix, parties, and address context.", margin, 60, {
    width: contentW,
  });
  drawSectionHeader(doc, "Accepted comps as displayed", margin, 88, contentW);

  const cardW = (contentW - 14) / 2;
  const cardH = 104;
  const startY = 116;
  comps.forEach((comp, idx) => {
    if (idx > 0 && idx % 8 === 0) {
      doc.addPage({ size: "LETTER", layout: "landscape", margin: 26 });
      doc.fillColor("#28251D").fontSize(16).font("Helvetica-Bold").text("Accepted Comp Detail", margin, 34);
      drawSectionHeader(doc, "Accepted comps as displayed", margin, 65, contentW);
    }
    const localIdx = idx % 8;
    const col = localIdx % 2;
    const row = Math.floor(localIdx / 2);
    const cardX = margin + col * (cardW + 14);
    const cardY = (idx >= 8 ? 93 : startY) + row * (cardH + 12);
    drawCompCard(doc, comp, idx, cardX, cardY, cardW, cardH);
  });

  doc
    .fillColor("#6D6B65")
    .fontSize(6.8)
    .text(
      "Median implied value equals accepted-comp median price per unit multiplied by subject total units. Source: embedded NIC MAP transaction extract provided by user.",
      margin,
      570,
      { width: contentW },
    );

  doc.end();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use((req, _res, next) => {
    if (req.path === "/api/memo-pdf") {
      req.setTimeout(120000);
    }
    next();
  });

  app.post("/api/memo-pdf", async (req: Request, res: Response) => {
    try {
      await buildMemoPdf(res, req.body ?? {});
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ error: "Memo PDF generation failed" });
    }
  });

  app.post("/api/map-points", async (req: Request, res: Response) => {
    const input = req.body?.input ?? {};
    const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
    const map = await buildMapPoints(input, comps);
    res.json(map);
  });

  app.post("/api/map-image", async (req: Request, res: Response) => {
    const input = req.body?.input ?? {};
    const comps = Array.isArray(req.body?.comps) ? req.body.comps.slice(0, 10) : [];
    const map = await buildMapResult(input, comps);
    const image = map.staticImage ?? stitchTilesToPng(map);
    res.json({
      points: map.points,
      mapsUrl: map.mapsUrl,
      zoom: map.tileZoom,
      bounds: map.bounds,
      provider: map.provider,
      attribution: map.attribution,
      requiresGoogleKey: !googleMapsApiKey,
      image: image ? `data:image/png;base64,${image.toString("base64")}` : null,
    });
  });

  app.get("/api/saved-searches", async (_req: Request, res: Response) => {
    const searches = await readSavedSearches();
    res.json({ searches });
  });

  app.post("/api/saved-searches", async (req: Request, res: Response) => {
    const search = cleanSavedSearch(req.body);
    if (!search) {
      res.status(400).json({ error: "Invalid saved search" });
      return;
    }
    const existing = await readSavedSearches();
    const deduped = existing.filter((item) => item.label !== search.label);
    const searches = [search, ...deduped].slice(0, 12);
    await writeSavedSearches(searches);
    res.json({ search, searches });
  });

  app.get("/api/download-csv", (req, res) => {
    const csv = typeof req.query.csv === "string" ? req.query.csv : "";
    const filename =
      typeof req.query.filename === "string" && req.query.filename.endsWith(".csv")
        ? req.query.filename
        : "senior-housing-comps.csv";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.send(csv);
  });

  return httpServer;
}
