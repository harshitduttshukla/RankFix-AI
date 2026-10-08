import { describe, expect, it } from 'vitest';
import { buildProposalValues, defaultChangeType, proposalHash, ProposalInputError } from '../src/services/review/proposal-builder.js';
import { evaluateStaleness } from '../src/services/review/staleness.js';

const snapshot = { dateRangeEnd: '2026-09-28', score: 70, clicks: 300, impressions: 30000, ctr: 0.01, position: 7.2 };
const base = { analysisPageVersionId: 'v42', currentPageVersionId: 'v42', snapshot, opportunity: { clicks: 300, impressions: 30000, position: 7.2 } };

describe('evaluateStaleness', () => {
  it('is fresh when version and evidence match', () => expect(evaluateStaleness(base)).toBeNull());
  it('detects a page version change (42 → 43)', () => expect(evaluateStaleness({ ...base, currentPageVersionId: 'v43' })).toBe('PAGE_VERSION_CHANGED'));
  it('detects a version appearing after an analysis without content', () =>
    expect(evaluateStaleness({ ...base, analysisPageVersionId: null })).toBe('PAGE_VERSION_CHANGED'));
  it('applies the ±30% impressions/clicks and ±2 position rules', () => {
    expect(evaluateStaleness({ ...base, opportunity: { ...base.opportunity, impressions: 38000 } })).toBeNull(); // +27%
    expect(evaluateStaleness({ ...base, opportunity: { ...base.opportunity, impressions: 39000 } })).toBe('EVIDENCE_CHANGED'); // +30%
    expect(evaluateStaleness({ ...base, opportunity: { ...base.opportunity, clicks: 200 } })).toBe('EVIDENCE_CHANGED');
    expect(evaluateStaleness({ ...base, opportunity: { ...base.opportunity, position: 9.2 } })).toBe('EVIDENCE_CHANGED');
    expect(evaluateStaleness({ ...base, opportunity: { ...base.opportunity, position: 8.9 } })).toBeNull();
  });
  it('ignores relative swings on small baselines and skips evidence without a snapshot', () => {
    const small = { ...base, snapshot: { ...snapshot, clicks: 10, impressions: 50 }, opportunity: { clicks: 2, impressions: 10, position: 7.2 } };
    expect(evaluateStaleness(small)).toBeNull();
    expect(evaluateStaleness({ ...base, snapshot: null, opportunity: { clicks: 0, impressions: 1, position: 50 } })).toBeNull();
  });
});

describe('proposal builder', () => {
  const version = { title: 'Old title', metaDescription: null, h1: 'H', sections: [{ sectionKey: 's1', heading: 'Intro', text: 'Body' }] };

  it('maps recommendation types to controlled change types', () => {
    expect(defaultChangeType({ type: 'TITLE', targetSection: null })).toBe('TITLE');
    expect(defaultChangeType({ type: 'HEADING', targetSection: null })).toBe('H1');
    expect(defaultChangeType({ type: 'HEADING', targetSection: 's1' })).toBe('SECTION_HEADING');
    expect(defaultChangeType({ type: 'SECTION_EXPANSION', targetSection: 's1' })).toBe('SECTION_CONTENT');
    expect(defaultChangeType({ type: 'MISSING_TOPIC', targetSection: null })).toBeNull();
  });

  it('reads the current value from the analyzed version and normalizes the proposal', () => {
    expect(buildProposalValues({ changeType: 'TITLE', proposedValue: '  New   title ' }, version)).toEqual({
      changeType: 'TITLE', targetSection: null, currentValue: 'Old title', proposedValue: 'New title',
    });
    expect(buildProposalValues({ changeType: 'META_DESCRIPTION', proposedValue: 'Meta' }, version).currentValue).toBeNull();
    expect(buildProposalValues({ changeType: 'SECTION_HEADING', targetSection: 's1', proposedValue: 'Introduction' }, version).currentValue).toBe('Intro');
  });

  it('rejects empty, identical, oversize, unsafe or untargeted changes', () => {
    const bad = [
      { changeType: 'TITLE' as const, proposedValue: ' ' },
      { changeType: 'TITLE' as const, proposedValue: 'Old title' },
      { changeType: 'TITLE' as const, proposedValue: 'x'.repeat(201) },
      { changeType: 'SECTION_CONTENT' as const, targetSection: 's1', proposedValue: '<iframe src=x>' },
      { changeType: 'SECTION_CONTENT' as const, proposedValue: 'text' },
      { changeType: 'SECTION_CONTENT' as const, targetSection: 'nope', proposedValue: 'text' },
    ];
    for (const b of bad) expect(() => buildProposalValues(b, version)).toThrow(ProposalInputError);
  });

  it('hashes the frozen change deterministically', () => {
    const p = { changeType: 'TITLE', targetSection: null, currentValue: 'a', proposedValue: 'b', pageVersionId: 'v42' };
    expect(proposalHash(p)).toBe(proposalHash({ ...p }));
    expect(proposalHash(p)).not.toBe(proposalHash({ ...p, pageVersionId: 'v43' }));
  });
});
