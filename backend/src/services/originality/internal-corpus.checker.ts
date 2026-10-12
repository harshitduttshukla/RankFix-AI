import { prisma } from '../../config/database.js';
import { findMatches, type MatchConfig } from './fingerprint.js';
import type { CheckInput, CheckOutcome, CorpusDocument, OriginalityChecker } from './originality.types.js';

/** Stated on every result so no one reads "no matches" as "original" or "plagiarism-free". */
export const INTERNAL_LIMITATIONS = [
  'Compared only with pages crawled into this project (the current version of each page). The public web and other projects were not searched.',
  'Detects verbatim and near-verbatim reuse only; paraphrased or translated copying is not detected.',
  'This is not an AI-writing detector and does not prove the text is original or plagiarism-free.',
  'Overlap figures describe shared wording with the searched pages; they are not a plagiarism score.',
];

export type CorpusLoader = (scope: { organizationId: string; projectId: string }, maxPages: number) => Promise<{ documents: CorpusDocument[]; pages: number; truncated: boolean }>;

/** Current version of every page in the tenant's project. Scoped by organization and project; nothing else is read. */
export const loadProjectCorpus: CorpusLoader = async (scope, maxPages) => {
  const pages = await prisma.contentPage.findMany({
    where: { organizationId: scope.organizationId, projectId: scope.projectId, currentVersionId: { not: null } },
    orderBy: { id: 'asc' },
    take: maxPages + 1,
    select: {
      id: true,
      url: true,
      websiteId: true,
      currentVersion: { select: { organizationId: true, title: true, metaDescription: true, h1: true, pageSections: { orderBy: { order: 'asc' }, select: { sectionKey: true, heading: true, text: true } } } },
    },
  });
  const truncated = pages.length > maxPages;
  const documents: CorpusDocument[] = [];
  for (const p of pages.slice(0, maxPages)) {
    const v = p.currentVersion;
    if (!v || v.organizationId !== scope.organizationId) continue; // defense in depth
    const base = { pageId: p.id, url: p.url, websiteId: p.websiteId };
    if (v.title) documents.push({ ...base, field: 'TITLE', sectionKey: null, text: v.title });
    if (v.metaDescription) documents.push({ ...base, field: 'META_DESCRIPTION', sectionKey: null, text: v.metaDescription });
    if (v.h1) documents.push({ ...base, field: 'H1', sectionKey: null, text: v.h1 });
    for (const s of v.pageSections) {
      if (s.heading) documents.push({ ...base, field: 'SECTION_HEADING', sectionKey: s.sectionKey, text: s.heading });
      if (s.text) documents.push({ ...base, field: 'SECTION_TEXT', sectionKey: s.sectionKey, text: s.text });
    }
  }
  return { documents, pages: Math.min(pages.length, maxPages), truncated };
};

/** Default checker: this project's own crawled pages, in-process. No network calls, no external provider. */
export class InternalCorpusChecker implements OriginalityChecker {
  readonly name = 'internal-corpus';
  readonly version = 'internal-ngram-v1';

  constructor(
    private readonly cfg: { match: MatchConfig; maxCorpusPages: number },
    private readonly loader: CorpusLoader = loadProjectCorpus,
  ) {}

  async check(scope: { organizationId: string; projectId: string }, input: CheckInput): Promise<CheckOutcome> {
    const corpus = await this.loader(scope, this.cfg.maxCorpusPages);
    const result = findMatches(input, corpus.documents, this.cfg.match);
    const limitations = [...INTERNAL_LIMITATIONS];
    if (corpus.truncated) limitations.push(`Only the first ${this.cfg.maxCorpusPages} pages of this project were compared.`);
    if (corpus.pages <= 1) limitations.push('This project has no other crawled pages, so there was little to compare against.');
    return { ...result, corpusPages: corpus.pages, limitations };
  }
}
