import { createHash } from 'node:crypto';
import type { ProposalChangeType } from '@prisma/client';
import type { Recommendation } from '../ai/ai.schemas.js';
import { REVIEW_CONFIG } from './review.config.js';

export const CHANGE_TYPES: ProposalChangeType[] = ['TITLE', 'META_DESCRIPTION', 'H1', 'SECTION_HEADING', 'SECTION_CONTENT'];
export const SECTION_CHANGES: ProposalChangeType[] = ['SECTION_HEADING', 'SECTION_CONTENT'];

/** Suggested concrete change type for a recommendation. The reviewer may choose another one. */
export function defaultChangeType(rec: Pick<Recommendation, 'type' | 'targetSection'>): ProposalChangeType | null {
  switch (rec.type) {
    case 'TITLE':
      return 'TITLE';
    case 'META_DESCRIPTION':
      return 'META_DESCRIPTION';
    case 'HEADING':
      return rec.targetSection ? 'SECTION_HEADING' : 'H1';
    case 'SECTION_EXPANSION':
    case 'CLARIFICATION':
    case 'INTRODUCTION':
    case 'MISSING_TOPIC':
    case 'INTERNAL_LINK':
      // Content-level changes are expressed as new text for an existing section.
      return rec.targetSection ? 'SECTION_CONTENT' : null;
  }
}

export interface VersionValues {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  sections: { sectionKey: string; heading: string | null; text: string }[];
}

export class ProposalInputError extends Error {}

/** The value the change would replace, read from the analyzed version (never from the client). */
export function currentValueFor(changeType: ProposalChangeType, targetSection: string | null, v: VersionValues): string | null {
  if (changeType === 'TITLE') return v.title;
  if (changeType === 'META_DESCRIPTION') return v.metaDescription;
  if (changeType === 'H1') return v.h1;
  const section = v.sections.find((s) => s.sectionKey === targetSection);
  if (!section) throw new ProposalInputError(`Section "${targetSection ?? ''}" does not exist in the analyzed page version`);
  return changeType === 'SECTION_HEADING' ? section.heading : section.text;
}

/** Validates and normalizes a concrete change; returns the fields stored on the proposal. */
export function buildProposalValues(
  input: { changeType: ProposalChangeType; targetSection?: string | null; proposedValue: string },
  version: VersionValues,
) {
  const isSection = SECTION_CHANGES.includes(input.changeType);
  const targetSection = isSection ? (input.targetSection ?? null) : null;
  if (isSection && !targetSection) throw new ProposalInputError(`${input.changeType} requires a target section`);
  const currentValue = currentValueFor(input.changeType, targetSection, version);
  const proposedValue = input.changeType === 'SECTION_CONTENT' ? input.proposedValue.trim() : input.proposedValue.replace(/\s+/g, ' ').trim();
  if (!proposedValue) throw new ProposalInputError('Proposed value is empty');
  const max = REVIEW_CONFIG.maxLength[input.changeType];
  if (proposedValue.length > max) throw new ProposalInputError(`Proposed value exceeds ${max} characters`);
  if (/<\s*(script|iframe|style)\b/i.test(proposedValue)) throw new ProposalInputError('Proposed value must not contain script, iframe or style tags');
  if (currentValue != null && currentValue.trim() === proposedValue) throw new ProposalInputError('Proposed value is identical to the current value');
  return { changeType: input.changeType, targetSection, currentValue, proposedValue };
}

/** Fingerprint of an approved change. Phase 7 can verify the proposal wasn't altered after approval. */
export function proposalHash(p: { changeType: string; targetSection: string | null; currentValue: string | null; proposedValue: string; pageVersionId: string }) {
  return createHash('sha256')
    .update(JSON.stringify([p.changeType, p.targetSection, p.currentValue, p.proposedValue, p.pageVersionId]))
    .digest('hex');
}
