import type { PageStructure } from '../src/services/optimization/opportunity.types.js';

/** Realistic per-window page totals and queries. Shared by the unit tests and the database seeding. */
export interface PageFixture {
  path: string;
  current: { clicks: number; impressions: number; position: number };
  previous: { clicks: number; impressions: number; position: number };
  queries: { query: string; clicks: number; impressions: number; position: number }[];
  structure: PageStructure | null;
}

/** High impressions, 1% CTR at position 7.2 → LOW_CTR + HIGH_IMPRESSIONS_LOW_CLICKS + PAGE_ONE_NEAR_TOP. */
export const PAGE_A: PageFixture = {
  path: '/blog/react-guide',
  current: { clicks: 300, impressions: 30_000, position: 7.2 },
  previous: { clicks: 310, impressions: 29_000, position: 7.0 },
  queries: [
    { query: 'react guide', clicks: 120, impressions: 12_000, position: 6.5 },
    { query: 'react hooks tutorial', clicks: 80, impressions: 8_000, position: 7.4 },
    { query: 'react state management', clicks: 40, impressions: 4_000, position: 8.1 },
  ],
  structure: {
    title: 'The Complete React Guide',
    h1: 'React Guide',
    headings: ['React hooks tutorial', 'State management in React', 'Testing'],
  },
};

/** Barely visible page → no meaningful opportunity. */
export const PAGE_B: PageFixture = {
  path: '/blog/tiny-note',
  current: { clicks: 5, impressions: 50, position: 40 },
  previous: { clicks: 4, impressions: 45, position: 42 },
  queries: [{ query: 'tiny note', clicks: 5, impressions: 50, position: 40 }],
  structure: { title: 'A tiny note', h1: 'A tiny note', headings: [] },
};

/** Clicks halved against the previous window → PERFORMANCE_DECLINE. */
export const PAGE_C: PageFixture = {
  path: '/blog/node-api',
  current: { clicks: 1000, impressions: 42_000, position: 5.2 },
  previous: { clicks: 2000, impressions: 40_000, position: 5.0 },
  queries: [
    { query: 'node api tutorial', clicks: 500, impressions: 20_000, position: 4.8 },
    { query: 'express rest api', clicks: 300, impressions: 12_000, position: 5.5 },
  ],
  structure: { title: 'Building a Node API', h1: 'Node API tutorial', headings: ['Express REST API basics', 'Authentication'] },
};

/** Healthy CTR near the top, but its main query's terms are absent from the page structure → CONTENT_COVERAGE_SIGNAL. */
export const PAGE_D: PageFixture = {
  path: '/blog/docker-guide',
  current: { clicks: 300, impressions: 3_000, position: 3.5 },
  previous: { clicks: 290, impressions: 2_900, position: 3.6 },
  queries: [
    { query: 'kubernetes deployment tutorial', clicks: 120, impressions: 1_500, position: 3.8 },
    { query: 'docker compose', clicks: 90, impressions: 600, position: 3.1 },
  ],
  structure: { title: 'Docker Guide', h1: 'Docker Guide', headings: ['Installing Docker', 'Docker Compose basics'] },
};
