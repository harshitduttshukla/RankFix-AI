import { describe, expect, it } from 'vitest';
import { isRetryable } from '../src/services/apply/apply.service.js';
import { normalizeForVerification, verifyChange, type VersionFields } from '../src/services/apply/verify.js';

const sections = (heads: [string | null, string][]) =>
  heads.map(([heading, text], order) => ({ sectionKey: `s${order}-${heading ? heading.toLowerCase().replace(/\s+/g, '-') : 'intro'}`, order, level: heading ? 2 : 0, heading, text }));

const approved: VersionFields = {
  title: 'React Guide',
  metaDescription: 'Learn React.',
  h1: 'React Guide',
  sections: sections([[null, 'Intro text here.'], ['React hooks tutorial', 'Hooks let you use state.'], ['State management', 'Context and reducers.']]),
};
const live = (over: Partial<VersionFields>): VersionFields => ({ ...approved, ...over });
const p = (changeType: 'TITLE' | 'META_DESCRIPTION' | 'H1' | 'SECTION_HEADING' | 'SECTION_CONTENT', currentValue: string | null, proposedValue: string, targetSection: string | null = null) => ({
  changeType,
  targetSection,
  currentValue,
  proposedValue,
});

describe('normalizeForVerification', () => {
  it('collapses whitespace and trims, but keeps case and punctuation', () => {
    expect(normalizeForVerification('  React\n\tGuide:  Hooks ')).toBe('React Guide: Hooks');
    expect(normalizeForVerification('React guide')).not.toBe(normalizeForVerification('React Guide'));
    expect(normalizeForVerification('React Guide.')).not.toBe(normalizeForVerification('React Guide'));
    expect(normalizeForVerification(null)).toBe('');
    // NFC: a decomposed é equals the composed one
    expect(normalizeForVerification('Café')).toBe(normalizeForVerification('Café'));
  });
});

describe('verifyChange', () => {
  it('matches title, meta description and H1 exactly after normalization', () => {
    expect(verifyChange(p('TITLE', 'React Guide', 'React Guide: Hooks'), approved, live({ title: 'React  Guide: Hooks ' })).result).toBe('MATCH');
    expect(verifyChange(p('META_DESCRIPTION', 'Learn React.', 'Learn React hooks.'), approved, live({ metaDescription: 'Learn React hooks.' })).result).toBe('MATCH');
    expect(verifyChange(p('H1', 'React Guide', 'The React Guide'), approved, live({ h1: 'The React Guide' })).result).toBe('MATCH');
  });

  it('reports UNCHANGED while the old value is live, CONFLICT for anything else (case matters)', () => {
    expect(verifyChange(p('TITLE', 'React Guide', 'React Guide: Hooks'), approved, approved).result).toBe('UNCHANGED');
    expect(verifyChange(p('TITLE', 'React Guide', 'React Guide: Hooks'), approved, live({ title: 'react guide: hooks' })).result).toBe('CONFLICT');
    expect(verifyChange(p('TITLE', 'React Guide', 'React Guide: Hooks'), approved, live({ title: null })).result).toBe('CONFLICT');
  });

  it('treats an absent field that was absent before as UNCHANGED', () => {
    const noMeta = live({ metaDescription: null });
    expect(verifyChange(p('META_DESCRIPTION', null, 'A new description.'), noMeta, noMeta).result).toBe('UNCHANGED');
  });

  it('never matches a value found in a different field', () => {
    expect(verifyChange(p('TITLE', 'React Guide', 'The React Guide'), approved, live({ h1: 'The React Guide' })).result).toBe('UNCHANGED');
  });

  it('section text: compared in its own section, paragraph whitespace ignored', () => {
    const change = p('SECTION_CONTENT', 'Hooks let you use state.', 'Hooks let you use state.\n\nThey replace classes.', 's1-react-hooks-tutorial');
    const ok = live({ sections: sections([[null, 'Intro text here.'], ['React hooks tutorial', 'Hooks let you use state. They replace classes.'], ['State management', 'Context and reducers.']]) });
    expect(verifyChange(change, approved, ok)).toMatchObject({ result: 'MATCH', liveSectionKey: 's1-react-hooks-tutorial' });
    // the approved text in another section is not a match for this one
    const elsewhere = live({ sections: sections([[null, 'Intro text here.'], ['React hooks tutorial', 'Hooks let you use state.'], ['State management', 'Hooks let you use state. They replace classes.']]) });
    expect(verifyChange(change, approved, elsewhere).result).toBe('UNCHANGED');
  });

  it('section text: TARGET_MISSING when the section is gone, never a fallback to another section', () => {
    const change = p('SECTION_CONTENT', 'Hooks let you use state.', 'New text for hooks.', 's1-react-hooks-tutorial');
    const gone = live({ sections: sections([[null, 'Intro text here.'], ['State management', 'New text for hooks.']]) });
    expect(verifyChange(change, approved, gone).result).toBe('TARGET_MISSING');
  });

  it('section heading: located by position and level although the key changed', () => {
    const change = p('SECTION_HEADING', 'React hooks tutorial', 'A React hooks tutorial', 's1-react-hooks-tutorial');
    const ok = live({ sections: sections([[null, 'Intro text here.'], ['A React hooks tutorial', 'Hooks let you use state.'], ['State management', 'Context and reducers.']]) });
    expect(verifyChange(change, approved, ok)).toMatchObject({ result: 'MATCH', liveSectionKey: 's1-a-react-hooks-tutorial' });
    expect(verifyChange(change, approved, approved).result).toBe('UNCHANGED');
  });

  it('section heading: TARGET_MISSING when the structure changed (positions are not trusted)', () => {
    const change = p('SECTION_HEADING', 'React hooks tutorial', 'A React hooks tutorial', 's1-react-hooks-tutorial');
    const shifted = live({ sections: sections([[null, 'Intro text here.'], ['New section', 'x'], ['A React hooks tutorial', 'Hooks let you use state.'], ['State management', 'y']]) });
    expect(verifyChange(change, approved, shifted).result).toBe('TARGET_MISSING');
  });

  it('TARGET_MISSING when the approved section key is unknown', () => {
    expect(verifyChange(p('SECTION_CONTENT', 'x', 'y', 's9-nope'), approved, approved).result).toBe('TARGET_MISSING');
  });
});

describe('isRetryable', () => {
  it('allows retrying unverified runs, not abandoned, integrity-failed or applied ones', () => {
    expect(isRetryable({ status: 'AWAITING_CHANGE', verificationError: null })).toBe(true);
    expect(isRetryable({ status: 'FAILED', verificationError: 'CONTENT_CONFLICT' })).toBe(true);
    expect(isRetryable({ status: 'FAILED', verificationError: 'FETCH_FAILED' })).toBe(true);
    expect(isRetryable({ status: 'FAILED', verificationError: 'ABANDONED' })).toBe(false);
    expect(isRetryable({ status: 'FAILED', verificationError: 'PROPOSAL_INTEGRITY' })).toBe(false);
    expect(isRetryable({ status: 'APPLIED', verificationError: null })).toBe(false);
    expect(isRetryable({ status: 'APPLYING', verificationError: null })).toBe(false);
  });
});
