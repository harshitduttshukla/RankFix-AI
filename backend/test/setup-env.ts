import { TEST_DATABASE_URL } from './test-env.js';

// Must run before any app module reads env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-123456';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.COOKIE_SECURE = 'false';
process.env.REDIS_URL = 'redis://localhost:6380/1';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/gsc/oauth/callback';
process.env.CRAWLER_DELAY_MS = '0';
process.env.CRAWLER_CONCURRENCY = '1';
process.env.CRAWLER_REQUEST_TIMEOUT_MS = '3000';
process.env.CRAWLER_MIN_CONTENT_WORDS = '40';
// Hermetic: a developer's local .env must not change detection thresholds or enable real AI calls.
Object.assign(process.env, {
  OPPORTUNITY_WINDOW_DAYS: '28',
  OPPORTUNITY_MIN_IMPRESSIONS: '200',
  OPPORTUNITY_LOW_CTR_RATIO: '0.6',
  OPPORTUNITY_LOW_CTR_MAX_POSITION: '20',
  OPPORTUNITY_LOW_CTR_MIN_IMPRESSIONS: '500',
  OPPORTUNITY_PAGE_ONE_MIN_POSITION: '4',
  OPPORTUNITY_PAGE_ONE_MAX_POSITION: '10',
  OPPORTUNITY_PAGE_ONE_MIN_IMPRESSIONS: '300',
  OPPORTUNITY_HIGH_IMPRESSIONS: '5000',
  OPPORTUNITY_HIGH_IMPRESSIONS_MAX_CTR: '0.015',
  OPPORTUNITY_MIN_DECLINE_PERCENT: '25',
  OPPORTUNITY_MIN_QUERY_IMPRESSIONS: '100',
  ANTHROPIC_API_KEY: '',
  AI_MODEL: '',
});
