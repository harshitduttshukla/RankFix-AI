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
