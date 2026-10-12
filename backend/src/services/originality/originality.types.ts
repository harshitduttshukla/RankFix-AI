/*
 * Content originality checking. A checker compares one text against a corpus and reports overlapping passages.
 * It never certifies that text is original or plagiarism-free: it can only report what it found in what it searched.
 */

export type OriginalityStatus = 'NOT_CHECKED' | 'CHECKED' | 'CHECK_FAILED';
export type OriginalityAssessment = 'NO_MATCHES' | 'INFORMATIONAL_MATCHES' | 'MINOR_MATCHES' | 'SIGNIFICANT_MATCHES';

/** The page field a corpus passage came from. */
export type SourceField = 'TITLE' | 'META_DESCRIPTION' | 'H1' | 'SECTION_HEADING' | 'SECTION_TEXT';

/**
 * INFO: same-page text (drafts are required to reuse the page's own facts) — never a concern.
 * MINOR: short or attributed overlap — shown, never blocks. SIGNIFICANT: long or dominant unattributed overlap.
 */
export type MatchSeverity = 'INFO' | 'MINOR' | 'SIGNIFICANT';

export interface OriginalityMatch {
  /** EXACT: one contiguous verbatim run · NEAR_VERBATIM: runs joined across small edits · DUPLICATE_FIELD: the whole text equals a whole field. */
  kind: 'EXACT' | 'NEAR_VERBATIM' | 'DUPLICATE_FIELD';
  severity: MatchSeverity;
  /** The matching passage as it appears in the checked text. */
  passage: string;
  /** Character offsets of `passage` in the checked text. */
  start: number;
  end: number;
  source: { pageId: string; url: string; field: SourceField; sectionKey: string | null; samePage: boolean; sameWebsite: boolean; excerpt: string };
  /** Other places the same passage was found (deduplicated into this match). */
  alsoFoundIn: { url: string; field: SourceField }[];
  /** Words of the checked text inside this match. */
  words: number;
  /** Longest single verbatim run, in words. */
  longestRunWords: number;
  /** Share of the checked text's words covered by this match (0-1). Not a plagiarism score. */
  textCoverage: number;
  attributed: boolean;
  explanation: string;
}

export interface CorpusDocument {
  pageId: string;
  url: string;
  websiteId: string;
  field: SourceField;
  sectionKey: string | null;
  text: string;
}

export interface CheckInput {
  text: string;
  /** The page whose field is being replaced; its other text is reported as INFO only. */
  pageId: string;
  websiteId: string;
  /** The exact field being replaced, excluded from the corpus. */
  replacing: { field: SourceField; sectionKey: string | null };
}

export interface CheckOutcome {
  assessment: OriginalityAssessment;
  /** Share of words inside MINOR/SIGNIFICANT matches (union). Explicitly not a universal plagiarism score. */
  overlapRatio: number;
  matches: OriginalityMatch[];
  corpusPages: number;
  limitations: string[];
}

/** Implementations: internal corpus (default). Others (e.g. a self-hosted engine) can be added behind this. */
export interface OriginalityChecker {
  readonly name: string;
  readonly version: string;
  /** Scoped to one tenant's project by the caller; must never read another tenant's content. */
  check(scope: { organizationId: string; projectId: string }, input: CheckInput): Promise<CheckOutcome>;
}

export class OriginalityCheckError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
