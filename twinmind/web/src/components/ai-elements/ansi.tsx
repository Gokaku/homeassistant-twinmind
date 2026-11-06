import type { CSSProperties, ReactNode } from "react";

/**
 * Twinmind: a small ANSI SGR renderer (colors, bold, dim, italic, underline) used instead of
 * ansi-to-react, whose linkify-it dependency has a quadratic-time DoS on crafted text.
 * Other escape sequences are dropped. Output is plain text nodes only (no HTML).
 */
const COLORS = ["#3f3f46", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#e879f9", "#22d3ee", "#e4e4e7"];
const BRIGHT = ["#71717a", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#f0abfc", "#67e8f9", "#ffffff"];

// SGR sequences, and any other CSI / OSC sequence (removed).
const ESC = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function Ansi({ children }: { children: string }) {
  const out: ReactNode[] = [];
  let style: CSSProperties = {};
  let last = 0;
  let key = 0;
  const push = (text: string) => {
    if (!text) return;
    out.push(Object.keys(style).length ? <span key={key++} style={style}>{text}</span> : text);
  };
  for (const m of children.matchAll(ESC)) {
    push(children.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] === undefined) continue; // non-color escape: drop
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    const next: CSSProperties = { ...style };
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.keys(next).forEach((k) => delete (next as any)[k]);
      else if (c === 1) next.fontWeight = 700;
      else if (c === 2) next.opacity = 0.7;
      else if (c === 3) next.fontStyle = "italic";
      else if (c === 4) next.textDecoration = "underline";
      else if (c === 22) delete next.fontWeight, delete next.opacity;
      else if (c === 39) delete next.color;
      else if (c >= 30 && c <= 37) next.color = COLORS[c - 30];
      else if (c >= 90 && c <= 97) next.color = BRIGHT[c - 90];
      else if (c === 38 && codes[i + 1] === 5) i += 2; // 256-color: ignore
      else if (c === 38 && codes[i + 1] === 2) i += 4; // truecolor: ignore
    }
    style = next;
  }
  push(children.slice(last));
  return <>{out}</>;
}
