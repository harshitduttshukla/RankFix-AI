import { env } from '../../config/env.js';

/*
 * Deterministic checks for AI rewrites of an existing section's body text (prompt section-body-v1).
 * A rewrite may change wording and structure, but not facts: every number, name and caveat in the original
 * must survive, nothing factual may be added, and the amount of change is bounded. Semantic similarity is
 * never treated as proof of correctness; these checks are explicit and conservative, and a failure means the
 * reviewer writes the text themselves.
 */

export interface BodyLimits {
  minWords: number;
  maxWords: number;
  maxParagraphs: number;
  /** Draft words must be ≥ minLengthRatio × original and ≤ max(maxLengthRatio × original, original + slack). */
  minLengthRatio: number;
  maxLengthRatio: number;
  lengthSlackWords: number;
  /** Word-level edit distance divided by the longer text; above this the draft is an unrelated rewrite. */
  maxChangeRatio: number;
  /** Share of the original's distinct content words (≥ 4 letters, not stop words) the draft must keep. */
  minTermOverlap: number;
  /** Share of the original's numbers and names the draft must keep (1 = all). */
  minFactPreservation: number;
}

export function bodyLimits(source: typeof env = env): BodyLimits {
  return {
    minWords: source.AI_BODY_MIN_WORDS,
    maxWords: source.AI_BODY_MAX_WORDS,
    maxParagraphs: source.AI_BODY_MAX_PARAGRAPHS,
    minLengthRatio: source.AI_BODY_MIN_LENGTH_RATIO,
    maxLengthRatio: source.AI_BODY_MAX_LENGTH_RATIO,
    lengthSlackWords: source.AI_BODY_LENGTH_SLACK_WORDS,
    maxChangeRatio: source.AI_BODY_MAX_CHANGE_RATIO,
    minTermOverlap: source.AI_BODY_MIN_TERM_OVERLAP,
    minFactPreservation: source.AI_BODY_MIN_FACT_PRESERVATION,
  };
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const words = (s: string) => Array.from(s.normalize('NFKC').matchAll(WORD), (m) => m[0]);
const lowerWords = (s: string) => words(s).map((w) => w.toLowerCase().replace(/’/g, "'"));

const STOP = new Set(
  'the and for with that this from your our you are was were have has had will would can could should into onto about over under than then them they their there these those which while where when what who whom also only just more most such each other both some any many much very well even being been were does done make made like within without upon between across per page site'.split(' '),
);

/** Numbers as written (digits, decimals, thousands separators), e.g. "1,200", "7.5", "24". */
export const numbersIn = (s: string) => [...new Set(Array.from(s.normalize('NFKC').matchAll(/\d+(?:[.,]\d+)*/g), (m) => m[0].replace(/,/g, '')))];

/** Capitalized tokens that don't start a sentence: product names, places, brands, systems ("Cuplock", "H-frame", "MS"). */
export function namesIn(s: string): string[] {
  const out = new Set<string>();
  const tokens = s.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*|[.!?:;\n•]/gu) ?? [];
  let start = true;
  for (const t of tokens) {
    if (/^[.!?:;\n•]$/.test(t)) {
      start = true;
      continue;
    }
    if (!start && /^\p{Lu}/u.test(t)) out.add(t.toLowerCase());
    start = false;
  }
  return [...out];
}

/** Qualifications whose removal changes meaning. If the original uses a class, the draft must too. */
export const CAVEAT_CLASSES: Record<string, RegExp> = {
  negation: /\b(?:not|no|never|cannot|can't|won't|without|none|nor)\b/i,
  condition: /\b(?:unless|if|subject to|depends? on|depending on|provided that|only when|only if|in case)\b/i,
  limitation: /\b(?:only|except|excluding|excludes|limited to|at least|at most|minimum|maximum|up to)\b/i,
  hedge: /\b(?:may|might|can vary|vary|varies|approximately|approx|around|estimated|provisional|indicative|typically|usually)\b/i,
};

/** Word-level Levenshtein distance (O(n·m) with two rows; bounded by the max word limits). */
function editDistance(a: string[], b: string[]) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const contentTerms = (s: string) => new Set(lowerWords(s).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d/.test(w)));
const round = (n: number) => Math.round(n * 1000) / 1000;

export interface BodyMetrics {
  originalWords: number;
  draftWords: number;
  /** (draft − original) / original. */
  lengthChange: number;
  /** Word-level edit distance / longer text (0 = identical, 1 = nothing shared in place). */
  changeRatio: number;
  /** Share of the original's content words kept. */
  termOverlap: number;
  /** Share of the original's numbers and names kept (1 when there are none). */
  factPreservation: number;
  paragraphs: number;
}

export function bodyMetrics(original: string, draft: string): BodyMetrics {
  const ow = lowerWords(original);
  const dw = lowerWords(draft);
  const terms = contentTerms(original);
  const draftTerms = contentTerms(draft);
  const kept = [...terms].filter((t) => draftTerms.has(t)).length;
  const facts = [...numbersIn(original), ...namesIn(original)];
  const draftLower = ` ${lowerWords(draft).join(' ')} `;
  const draftNums = new Set(numbersIn(draft));
  const factsKept = facts.filter((f) => (/^\d/.test(f) ? draftNums.has(f) : draftLower.includes(` ${f.toLowerCase()} `))).length;
  return {
    originalWords: ow.length,
    draftWords: dw.length,
    lengthChange: ow.length ? round((dw.length - ow.length) / ow.length) : 0,
    changeRatio: round(editDistance(ow, dw) / Math.max(ow.length, dw.length, 1)),
    termOverlap: terms.size ? round(kept / terms.size) : 1,
    factPreservation: facts.length ? round(factsKept / facts.length) : 1,
    paragraphs: draft.split(/\n\s*\n/).filter((p) => p.trim()).length,
  };
}

export interface BodyCheck {
  issues: string[];
  metrics: BodyMetrics;
}

/**
 * Fact-preservation and change-bound checks for a body rewrite of `original`. `pageText` is the verified page
 * evidence (the page's own text) a draft may additionally draw names from; numbers must come from the section.
 */
export function checkSectionBody(original: string, draft: string, pageText: string, limits = bodyLimits()): BodyCheck {
  const metrics = bodyMetrics(original, draft);
  const issues: string[] = [];
  const text = draft.trim();
  if (!text) return { issues: ['draft is empty'], metrics };
  if (!original.trim()) return { issues: ['the section has no text to rewrite'], metrics };

  // Shape and size.
  if (/<[a-z/!][^>]*>|\]\(|https?:\/\/|^#{1,6}\s|\*\*|__/im.test(text)) issues.push('draft must be plain text (no HTML, Markdown or links)');
  if (metrics.draftWords < limits.minWords) issues.push(`draft has ${metrics.draftWords} words; the minimum is ${limits.minWords}`);
  if (metrics.draftWords > limits.maxWords) issues.push(`draft has ${metrics.draftWords} words; the maximum is ${limits.maxWords}`);
  if (metrics.paragraphs > limits.maxParagraphs) issues.push(`draft has ${metrics.paragraphs} paragraphs; the maximum is ${limits.maxParagraphs}`);
  // The slack only lets short sections grow a little (a ratio alone would allow almost nothing); it never loosens the ratio for longer text.
  const low = Math.floor(metrics.originalWords * limits.minLengthRatio);
  const high = Math.max(Math.ceil(metrics.originalWords * limits.maxLengthRatio), metrics.originalWords + limits.lengthSlackWords);
  if (metrics.draftWords < low) issues.push(`draft is too much shorter than the original (${metrics.draftWords} vs ${metrics.originalWords} words; at least ${low})`);
  if (metrics.draftWords > high) issues.push(`draft expands the original too much (${metrics.draftWords} vs ${metrics.originalWords} words; at most ${high})`);

  // Unrelated rewrites.
  if (metrics.changeRatio > limits.maxChangeRatio) issues.push(`draft changes too much of the original (change ratio ${metrics.changeRatio} > ${limits.maxChangeRatio})`);
  if (metrics.termOverlap < limits.minTermOverlap) issues.push(`draft keeps too few of the original's key terms (${Math.round(metrics.termOverlap * 100)}% < ${Math.round(limits.minTermOverlap * 100)}%)`);

  // Material facts kept.
  const draftNums = new Set(numbersIn(text));
  const draftLower = ` ${lowerWords(text).join(' ')} `;
  const lostNumbers = numbersIn(original).filter((n) => !draftNums.has(n));
  const lostNames = namesIn(original).filter((n) => !draftLower.includes(` ${n} `));
  if (metrics.factPreservation < limits.minFactPreservation) {
    if (lostNumbers.length) issues.push(`draft drops or changes material numbers: ${lostNumbers.slice(0, 5).join(', ')}`);
    if (lostNames.length) issues.push(`draft drops material names: ${lostNames.slice(0, 5).join(', ')}`);
  }
  for (const [name, re] of Object.entries(CAVEAT_CLASSES)) {
    if (re.test(original) && !re.test(text)) issues.push(`draft removes a ${name} caveat from the original (e.g. "${original.match(re)![0]}")`);
  }

  // Nothing factual added: numbers must come from this section; names from this section or the page.
  const origNums = new Set(numbersIn(original));
  const addedNumbers = [...draftNums].filter((n) => !origNums.has(n));
  if (addedNumbers.length) issues.push(`draft adds numbers not in the section: ${addedNumbers.slice(0, 5).join(', ')}`);
  const pageLower = ` ${lowerWords(`${original} ${pageText}`).join(' ')} `;
  const addedNames = namesIn(text).filter((n) => !pageLower.includes(` ${n} `));
  if (addedNames.length) issues.push(`draft adds names not on the page: ${addedNames.slice(0, 5).join(', ')}`);

  return { issues, metrics };
}
