# Domain Availability Hunter

`Next.js` app for generating domain candidates, checking `.com`, `.io`, and `.ai` availability, and persisting runs so you do not repeat the same search twice.

## Modes

- Local mode: Uses SQLite plus the in-process worker you already had for local development.
- Vercel mode: Uses hosted Postgres for persistence and Vercel Workflow for durable background scans. Supabase is the recommended hosted database for this path.

The app automatically switches to hosted mode when it sees `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`, `DATABASE_URL`, `SUPABASE_DB_URL`, or `NEON_DATABASE_URL`.

## What it does

- Generates keyword compounds, pronounceable short names, and brandable mashups from built-in and uploaded word lists
- Includes a dictionary-backed source for exhaustive single-word sweeps across your selected TLDs
- Scores candidates before they hit the availability worker
- Prefers Name.com when configured, otherwise falls back to an external checker or RDAP
- Shows provider status in the dashboard and lets you disable Name.com per run when credentials are present
- Stores word sources, runs, and check results so later scans can skip repeats
- Lets you stop runs, export hits, and manually recheck domains from the UI

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploying to Vercel

1. Create a Vercel project for this repo.
2. Create a Supabase project and copy its pooled Postgres connection string.
3. Add that connection string to Vercel as `DATABASE_URL` or `SUPABASE_DB_URL`.
4. Push or deploy normally.

This repo already includes Workflow support in `next.config.ts` and an explicit `vercel.json` with Fluid compute enabled for deployments. The hosted database client keeps prepared statements disabled so Supabase poolers work cleanly.

## Environment variables

The app supports these database variables for hosted mode:

```bash
POSTGRES_URL_NON_POOLING=
POSTGRES_URL=
DATABASE_URL=
SUPABASE_DB_URL=
NEON_DATABASE_URL=
```

Only one is needed.

Optional Name.com integration:

```bash
NAMECOM_API_USERNAME=
NAMECOM_API_TOKEN=
NAMECOM_API_BASE_URL=
```

If `NAMECOM_API_USERNAME` and `NAMECOM_API_TOKEN` are both set, the app uses the Name.com CORE API first:

- `Zone Check` for high-volume preliminary screening
- `Check Availability` for live confirmation of promising domains

Only live-confirmed purchasable domains count as hits.

Optional external checker seam:

```bash
DOMAIN_CHECK_HTTP_URL=
DOMAIN_CHECK_HTTP_TOKEN=
```

If Name.com is not configured and `DOMAIN_CHECK_HTTP_URL` is set, the app will call your external availability endpoint instead of the built-in RDAP checker.

Name.com and external checker credentials stay server-side only. Do not place them in `NEXT_PUBLIC_*` variables. If you have ever pasted a real Name.com token into chat or another shared surface, rotate it before production use.

## Tests and verification

```bash
npm test
npm run build
```
