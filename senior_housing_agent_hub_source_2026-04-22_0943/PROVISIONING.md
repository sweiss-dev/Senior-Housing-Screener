# Provisioning Checklist — Deal Intake Module

Complete these steps in the Vercel dashboard after deploying.

## 1. Vercel Postgres (Neon)

1. Open your project in the Vercel dashboard
2. Click **Storage** → **Create Database** → **Postgres** (Neon)
3. Name it (e.g. `senior-housing-db`) and click **Create & Continue**
4. On the next screen, click **Connect to Project** and select your project
5. Vercel automatically injects:
   - `POSTGRES_URL`
   - `POSTGRES_URL_NON_POOLING`
   - `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`
6. Redeploy the project — the `ensureSchema()` call will create the tables on first request

> **Without Postgres:** The app runs with an in-memory fallback. Data is lost on restart.
> A warning is logged on every cold start.

## 2. Vercel Blob

1. In the Vercel dashboard, click **Storage** → **Create Database** → **Blob**
2. Name it (e.g. `deal-files`) and click **Create & Continue**
3. Click **Connect to Project**
4. Vercel automatically injects `BLOB_READ_WRITE_TOKEN`
5. Redeploy — uploaded PDFs and spreadsheets will now be stored in Blob

> **Without Blob:** Files are still parsed and analyzed. The `blob_url` field is `null`.
> No files are stored persistently.

## 3. Anthropic API Key

If not already set:

1. Vercel dashboard → Project → **Settings** → **Environment Variables**
2. Add `ANTHROPIC_API_KEY` = `sk-ant-...`
3. Redeploy

## 4. Email Forward (optional — DNS setup required)

To enable `/api/deal-inbox` (automatic deal intake from forwarded emails):

1. Pick a provider: **SendGrid Inbound Parse** or **Cloudflare Email Workers**
2. Create an MX record on a subdomain:
   ```
   intake.bloomfieldcapital.com   MX  10  mx.sendgrid.net
   ```
3. In SendGrid → Settings → Inbound Parse → Add Host & URL:
   - Host: `intake.bloomfieldcapital.com`
   - URL: `https://<your-app>.vercel.app/api/deal-inbox`
   - ☑ Post the raw, full MIME message
4. Instruct brokers to forward teasers to `deals@intake.bloomfieldcapital.com`
5. Deals will appear in `/deals` within ~60 seconds

## Quick Links (after deploy)

- Deal Intake: `/deal-intake/`
- Pipeline Dashboard: `/deals`
- Agent Hub: `/`
