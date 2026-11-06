/** PDF / typography: 1 point = 1/72 inch. */
export const PT_PER_IN = 72;
export const MM_PER_IN = 25.4;
export const PT_PER_MM = PT_PER_IN / MM_PER_IN;
export const MM_PER_PT = MM_PER_IN / PT_PER_IN;

/** CSS reference pixel (96 dpi) — browsers/Inkscape often map SVG px this way. */
export const MM_PER_PX_CSS = MM_PER_IN / 96;

/** Parse an SVG/CSS length to millimetres. Returns null if unknown. */
export function lengthToMm(raw: string): number | null {
  const m = raw
    .trim()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|cm|in|pt|pc|px|%)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const u = (m[2] || "px").toLowerCase();
  switch (u) {
    case "mm":
      return v;
    case "cm":
      return v * 10;
    case "in":
      return v * MM_PER_IN;
    case "pt":
      return v * MM_PER_PT;
    case "pc":
      return v * MM_PER_PT * 12;
    case "px":
      return v * MM_PER_PX_CSS;
    case "%":
      return null;
    default:
      return null;
  }
}
