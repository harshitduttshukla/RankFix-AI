"use client";

import { useEffect } from "react";

/**
 * Lightweight scroll reveal for elements marked `data-reveal`. Content is fully visible without JavaScript;
 * the `lp-js` class opts into the transition, and prefers-reduced-motion disables it in CSS.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const root = document.querySelector(".lp-root");
    if (!root || !("IntersectionObserver" in window)) return;
    root.classList.add("lp-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-shown", "");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    root.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
