# Blog Optimizer (V1)

Improves **existing** blog pages using Google Search Console evidence, with human approval before any change.
Design: [docs/DESIGN.md](docs/DESIGN.md)

## Layout

- `backend/` Express + TypeScript + Prisma (PostgreSQL)
- `frontend/` Next.js + Tailwind + TanStack Query
- `docker-compose.yml` PostgreSQL only (Redis will be added in Phase 2 for BullMQ)

## Run locally

```bash
docker compose up -d                      # Postgres on localhost:5433 (dev db + gsc_optimizer_test)

cd backend
cp .env.example .env                      # then set JWT_ACCESS_SECRET and ENCRYPTION_KEY (commands in the file)
npm install
npx prisma migrate dev
npm run dev                               # API on http://localhost:4000

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
- [ ] Phase 2: Google Search Console
- [ ] Phase 3: Website crawler
- [ ] Phase 4: Opportunity engine
- [ ] Phase 5: AI (Claude)
- [ ] Phase 6: Approval
- [ ] Phase 7: Content update (Site Update API)
- [ ] Phase 8: Measurement
- [ ] Phase 9: Hardening and E2E
