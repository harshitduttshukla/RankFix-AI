import { env } from '../../config/env.js';
import type { AIContext } from './ai-context.builder.js';
import { forbiddenLanguage } from './ai.guardrails.js';
import type { Recommendation, RecommendationSet, StoredRecommendation } from './ai.schemas.js';

/*
 * AI-drafted replacement copy. A draft is untrusted model output: it is only stored, and only shown to a reviewer
 * as a starting value, after every check here passes. Checks are deterministic and conservative; a false positive
 * just means the reviewer writes the copy themselves.
 */

/** What a draft replaces. INTRODUCTION is the text of the page's intro section (before the first heading). */
export type DraftTarget = 'TITLE' | 'META_DESCRIPTION' | 'H1' | 'SECTION_HEADING' | 'INTRODUCTION';

export interface DraftLimits {
  maxLength: Record<DraftTarget, number>;
  minLength: Record<DraftTarget, number>;
  maxRegenerations: number;
}

export function draftLimits(source: Pick<typeof env, 'AI_DRAFT_MAX_TITLE' | 'AI_DRAFT_MAX_META_DESCRIPTION' | 'AI_DRAFT_MAX_H1' | 'AI_DRAFT_MAX_SECTION_HEADING' | 'AI_DRAFT_MAX_INTRODUCTION' | 'AI_DRAFT_MAX_REGENERATIONS'> = env): DraftLimits {
  return {
    maxLength: {
      TITLE: source.AI_DRAFT_MAX_TITLE,
      META_DESCRIPTION: source.AI_DRAFT_MAX_META_DESCRIPTION,
      H1: source.AI_DRAFT_MAX_H1,
      SECTION_HEADING: source.AI_DRAFT_MAX_SECTION_HEADING,
      INTRODUCTION: source.AI_DRAFT_MAX_INTRODUCTION,
    },
    minLength: { TITLE: 10, META_DESCRIPTION: 50, H1: 3, SECTION_HEADING: 3, INTRODUCTION: 80 },
    maxRegenerations: source.AI_DRAFT_MAX_REGENERATIONS,
  };
}

type PageContent = NonNullable<AIContext['page']['content']>;
type DraftableRec = Pick<Recommendation, 'type' | 'targetSection'>;

/**
 * The field a recommendation's draft would replace, or null when it may not have one. An INTRODUCTION draft is
 * only allowed for the page's real intro section (first section, no heading), so it can never replace other text.
 */
export function draftTarget(rec: DraftableRec, content: { sections: { sectionKey: string; heading: string | null }[] } | null): DraftTarget | null {
  switch (rec.type) {
    case 'TITLE':
      return 'TITLE';
    case 'META_DESCRIPTION':
      return 'META_DESCRIPTION';
    case 'HEADING':
      if (!rec.targetSection) return 'H1';
      return content?.sections.some((s) => s.sectionKey === rec.targetSection && s.heading) ? 'SECTION_HEADING' : null;
    case 'INTRODUCTION': {
      const first = content?.sections[0];
      return first && !first.heading && first.sectionKey === rec.targetSection ? 'INTRODUCTION' : null;
    }
    default:
      return null;
  }
}

function currentValue(target: DraftTarget, rec: DraftableRec, c: PageContent): string | null {
  if (target === 'TITLE') return c.title;
  if (target === 'META_DESCRIPTION') return c.metaDescription;
  if (target === 'H1') return c.h1;
  const s = c.sections.find((x) => x.sectionKey === rec.targetSection);
  return (target === 'SECTION_HEADING' ? s?.heading : s?.text) ?? null;
}

/** Normalization shared with proposals: single-line fields collapse whitespace, intro text is only trimmed. */
export function normalizeDraft(target: DraftTarget, value: string) {
  return target === 'INTRODUCTION' ? value.trim() : value.replace(/\s+/g, ' ').trim();
}

const lower = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word (or whole-number) containment, so "rate" doesn't match "accurate" or "1" match "10". */
const has = (text: string, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/**
 * Price, offer and credential terms: a draft may only use one the page itself already uses. "guarantee" is left to
 * the shared overclaim check, which already allows clearly negated disclaimers ("results are not guaranteed").
 */
const CLAIM_TERMS =
  /[₹$€£]|\b(?:rs\.?|inr|usd|eur|gbp|prices?|priced|pricing|rates?|costs?|fees?|charges?|discounts?|offers?|deals?|cheap(?:er|est)?|lowest|affordable|free|certified|certification|accredited|licensed|insured|iso|awards?|award-winning|best|leading|top-rated|no\.?\s?1|number one|#1|trusted|experienced|experts?|years?|since|24\/7|24x7|same-day|next-day|warrant(?:y|ies|ied)|safest|fastest|largest|biggest|only|official|approved|clients?|customers?|projects completed|satisfaction|reviews?|rated)\b/gi;

/** Capitalized words a title-case draft may use without the page containing them. */
const COMMON = new Set(
  'a an and or of in on for to the with at by from your our you we us is are be get how what why when where which who guide guides tips overview introduction about contact services service rental rentals rent hire buy sale sales quote quotes request book call online near me home page more information details options solutions products product range available supply supplies support help faq faqs complete simple easy quick new learn find choose types type list'.split(' '),
);

/**
 * Facts in the draft that the page doesn't support: numbers, price/credential terms and proper nouns (places,
 * brands, names) that appear neither in the page's own text nor (for words) in its Search Console queries.
 */
export function unsupportedClaims(draft: string, ctx: AIContext): string[] {
  const c = ctx.page.content;
  if (!c) return ['no crawled page content to ground the draft in'];
  const pageText = lower(
    [c.title, c.metaDescription, c.h1, ...c.headings.map((h) => h.text), ...c.sections.flatMap((s) => [s.heading, s.text]), ctx.project.name, ctx.website.baseUrl]
      .filter(Boolean)
      .join(' \n '),
  );
  const queryText = lower(ctx.opportunity.topQueries.map((q) => q.query).join(' \n '));
  const issues: string[] = [];

  for (const m of draft.matchAll(/\d[\d,.]*\d|\d/g)) {
    if (!has(pageText, m[0])) issues.push(`number "${m[0]}" does not appear on the page`);
  }
  for (const m of draft.matchAll(CLAIM_TERMS)) {
    if (!has(pageText, lower(m[0]))) issues.push(`claim "${m[0]}" is not supported by the page content`);
  }
  // Proper nouns: capitalized tokens other than a sentence's first word.
  const tokens = draft.match(/[\p{L}\p{N}][\p{L}\p{N}'’&-]*|[.!?:|–—-]/gu) ?? [];
  let sentenceStart = true;
  for (const tok of tokens) {
    if (/^[.!?:|–—-]$/.test(tok)) {
      sentenceStart = true;
      continue;
    }
    const isCapitalized = /^\p{Lu}/u.test(tok);
    const w = tok.toLowerCase();
    if (isCapitalized && !sentenceStart && !COMMON.has(w) && !has(pageText, w) && !has(queryText, w)) {
      issues.push(`name "${tok}" does not appear on the page or in its queries`);
    }
    sentenceStart = false;
  }
  return [...new Set(issues)];
}

/**
 * Every check a draft must pass before a reviewer sees it. Returns the problems found (empty = valid). The
 * existing overclaim check (forbidden promissory wording, un-negated "guarantee") applies to drafts too.
 */
export function checkDraft(ctx: AIContext, rec: DraftableRec, value: string | null | undefined, limits = draftLimits()): string[] {
  if (value == null) return [];
  const target = draftTarget(rec, ctx.page.content);
  if (!target) return [`a ${rec.type} recommendation${rec.targetSection ? ` for "${rec.targetSection}"` : ''} may not carry a draft`];
  const draft = normalizeDraft(target, value);
  if (!draft) return ['draft is empty'];
  const issues: string[] = [];
  if (draft.length > limits.maxLength[target]) issues.push(`draft exceeds ${limits.maxLength[target]} characters for ${target}`);
  if (draft.length < limits.minLength[target]) issues.push(`draft is shorter than ${limits.minLength[target]} characters for ${target}`);
  if (target !== 'INTRODUCTION' && /[\r\n]/.test(value.trim())) issues.push('draft must be a single line');
  if (/[<>]/.test(draft) || /\]\(|https?:\/\//i.test(draft)) issues.push('draft must be plain text (no markup or links)');
  const current = currentValue(target, rec, ctx.page.content!);
  if (current != null && normalizeDraft(target, current) === draft) issues.push('draft is identical to the current value');
  issues.push(...unsupportedClaims(draft, ctx));
  issues.push(...forbiddenLanguage(draft));
  return issues;
}

/**
 * Applies checkDraft to every recommendation of a validated set. Invalid drafts are dropped (suggestedValue null)
 * and the reasons kept in `draftIssues`; the recommendation itself is unaffected.
 */
export function sanitizeDrafts(ctx: AIContext, set: RecommendationSet, limits = draftLimits()): { recommendations: StoredRecommendation[]; caveats: string[] } {
  return {
    ...set,
    recommendations: set.recommendations.map((rec) => {
      const issues = checkDraft(ctx, rec, rec.suggestedValue, limits);
      if (rec.suggestedValue == null) return { ...rec, suggestedValue: null };
      if (issues.length) return { ...rec, suggestedValue: null, draftIssues: issues.slice(0, 5) };
      return { ...rec, suggestedValue: normalizeDraft(draftTarget(rec, ctx.page.content)!, rec.suggestedValue) };
    }),
  };
}
