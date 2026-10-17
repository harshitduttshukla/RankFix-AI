import type { ProposalChangeType } from '@prisma/client';

/*
 * Deterministic verification of a manually applied change (Phase 7a). No AI, no fuzzy matching: the live field is
 * compared with the approved value after the normalization below, and nothing on the website is ever written.
 *
 * Normalization (both sides): Unicode NFC, then every whitespace run (including paragraph breaks) collapsed to one
 * space, then trimmed. Case, punctuation and wording are compared exactly. This matches buildProposalValues() for
 * single-line fields; for SECTION_CONTENT it is slightly looser than the proposal's trim-only rule because the
 * extractor rebuilds section text from HTML blocks, so paragraph breaks are not a reliable signal.
 */

export interface VersionSection {
  sectionKey: string;
  order: number;
  level: number;
  heading: string | null;
  text: string;
}

export interface VersionFields {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  sections: VersionSection[];
}

export type VerifyResult = 'MATCH' | 'UNCHANGED' | 'CONFLICT' | 'TARGET_MISSING';

export interface Verification {
  result: VerifyResult;
  /** Normalized live value of the target field (null when the field is absent). */
  liveValue: string | null;
  /** Section the value was read from, for SECTION_* changes. */
  liveSectionKey: string | null;
  reason?: string;
}

export const normalizeForVerification = (value: string | null | undefined) => (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

type Located = { found: true; value: string | null; sectionKey: string | null } | { found: false; reason: string };

/**
 * Finds the target field in the live version. A section is never guessed:
 * - SECTION_CONTENT: the live section with the approved section's key (key = order + heading slug, so an unchanged
 *   heading at the same position).
 * - SECTION_HEADING: the heading change alters the key, so the section is the one at the same position and level,
 *   and only while the page still has the same number of sections (otherwise positions can't be trusted).
 */
export function locateTarget(changeType: ProposalChangeType, targetSection: string | null, approved: VersionFields, live: VersionFields): Located {
  if (changeType === 'TITLE') return { found: true, value: live.title, sectionKey: null };
  if (changeType === 'META_DESCRIPTION') return { found: true, value: live.metaDescription, sectionKey: null };
  if (changeType === 'H1') return { found: true, value: live.h1, sectionKey: null };

  const source = approved.sections.find((s) => s.sectionKey === targetSection);
  if (!source) return { found: false, reason: `section "${targetSection ?? ''}" is not in the approved page version` };

  if (changeType === 'SECTION_CONTENT') {
    const s = live.sections.find((x) => x.sectionKey === source.sectionKey);
    return s ? { found: true, value: s.text, sectionKey: s.sectionKey } : { found: false, reason: `section "${source.sectionKey}" is no longer on the page` };
  }
  if (live.sections.length !== approved.sections.length) {
    return { found: false, reason: `the page now has ${live.sections.length} sections instead of ${approved.sections.length}; the target heading can't be located safely` };
  }
  const s = live.sections.find((x) => x.order === source.order);
  if (!s || s.level !== source.level) return { found: false, reason: `no level-${source.level} section at position ${source.order}` };
  return { found: true, value: s.heading, sectionKey: s.sectionKey };
}

/** MATCH: live = approved value · UNCHANGED: live = the value it replaced · CONFLICT: anything else. */
export function verifyChange(
  proposal: { changeType: ProposalChangeType; targetSection: string | null; currentValue: string | null; proposedValue: string },
  approved: VersionFields,
  live: VersionFields,
): Verification {
  const located = locateTarget(proposal.changeType, proposal.targetSection, approved, live);
  if (!located.found) return { result: 'TARGET_MISSING', liveValue: null, liveSectionKey: null, reason: located.reason };
  const liveValue = normalizeForVerification(located.value);
  const base = { liveValue: located.value == null ? null : liveValue, liveSectionKey: located.sectionKey };
  const proposed = normalizeForVerification(proposal.proposedValue);
  if (proposed && liveValue === proposed) return { result: 'MATCH', ...base };
  if (liveValue === normalizeForVerification(proposal.currentValue)) return { result: 'UNCHANGED', ...base };
  return { result: 'CONFLICT', ...base, reason: 'the live value is neither the approved value nor the value it replaced' };
}
