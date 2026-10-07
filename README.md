# Blog Optimizer (V1)

Improves **existing** blog pages using Google Search Console evidence, with human approval before any change.
Design: [docs/DESIGN.md](docs/DESIGN.md)

## Layout

- `backend/` Express + TypeScript + Prisma (PostgreSQL)
- `frontend/` Next.js + Tailwind + TanStack Query
- `docker-compose.yml` PostgreSQL (localhost:5433) and Redis (localhost:6380)

## Run locally

```bash
docker compose up -d                      # Postgres :5433 (dev + test db), Redis :6380

cd backend
cp .env.example .env                      # set JWT_ACCESS_SECRET, ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm install
npx prisma migrate dev
npm run dev                               # API on http://localhost:4000
npm run worker                            # background jobs (GSC sync, website crawl, opportunity detection), separate terminal
npx playwright install chromium           # once: browser for the JavaScript-rendering fallback

cd ../frontend
npm install
npm run dev                               # App on http://localhost:3100 (proxies /api to :4000)
```

## Tests

```bash
cd backend && npm test                    # Vitest + Supertest against the real test database
```

## Status

- [x] Phase 1: Foundation (auth, organizations, projects, websites, tenant isolation)
- [x] Phase 2: Google Search Console (OAuth, properties, sync jobs, performance)
- [x] Phase 3: Website crawler (robots, sitemaps, SSRF-safe fetch, structured extraction, Playwright fallback, versions)
- [x] Phase 4: Opportunity engine (deterministic signals, scoring, evidence, background detection) — [docs](docs/PHASE4_OPPORTUNITIES.md)
- [ ] Phase 5: AI (Claude)
- [ ] Phase 6: Approval
- [ ] Phase 7: Content update (Site Update API)
- [ ] Phase 8: Measurement
- [ ] Phase 9: Hardening and E2E

## Google Search Console setup

1. In Google Cloud Console, enable the **Google Search Console API**.
2. Create an OAuth client of type **Web application** with redirect URI `http://localhost:4000/api/gsc/oauth/callback`.
3. On the OAuth consent screen, add the scope `.../auth/webmasters.readonly`. While the app is in "Testing", add your Google account as a test user.
4. Put the client ID and secret in `backend/.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
