const CURRENT_ACS_YEAR = "2024";
const PRIOR_ACS_YEAR = "2019";
const RADIUS_MILES = [1, 3, 5];
const ACS_VARIABLES = [
  "B01003_001E",
  "B01001_020E",
  "B01001_021E",
  "B01001_022E",
  "B01001_023E",
  "B01001_024E",
  "B01001_025E",
  "B01001_044E",
  "B01001_045E",
  "B01001_046E",
  "B01001_047E",
  "B01001_048E",
  "B01001_049E",
  "B19013_001E",
  "B25077_001E",
  "B03002_001E",
  "B03002_003E",
  "B03002_004E",
  "B03002_006E",
  "B03002_012E",
];
const PRIOR_VARIABLES = ACS_VARIABLES.slice(0, 13);
const stateNameByFips = {
  "01": "Alabama",
  "02": "Alaska",
  "04": "Arizona",
  "05": "Arkansas",
  "06": "California",
  "08": "Colorado",
  "09": "Connecticut",
  "10": "Delaware",
  "11": "District of Columbia",
  "12": "Florida",
  "13": "Georgia",
  "15": "Hawaii",
  "16": "Idaho",
  "17": "Illinois",
  "18": "Indiana",
  "19": "Iowa",
  "20": "Kansas",
  "21": "Kentucky",
  "22": "Louisiana",
  "23": "Maine",
  "24": "Maryland",
  "25": "Massachusetts",
  "26": "Michigan",
  "27": "Minnesota",
  "28": "Mississippi",
  "29": "Missouri",
  "30": "Montana",
  "31": "Nebraska",
  "32": "Nevada",
  "33": "New Hampshire",
  "34": "New Jersey",
  "35": "New Mexico",
  "36": "New York",
  "37": "North Carolina",
  "38": "North Dakota",
  "39": "Ohio",
  "40": "Oklahoma",
  "41": "Oregon",
  "42": "Pennsylvania",
  "44": "Rhode Island",
  "45": "South Carolina",
  "46": "South Dakota",
  "47": "Tennessee",
  "48": "Texas",
  "49": "Utah",
  "50": "Vermont",
  "51": "Virginia",
  "53": "Washington",
  "54": "West Virginia",
  "55": "Wisconsin",
  "56": "Wyoming",
  "72": "Puerto Rico",
};
const stateAbbrByFips = {
  "01": "AL",
  "02": "AK",
  "04": "AZ",
  "05": "AR",
  "06": "CA",
  "08": "CO",
  "09": "CT",
  "10": "DE",
  "11": "DC",
  "12": "FL",
  "13": "GA",
  "15": "HI",
  "16": "ID",
  "17": "IL",
  "18": "IN",
  "19": "IA",
  "20": "KS",
  "21": "KY",
  "22": "LA",
  "23": "ME",
  "24": "MD",
  "25": "MA",
  "26": "MI",
  "27": "MN",
  "28": "MS",
  "29": "MO",
  "30": "MT",
  "31": "NE",
  "32": "NV",
  "33": "NH",
  "34": "NJ",
  "35": "NM",
  "36": "NY",
  "37": "NC",
  "38": "ND",
  "39": "OH",
  "40": "OK",
  "41": "OR",
  "42": "PA",
  "44": "RI",
  "45": "SC",
  "46": "SD",
  "47": "TN",
  "48": "TX",
  "49": "UT",
  "50": "VT",
  "51": "VA",
  "53": "WA",
  "54": "WV",
  "55": "WI",
  "56": "WY",
  "72": "PR",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ message: "POST required" });

  try {
    const address = (req.body && req.body.address ? String(req.body.address) : "").trim();
    if (address.length < 5) return res.status(400).json({ message: "Enter a full property address." });

    const match = await geocodeAddress(address);
    const state = match.geographies.States && match.geographies.States[0];
    const county = match.geographies.Counties && match.geographies.Counties[0];
    if (!state || !county || !state.STATE || !county.COUNTY) {
      return res.status(422).json({ message: "Census did not return county/state geography." });
    }

    const lat = Number(match.coordinates.y);
    const lon = Number(match.coordinates.x);
    const stateFips = state.STATE;
    const countyFips = county.COUNTY;
    const countyName = county.NAME || county.BASENAME || "County";
    const stateName = state.NAME || stateNameByFips[stateFips] || "State";
    const stateAbbr = state.STUSAB || stateAbbrByFips[stateFips] || stateFips;
    const blockGroups = await getNearbyBlockGroups(lat, lon, 5.25);
    const rows = [];

    for (const radius of RADIUS_MILES) {
      const selected = blockGroups.filter((bg) => bg.distanceMiles <= radius);
      const currentRecords = await getBlockGroupRecords(CURRENT_ACS_YEAR, selected);
      const priorRecords = await getBlockGroupRecords(PRIOR_ACS_YEAR, selected, true);
      const current = aggregateRecords(currentRecords);
      const prior = aggregateRecords(priorRecords);
      rows.push({
        geography: `${radius} mile radius`,
        geographyType: "radius",
        population: current.population,
        populationGrowth5Y: calculateGrowth(current.population, prior.population),
        population75Plus: current.population75Plus,
        population75PlusGrowth5Y: calculateGrowth(current.population75Plus, prior.population75Plus),
        medianIncome: weightedMedian(currentRecords, "B19013_001E", "B01003_001E"),
        medianHomeValue: weightedMedian(currentRecords, "B25077_001E", "B01003_001E"),
        race: current.race,
        blockGroupsIncluded: selected.length,
        note: priorRecords.length === 0 ? "Growth unavailable due to prior block group boundary mismatch." : undefined,
      });
    }

    const countyCurrent = await getSummaryRecord(CURRENT_ACS_YEAR, stateFips, countyFips);
    const countyPrior = await getSummaryRecord(PRIOR_ACS_YEAR, stateFips, countyFips);
    const stateCurrent = await getSummaryRecord(CURRENT_ACS_YEAR, stateFips);
    const statePrior = await getSummaryRecord(PRIOR_ACS_YEAR, stateFips);
    rows.push(toSummaryRow(countyName, "county", countyCurrent, countyPrior));
    rows.push(toSummaryRow(stateName, "state", stateCurrent, statePrior));

    return res.status(200).json({
      inputAddress: address,
      matchedAddress: match.matchedAddress,
      coordinates: { lat, lon },
      county: { name: countyName, stateFips, countyFips },
      state: { name: stateName, abbreviation: stateAbbr, fips: stateFips },
      dataVintage: { current: `${CURRENT_ACS_YEAR} ACS 5-year`, prior: `${PRIOR_ACS_YEAR} ACS 5-year` },
      rows,
      methodology: [
        "Address matching uses the U.S. Census Geocoder.",
        "Radius estimates use ACS block groups whose Census internal point falls within 1, 3, or 5 miles of the address.",
        "Population, 75+ population, and race counts are summed across included block groups.",
        "Median income and median home value for radii are weighted median estimates from block-group medians.",
        "County and state comparisons use direct ACS estimates.",
      ],
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || "Unexpected error" });
  }
};

async function geocodeAddress(address) {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("vintage", "Current_Current");
  url.searchParams.set("format", "json");
  const data = await fetchJson(url.toString());
  const match = data && data.result && data.result.addressMatches && data.result.addressMatches[0];
  if (!match) throw httpError(404, "No Census geocode match found for that address.");
  return match;
}

async function getNearbyBlockGroups(lat, lon, maxMiles) {
  const deltaLat = maxMiles / 69;
  const deltaLon = maxMiles / Math.max(1, 69 * Math.cos((lat * Math.PI) / 180));
  const geometry = [lon - deltaLon, lat - deltaLat, lon + deltaLon, lat + deltaLat].join(",");
  const url = new URL("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/8/query");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "GEOID,STATE,COUNTY,TRACT,BLKGRP,CENTLAT,CENTLON,INTPTLAT,INTPTLON");
  url.searchParams.set("geometry", geometry);
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultRecordCount", "10000");
  const data = await fetchJson(url.toString());
  return (data.features || [])
    .map((feature) => {
      const a = feature.attributes;
      const geoid = String(a.GEOID);
      const bgLat = Number(a.INTPTLAT || a.CENTLAT);
      const bgLon = Number(a.INTPTLON || a.CENTLON);
      return {
        geoid,
        state: String(a.STATE || geoid.slice(0, 2)),
        county: String(a.COUNTY || geoid.slice(2, 5)),
        tract: String(a.TRACT || geoid.slice(5, 11)),
        blockGroup: String(a.BLKGRP || geoid.slice(11, 12)),
        lat: bgLat,
        lon: bgLon,
        distanceMiles: haversineMiles(lat, lon, bgLat, bgLon),
      };
    })
    .filter((bg) => Number.isFinite(bg.distanceMiles) && bg.distanceMiles <= maxMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

async function getBlockGroupRecords(year, blockGroups, prior = false) {
  const records = [];
  const vars = prior ? PRIOR_VARIABLES : ACS_VARIABLES;
  for (const bg of blockGroups) {
    const url = new URL(`https://api.census.gov/data/${year}/acs/acs5`);
    url.searchParams.set("get", vars.join(","));
    url.searchParams.set("for", `block group:${bg.blockGroup}`);
    url.searchParams.set("in", `state:${bg.state} county:${bg.county} tract:${bg.tract}`);
    try {
      const rows = await fetchJson(url.toString());
      if (Array.isArray(rows) && rows.length > 1) records.push(parseAcsRow(rows[0], rows[1]));
    } catch (error) {
      if (!prior) throw error;
    }
  }
  return records;
}

async function getSummaryRecord(year, stateFips, countyFips) {
  const url = new URL(`https://api.census.gov/data/${year}/acs/acs5`);
  url.searchParams.set("get", ACS_VARIABLES.join(","));
  if (countyFips) {
    url.searchParams.set("for", `county:${countyFips}`);
    url.searchParams.set("in", `state:${stateFips}`);
  } else {
    url.searchParams.set("for", `state:${stateFips}`);
  }
  const rows = await fetchJson(url.toString());
  return Array.isArray(rows) && rows.length > 1 ? parseAcsRow(rows[0], rows[1]) : null;
}

function parseAcsRow(headers, row) {
  return headers.reduce((acc, key, index) => {
    const value = row[index];
    acc[key] = ["state", "county", "tract", "block group"].includes(key) ? value : parseEstimate(value);
    return acc;
  }, {});
}

function aggregateRecords(records) {
  const population = sum(records, "B01003_001E");
  const population75Plus = sum75Plus(records);
  const raceBase = sum(records, "B03002_001E") || population;
  const white = sum(records, "B03002_003E");
  const black = sum(records, "B03002_004E");
  const asian = sum(records, "B03002_006E");
  const hispanic = sum(records, "B03002_012E");
  const other = [raceBase, white, black, asian, hispanic].some((value) => value === null)
    ? null
    : Math.max(0, raceBase - white - black - asian - hispanic);
  return {
    population,
    population75Plus,
    medianIncome: weightedMedian(records, "B19013_001E", "B01003_001E"),
    medianHomeValue: weightedMedian(records, "B25077_001E", "B01003_001E"),
    race: {
      white: asPct(white, raceBase),
      black: asPct(black, raceBase),
      asian: asPct(asian, raceBase),
      hispanic: asPct(hispanic, raceBase),
      other: asPct(other, raceBase),
    },
  };
}

function toSummaryRow(geography, geographyType, current, prior) {
  const c = current ? aggregateRecords([current]) : aggregateRecords([]);
  const p = prior ? aggregateRecords([prior]) : aggregateRecords([]);
  return {
    geography,
    geographyType,
    population: c.population,
    populationGrowth5Y: calculateGrowth(c.population, p.population),
    population75Plus: c.population75Plus,
    population75PlusGrowth5Y: calculateGrowth(c.population75Plus, p.population75Plus),
    medianIncome: c.medianIncome,
    medianHomeValue: c.medianHomeValue,
    race: c.race,
  };
}

function sum(records, key) {
  let total = 0;
  let found = false;
  for (const record of records) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function sum75Plus(records) {
  return [
    "B01001_020E",
    "B01001_021E",
    "B01001_022E",
    "B01001_023E",
    "B01001_024E",
    "B01001_025E",
    "B01001_044E",
    "B01001_045E",
    "B01001_046E",
    "B01001_047E",
    "B01001_048E",
    "B01001_049E",
  ].reduce((total, key) => {
    const value = sum(records, key);
    if (value === null) return total;
    return (total || 0) + value;
  }, null);
}

function weightedMedian(records, valueKey, weightKey) {
  const values = records
    .map((record) => ({ value: record[valueKey], weight: record[weightKey] }))
    .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.value >= 0 && entry.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!values.length) return null;
  const totalWeight = values.reduce((total, entry) => total + entry.weight, 0);
  let cumulative = 0;
  for (const entry of values) {
    cumulative += entry.weight;
    if (cumulative >= totalWeight / 2) return entry.value;
  }
  return values[values.length - 1].value;
}

function calculateGrowth(current, prior) {
  if (current === null || prior === null || prior <= 0) return null;
  return (current - prior) / prior;
}

function asPct(numerator, denominator) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function parseEstimate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMiles * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw httpError(response.status, `External data request failed: ${response.statusText}`);
  return response.json();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
