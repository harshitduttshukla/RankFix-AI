export const fmtInt = (n: number) => n.toLocaleString();
export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const fmtPos = (n: number | null) => (n == null ? "—" : n.toFixed(1));
export const fmtDateTime = (s: string | null) => (s ? new Date(s).toLocaleString() : "Never");
