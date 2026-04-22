/**
 * server/db.ts — Vercel Postgres (Neon) client + schema bootstrap.
 *
 * Graceful fallback: if POSTGRES_URL is not set we silently use an in-memory
 * Map so local dev and first deploy don't crash before the user provisions
 * Postgres.  All storage operations are accessed through the helpers exported
 * below rather than through the sql tag directly.
 */

import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Types (mirror the DB schema so both paths share the same shape)
// ---------------------------------------------------------------------------

export type Deal = {
  id: string;
  created_at: string;
  source: string | null;
  property_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  units: number | null;
  vintage: string | null;
  sponsor: string | null;
  operator: string | null;
  broker_firm: string | null;
  broker_contact: string | null;
  ask_amount: number | null;
  sponsor_basis: number | null;
  purchase_price: number | null;
  purpose: string | null;
  noi_t12: number | null;
  noi_y1: number | null;
  noi_y2: number | null;
  noi_stab: number | null;
  occupancy: string | null;
  verdict: string | null;
  verdict_label: string | null;
  headline: string | null;
  memo_markdown: string | null;
  computed_metrics: unknown | null;
  raw_text: string | null;
  status: string;
};

export type DealFile = {
  id: string;
  deal_id: string;
  filename: string;
  blob_url: string | null;
  kind: string | null;
  created_at: string;
};

export type ModuleRun = {
  id: string;
  deal_id: string;
  module: string;
  inputs_json: unknown;
  output_json: unknown;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Decide which backend to use
// ---------------------------------------------------------------------------

const USE_POSTGRES = Boolean(process.env.POSTGRES_URL);
let _warnedOnce = false;

function warnFallback() {
  if (_warnedOnce) return;
  _warnedOnce = true;
  console.warn(
    "[db] POSTGRES_URL not set — using in-memory fallback. " +
    "Data will not persist across restarts. " +
    "Provision Vercel Postgres (Neon) and redeploy to persist."
  );
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

const memDeals = new Map<string, Deal>();
const memFiles = new Map<string, DealFile>();
const memRuns = new Map<string, ModuleRun>();

// ---------------------------------------------------------------------------
// Schema bootstrap (idempotent)
// ---------------------------------------------------------------------------

export async function ensureSchema(): Promise<void> {
  if (!USE_POSTGRES) {
    warnFallback();
    return;
  }
  const { sql } = await import("@vercel/postgres");
  await sql`
    CREATE TABLE IF NOT EXISTS deals (
      id            text PRIMARY KEY,
      created_at    timestamptz DEFAULT now(),
      source        text,
      property_name text,
      address       text,
      city          text,
      state         text,
      units         int,
      vintage       text,
      sponsor       text,
      operator      text,
      broker_firm   text,
      broker_contact text,
      ask_amount    numeric,
      sponsor_basis numeric,
      purchase_price numeric,
      purpose       text,
      noi_t12       numeric,
      noi_y1        numeric,
      noi_y2        numeric,
      noi_stab      numeric,
      occupancy     text,
      verdict       text,
      verdict_label text,
      headline      text,
      memo_markdown text,
      computed_metrics jsonb,
      raw_text      text,
      status        text DEFAULT 'new'
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS deal_files (
      id         text PRIMARY KEY,
      deal_id    text REFERENCES deals(id),
      filename   text,
      blob_url   text,
      kind       text,
      created_at timestamptz DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS module_runs (
      id          text PRIMARY KEY,
      deal_id     text REFERENCES deals(id),
      module      text,
      inputs_json jsonb,
      output_json jsonb,
      created_at  timestamptz DEFAULT now()
    )
  `;
}

// ---------------------------------------------------------------------------
// Deal CRUD
// ---------------------------------------------------------------------------

export async function insertDeal(deal: Omit<Deal, "id" | "created_at"> & { id?: string }): Promise<Deal> {
  const id = deal.id ?? nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: Deal = { ...deal, id, created_at: now } as Deal;
    memDeals.set(id, record);
    return record;
  }

  const { sql } = await import("@vercel/postgres");
  const result = await sql<Deal>`
    INSERT INTO deals (
      id, source, property_name, address, city, state, units, vintage,
      sponsor, operator, broker_firm, broker_contact,
      ask_amount, sponsor_basis, purchase_price, purpose,
      noi_t12, noi_y1, noi_y2, noi_stab, occupancy,
      verdict, verdict_label, headline, memo_markdown,
      computed_metrics, raw_text, status
    ) VALUES (
      ${id},
      ${deal.source ?? null},
      ${deal.property_name ?? null},
      ${deal.address ?? null},
      ${deal.city ?? null},
      ${deal.state ?? null},
      ${deal.units ?? null},
      ${deal.vintage ?? null},
      ${deal.sponsor ?? null},
      ${deal.operator ?? null},
      ${deal.broker_firm ?? null},
      ${deal.broker_contact ?? null},
      ${deal.ask_amount ?? null},
      ${deal.sponsor_basis ?? null},
      ${deal.purchase_price ?? null},
      ${deal.purpose ?? null},
      ${deal.noi_t12 ?? null},
      ${deal.noi_y1 ?? null},
      ${deal.noi_y2 ?? null},
      ${deal.noi_stab ?? null},
      ${deal.occupancy ?? null},
      ${deal.verdict ?? null},
      ${deal.verdict_label ?? null},
      ${deal.headline ?? null},
      ${deal.memo_markdown ?? null},
      ${deal.computed_metrics ? JSON.stringify(deal.computed_metrics) : null},
      ${deal.raw_text ?? null},
      ${deal.status ?? "new"}
    )
    RETURNING *
  `;
  return result.rows[0];
}

export async function getDeal(id: string): Promise<Deal | null> {
  if (!USE_POSTGRES) {
    return memDeals.get(id) ?? null;
  }
  const { sql } = await import("@vercel/postgres");
  const result = await sql<Deal>`SELECT * FROM deals WHERE id = ${id}`;
  return result.rows[0] ?? null;
}

export async function listDeals(): Promise<Deal[]> {
  if (!USE_POSTGRES) {
    return [...memDeals.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }
  const { sql } = await import("@vercel/postgres");
  const result = await sql<Deal>`
    SELECT id, property_name, city, state, verdict, verdict_label, headline,
           status, created_at, ask_amount, units
    FROM deals ORDER BY created_at DESC
  `;
  return result.rows;
}

export async function updateDealStatus(id: string, status: string): Promise<void> {
  if (!USE_POSTGRES) {
    const deal = memDeals.get(id);
    if (deal) deal.status = status;
    return;
  }
  const { sql } = await import("@vercel/postgres");
  await sql`UPDATE deals SET status = ${status} WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// DealFile CRUD
// ---------------------------------------------------------------------------

export async function insertDealFile(file: Omit<DealFile, "id" | "created_at">): Promise<DealFile> {
  const id = nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: DealFile = { ...file, id, created_at: now };
    memFiles.set(id, record);
    return record;
  }

  const { sql } = await import("@vercel/postgres");
  const result = await sql<DealFile>`
    INSERT INTO deal_files (id, deal_id, filename, blob_url, kind)
    VALUES (${id}, ${file.deal_id}, ${file.filename}, ${file.blob_url ?? null}, ${file.kind ?? null})
    RETURNING *
  `;
  return result.rows[0];
}

export async function getDealFiles(dealId: string): Promise<DealFile[]> {
  if (!USE_POSTGRES) {
    return [...memFiles.values()].filter((f) => f.deal_id === dealId);
  }
  const { sql } = await import("@vercel/postgres");
  const result = await sql<DealFile>`
    SELECT * FROM deal_files WHERE deal_id = ${dealId} ORDER BY created_at ASC
  `;
  return result.rows;
}

// ---------------------------------------------------------------------------
// ModuleRun CRUD
// ---------------------------------------------------------------------------

export async function insertModuleRun(run: Omit<ModuleRun, "id" | "created_at">): Promise<ModuleRun> {
  const id = nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: ModuleRun = { ...run, id, created_at: now };
    memRuns.set(id, record);
    return record;
  }

  const { sql } = await import("@vercel/postgres");
  const result = await sql<ModuleRun>`
    INSERT INTO module_runs (id, deal_id, module, inputs_json, output_json)
    VALUES (
      ${id},
      ${run.deal_id},
      ${run.module},
      ${JSON.stringify(run.inputs_json)},
      ${JSON.stringify(run.output_json)}
    )
    RETURNING *
  `;
  return result.rows[0];
}

export async function getDealModuleRuns(dealId: string): Promise<ModuleRun[]> {
  if (!USE_POSTGRES) {
    return [...memRuns.values()].filter((r) => r.deal_id === dealId);
  }
  const { sql } = await import("@vercel/postgres");
  const result = await sql<ModuleRun>`
    SELECT * FROM module_runs WHERE deal_id = ${dealId} ORDER BY created_at ASC
  `;
  return result.rows;
}
