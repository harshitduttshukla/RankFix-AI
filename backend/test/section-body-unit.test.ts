import { describe, expect, it } from 'vitest';
import type { AIContext } from '../src/services/ai/ai-context.builder.js';
import { checkBodyDraft, checkDraft, draftLimits, sanitizeDrafts } from '../src/services/ai/drafts.js';
import { SECTION_BODY_PROMPT_VERSION, SECTION_BODY_SYSTEM, buildSectionBodyMessage } from '../src/services/ai/prompts/index.js';
import { bodyLimits, bodyMetrics, checkSectionBody, namesIn, numbersIn } from '../src/services/ai/section-body.js';
import { sampleContext, validRecommendations } from './ai-fixtures.js';

const ORIGINAL =
  'Scaffolding can be hired for short or long periods. Availability depends on the system, quantity and location. We supply H-frame and Cuplock systems only, and delivery to Pune may take 2 days. Prices are not fixed and may change with transport and labour scope.';
const VALID =
  'You can hire scaffolding for short or long periods. Availability depends on the system, quantity and location. We supply only H-frame and Cuplock systems, and delivery to Pune may take 2 days. Prices are not fixed and may change with your transport and labour scope.';

const limits = bodyLimits({
  AI_BODY_MIN_WORDS: 15,
  AI_BODY_MAX_WORDS: 800,
  AI_BODY_MAX_PARAGRAPHS: 8,
  AI_BODY_MIN_LENGTH_RATIO: 0.6,
  AI_BODY_MAX_LENGTH_RATIO: 1.5,
  AI_BODY_LENGTH_SLACK_WORDS: 25,
  AI_BODY_MAX_CHANGE_RATIO: 0.85,
  AI_BODY_MIN_TERM_OVERLAP: 0.4,
  AI_BODY_MIN_FACT_PRESERVATION: 1,
} as never);
const PAGE = 'Scaffolding Rental | H-frame and Cuplock scaffolding for builders';
const check = (draft: string, original = ORIGINAL) => checkSectionBody(original, draft, PAGE, limits);

/** sampleContext with the scaffolding section as s1. */
function ctxWith(text = ORIGINAL, truncated = false): AIContext {
  const ctx = sampleContext();
  ctx.page.content!.sections = [{ sectionKey: 's1-rental-terms', heading: 'Rental terms', level: 2, wordCount: 50, text, truncated }];
  return ctx;
}
const REC = { type: 'CLARIFICATION', targetSection: 's1-rental-terms' } as const;

describe('fact extraction', () => {
  it('finds numbers and non-initial capitalized names', () => {
    expect(numbersIn('From 1,200 sq ft in 7.5 days, 24 hours')).toEqual(['1200', '7.5', '24']);
    expect(namesIn(ORIGINAL)).toEqual(['h-frame', 'cuplock', 'pune']);
  });
});

describe('checkSectionBody', () => {
  it('accepts a fact-preserving rewrite and reports its metrics', () => {
    const r = check(VALID);
    expect(r.issues).toEqual([]);
    expect(r.metrics).toMatchObject({ originalWords: 44, factPreservation: 1, paragraphs: 1 });
    expect(r.metrics.changeRatio).toBeLessThan(0.5);
    expect(Math.abs(r.metrics.lengthChange)).toBeLessThan(0.1);
  });

  it('accepts a concise rewrite within the length allowance', () => {
    const concise = 'Hire scaffolding for short or long periods. Availability depends on the system, quantity and location. We supply only H-frame and Cuplock systems; delivery to Pune may take 2 days. Prices are not fixed and may change with transport and labour scope.';
    expect(check(concise).issues).toEqual([]);
  });

  it('rejects added prices and numbers', () => {
    const r = check(`${VALID} Rates start at 500 per day.`);
    expect(r.issues.join()).toMatch(/adds numbers not in the section: 500/);
  });

  it('rejects added places, brands or names', () => {
    expect(check(VALID.replace('to Pune', 'to Pune and Mumbai')).issues.join()).toMatch(/adds names not on the page: mumbai/);
  });

  it('rejects dropped or changed material numbers and names', () => {
    expect(check(VALID.replace('2 days', 'two days')).issues.join()).toMatch(/drops or changes material numbers: 2/);
    expect(check(VALID.replace('2 days', '3 days')).issues.join()).toMatch(/drops or changes material numbers: 2.*|adds numbers not in the section: 3/);
    expect(check(VALID.replace(' and Cuplock', '')).issues.join()).toMatch(/drops material names: cuplock/);
  });

  it('rejects removed caveats and qualifications', () => {
    expect(check(VALID.replace('Prices are not fixed and may change', 'Prices change')).issues.join()).toMatch(/negation caveat.*not/);
    expect(check(VALID.replace('Availability depends on', 'Availability covers')).issues.join()).toMatch(/condition caveat/);
    expect(check(VALID.replace('We supply only', 'We supply')).issues.join()).toMatch(/limitation caveat/);
    expect(check(VALID.replace(/may /g, 'will ')).issues.join()).toMatch(/hedge caveat/);
  });

  it('rejects excessive expansion and compression', () => {
    expect(check(`${VALID}\n\n${VALID}`).issues.join()).toMatch(/expands the original too much/);
    expect(check('Hire H-frame or Cuplock scaffolding near Pune within 2 days; terms may vary and are not fixed, depending on scope only.').issues.join()).toMatch(/too much shorter|minimum is 15/);
    expect(check('Scaffolding hire.').issues.join()).toMatch(/minimum is 15/);
  });

  it('rejects unrelated rewrites', () => {
    const unrelated =
      'Safety inspections should happen before every shift. Workers need harnesses, toe boards and guard rails, and a competent person must sign off the structure. Weather can make platforms slippery, so check them again after rain.';
    const r = check(unrelated);
    expect(r.issues.join()).toMatch(/changes too much|keeps too few/);
  });

  it('rejects markup, empty drafts and empty sections', () => {
    expect(check(`<p>${VALID}</p>`).issues.join()).toMatch(/plain text/);
    expect(check(`**${VALID}**`).issues.join()).toMatch(/plain text/);
    expect(check('   ').issues).toEqual(['draft is empty']);
    expect(check(VALID, '').issues).toEqual(['the section has no text to rewrite']);
  });

  it('honors configured limits', () => {
    const strict = { ...limits, maxChangeRatio: 0.1 };
    expect(checkSectionBody(ORIGINAL, VALID, PAGE, strict).issues.join()).toMatch(/changes too much/);
  });

  it('metrics compare against the original', () => {
    expect(bodyMetrics('a b c d', 'a b c d e f')).toMatchObject({ originalWords: 4, draftWords: 6, lengthChange: 0.5 });
  });
});

describe('SECTION_BODY drafts through checkDraft', () => {
  const dl = { ...draftLimits(), body: limits };
  it('applies body checks plus the existing claim and overclaim checks', () => {
    expect(checkDraft(ctxWith(), REC, VALID, dl)).toEqual([]);
    expect(checkDraft(ctxWith(), REC, `${VALID} Results will increase your bookings.`, dl).join()).toMatch(/forbidden wording/);
    expect(checkDraft(ctxWith(), REC, VALID.replace('only H-frame', 'certified H-frame'), dl).join()).toMatch(/claim "certified"/);
    expect(checkDraft(ctxWith(), REC, ORIGINAL, dl).join()).toMatch(/identical to the current value/);
  });

  it('refuses invalid section references and truncated sections', () => {
    expect(checkDraft(ctxWith(), { type: 'CLARIFICATION', targetSection: 's9-missing' }, VALID, dl).join()).toMatch(/may not carry a draft/);
    expect(checkBodyDraft(ctxWith(ORIGINAL, true), REC, VALID, dl).issues.join()).toMatch(/truncated/);
  });

  it('never accepts body drafts from the analysis (on request only)', () => {
    const set = validRecommendations();
    set.recommendations[1] = { ...set.recommendations[1]!, type: 'CLARIFICATION', targetSection: 's1-rental-terms', suggestedValue: VALID };
    const out = sanitizeDrafts(ctxWith(), set, dl);
    expect(out.recommendations[1]).toMatchObject({ suggestedValue: null, draftIssues: ['body-section drafts are only generated when a reviewer requests one'] });
  });
});

describe('section-body-v1 prompt', () => {
  it('is versioned separately and states the preservation rules', () => {
    expect(SECTION_BODY_PROMPT_VERSION).toBe('section-body-v1');
    expect(SECTION_BODY_SYSTEM).toMatch(/Keep every material fact/);
    expect(SECTION_BODY_SYSTEM).toMatch(/Never introduce anything the section does not state/);
    expect(SECTION_BODY_SYSTEM).toMatch(/untrusted data/);
    const msg = buildSectionBodyMessage(ctxWith(), { ...validRecommendations().recommendations[1]!, type: 'CLARIFICATION', targetSection: 's1-rental-terms' }, 's1-rental-terms', ['earlier']);
    expect(msg).toContain(ORIGINAL);
    expect(msg).toContain('earlier');
    expect(msg).toContain('untrusted text');
  });
});
