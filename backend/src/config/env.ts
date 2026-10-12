import 'dotenv/config';
import { z } from 'zod';

/** `KEY=` in a .env file means unset. */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:3100'),
  JWT_ACCESS_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:4000/api/gsc/oauth/callback'),
  GSC_INITIAL_SYNC_DAYS: z.coerce.number().int().min(1).max(480).default(90),
  CRAWLER_USER_AGENT: z.string().min(3).default('BlogPilotBot/1.0'),
  CRAWLER_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(500),
  CRAWLER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  CRAWLER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  CRAWLER_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  CRAWLER_MAX_DURATION_MS: z.coerce.number().int().min(10_000).default(30 * 60_000),
  CRAWLER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(10_000).default(5 * 1024 * 1024),
  CRAWLER_MIN_CONTENT_WORDS: z.coerce.number().int().min(0).default(80),
  CRAWLER_PLAYWRIGHT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CRAWLER_PLAYWRIGHT_MAX_PAGES: z.coerce.number().int().min(0).default(25),
  CRAWLER_PLAYWRIGHT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  // Opportunity engine thresholds (see services/optimization/opportunity.config.ts for meaning)
  OPPORTUNITY_WINDOW_DAYS: z.coerce.number().int().min(7).max(90).default(28),
  OPPORTUNITY_MIN_IMPRESSIONS: z.coerce.number().int().min(1).default(200),
  OPPORTUNITY_LOW_CTR_RATIO: z.coerce.number().gt(0).max(1).default(0.6),
  OPPORTUNITY_LOW_CTR_MAX_POSITION: z.coerce.number().min(1).default(20),
  OPPORTUNITY_LOW_CTR_MIN_IMPRESSIONS: z.coerce.number().int().min(1).default(500),
  OPPORTUNITY_PAGE_ONE_MIN_POSITION: z.coerce.number().min(1).default(4),
  OPPORTUNITY_PAGE_ONE_MAX_POSITION: z.coerce.number().min(1).default(10),
  OPPORTUNITY_PAGE_ONE_MIN_IMPRESSIONS: z.coerce.number().int().min(1).default(300),
  OPPORTUNITY_HIGH_IMPRESSIONS: z.coerce.number().int().min(1).default(5000),
  OPPORTUNITY_HIGH_IMPRESSIONS_MAX_CTR: z.coerce.number().gt(0).max(1).default(0.015),
  OPPORTUNITY_MIN_DECLINE_PERCENT: z.coerce.number().gt(0).max(100).default(25),
  OPPORTUNITY_MIN_QUERY_IMPRESSIONS: z.coerce.number().int().min(1).default(100),
  // AI (Phase 5). AI_PROVIDER picks the implementation; each reads its own key. Optional so the app boots
  // without AI; analysis is refused until the selected provider's key and AI_MODEL are set.
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['openrouter', 'gemini']).default('openrouter')),
  GEMINI_API_KEY: z.preprocess(emptyToUndefined, z.string().min(20).optional()),
  OPENROUTER_API_KEY: z.preprocess(emptyToUndefined, z.string().min(20).optional()),
  OPENROUTER_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('https://openrouter.ai/api/v1')),
  AI_MODEL: z.preprocess(emptyToUndefined, z.string().min(3).max(200).optional()),
  AI_MAX_TOKENS: z.coerce.number().int().min(1024).max(64_000).default(16_000),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(180_000),
  // Retries inside one job attempt (transient errors only). BullMQ adds up to 3 attempts on top.
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  // json_schema: provider-enforced structured output (recommended). prompt: schema in the system message, for
  // models without structured-output support. Both are Zod-validated and grounding-checked.
  AI_OUTPUT_MODE: z.enum(['json_schema', 'prompt']).default('json_schema'),
  AI_REASONING_EFFORT: z.preprocess(emptyToUndefined, z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()),
  // AI-drafted replacement copy: per-target length limits (characters) and regenerations per recommendation.
  AI_DRAFT_MAX_TITLE: z.coerce.number().int().min(10).max(200).default(70),
  AI_DRAFT_MAX_META_DESCRIPTION: z.coerce.number().int().min(50).max(400).default(160),
  AI_DRAFT_MAX_H1: z.coerce.number().int().min(10).max(200).default(90),
  AI_DRAFT_MAX_SECTION_HEADING: z.coerce.number().int().min(10).max(200).default(90),
  AI_DRAFT_MAX_INTRODUCTION: z.coerce.number().int().min(100).max(5_000).default(1_200),
  AI_DRAFT_MAX_REGENERATIONS: z.coerce.number().int().min(0).max(20).default(5),
  // Body-section rewrites (section-body-v1). See docs/PHASE5_AI.md "Body-section drafts".
  AI_BODY_MIN_WORDS: z.coerce.number().int().min(1).max(1_000).default(15),
  AI_BODY_MAX_WORDS: z.coerce.number().int().min(20).max(5_000).default(800),
  AI_BODY_MAX_PARAGRAPHS: z.coerce.number().int().min(1).max(50).default(8),
  AI_BODY_MIN_LENGTH_RATIO: z.coerce.number().gt(0).max(1).default(0.6),
  AI_BODY_MAX_LENGTH_RATIO: z.coerce.number().min(1).max(5).default(1.5),
  AI_BODY_LENGTH_SLACK_WORDS: z.coerce.number().int().min(0).max(200).default(25),
  AI_BODY_MAX_CHANGE_RATIO: z.coerce.number().gt(0).max(1).default(0.85),
  AI_BODY_MIN_TERM_OVERLAP: z.coerce.number().min(0).max(1).default(0.4),
  AI_BODY_MIN_FACT_PRESERVATION: z.coerce.number().min(0).max(1).default(1),
  // Content originality check (internal corpus only; no external provider). See docs/ORIGINALITY.md.
  ORIGINALITY_CHECKER: z.enum(['internal', 'none']).default('internal'),
  // off: never check · warn: show matches only · require_ack: significant matches need acknowledgment · block: significant matches block approval
  ORIGINALITY_POLICY: z.enum(['off', 'warn', 'require_ack', 'block']).default('require_ack'),
  // When true, approval of checkable text fails if the check itself fails (never treated as "no matches").
  ORIGINALITY_REQUIRE_CHECK: z.preprocess((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1'), z.boolean().default(true)),
  ORIGINALITY_MIN_MATCH_WORDS: z.coerce.number().int().min(3).max(20).default(6),
  ORIGINALITY_SIGNIFICANT_RUN_WORDS: z.coerce.number().int().min(4).max(100).default(12),
  ORIGINALITY_SIGNIFICANT_COVERAGE: z.coerce.number().gt(0).max(1).default(0.5),
  ORIGINALITY_COMMON_PHRASE_MIN_PAGES: z.coerce.number().int().min(2).max(1000).default(3),
  ORIGINALITY_COMMON_PHRASE_RATIO: z.coerce.number().gt(0).max(1).default(0.3),
  ORIGINALITY_MAX_CORPUS_PAGES: z.coerce.number().int().min(1).max(50_000).default(2_000),
  // A stored result is reused for approval only while it is this fresh (the corpus may change after a crawl).
  ORIGINALITY_RESULT_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
