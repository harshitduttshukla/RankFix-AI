import type { CrawlStatus, PageStatus } from "@/lib/types";
import { Chip, type Tone } from "./ui";

// teal = system working · coral = needs a human · rest = settled
const CRAWL_TONE: Record<CrawlStatus, Tone> = {
  PENDING: "teal",
  RUNNING: "teal",
  COMPLETED: "rest",
  PARTIAL: "coral",
  FAILED: "coral",
  CANCELLED: "rest",
};

const PAGE_TONE: Record<PageStatus, Tone> = {
  ACTIVE: "rest",
  EXCLUDED: "rest",
  REDIRECTED: "rest",
  GONE: "coral",
  ERROR: "coral",
};

export const CrawlChip = ({ status }: { status: CrawlStatus }) => <Chip tone={CRAWL_TONE[status]}>{status.toLowerCase()}</Chip>;
export const PageStatusChip = ({ status }: { status: PageStatus }) => <Chip tone={PAGE_TONE[status]}>{status.toLowerCase()}</Chip>;

export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};
