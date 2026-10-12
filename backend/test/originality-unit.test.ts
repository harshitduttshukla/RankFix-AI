import { describe, expect, it } from 'vitest';
import { findMatches, normalizeForMatch, type MatchConfig } from '../src/services/originality/fingerprint.js';
import { InternalCorpusChecker, INTERNAL_LIMITATIONS } from '../src/services/originality/internal-corpus.checker.js';
import type { CheckInput, CorpusDocument } from '../src/services/originality/originality.types.js';
import { originalityTarget } from '../src/services/originality/originality.service.js';

const CFG: MatchConfig = { minMatchWords: 6, significantRunWords: 12, significantCoverage: 0.5, commonPhraseMinPages: 3, commonPhraseRatio: 0.3, maxGapWords: 3 };

const OTHER = 'We supply H-frame and Cuplock scaffolding to construction sites across the western suburbs with erection and dismantling crews available on request.';
const doc = (pageId: string, text: string, over: Partial<CorpusDocument> = {}): CorpusDocument => ({ pageId, url: `https://site.example.com/${pageId}`, websiteId: 'w1', field: 'SECTION_TEXT', sectionKey: 's1', text, ...over });
const input = (text: string, over: Partial<CheckInput> = {}): CheckInput => ({ text, pageId: 'self', websiteId: 'w1', replacing: { field: 'META_DESCRIPTION', sectionKey: null }, ...over });
/** Filler pages so common-phrase thresholds behave as on a real site. */
const filler = Array.from({ length: 10 }, (_, i) => doc(`f${i}`, `Unrelated page number ${i} about safety nets, ladders and site inspections for builders.`));

describe('findMatches', () => {
  it('finds an exact verbatim copy and explains it', () => {
    const r = findMatches(input('Our team will supply H-frame and Cuplock scaffolding to construction sites across the western suburbs with erection and dismantling crews available on request.'), [doc('p2', OTHER), ...filler], CFG);
    expect(r.assessment).toBe('SIGNIFICANT_MATCHES');
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0]!;
    expect(m).toMatchObject({ kind: 'EXACT', severity: 'SIGNIFICANT', source: { pageId: 'p2', url: 'https://site.example.com/p2', field: 'SECTION_TEXT', samePage: false, sameWebsite: true }, attributed: false });
    expect(m.passage).toMatch(/^supply H-frame and Cuplock scaffolding/);
    expect(m.longestRunWords).toBeGreaterThanOrEqual(12);
    expect(m.explanation).toMatch(/verbatim/);
    expect(m.explanation).toMatch(/may still be legitimate/);
    expect(r.overlapRatio).toBeGreaterThan(0.8);
  });

  it('finds near-verbatim copies with small edits', () => {
    const edited = 'We supply H-frame and Cuplock scaffolding to building sites across the western suburbs with erection and dismantling crews available on request.';
    const r = findMatches(input(edited), [doc('p2', OTHER), ...filler], CFG);
    expect(r.matches[0]).toMatchObject({ kind: 'NEAR_VERBATIM', severity: 'SIGNIFICANT' });
    expect(r.matches[0]!.explanation).toMatch(/near-verbatim/);
  });

  it('ignores formatting, case and punctuation differences', () => {
    const r = findMatches(input('WE SUPPLY H-frame & Cuplock   scaffolding — to construction sites, across the WESTERN suburbs; with erection and dismantling crews available on request!'), [doc('p2', OTHER), ...filler], CFG);
    expect(r.assessment).toBe('SIGNIFICANT_MATCHES');
    expect(normalizeForMatch('  Hello,  WORLD’s   end! ')).toBe("hello world's end");
  });

  it('does not flag common phrases that appear on many pages', () => {
    const common = 'Request a project quote from our team today';
    const corpus = Array.from({ length: 6 }, (_, i) => doc(`c${i}`, `Page ${i} body text. ${common}.`)).concat(filler);
    const r = findMatches(input(`Rent Cuplock scaffolding in Mumbai. ${common}.`), corpus, CFG);
    expect(r.assessment).toBe('NO_MATCHES');
  });

  it('short shared terminology below the minimum run is never a match', () => {
    const r = findMatches(input('Scaffolding rental services in Mumbai for builders'), [doc('p2', 'Scaffolding rental services in Pune for contractors'), ...filler], CFG);
    expect(r.matches).toEqual([]);
  });

  it('reports a short overlap as MINOR without blocking', () => {
    const text = 'Choose material-only or add erection and dismantling labour for your site in Mumbai, with delivery planned around your schedule and permits.';
    const r = findMatches(input(text), [doc('p2', 'Customers can add erection and dismantling labour for any order.'), ...filler], CFG);
    expect(r.assessment).toBe('MINOR_MATCHES');
    expect(r.matches[0]!.severity).toBe('MINOR');
  });

  it('a whole short field identical to another page’s field is a duplicate', () => {
    const r = findMatches(input('Scaffolding Rental in Mumbai', { replacing: { field: 'TITLE', sectionKey: null } }), [doc('p2', 'Scaffolding rental in Mumbai', { field: 'TITLE', sectionKey: null }), ...filler], CFG);
    expect(r.matches[0]).toMatchObject({ kind: 'DUPLICATE_FIELD', severity: 'SIGNIFICANT' });
    expect(r.matches[0]!.explanation).toMatch(/identical to the title of https:\/\/site.example.com\/p2/);
  });

  it('treats quoted or attributed passages as MINOR', () => {
    const quoted = `As our safety partner puts it, "We supply H-frame and Cuplock scaffolding to construction sites across the western suburbs with erection and dismantling crews available on request."`;
    const r = findMatches(input(quoted), [doc('p2', OTHER), ...filler], CFG);
    expect(r.matches[0]).toMatchObject({ attributed: true, severity: 'MINOR' });
    expect(r.assessment).toBe('MINOR_MATCHES');
    const cited = `According to the site survey, we supply H-frame and Cuplock scaffolding to construction sites across the western suburbs with erection and dismantling crews.`;
    expect(findMatches(input(cited), [doc('p2', OTHER), ...filler], CFG).matches[0]!.attributed).toBe(true);
  });

  it('same-page text is informational only; the field being replaced is excluded', () => {
    const own = doc('self', OTHER);
    const replaced = doc('self', 'Rent H-frame and Cuplock scaffolding across Mumbai today', { field: 'META_DESCRIPTION', sectionKey: null });
    const r = findMatches(input('Rent H-frame and Cuplock scaffolding across Mumbai today. We supply H-frame and Cuplock scaffolding to construction sites across the western suburbs.'), [own, replaced, ...filler], CFG);
    expect(r.assessment).toBe('INFORMATIONAL_MATCHES');
    expect(r.matches.every((m) => m.severity === 'INFO' && m.source.samePage)).toBe(true);
    expect(r.matches.some((m) => m.source.field === 'META_DESCRIPTION')).toBe(false);
    expect(r.overlapRatio).toBe(0);
  });

  it('deduplicates the same passage found on several pages', () => {
    const r = findMatches(input(OTHER), [doc('p2', OTHER), doc('p3', OTHER), ...filler], CFG);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.alsoFoundIn).toEqual([{ url: 'https://site.example.com/p3', field: 'SECTION_TEXT' }]);
  });

  it('empty text has nothing to match', () => {
    expect(findMatches(input('  ... '), [doc('p2', OTHER)], CFG)).toEqual({ assessment: 'NO_MATCHES', overlapRatio: 0, matches: [] });
  });
});

describe('InternalCorpusChecker', () => {
  it('uses only the scope it is given and always states its limitations', async () => {
    const seen: unknown[] = [];
    const c = new InternalCorpusChecker({ match: CFG, maxCorpusPages: 100 }, async (scope) => {
      seen.push(scope);
      return { documents: [doc('p2', OTHER)], pages: 2, truncated: true };
    });
    const r = await c.check({ organizationId: 'o1', projectId: 'p1' }, input(OTHER));
    expect(seen).toEqual([{ organizationId: 'o1', projectId: 'p1' }]);
    expect(r.limitations).toEqual(expect.arrayContaining([...INTERNAL_LIMITATIONS, 'Only the first 100 pages of this project were compared.']));
    expect(r.limitations.join(' ')).toMatch(/not .*plagiarism-free/);
    expect(c.version).toBe('internal-ngram-v1');
  });
});

describe('originalityTarget', () => {
  const values = { sections: [{ sectionKey: 's0-intro', heading: null }, { sectionKey: 's1-a', heading: 'A' }] };
  it('covers draftable fields only', () => {
    expect(originalityTarget('TITLE', null, values)).toEqual({ field: 'TITLE', sectionKey: null });
    expect(originalityTarget('SECTION_HEADING', 's1-a', values)).toEqual({ field: 'SECTION_HEADING', sectionKey: 's1-a' });
    expect(originalityTarget('SECTION_CONTENT', 's0-intro', values)).toEqual({ field: 'SECTION_TEXT', sectionKey: 's0-intro' });
    expect(originalityTarget('SECTION_CONTENT', 's1-a', values)).toBeNull();
  });
});
