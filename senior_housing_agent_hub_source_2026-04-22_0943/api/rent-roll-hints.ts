import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  driveHintsConfigStatus,
  driveHintsConfigured,
  normalizeLibrary,
  readDriveHintLibrary,
  writeDriveHintLibrary,
} from "../server/drive-hints.ts";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      if (!driveHintsConfigured()) {
        res.status(200).json({
          ok: false,
          mode: "local-fallback",
          library: {},
          status: driveHintsConfigStatus(),
          message: "Google Drive hints backend is not configured. Using browser fallback.",
        });
        return;
      }
      const { library, fileId } = await readDriveHintLibrary();
      res.status(200).json({ ok: true, mode: "google-drive", library, fileId, status: driveHintsConfigStatus() });
      return;
    }

    if (req.method === "POST") {
      if (!driveHintsConfigured()) {
        res.status(501).json({
          ok: false,
          mode: "local-fallback",
          status: driveHintsConfigStatus(),
          message: "Google Drive hints backend is not configured.",
        });
        return;
      }
      const incomingLibrary = normalizeLibrary(req.body?.library ?? {});
      const { fileId } = await writeDriveHintLibrary(incomingLibrary);
      res.status(200).json({ ok: true, mode: "google-drive", library: incomingLibrary, fileId });
      return;
    }

    if (req.method === "DELETE") {
      if (!driveHintsConfigured()) {
        res.status(501).json({
          ok: false,
          mode: "local-fallback",
          status: driveHintsConfigStatus(),
          message: "Google Drive hints backend is not configured.",
        });
        return;
      }
      const operatorName = String(req.query.operatorName ?? "").trim();
      const { library } = await readDriveHintLibrary();
      if (operatorName) delete library[operatorName];
      const { fileId } = await writeDriveHintLibrary(library);
      res.status(200).json({ ok: true, mode: "google-drive", library, fileId });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      mode: "local-fallback",
      status: driveHintsConfigStatus(),
      message: error instanceof Error ? error.message : "Could not access Google Drive hints backend.",
    });
  }
}
