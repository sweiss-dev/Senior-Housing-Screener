import type { VercelRequest, VercelResponse } from "@vercel/node";
import { googleMapsApiKey, googleMapsKeyLabel } from "../server/google-key.ts";

type ReviewSource = {
  source: string;
  status: "found" | "not_found" | "limited" | "error";
  name?: string;
  rating?: number | null;
  reviewCount?: number | null;
  url?: string | null;
  summary?: string;
  reviewSnippets?: string[];
  notes?: string;
};

type ReviewContext = {
  query: string;
  google?: ReviewSource | null;
};

type GooglePlace = {
  id?: string;
  name?: string;
  displayName?: { text?: string };
  formatted_address?: string;
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  user_ratings_total?: number;
  url?: string;
  website?: string;
  googleMapsUri?: string;
  websiteUri?: string;
  reviews?: Array<{
    author_name?: string;
    authorAttribution?: { displayName?: string };
    rating?: number;
    relative_time_description?: string;
    relativePublishTimeDescription?: string;
    text?: string;
    originalText?: { text?: string };
  }>;
};

const DIRECTORY_TARGETS = [
  {
    source: "A Place for Mom",
    domain: "aplaceformom.com",
    searchLabel: "A Place for Mom",
  },
  {
    source: "Caring.com",
    domain: "caring.com",
    searchLabel: "Caring.com senior living",
  },
  {
    source: "Seniorly",
    domain: "seniorly.com",
    searchLabel: "Seniorly",
  },
  {
    source: "SeniorAdvisor",
    domain: "senioradvisor.com",
    searchLabel: "SeniorAdvisor",
  },
  {
    source: "U.S. News Senior Living",
    domain: "health.usnews.com",
    searchLabel: "U.S. News senior living reviews",
  },
  {
    source: "Yelp",
    domain: "yelp.com",
    searchLabel: "Yelp senior living reviews",
  },
  {
    source: "Trustpilot",
    domain: "trustpilot.com",
    searchLabel: "Trustpilot reviews",
  },
  {
    source: "PissedConsumer",
    domain: "pissedconsumer.com",
    searchLabel: "PissedConsumer reviews complaints",
  },
];

const USER_AGENT =
  "Mozilla/5.0 (compatible; BloomfieldReviewAgent/1.0; +https://senior-housing-screener.vercel.app)";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawQuery = String(req.body?.query ?? "").trim();
  const explicitSourceUrl = String(req.body?.sourceUrl ?? "").trim();
  const queryLooksLikeUrl = isHttpUrl(rawQuery);
  const sourceUrl = explicitSourceUrl || (queryLooksLikeUrl ? rawQuery : "");
  const query = queryLooksLikeUrl ? facilityQueryFromUrl(rawQuery) : rawQuery;
  if (!query && !sourceUrl) {
    res.status(400).json({ error: "Enter a facility name/address or paste a review page URL." });
    return;
  }

  try {
    const google = query ? await getGoogleReviews(query) : null;
    const pastedSource = sourceUrl ? [await getPastedSource(sourceUrl)] : [];
    const context: ReviewContext = { query, google };
    const directorySources = query
      ? await Promise.all(DIRECTORY_TARGETS.map((target) => getDirectorySource(context, target)))
      : [];

    const sources = [google, ...pastedSource, ...directorySources].filter(Boolean) as ReviewSource[];
    const found = sources.filter((source) => source.status === "found");
    const weightedRating = calculateWeightedRating(found);
    const totalReviews = found.reduce((sum, source) => sum + (source.reviewCount ?? 0), 0);

    res.status(200).json({
      query: query || sourceUrl,
      generatedAt: new Date().toISOString(),
      headline: buildHeadline(found, weightedRating, totalReviews),
      weightedRating,
      totalReviews,
      sources,
      methodology: [
        "Google data is pulled from the Google Places API using the configured project API key.",
        "Directory pages are discovered with DuckDuckGo HTML search scoped to senior-housing review domains, then parsed for public JSON-LD aggregateRating and visible rating/review count text.",
        "Some review sites limit automated access or render review details client-side; those sources are marked limited when a likely page is found but structured review metadata is unavailable.",
      ],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not pull reviews for this facility." });
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function facilityQueryFromUrl(value: string) {
  try {
    const url = new URL(value);
    const slug = url.pathname
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .trim();
    return slug || url.hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

async function getPastedSource(url: string): Promise<ReviewSource> {
  try {
    const parsed = new URL(url);
    const source = sourceNameForHost(parsed.hostname);
    const page = await fetchDirectoryPage(parsed.href);
    if (!page) {
      return {
        source,
        status: "limited",
        url: parsed.href,
        notes: "The pasted source page could not be fetched for rating extraction.",
      };
    }
    const extracted = extractRatingData(page.html);
    const snippets = extractReviewText(page.html).slice(0, 4);
    return {
      source,
      status: extracted.rating || extracted.reviewCount || snippets.length ? "found" : "limited",
      name: extracted.name,
      rating: extracted.rating,
      reviewCount: extracted.reviewCount,
      url: parsed.href,
      reviewSnippets: snippets,
      notes:
        extracted.rating || extracted.reviewCount
          ? undefined
          : "The pasted page loaded, but structured rating metadata was not exposed in the fetched HTML.",
    };
  } catch {
    return {
      source: "Pasted source",
      status: "error",
      url,
      notes: "The pasted source URL was not valid.",
    };
  }
}

function sourceNameForHost(hostname: string) {
  const host = hostname.replace(/^www\./, "");
  if (host.includes("aplaceformom.com")) return "A Place for Mom";
  if (host.includes("caring.com")) return "Caring.com";
  if (host.includes("seniorly.com")) return "Seniorly";
  if (host.includes("senioradvisor.com")) return "SeniorAdvisor";
  if (host.includes("health.usnews.com")) return "U.S. News Senior Living";
  if (host.includes("yelp.com")) return "Yelp";
  if (host.includes("trustpilot.com")) return "Trustpilot";
  if (host.includes("pissedconsumer.com")) return "PissedConsumer";
  return host;
}

async function getGoogleReviews(query: string): Promise<ReviewSource> {
  const key = googleMapsApiKey();
  if (!key) {
    return {
      source: "Google",
      status: "limited",
      notes: `${googleMapsKeyLabel()} is not configured in this Vercel deployment.`,
    };
  }

  const searchResponse = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri,places.reviews",
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 5,
    }),
  });
  const searchBody = await searchResponse.json();
  const candidates: GooglePlace[] = Array.isArray(searchBody?.places) ? searchBody.places : [];
  const matched = chooseBestGooglePlace(query, candidates);
  const place = matched?.place;
  if (!place?.id) {
    return {
      source: "Google",
      status: searchBody?.error?.message ? "limited" : "not_found",
      notes: searchBody?.error?.message ?? "No Google Places match found.",
    };
  }

  if (!place.displayName?.text && !place.name) {
    return {
      source: "Google",
      status: "limited",
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? place.user_ratings_total ?? null,
      notes: searchBody?.error?.message ?? "Google returned a place match but no detail payload.",
    };
  }

  const snippets = (place.reviews ?? [])
    .map((review) => {
      const text =
        typeof review.text === "string"
          ? review.text
          : review.originalText?.text;
      const parts = [
        review.rating ? `${review.rating}/5` : null,
        review.relativePublishTimeDescription ?? review.relative_time_description,
        text,
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .filter(Boolean)
    .slice(0, 5);

  return {
    source: "Google",
    status: "found",
    name: place.displayName?.text ?? place.name,
    rating: asNumber(place.rating),
    reviewCount: asNumber(place.userRatingCount ?? place.user_ratings_total),
    url: place.googleMapsUri ?? place.url ?? null,
    summary: place.formattedAddress ?? place.formatted_address,
    reviewSnippets: snippets,
    notes:
      matched && matched.score < 0.42
        ? `Low-confidence Google match for "${query}". Returned "${place.displayName?.text ?? place.name}". Add city/state or paste a source URL if this looks wrong.`
        : undefined,
  };
}

function chooseBestGooglePlace(query: string, places: GooglePlace[]) {
  if (!places.length) return null;
  const queryTokens = meaningfulTokens(query);
  const scored = places.map((place) => {
    const name = place.displayName?.text ?? place.name ?? "";
    const address = place.formattedAddress ?? place.formatted_address ?? "";
    const text = `${name} ${address}`;
    const textTokens = meaningfulTokens(text);
    const tokenScore = tokenOverlapScore(queryTokens, textTokens);
    const nameScore = tokenOverlapScore(queryTokens, meaningfulTokens(name));
    const ratingBoost = place.rating ? 0.03 : 0;
    const score = Math.min(1, tokenScore * 0.55 + nameScore * 0.4 + ratingBoost);
    return { place, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function meaningfulTokens(value: string) {
  const stop = new Set([
    "the",
    "at",
    "of",
    "a",
    "an",
    "and",
    "senior",
    "living",
    "assisted",
    "facility",
    "community",
    "memory",
    "care",
    "llc",
    "inc",
    "fl",
    "tn",
    "ca",
    "ny",
    "tx",
  ]);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stop.has(token));
}

function tokenOverlapScore(queryTokens: string[], textTokens: string[]) {
  if (!queryTokens.length || !textTokens.length) return 0;
  const textSet = new Set(textTokens);
  const matches = queryTokens.filter((token) => textSet.has(token)).length;
  return matches / queryTokens.length;
}

async function findStructuredDirectoryPage(
  context: ReviewContext,
  target: { source: string; domain: string; searchLabel: string },
): Promise<ReviewSource | null> {
  if (target.domain === "aplaceformom.com") return findAPlaceForMomFromCityPages(context);
  if (target.domain === "caring.com") return findCaringFromSlug(context);
  if (target.domain === "seniorly.com") return findSeniorlyFromSlug(context);
  return null;
}

async function findAPlaceForMomFromCityPages(context: ReviewContext): Promise<ReviewSource | null> {
  const location = parseGoogleLocation(context.google?.summary);
  if (!location?.city || !location?.stateName) return null;
  const slugs = [
    `https://www.aplaceformom.com/assisted-living/${location.stateName}/${location.citySlug}`,
    `https://www.aplaceformom.com/memory-care/${location.stateName}/${location.citySlug}`,
    `https://www.aplaceformom.com/independent-living/${location.stateName}/${location.citySlug}`,
  ];

  const candidates: Array<{ url: string; name?: string; rating?: number | null; reviewCount?: number | null; snippets?: string[]; score: number }> = [];
  for (const url of slugs) {
    const page = await fetchDirectoryPage(url);
    if (!page) continue;
    const items = extractDirectoryItems(page.html);
    for (const item of items) {
      const score = directoryMatchScore(context, item.name ?? "", item.url ?? "");
      if (score >= 0.48 && item.url) {
        candidates.push({ ...item, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best?.url) return null;
  const communityUrl = absoluteUrl(best.url, "https://www.aplaceformom.com");
  const detail = await fetchDirectoryPage(communityUrl);
  const extracted = detail ? extractRatingData(detail.html) : { rating: best.rating ?? null, reviewCount: best.reviewCount ?? null };
  const snippets = detail ? extractReviewText(detail.html).slice(0, 4) : best.snippets ?? [];
  return {
    source: "A Place for Mom",
    status: "found",
    name: extracted.name ?? best.name,
    rating: normalizeRating(extracted.rating ?? best.rating ?? null, 10),
    reviewCount: extracted.reviewCount ?? best.reviewCount ?? null,
    url: communityUrl,
    reviewSnippets: snippets,
  };
}

async function findCaringFromSlug(context: ReviewContext): Promise<ReviewSource | null> {
  const location = parseGoogleLocation(context.google?.summary);
  if (!location?.city || !location?.stateName) return null;
  const facilitySlug = slugify(stripProviderSuffix(context.google?.name || context.query));
  const citySlug = location.citySlug;
  const candidates = [
    `https://www.caring.com/senior-living/${location.stateName}/${citySlug}/${facilitySlug}`,
  ];
  for (const url of candidates) {
    const page = await fetchDirectoryPage(url);
    if (!page) continue;
    if (!page.url.includes(facilitySlug)) continue;
    const extracted = extractRatingData(page.html);
    const name = extracted.name ?? stripProviderSuffix(context.google?.name || context.query);
    if ((extracted.rating || extracted.reviewCount) && directoryMatchScore(context, name, url) >= 0.35) {
      return {
        source: "Caring.com",
        status: "found",
        name,
        rating: normalizeRating(extracted.rating, 5),
        reviewCount: extracted.reviewCount,
        url,
        reviewSnippets: extractReviewText(page.html).slice(0, 4),
      };
    }
  }
  return null;
}

async function findSeniorlyFromSlug(context: ReviewContext): Promise<ReviewSource | null> {
  const location = parseGoogleLocation(context.google?.summary);
  if (!location?.city || !location?.stateName) return null;
  const facilitySlug = slugify(stripProviderSuffix(context.google?.name || context.query));
  const citySlug = location.citySlug;
  const urls = [
    `https://www.seniorly.com/assisted-living/${location.stateName}/${citySlug}/${facilitySlug}`,
    `https://www.seniorly.com/independent-living/${location.stateName}/${citySlug}/${facilitySlug}`,
    `https://www.seniorly.com/memory-care/${location.stateName}/${citySlug}/${facilitySlug}`,
  ];
  for (const url of urls) {
    const page = await fetchDirectoryPage(url);
    if (!page) continue;
    if (!page.url.includes(facilitySlug)) continue;
    const extracted = extractRatingData(page.html);
    const name = extracted.name ?? stripProviderSuffix(context.google?.name || context.query);
    if ((extracted.rating || extracted.reviewCount) && directoryMatchScore(context, name, url) >= 0.35) {
      return {
        source: "Seniorly",
        status: "found",
        name,
        rating: normalizeRating(extracted.rating, 5),
        reviewCount: extracted.reviewCount,
        url,
        reviewSnippets: extractReviewText(page.html).slice(0, 4),
      };
    }
  }
  return null;
}

function extractDirectoryItems(html: string) {
  const blocks = [...html.matchAll(/"@type":"ListItem"[\s\S]*?(?=,\{"@type":"ListItem"|"breadcrumb"|<\/script>)/g)].map((match) => `{${match[0]}`);
  return blocks
    .map((block) => {
      const name = matchString(block, /"name":"([^"]+)"/);
      const url = matchString(block, /"url":"([^"]+)"/);
      const rating = asNumber(matchString(block, /"aggregateRating":\{"@type":"AggregateRating","ratingValue":([0-9.]+)/));
      const reviewCount = asNumber(matchString(block, /"reviewCount":([0-9,]+)/));
      const snippet = matchString(block, /"reviewBody":"([^"]{20,600})"/);
      return { name, url, rating, reviewCount, snippets: snippet ? [htmlDecode(snippet)] : [] };
    })
    .filter((item) => item.name && item.url);
}

function matchString(value: string, regex: RegExp) {
  const match = value.match(regex);
  return match?.[1] ? htmlDecode(match[1]) : undefined;
}

function directoryMatchScore(context: ReviewContext, name: string, url: string) {
  const googleName = stripProviderSuffix(context.google?.name ?? "");
  const query = stripProviderSuffix(context.query);
  const baseTokens = meaningfulTokens(`${query} ${googleName}`);
  const targetTokens = meaningfulTokens(`${name} ${url.replace(/[-/_]/g, " ")}`);
  return tokenOverlapScore(baseTokens, targetTokens);
}

function parseGoogleLocation(summary?: string) {
  if (!summary) return null;
  const parts = summary.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const city = parts[parts.length - 3];
  const stateToken = parts[parts.length - 2]?.split(/\s+/)[0]?.toUpperCase();
  const stateName = stateSlug(stateToken);
  if (!city || !stateName) return null;
  return { city, citySlug: slugify(city), state: stateToken, stateName };
}

function stripProviderSuffix(value: string) {
  return value
    .replace(/\s+-\s+.*$/g, "")
    .replace(/\bA Willow Ridge Senior Living community\b/gi, "")
    .replace(/\bSenior Living Community\b/gi, "")
    .trim();
}

function normalizeRating(value: number | null | undefined, bestRating: number) {
  if (!value) return null;
  return bestRating === 10 && value > 5 ? Number((value / 2).toFixed(1)) : value;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url: string, base: string) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function stateSlug(state?: string) {
  const states: Record<string, string> = {
    AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new-hampshire", NJ: "new-jersey", NM: "new-mexico", NY: "new-york", NC: "north-carolina", ND: "north-dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode-island", SC: "south-carolina", SD: "south-dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west-virginia", WI: "wisconsin", WY: "wyoming", DC: "district-of-columbia",
  };
  return state ? states[state] : undefined;
}

async function getDirectorySource(
  context: ReviewContext,
  target: { source: string; domain: string; searchLabel: string },
): Promise<ReviewSource> {
  const query = context.query;
  try {
    const directResult = await findStructuredDirectoryPage(context, target);
    if (directResult) return directResult;

    const result = await findDirectoryPage(query, target);
    if (!result) {
      return {
        source: target.source,
        status: "limited",
        url: buildManualSearchUrl(query, target),
        notes: `No likely ${target.source} page was automatically matched. Open the search link to review matches manually.`,
      };
    }

    const page = await fetchDirectoryPage(result.url);
    if (!page) {
      return {
        source: target.source,
        status: "limited",
        name: result.title,
        url: result.url,
        summary: result.snippet,
        notes: "A likely page was found, but the page could not be fetched for rating extraction.",
      };
    }

    const extracted = extractRatingData(page.html);
    const snippets = extractReviewText(page.html).slice(0, 4);
    const resolvedName = extracted.name ?? cleanupTitle(result.title);
    const matchScore = directoryMatchScore(context, resolvedName, page.url || result.url);
    if (matchScore < 0.35) {
      return {
        source: target.source,
        status: "limited",
        name: resolvedName,
        url: result.url,
        summary: result.snippet,
        notes:
          "A possible page was found, but it looked like a city/provider page rather than a confident match to this facility.",
      };
    }
    const status = extracted.rating || extracted.reviewCount || snippets.length ? "found" : "limited";

    return {
      source: target.source,
      status,
      name: resolvedName,
      rating: extracted.rating,
      reviewCount: extracted.reviewCount,
      url: result.url,
      summary: result.snippet,
      reviewSnippets: snippets,
      notes:
        status === "limited"
          ? "Likely directory page found, but structured rating metadata was not exposed in the fetched HTML."
          : undefined,
    };
  } catch (error) {
    console.error(`Directory source failed: ${target.source}`, error);
    return {
      source: target.source,
      status: "error",
      notes: "Directory lookup failed.",
    };
  }
}

function buildManualSearchUrl(query: string, target: { source: string; domain: string; searchLabel: string }) {
  const encoded = encodeURIComponent(query);
  if (target.domain === "aplaceformom.com") return `https://www.aplaceformom.com/search?searchQuery=${encoded}`;
  if (target.domain === "caring.com") return `https://www.google.com/search?q=${encodeURIComponent(`site:caring.com/senior-living ${query} reviews`)}`;
  if (target.domain === "seniorly.com") return `https://www.google.com/search?q=${encodeURIComponent(`site:seniorly.com ${query} reviews`)}`;
  if (target.domain === "senioradvisor.com") return `https://www.google.com/search?q=${encodeURIComponent(`site:senioradvisor.com ${query} reviews`)}`;
  if (target.domain === "health.usnews.com") return `https://www.google.com/search?q=${encodeURIComponent(`site:health.usnews.com/best-senior-living ${query} reviews`)}`;
  if (target.domain === "yelp.com") return `https://www.yelp.com/search?find_desc=${encoded}`;
  if (target.domain === "trustpilot.com") return `https://www.trustpilot.com/search?query=${encoded}`;
  if (target.domain === "pissedconsumer.com") return `https://www.google.com/search?q=${encodeURIComponent(`site:pissedconsumer.com ${query} reviews complaints`)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${target.domain} ${query} reviews`)}`;
}

async function findDirectoryPage(
  query: string,
  target: { domain: string; searchLabel: string },
): Promise<{ title: string; url: string; snippet: string } | null> {
  return (await findDuckDuckGoPage(query, target)) ?? (await findBingPage(query, target));
}

async function findDuckDuckGoPage(
  query: string,
  target: { domain: string; searchLabel: string },
): Promise<{ title: string; url: string; snippet: string } | null> {
  const searchUrl = new URL("https://duckduckgo.com/html/");
  searchUrl.searchParams.set("q", `site:${target.domain} ${query} ${target.searchLabel} reviews`);

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const results = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/gi)]
    .map((match) => ({
      title: stripHtml(match[2]),
      url: decodeDuckDuckGoUrl(match[1]),
      snippet: stripHtml((match[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ?? [null, match[3]])[1]),
    }))
    .filter((result) => result.url.includes(target.domain));

  return results[0] ?? null;
}

async function findBingPage(
  query: string,
  target: { domain: string; searchLabel: string },
): Promise<{ title: string; url: string; snippet: string } | null> {
  const searchUrl = new URL("https://www.bing.com/search");
  searchUrl.searchParams.set("q", `site:${target.domain} ${query} ${target.searchLabel} reviews`);
  searchUrl.searchParams.set("count", "5");

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const results = [...html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi)]
    .map((match) => ({
      title: stripHtml(match[2] ?? ""),
      url: htmlDecode(match[1] ?? ""),
      snippet: stripHtml(match[3] ?? ""),
    }))
    .filter((result) => result.url.includes(target.domain));
  return results[0] ?? null;
}

async function fetchDirectoryPage(url: string): Promise<{ html: string; url: string } | null> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) return null;
  return { html: await response.text(), url: response.url };
}

function extractRatingData(html: string): { name?: string; rating: number | null; reviewCount: number | null } {
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => safeJson(match[1]))
    .flatMap((value) => flattenJsonLd(value));

  for (const item of jsonLdBlocks) {
    const aggregate = item?.aggregateRating ?? item?.review?.aggregateRating;
    const rating = asNumber(aggregate?.ratingValue ?? aggregate?.rating);
    const reviewCount = asNumber(aggregate?.reviewCount ?? aggregate?.ratingCount ?? aggregate?.count);
    if (rating || reviewCount) {
      return {
        name: typeof item?.name === "string" ? item.name : undefined,
        rating,
        reviewCount,
      };
    }
  }

  const text = stripHtml(html).replace(/\s+/g, " ");
  const ratingMatch =
    text.match(/(?:rating|rated)\s*[: ]\s*([0-5](?:\.\d)?)\s*(?:out of|\/)\s*5/i) ??
    text.match(/([0-5](?:\.\d)?)\s*(?:out of|\/)\s*5\s*(?:stars|star rating|rating)?/i);
  const reviewMatch =
    text.match(/([0-9][0-9,]*)\s+(?:reviews|customer reviews|family reviews|ratings)/i) ??
    text.match(/reviews\s*\(?\s*([0-9][0-9,]*)\s*\)?/i);

  return {
    rating: ratingMatch ? asNumber(ratingMatch[1]) : null,
    reviewCount: reviewMatch ? asNumber(reviewMatch[1]) : null,
  };
}

function extractReviewText(html: string): string[] {
  const text = stripHtml(html).replace(/\s+/g, " ");
  const quotes = [...text.matchAll(/[“"]([^“”"]{80,420})[”"]/g)]
    .map((match) => match[1])
    .filter((snippet) => /care|staff|resident|community|facility|nurse|food|clean|memory|assisted/i.test(snippet));
  return dedupe(quotes).slice(0, 5);
}

function calculateWeightedRating(sources: ReviewSource[]): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const source of sources) {
    if (!source.rating) continue;
    const weight = Math.max(1, Math.min(source.reviewCount ?? 1, 250));
    numerator += source.rating * weight;
    denominator += weight;
  }
  return denominator ? Number((numerator / denominator).toFixed(2)) : null;
}

function buildHeadline(sources: ReviewSource[], weightedRating: number | null, totalReviews: number) {
  if (!sources.length) return "No review sources found yet.";
  const best = sources
    .filter((source) => source.rating)
    .sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0))[0];
  const parts = [];
  if (weightedRating) parts.push(`${weightedRating.toFixed(2)} weighted rating`);
  if (totalReviews) parts.push(`${totalReviews.toLocaleString("en-US")} reviews/ratings located`);
  if (best) parts.push(`largest signal from ${best.source}`);
  return parts.join(" · ") || `${sources.length} review source${sources.length === 1 ? "" : "s"} located`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
}

function flattenJsonLd(value: unknown): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const graph = Array.isArray(record["@graph"]) ? flattenJsonLd(record["@graph"]) : [];
    return [record, ...graph];
  }
  return [];
}

function decodeDuckDuckGoUrl(url: string) {
  const decoded = htmlDecode(url);
  try {
    const parsed = new URL(decoded, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return decoded;
  }
}

function stripHtml(value: string) {
  return htmlDecode(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function htmlDecode(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanupTitle(value: string) {
  return value.replace(/\s+[-|]\s+.*$/, "").trim();
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
