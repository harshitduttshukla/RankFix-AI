# RankFix AI

Improves **existing** website pages using Google Search Console evidence and the pages' crawled content. AI drafts changes, and a person approves each one before anything changes.
Design: [docs/DESIGN.md](docs/DESIGN.md) (original V1 design; the AI section predates the current OpenRouter/Gemini providers, see [docs/PHASE5_AI.md](docs/PHASE5_AI.md)) · Audit: [docs/audits/full-project-audit.md](docs/audits/full-project-audit.md)

## Layout

- `backend/`: Express, TypeScript, Prisma (PostgreSQL), BullMQ workers (Redis)
- `frontend/`: Next.js, Tailwind, TanStack Query
- `docker-compose.yml`: PostgreSQL (localhost:5433) and Redis (localhost:6380)

## Run locally

```bash
docker compose up -d                      # Postgres :5433 (dev + test db), Redis :6380

cd backend
cp .env.example .env                      # set JWT_ACCESS_SECRET, ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
                                          # AI (optional): AI_PROVIDER (openrouter | gemini), its key (OPENROUTER_API_KEY or GEMINI_API_KEY), AI_MODEL
npm install
npx prisma migrate dev
npm run dev                               # API on http://localhost:4000
npm run worker                            # background jobs (GSC sync, website crawl, opportunity detection, AI analysis), separate terminal
npx playwright install chromium           # once: browser for the JavaScript-rendering fallback

cd ../frontend
npm install
npm run dev                               # App on http://localhost:3100 (proxies /api to :4000)
```

The app starts without AI configured; analysis and drafting then return "not configured". Only the selected provider's key is needed.

## Tests

```bash
cd backend && npm test                    # Vitest + Supertest against the real test database (gsc_optimizer_test; tables are truncated)
```

## Status

- [x] Phase 1: Foundation (auth, organizations, projects, websites, tenant isolation)
- [x] Phase 2: Google Search Console (OAuth, properties, sync jobs, performance)
- [x] Phase 3: Website crawler (robots, sitemaps, SSRF-safe fetch, structured extraction, Playwright fallback, versions)
- [x] Phase 4: Opportunity engine (deterministic signals, scoring, evidence, background detection): [docs](docs/PHASE4_OPPORTUNITIES.md)
- [x] Phase 5: AI analysis, recommendations and validated drafts (OpenRouter or Gemini via `AIProvider`, structured output, grounding checks, background jobs): [docs](docs/PHASE5_AI.md)
- [x] Phase 6: Human approval (recommendation review, page-version-bound proposals, stale detection, internal-corpus originality check, audit): [docs](docs/PHASE6_REVIEW.md), [originality](docs/ORIGINALITY.md)
- [x] Phase 7a: Apply-and-verify. The customer applies an approved change on their own site and clicks "I've applied this"; RankFix AI recrawls that one page, compares the field deterministically, and stores a pre-change Search Console baseline. **RankFix AI never writes to the website.**
- [ ] Phase 7b: Automated publishing (Site Update API / CMS integrations): not available
- [ ] Phase 8: Measurement
- [ ] Phase 9: Hardening and E2E

## Reverse proxy and client IPs

Rate limits (global, login/register, and per-project AI) key on `req.ip`. `req.ip` comes from `X-Forwarded-For` **only** when the request arrives from a peer listed in `TRUST_PROXY`:

| `TRUST_PROXY` | Use when |
|---|---|
| `loopback` (default) | The API is reached only through a proxy on the same host: the Next.js `/api` rewrite in development, or nginx/Caddy on the same machine |
| `1`, `2`, … | That many proxy hops always sit in front of the API (for example, a load balancer plus nginx) |
| `10.0.0.0/8,loopback` | Proxies at known addresses or subnets |
| `false` | No proxy: clients connect directly, and `X-Forwarded-For` is ignored |

`true` is rejected at startup, because it would let any client choose its own IP and bypass the limits.

For production:
- Don't expose the API port (4000) publicly. Only the reverse proxy should reach it, or the proxy settings above can't be relied on.
- The proxy must **append** the connecting client's address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Express uses the right-most untrusted entry, so values a client forges at the front are ignored.

## Logging

Request logs (pino-http) redact request `Cookie`/`Authorization` headers, the response `Set-Cookie` header (access and refresh tokens), and API keys. See `REDACT_PATHS` in `backend/src/utils/logger.ts`. `test/security-logging.test.ts` guards this.

## Crawler identity

The crawler sends `User-Agent: RankFixBot/1.0` (`CRAWLER_USER_AGENT`) and matches `robots.txt` groups for `RankFixBot`. Sites that wrote rules for the earlier `BlogPilotBot` token need them updated. An existing `backend/.env` copied from the old example may still set `CRAWLER_USER_AGENT=BlogPilotBot/1.0`.

## Google Search Console setup

1. In Google Cloud Console, enable the **Google Search Console API**.
2. Create an OAuth client of type **Web application** with redirect URI `http://localhost:4000/api/gsc/oauth/callback`.
3. On the OAuth consent screen, add the scope `.../auth/webmasters.readonly`. While the app is in "Testing", add your Google account as a test user.
4. Put the client ID and secret in `backend/.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
