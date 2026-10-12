import { ImageResponse } from "next/og";

export const alt = "RankFix AI — Find SEO Opportunities. Fix What Matters.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Social preview card: brand mark, product name and tagline. No claims or metrics. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: "#f7f6f2", color: "#14151b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "#3a4af0", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 7, padding: 14 }}>
            <div style={{ width: 9, height: 16, borderRadius: 3, background: "rgba(255,255,255,0.55)" }} />
            <div style={{ width: 9, height: 26, borderRadius: 3, background: "rgba(255,255,255,0.8)" }} />
            <div style={{ width: 9, height: 34, borderRadius: 3, background: "#fff" }} />
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
            RankFix <span style={{ color: "#3a4af0", marginLeft: 10 }}>AI</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -3, lineHeight: 1.02 }}>Find SEO Opportunities. Fix What Matters.</div>
          <div style={{ fontSize: 30, color: "#4a4d58" }}>Search Console evidence · grounded AI drafts · human-approved changes</div>
        </div>
      </div>
    ),
    size,
  );
}
