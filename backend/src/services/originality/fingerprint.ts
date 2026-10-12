import type { CheckInput, CheckOutcome, CorpusDocument, MatchSeverity, OriginalityMatch } from './originality.types.js';

/*
 * Deterministic verbatim / near-verbatim matching with word n-gram fingerprints.
 *
 * 1. Normalize and tokenize (NFKC, case-folded, punctuation and formatting ignored), keeping character offsets.
 * 2. Fingerprint the checked text with word n-grams (n = minMatchWords) and scan each corpus field for them.
 * 3. Drop common phrases: n-grams found on many distinct pages are boilerplate or terminology, not copying.
 * 4. Join consecutive n-gram hits into verbatim runs; join runs separated by small edits into near-verbatim matches.
 * 5. A whole short field identical to a whole corpus field is a duplicate even below n words.
 * 6. Deduplicate overlapping matches across sources, then grade severity and explain each match.
 */

export interface MatchConfig {
  minMatchWords: number;
  significantRunWords: number;
  significantCoverage: number;
  commonPhraseMinPages: number;
  commonPhraseRatio: number;
  /** Max words skipped (on either side) when joining runs into a near-verbatim match. */
  maxGapWords: number;
}

interface Token {
  w: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.normalize('NFKC').matchAll(WORD)) {
    out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Whitespace/punctuation/case-insensitive form, used for hashing and staleness comparison. */
export const normalizeForMatch = (text: string) => tokenize(text).map((t) => t.w).join(' ');

const gram = (t: Token[], i: number, n: number) => t.slice(i, i + n).map((x) => x.w).join(' ');

interface Run {
  dStart: number; // token index in checked text (inclusive)
  dEnd: number; // exclusive
  sStart: number;
  sEnd: number;
  matched: number; // tokens actually matched (excludes gaps)
  longest: number;
  joined: boolean;
}

/** Quotation marks around the passage, or an explicit source cue just before it. */
function isAttributed(text: string, start: number, end: number) {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 3);
  if (/["“«']\s*$/.test(before) && /^\s*[.,;:!?]?["”»']/.test(after)) return true;
  return /\b(?:according to|as stated (?:by|in|on)|source:|quoted from|via)\b[^.!?]{0,60}$/i.test(text.slice(Math.max(0, start - 80), start));
}

const FIELD_LABEL = { TITLE: 'title', META_DESCRIPTION: 'meta description', H1: 'H1', SECTION_HEADING: 'section heading', SECTION_TEXT: 'section text' } as const;

export function findMatches(input: CheckInput, docs: CorpusDocument[], cfg: MatchConfig): Omit<CheckOutcome, 'limitations' | 'corpusPages'> {
  const text = input.text;
  const tokens = tokenize(text);
  const n = cfg.minMatchWords;
  if (!tokens.length) return { assessment: 'NO_MATCHES', overlapRatio: 0, matches: [] };

  const corpus = docs.filter((d) => !(d.pageId === input.pageId && d.field === input.replacing.field && (d.sectionKey ?? null) === (input.replacing.sectionKey ?? null)));
  const pageCount = new Set(corpus.map((d) => d.pageId)).size;

  // Fingerprints of the checked text: n-gram → positions.
  const grams = new Map<string, number[]>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const g = gram(tokens, i, n);
    grams.set(g, [...(grams.get(g) ?? []), i]);
  }

  // Scan the corpus once; remember hits per document and on how many distinct pages each n-gram occurs.
  const docTokens = new Map<CorpusDocument, Token[]>();
  const hits = new Map<CorpusDocument, { d: number; s: number }[]>();
  const pagesWith = new Map<string, Set<string>>();
  for (const doc of corpus) {
    const st = tokenize(doc.text);
    docTokens.set(doc, st);
    for (let j = 0; j + n <= st.length; j++) {
      const g = gram(st, j, n);
      const at = grams.get(g);
      if (!at) continue;
      if (!pagesWith.has(g)) pagesWith.set(g, new Set());
      pagesWith.get(g)!.add(doc.pageId);
      const list = hits.get(doc) ?? [];
      for (const d of at) list.push({ d, s: j });
      hits.set(doc, list);
    }
  }
  const commonThreshold = Math.max(cfg.commonPhraseMinPages, Math.ceil(cfg.commonPhraseRatio * pageCount));
  const isCommon = (g: string) => (pagesWith.get(g)?.size ?? 0) >= commonThreshold;

  const raw: { doc: CorpusDocument; run: Run }[] = [];
  for (const [doc, list] of hits) {
    const pairs = list.filter((h) => !isCommon(gram(tokens, h.d, n))).sort((a, b) => a.d - b.d || a.s - b.s);
    // Verbatim runs: consecutive n-gram hits on both sides.
    const runs: Run[] = [];
    for (const h of pairs) {
      const r = runs.find((x) => x.dEnd - n + 1 === h.d && x.sEnd - n + 1 === h.s);
      if (r) {
        r.dEnd++;
        r.sEnd++;
        r.matched++;
        r.longest = r.matched;
      } else {
        runs.push({ dStart: h.d, dEnd: h.d + n, sStart: h.s, sEnd: h.s + n, matched: n, longest: n, joined: false });
      }
    }
    // Near-verbatim: join runs in order on both sides with small gaps.
    runs.sort((a, b) => a.dStart - b.dStart);
    const joined: Run[] = [];
    for (const r of runs) {
      const prev = joined.at(-1);
      if (prev && r.sStart >= prev.sStart && r.dStart - prev.dEnd <= cfg.maxGapWords && r.sStart - prev.sEnd <= cfg.maxGapWords) {
        // Joined across a small edit (or overlapping): count only newly covered words as matched.
        const gap = r.dStart > prev.dEnd || r.sStart > prev.sEnd;
        prev.matched += Math.max(0, r.dEnd - Math.max(prev.dEnd, r.dStart));
        prev.longest = Math.max(prev.longest, r.longest);
        prev.dEnd = Math.max(prev.dEnd, r.dEnd);
        prev.sEnd = Math.max(prev.sEnd, r.sEnd);
        prev.joined ||= gap;
      } else if (prev && r.dStart < prev.dEnd) {
        continue; // a different alignment of words already matched in this document
      } else {
        joined.push({ ...r });
      }
    }
    for (const run of joined) raw.push({ doc, run });
  }

  // Whole-field duplicates (covers short titles/headings below n words). Needs at least 3 words.
  const norm = tokens.map((t) => t.w).join(' ');
  if (tokens.length >= 3) {
    for (const doc of corpus) {
      const st = docTokens.get(doc) ?? tokenize(doc.text);
      if (st.length === tokens.length && st.map((t) => t.w).join(' ') === norm) {
        raw.push({ doc, run: { dStart: 0, dEnd: tokens.length, sStart: 0, sEnd: st.length, matched: tokens.length, longest: tokens.length, joined: false } });
      }
    }
  }

  const build = (doc: CorpusDocument, run: Run): OriginalityMatch => {
    const st = docTokens.get(doc) ?? tokenize(doc.text);
    const start = tokens[run.dStart]!.start;
    const end = tokens[run.dEnd - 1]!.end;
    const sFrom = st[run.sStart]!.start;
    const sTo = st[run.sEnd - 1]!.end;
    const words = run.dEnd - run.dStart;
    const duplicate = run.dStart === 0 && run.dEnd === tokens.length && st.length === tokens.length && run.matched === tokens.length;
    const kind: OriginalityMatch['kind'] = duplicate ? 'DUPLICATE_FIELD' : run.joined ? 'NEAR_VERBATIM' : 'EXACT';
    const samePage = doc.pageId === input.pageId;
    const attributed = isAttributed(text, start, end);
    const coverage = Math.round((words / tokens.length) * 1000) / 1000;
    let severity: MatchSeverity = 'MINOR';
    if (samePage) severity = 'INFO';
    else if (attributed) severity = 'MINOR';
    else if (kind === 'DUPLICATE_FIELD' || run.longest >= cfg.significantRunWords || (coverage >= cfg.significantCoverage && words >= Math.min(n, tokens.length))) severity = 'SIGNIFICANT';
    const where = `the ${FIELD_LABEL[doc.field]} of ${samePage ? 'this same page' : doc.url}`;
    const what =
      kind === 'DUPLICATE_FIELD'
        ? `The whole text is identical to ${where}`
        : `${words} words${kind === 'NEAR_VERBATIM' ? ' (near-verbatim, with small edits)' : ' (verbatim)'} also appear in ${where}`;
    const why =
      severity === 'INFO'
        ? 'Reusing this page’s own wording is expected; shown for information only.'
        : attributed
          ? 'The passage is quoted or attributed in the text; confirm the attribution is correct.'
          : severity === 'SIGNIFICANT'
            ? `Flagged because ${kind === 'DUPLICATE_FIELD' ? 'duplicate fields across pages' : run.longest >= cfg.significantRunWords ? `a verbatim run of ${run.longest} words` : `it covers ${Math.round(coverage * 100)}% of the text`} may indicate copied or duplicated content. It may still be legitimate (a business or product name, a standard phrase, or properly attributed material).`
            : 'A short overlap; often a common phrase or shared terminology. Shown for review, not a concern on its own.';
    return {
      kind,
      severity,
      passage: text.slice(start, end),
      start,
      end,
      source: { pageId: doc.pageId, url: doc.url, field: doc.field, sectionKey: doc.sectionKey, samePage, sameWebsite: doc.websiteId === input.websiteId, excerpt: doc.text.slice(sFrom, sTo).slice(0, 300) },
      alsoFoundIn: [],
      words,
      longestRunWords: Math.min(run.longest, words),
      textCoverage: coverage,
      attributed,
      explanation: `${what}. ${why}`,
    };
  };

  // Deduplicate: strongest first; a match overlapping a kept one by more than half is folded into it.
  const rank = { SIGNIFICANT: 2, MINOR: 1, INFO: 0 } as const;
  const candidates = raw.map((r) => build(r.doc, r.run)).sort((a, b) => rank[b.severity] - rank[a.severity] || b.words - a.words || a.start - b.start);
  const kept: OriginalityMatch[] = [];
  for (const m of candidates) {
    const host = kept.find((k) => Math.min(k.end, m.end) - Math.max(k.start, m.start) > (m.end - m.start) / 2);
    if (host) {
      const known = (host.source.url === m.source.url && host.source.field === m.source.field) || host.alsoFoundIn.some((x) => x.url === m.source.url && x.field === m.source.field);
      if (host.alsoFoundIn.length < 5 && !known) host.alsoFoundIn.push({ url: m.source.url, field: m.source.field });
    } else kept.push(m);
  }
  kept.sort((a, b) => a.start - b.start);

  const covered = new Set<number>();
  for (const m of kept) {
    if (m.severity === 'INFO') continue;
    tokens.forEach((t, i) => t.start >= m.start && t.end <= m.end && covered.add(i));
  }
  const overlapRatio = Math.round((covered.size / tokens.length) * 1000) / 1000;
  const assessment = kept.some((m) => m.severity === 'SIGNIFICANT')
    ? 'SIGNIFICANT_MATCHES'
    : kept.some((m) => m.severity === 'MINOR')
      ? 'MINOR_MATCHES'
      : kept.length
        ? 'INFORMATIONAL_MATCHES'
        : 'NO_MATCHES';
  return { assessment, overlapRatio, matches: kept.slice(0, 25) };
}
