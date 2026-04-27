/**
 * server/db.ts — Postgres client + schema bootstrap.
 *
 * Uses the standard `pg` package so any Postgres URL works (Supabase, Neon,
 * RDS, etc.).  Graceful fallback: if POSTGRES_URL is not set we silently use
 * an in-memory Map so local dev and first deploy don't crash before the user
 * provisions Postgres.
 */

import { nanoid } from "nanoid";
import { Pool, type QueryResultRow } from "pg";

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

const POSTGRES_URL = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "";
const USE_POSTGRES = Boolean(POSTGRES_URL);
let _warnedOnce = false;

function warnFallback() {
  if (_warnedOnce) return;
  _warnedOnce = true;
  console.warn(
    "[db] POSTGRES_URL not set — using in-memory fallback. " +
    "Data will not persist across restarts. " +
    "Provision Postgres and redeploy to persist.",
  );
}

// Reuse a single Pool across hot-reloaded module instances on Vercel.
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!global.__pgPool) {
    // Strip any sslmode= from the connection string and explicitly configure
    // SSL ourselves so we can accept Supabase's self-signed cert chain. The
    // pg driver's built-in `sslmode=require` enables full chain verification
    // which Supabase's pooler cert does not satisfy out of the box.
    const cleanUrl = POSTGRES_URL.replace(/([?&])sslmode=[^&]*/g, "$1")
      .replace(/[?&]$/, "")
      .replace(/\?&/, "?");

    global.__pgPool = new Pool({
      connectionString: cleanUrl,
      ssl: { rejectUnauthorized: false },
      // Keep the pool tiny — serverless + pgbouncer.
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  return global.__pgPool;
}

async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const pool = getPool();
  const result = await pool.query<T>(text, params as unknown[]);
  return { rows: result.rows };
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
  await query(`
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
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS deal_files (
      id         text PRIMARY KEY,
      deal_id    text REFERENCES deals(id),
      filename   text,
      blob_url   text,
      kind       text,
      created_at timestamptz DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS module_runs (
      id          text PRIMARY KEY,
      deal_id     text REFERENCES deals(id),
      module      text,
      inputs_json jsonb,
      output_json jsonb,
      created_at  timestamptz DEFAULT now()
    )
  `);
}

// ---------------------------------------------------------------------------
// Deal CRUD
// ---------------------------------------------------------------------------

export async function insertDeal(
  deal: Omit<Deal, "id" | "created_at"> & { id?: string },
): Promise<Deal> {
  const id = deal.id ?? nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: Deal = { ...deal, id, created_at: now } as Deal;
    memDeals.set(id, record);
    return record;
  }

  const result = await query<Deal>(
    `
    INSERT INTO deals (
      id, source, property_name, address, city, state, units, vintage,
      sponsor, operator, broker_firm, broker_contact,
      ask_amount, sponsor_basis, purchase_price, purpose,
      noi_t12, noi_y1, noi_y2, noi_stab, occupancy,
      verdict, verdict_label, headline, memo_markdown,
      computed_metrics, raw_text, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      $22, $23, $24, $25,
      $26, $27, $28
    )
    RETURNING *
    `,
    [
      id,
      deal.source ?? null,
      deal.property_name ?? null,
      deal.address ?? null,
      deal.city ?? null,
      deal.state ?? null,
      deal.units ?? null,
      deal.vintage ?? null,
      deal.sponsor ?? null,
      deal.operator ?? null,
      deal.broker_firm ?? null,
      deal.broker_contact ?? null,
      deal.ask_amount ?? null,
      deal.sponsor_basis ?? null,
      deal.purchase_price ?? null,
      deal.purpose ?? null,
      deal.noi_t12 ?? null,
      deal.noi_y1 ?? null,
      deal.noi_y2 ?? null,
      deal.noi_stab ?? null,
      deal.occupancy ?? null,
      deal.verdict ?? null,
      deal.verdict_label ?? null,
      deal.headline ?? null,
      deal.memo_markdown ?? null,
      deal.computed_metrics ? JSON.stringify(deal.computed_metrics) : null,
      deal.raw_text ?? null,
      deal.status ?? "new",
    ],
  );
  return result.rows[0];
}

export async function getDeal(id: string): Promise<Deal | null> {
  if (!USE_POSTGRES) {
    return memDeals.get(id) ?? null;
  }
  const result = await query<Deal>(`SELECT * FROM deals WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listDeals(): Promise<Deal[]> {
  if (!USE_POSTGRES) {
    return [...memDeals.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }
  const result = await query<Deal>(`
    SELECT id, property_name, city, state, verdict, verdict_label, headline,
           status, created_at, ask_amount, units
    FROM deals ORDER BY created_at DESC
  `);
  return result.rows;
}

export async function updateDealStatus(id: string, status: string): Promise<void> {
  if (!USE_POSTGRES) {
    const deal = memDeals.get(id);
    if (deal) deal.status = status;
    return;
  }
  await query(`UPDATE deals SET status = $1 WHERE id = $2`, [status, id]);
}

// Patch any subset of deal fields. Used by the async /api/deal-process route
// after Claude finishes extracting metrics on a deal that was inserted in
// "processing" state by /api/deal-intake.
export async function updateDeal(id: string, patch: Partial<Deal>): Promise<void> {
  if (!USE_POSTGRES) {
    const deal = memDeals.get(id);
    if (deal) Object.assign(deal, patch);
    return;
  }
  await query(
    `
    UPDATE deals SET
      property_name    = COALESCE($1, property_name),
      address          = COALESCE($2, address),
      city             = COALESCE($3, city),
      state            = COALESCE($4, state),
      units            = COALESCE($5, units),
      vintage          = COALESCE($6, vintage),
      sponsor          = COALESCE($7, sponsor),
      operator         = COALESCE($8, operator),
      broker_firm      = COALESCE($9, broker_firm),
      broker_contact   = COALESCE($10, broker_contact),
      ask_amount       = COALESCE($11, ask_amount),
      sponsor_basis    = COALESCE($12, sponsor_basis),
      purchase_price   = COALESCE($13, purchase_price),
      purpose          = COALESCE($14, purpose),
      noi_t12          = COALESCE($15, noi_t12),
      noi_y1           = COALESCE($16, noi_y1),
      noi_y2           = COALESCE($17, noi_y2),
      noi_stab         = COALESCE($18, noi_stab),
      occupancy        = COALESCE($19, occupancy),
      verdict          = COALESCE($20, verdict),
      verdict_label    = COALESCE($21, verdict_label),
      headline         = COALESCE($22, headline),
      memo_markdown    = COALESCE($23, memo_markdown),
      computed_metrics = COALESCE($24::jsonb, computed_metrics),
      raw_text         = COALESCE($25, raw_text),
      status           = COALESCE($26, status)
    WHERE id = $27
    `,
    [
      patch.property_name ?? null,
      patch.address ?? null,
      patch.city ?? null,
      patch.state ?? null,
      patch.units ?? null,
      patch.vintage ?? null,
      patch.sponsor ?? null,
      patch.operator ?? null,
      patch.broker_firm ?? null,
      patch.broker_contact ?? null,
      patch.ask_amount ?? null,
      patch.sponsor_basis ?? null,
      patch.purchase_price ?? null,
      patch.purpose ?? null,
      patch.noi_t12 ?? null,
      patch.noi_y1 ?? null,
      patch.noi_y2 ?? null,
      patch.noi_stab ?? null,
      patch.occupancy ?? null,
      patch.verdict ?? null,
      patch.verdict_label ?? null,
      patch.headline ?? null,
      patch.memo_markdown ?? null,
      patch.computed_metrics ? JSON.stringify(patch.computed_metrics) : null,
      patch.raw_text ?? null,
      patch.status ?? null,
      id,
    ],
  );
}

// ---------------------------------------------------------------------------
// DealFile CRUD
// ---------------------------------------------------------------------------

export async function insertDealFile(
  file: Omit<DealFile, "id" | "created_at">,
): Promise<DealFile> {
  const id = nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: DealFile = { ...file, id, created_at: now };
    memFiles.set(id, record);
    return record;
  }

  const result = await query<DealFile>(
    `
    INSERT INTO deal_files (id, deal_id, filename, blob_url, kind)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
    `,
    [id, file.deal_id, file.filename, file.blob_url ?? null, file.kind ?? null],
  );
  return result.rows[0];
}

export async function getDealFiles(dealId: string): Promise<DealFile[]> {
  if (!USE_POSTGRES) {
    return [...memFiles.values()].filter((f) => f.deal_id === dealId);
  }
  const result = await query<DealFile>(
    `SELECT * FROM deal_files WHERE deal_id = $1 ORDER BY created_at ASC`,
    [dealId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// ModuleRun CRUD
// ---------------------------------------------------------------------------

export async function insertModuleRun(
  run: Omit<ModuleRun, "id" | "created_at">,
): Promise<ModuleRun> {
  const id = nanoid(12);
  const now = new Date().toISOString();

  if (!USE_POSTGRES) {
    const record: ModuleRun = { ...run, id, created_at: now };
    memRuns.set(id, record);
    return record;
  }

  const result = await query<ModuleRun>(
    `
    INSERT INTO module_runs (id, deal_id, module, inputs_json, output_json)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    RETURNING *
    `,
    [
      id,
      run.deal_id,
      run.module,
      JSON.stringify(run.inputs_json),
      JSON.stringify(run.output_json),
    ],
  );
  return result.rows[0];
}

export async function getDealModuleRuns(dealId: string): Promise<ModuleRun[]> {
  if (!USE_POSTGRES) {
    return [...memRuns.values()].filter((r) => r.deal_id === dealId);
  }
  const result = await query<ModuleRun>(
    `SELECT * FROM module_runs WHERE deal_id = $1 ORDER BY created_at ASC`,
    [dealId],
  );
  return result.rows;
}
