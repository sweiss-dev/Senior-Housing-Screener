import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cleanSavedSearch, readSavedSearches, writeSavedSearches } from "../server/routes.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const searches = await readSavedSearches();
      res.status(200).json({ searches });
      return;
    }

    if (req.method === "POST") {
      const search = cleanSavedSearch(req.body);
      if (!search) {
        res.status(400).json({ error: "Invalid saved search" });
        return;
      }
      const existing = await readSavedSearches();
      const deduped = existing.filter((item) => item.label !== search.label);
      const searches = [search, ...deduped].slice(0, 12);
      await writeSavedSearches(searches);
      res.status(200).json({ search, searches });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Saved searches unavailable" });
  }
}
