import type { OpportunityStatus, OpportunityType } from "@/lib/types";
import { Chip, type Tone } from "./ui";

export const TYPE_LABEL: Record<OpportunityType, string> = {
  LOW_CTR: "Low CTR",
  PAGE_ONE_NEAR_TOP: "Page 1, near top",
  HIGH_IMPRESSIONS_LOW_CLICKS: "High impressions, low clicks",
  PERFORMANCE_DECLINE: "Declining",
  CONTENT_COVERAGE_SIGNAL: "Query coverage",
};

export const TYPE_HINT: Record<OpportunityType, string> = {
  LOW_CTR: "CTR is well below what is typical for the page's average position.",
  PAGE_ONE_NEAR_TOP: "The page already ranks on page one, just below the top results.",
  HIGH_IMPRESSIONS_LOW_CLICKS: "The page is shown very often in search but rarely clicked.",
  PERFORMANCE_DECLINE: "Clicks or CTR dropped compared with the previous period.",
  CONTENT_COVERAGE_SIGNAL: "An important search query's terms don't appear in the page's title or headings.",
};

// coral = needs a human decision · rest = settled
const STATUS_TONE: Partial<Record<OpportunityStatus, Tone>> = { DETECTED: "coral", REVIEWED: "coral", DISMISSED: "rest" };

export const TypeChip = ({ type }: { type: OpportunityType }) => <Chip tone="rest">{TYPE_LABEL[type]}</Chip>;
export const OpportunityStatusChip = ({ status }: { status: OpportunityStatus }) => (
  <Chip tone={STATUS_TONE[status] ?? "teal"}>{status.toLowerCase().replace(/_/g, " ")}</Chip>
);

export function Score({ value, large = false }: { value: number; large?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span className="inline-flex items-center gap-2" title={`Opportunity score ${value.toFixed(1)} / 100`}>
      <span className={`font-mono font-medium ${large ? "text-[22px]" : "text-[13px]"}`}>{Math.round(value)}</span>
      <span className={`relative h-[5px] overflow-hidden rounded-full bg-line2 ${large ? "w-24" : "w-12"}`} aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-teal" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
