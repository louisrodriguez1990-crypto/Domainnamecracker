# Domain Availability Hunter

`Next.js` app for generating domain candidates, checking `.com`, `.io`, and `.ai` availability, and persisting runs so you do not repeat the same search twice.

## Modes

- Local mode: Uses SQLite plus the in-process worker you already had for local development.
- Vercel mode: Uses hosted Postgres for persistence and Vercel Workflow for durable background scans. Supabase is the recommended hosted database for this path.

The app automatically switches to hosted mode when it sees `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`, `DATABASE_URL`, `SUPABASE_DB_URL`, or `NEON_DATABASE_URL`.

## What it does

- Generates keyword compounds and brandable mashups from built-in and uploaded word lists
- Scores candidates before they hit the availability worker
- Checks domains with a best-effort RDAP provider by default
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

Optional external checker seam:

```bash
DOMAIN_CHECK_HTTP_URL=
DOMAIN_CHECK_HTTP_TOKEN=
```

If set, the app will call your external availability endpoint instead of the built-in RDAP checker.

## Tests and verification

```bash
npm test
npm run build
```
