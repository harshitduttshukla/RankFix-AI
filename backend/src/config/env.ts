import 'dotenv/config';
import { z } from 'zod';

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
