const DAY = 86_400_000;

/** UTC midnight for a YYYY-MM-DD string or a Date. */
export function utcDay(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(`${input}T00:00:00Z`) : input;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

/** GSC data is typically final ~3 days after the fact. */
export const GSC_LAG_DAYS = 3;
export const latestFinalGscDate = (now = new Date()) => addDays(utcDay(now), -GSC_LAG_DAYS);
