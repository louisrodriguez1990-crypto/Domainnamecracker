# Domain Availability Hunter

Local `Next.js` app for generating domain candidates, checking `.com`, `.io`, and `.ai` availability, and persisting runs in SQLite so you do not repeat the same search twice.

## What it does

- Generates keyword compounds and brandable mashups from built-in and uploaded word lists
- Scores candidates before they hit the availability worker
- Checks domains with a best-effort RDAP provider by default
- Stores word sources, runs, generated candidates, and check results in `data/domain-hunter.sqlite`
- Lets you stop runs, export hits, and manually recheck domains from the UI

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Tests and verification

```bash
npm test
npm run build
```

## Optional external checker seam

If you want to replace the built-in RDAP checker later, the app can call an external HTTP availability endpoint instead:

```bash
DOMAIN_CHECK_HTTP_URL=https://your-checker.example.com
DOMAIN_CHECK_HTTP_TOKEN=your-token
```

The external endpoint should accept `POST` JSON with `{ "domain": "example.com" }` and return:

```json
{
  "status": "available",
  "checkedAt": "2026-04-01T12:00:00.000Z",
  "confidence": 0.95,
  "note": "Registrar API result"
}
```
