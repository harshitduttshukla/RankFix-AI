import { describe, expect, it } from 'vitest';
import type { AIContext } from '../src/services/ai/ai-context.builder.js';
import { checkRecommendations } from '../src/services/ai/ai.guardrails.js';
import { Recommendation } from '../src/services/ai/ai.schemas.js';
import { checkDraft, draftLimits, draftTarget, sanitizeDrafts, unsupportedClaims } from '../src/services/ai/drafts.js';
import { DRAFT_PROMPT_VERSION, DRAFT_SYSTEM, RECOMMENDATION_SYSTEM } from '../src/services/ai/prompts/index.js';
import { sampleContext, validRecommendations } from './ai-fixtures.js';

const limits = draftLimits({
  AI_DRAFT_MAX_TITLE: 70,
  AI_DRAFT_MAX_META_DESCRIPTION: 160,
  AI_DRAFT_MAX_H1: 90,
  AI_DRAFT_MAX_SECTION_HEADING: 90,
  AI_DRAFT_MAX_INTRODUCTION: 1200,
  AI_DRAFT_MAX_REGENERATIONS: 5,
});
const TITLE = { type: 'TITLE', targetSection: null } as const;

/** sampleContext plus an intro section (no heading) before the hooks section. */
function withIntro(): AIContext {
  const ctx = sampleContext();
  ctx.page.content!.sections.unshift({ sectionKey: 's0-intro', heading: null, level: 0, wordCount: 30, text: 'This React guide explains hooks and state for beginners.', truncated: false });
  return ctx;
}

describe('draft targets', () => {
  it('maps draftable recommendation types to the field they replace', () => {
    const ctx = withIntro();
    expect(draftTarget(TITLE, ctx.page.content)).toBe('TITLE');
    expect(draftTarget({ type: 'META_DESCRIPTION', targetSection: null }, ctx.page.content)).toBe('META_DESCRIPTION');
    expect(draftTarget({ type: 'HEADING', targetSection: null }, ctx.page.content)).toBe('H1');
    expect(draftTarget({ type: 'HEADING', targetSection: 's1-react-hooks-tutorial' }, ctx.page.content)).toBe('SECTION_HEADING');
    expect(draftTarget({ type: 'INTRODUCTION', targetSection: 's0-intro' }, ctx.page.content)).toBe('INTRODUCTION');
  });

  it('refuses drafts for content types, unknown sections, and introductions that are not the real intro section', () => {
    const ctx = withIntro();
    for (const type of ['SECTION_EXPANSION', 'MISSING_TOPIC', 'CLARIFICATION', 'INTERNAL_LINK'] as const) {
      expect(draftTarget({ type, targetSection: 's1-react-hooks-tutorial' }, ctx.page.content)).toBeNull();
    }
    expect(draftTarget({ type: 'HEADING', targetSection: 's9-missing' }, ctx.page.content)).toBeNull();
    expect(draftTarget({ type: 'HEADING', targetSection: 's0-intro' }, ctx.page.content)).toBeNull(); // has no heading to replace
    expect(draftTarget({ type: 'INTRODUCTION', targetSection: 's1-react-hooks-tutorial' }, ctx.page.content)).toBeNull();
    expect(draftTarget({ type: 'INTRODUCTION', targetSection: null }, ctx.page.content)).toBeNull();
    expect(draftTarget({ type: 'INTRODUCTION', targetSection: 's1-react-hooks-tutorial' }, sampleContext().page.content)).toBeNull();
  });
});

describe('checkDraft', () => {
  it('accepts a concise draft grounded in the page', () => {
    expect(checkDraft(sampleContext(), TITLE, 'React Guide: React Hooks Tutorial', limits)).toEqual([]);
    expect(checkDraft(withIntro(), { type: 'INTRODUCTION', targetSection: 's0-intro' }, 'This React guide explains hooks and state for beginners, starting with the React hooks tutorial.', limits)).toEqual([]);
  });

  it('a null draft is not an error', () => {
    expect(checkDraft(sampleContext(), TITLE, null, limits)).toEqual([]);
  });

  it('rejects empty, too long, too short, multi-line, markup and identical drafts', () => {
    const ctx = sampleContext();
    expect(checkDraft(ctx, TITLE, '   ', limits)).toEqual(['draft is empty']);
    expect(checkDraft(ctx, TITLE, `React Guide ${'React hooks tutorial '.repeat(5)}`, limits).join()).toMatch(/exceeds 70 characters for TITLE/);
    expect(checkDraft(ctx, TITLE, 'React', limits).join()).toMatch(/shorter than 10/);
    expect(checkDraft(ctx, TITLE, 'React Guide\nReact hooks tutorial', limits).join()).toMatch(/single line/);
    expect(checkDraft(ctx, TITLE, 'React Guide <b>hooks</b> tutorial', limits).join()).toMatch(/plain text/);
    expect(checkDraft(ctx, TITLE, 'React Guide https://site.example.com', limits).join()).toMatch(/plain text/);
    expect(checkDraft(ctx, { type: 'HEADING', targetSection: 's1-react-hooks-tutorial' }, 'React hooks   tutorial', limits).join()).toMatch(/identical to the current value/);
  });

  it('honors configured limits', () => {
    const tight = { ...limits, maxLength: { ...limits.maxLength, TITLE: 20 } };
    expect(checkDraft(sampleContext(), TITLE, 'React Guide: React Hooks Tutorial', tight).join()).toMatch(/exceeds 20 characters/);
  });

  it('rejects drafts for types that may not carry one', () => {
    expect(checkDraft(sampleContext(), { type: 'SECTION_EXPANSION', targetSection: 's1-react-hooks-tutorial' }, 'More hooks examples here', limits)).toEqual([
      'a SECTION_EXPANSION recommendation for "s1-react-hooks-tutorial" may not carry a draft',
    ]);
  });

  it('keeps the existing overclaim check, including negated guarantee disclaimers', () => {
    const ctx = sampleContext();
    expect(checkDraft(ctx, TITLE, 'React Guide that will increase your skills', limits).join()).toMatch(/forbidden wording/);
    expect(checkDraft(ctx, TITLE, 'React Guide: guaranteed React hooks tutorial', limits).join()).toMatch(/un-negated "guarantee"/);
    expect(checkDraft(ctx, { type: 'META_DESCRIPTION', targetSection: null }, 'A React guide and React hooks tutorial for learning hooks. Results are not guaranteed for every reader of the guide.', limits)).toEqual([]);
  });
});

describe('unsupported claims', () => {
  const ctx = sampleContext();
  it('flags prices, numbers and rates the page does not state', () => {
    const issues = unsupportedClaims('React Guide with daily rates from ₹500', ctx);
    expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/number "500"/), expect.stringMatching(/claim "₹"/), expect.stringMatching(/claim "rates"/)]));
  });

  it('flags credentials, superlatives and experience claims', () => {
    expect(unsupportedClaims('Certified React Guide', ctx).join()).toMatch(/claim "Certified"/);
    expect(unsupportedClaims('The best React Guide', ctx).join()).toMatch(/claim "best"/);
    expect(unsupportedClaims('React Guide from experts with 10 years', ctx).join()).toMatch(/experts.*years|years.*experts/);
  });

  it('flags places and names that appear neither on the page nor in its queries', () => {
    expect(unsupportedClaims('React Guide for developers in Mumbai', ctx)).toEqual(['name "Mumbai" does not appear on the page or in its queries']);
    expect(unsupportedClaims('React Guide covering React Performance', ctx)).toEqual([]); // "performance" is a query term
  });

  it('allows terms the page itself uses, and matches whole words only', () => {
    const c = sampleContext();
    c.page.content!.sections[0]!.text = 'Daily rates start at 500 for accurate builds.';
    expect(unsupportedClaims('React Guide with daily rates from 500', c)).toEqual([]);
    expect(unsupportedClaims('React Guide with 50 hooks', c).join()).toMatch(/number "50"/); // "50" is not "500"
  });

  it('cannot ground anything without crawled content', () => {
    expect(unsupportedClaims('React Guide', sampleContext({ content: null }))).toEqual(['no crawled page content to ground the draft in']);
  });
});

describe('sanitizeDrafts', () => {
  it('keeps valid drafts (normalized), drops invalid ones with reasons, and leaves the recommendations intact', () => {
    const set = validRecommendations();
    set.recommendations[0]!.suggestedValue = '  React Guide:   React Hooks Tutorial ';
    set.recommendations.push({ ...set.recommendations[0]!, type: 'META_DESCRIPTION', suggestedValue: 'Rent React hooks in Mumbai from ₹500 per day, the best price.' });
    const out = sanitizeDrafts(sampleContext(), set, limits);
    expect(out.recommendations[0]).toMatchObject({ type: 'TITLE', suggestedValue: 'React Guide: React Hooks Tutorial' });
    expect(out.recommendations[0]!.draftIssues).toBeUndefined();
    expect(out.recommendations[1]).toMatchObject({ suggestedValue: null });
    expect(out.recommendations[2]).toMatchObject({ type: 'META_DESCRIPTION', suggestedValue: null, recommendation: set.recommendations[2]!.recommendation });
    expect(out.recommendations[2]!.draftIssues!.join()).toMatch(/Mumbai|₹|500/);
    expect(out.caveats).toEqual(set.caveats);
  });

  it('existing grounding checks still reject unknown sections regardless of drafts', () => {
    const set = validRecommendations();
    set.recommendations[1]!.targetSection = 's9-nope';
    expect(checkRecommendations(sampleContext(), set).join()).toMatch(/unknown section/);
  });
});

describe('schema and prompts', () => {
  it('requires suggestedValue to be present (string or null) in AI output', () => {
    const { suggestedValue: _omit, ...withoutDraft } = validRecommendations().recommendations[0]!;
    expect(Recommendation.safeParse(withoutDraft).success).toBe(false);
    expect(Recommendation.safeParse({ ...withoutDraft, suggestedValue: null }).success).toBe(true);
    expect(Recommendation.safeParse({ ...withoutDraft, suggestedValue: 42 }).success).toBe(false);
  });

  it('recommendation-v2 and draft-v1 forbid invented business facts and treat page content as untrusted', () => {
    expect(DRAFT_PROMPT_VERSION).toBe('draft-v1');
    for (const p of [RECOMMENDATION_SYSTEM, DRAFT_SYSTEM]) {
      expect(p).toContain('Never introduce prices, rates');
      expect(p).toContain('untrusted data');
      expect(p).toContain('set suggestedValue to null');
    }
  });
});
