/**
 * Vector import helpers: SVG text + PDF path extraction (Inkscape/cairo-style).
 * PDF/SVG physical sizes → mmPerPx so print-scale and Inkscape mm drawings persist.
 */

import { lengthToMm, MM_PER_PT } from "./units";

export type ImportedSeg = {
  point: { x: number; y: number };
  handleIn: { x: number; y: number };
  handleOut: { x: number; y: number };
};

export type ImportedPath = {
  closed: boolean;
  segments: ImportedSeg[];
  /** Extra closed rings (holes) for even-odd fills — e.g. stamp rim annulus. */
  holes?: ImportedSeg[][];
  /** Stroke RGB 0–1 when known (PDF import / our export). */
  strokeRgb?: [number, number, number];
  /** True when the path was filled (or fill+stroke). */
  filled?: boolean;
  /** Stroke width in PDF points when known. */
  strokePt?: number;
  /** Classified stamp role (set by our PDF round-trip / color heuristic). */
  role?: "cutter" | "feature";
  raised?: boolean;
  widthMm?: number;
  /** Raised plate-edge rim — visual only; rebuilt from StampOutline on import. */
  stampRim?: boolean;
  /**
   * Drawn stamp-outline curve (outer edge of the raised rim).
   * The cutter is rebuilt around it on import; old PDFs omit this.
   */
  stampPlate?: boolean;
};

/** Raised stamp red / recessed stamp blue used in our PDF export. */
export const STAMP_RAISE_RGB: [number, number, number] = [0.498, 0.114, 0.114];
export const STAMP_RECESS_RGB: [number, number, number] = [0.118, 0.227, 0.541];
/**
 * Raised rim annulus along the stamp plate edge.
 * Distinct from feature red so import can skip it (rim is rebuilt from
 * /StampOutline metadata) while Inkscape still shows a red fill.
 */
export const STAMP_RIM_RGB: [number, number, number] = [0.62, 0.16, 0.16];
/**
 * Authoritative stamp-outline curve (stamp drawn first).
 * Far from black, feature red, and rim red so older PDFs stay cutters.
 */
export const STAMP_PLATE_RGB: [number, number, number] = [0.05, 0.42, 0.38];

function colorDist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.hypot(dr, dg, db);
}

/** Classify a stroke color: reds → raised, blues → recessed, else cutter. */
export function classifyStampColor(
  rgb: [number, number, number] | undefined,
): {
  role: "cutter" | "feature";
  raised: boolean;
  stampRim?: boolean;
  stampPlate?: boolean;
} {
  if (!rgb) return { role: "cutter", raised: true };
  const [r, g, b] = rgb;
  // Exact / near matches for our own export colors first
  if (colorDist(rgb, STAMP_PLATE_RGB) < 0.08) {
    return { role: "cutter", raised: true, stampPlate: true };
  }
  if (colorDist(rgb, STAMP_RIM_RGB) < 0.12) {
    return { role: "feature", raised: true, stampRim: true };
  }
  if (colorDist(rgb, STAMP_RAISE_RGB) < 0.18) {
    return { role: "feature", raised: true };
  }
  if (colorDist(rgb, STAMP_RECESS_RGB) < 0.18) {
    return { role: "feature", raised: false };
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max < 1e-6 ? 0 : (max - min) / max;
  // Near-black / near-gray → cutter
  if (sat < 0.18 || max < 0.2) return { role: "cutter", raised: true };
  // Pure-ish reds (low green) → raised stamp
  if (r > b + 0.1 && r > g + 0.15 && g < 0.35) {
    return { role: "feature", raised: true };
  }
  // Blues → recessed stamp
  if (b > r + 0.08 && b >= g * 0.75) {
    return { role: "feature", raised: false };
  }
  return { role: "cutter", raised: true };
}

export function isVectorFile(file: File): boolean {
  const t = file.type;
  if (t === "image/svg+xml" || t === "application/pdf") return true;
  const n = file.name.toLowerCase();
  return n.endsWith(".svg") || n.endsWith(".pdf");
}

export function isRasterImageFile(file: File): boolean {
  if (isVectorFile(file)) return false;
  return file.type.startsWith("image/");
}

async function inflateAsync(payload: Uint8Array): Promise<string | null> {
  try {
    const tryFormat = async (format: CompressionFormat) => {
      const ds = new DecompressionStream(format);
      const stream = new Blob([payload as BlobPart]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new TextDecoder("latin1").decode(buf);
    };
    try {
      return await tryFormat("deflate");
    } catch {
      return await tryFormat("deflate-raw");
    }
  } catch {
    return null;
  }
}

async function pdfContentStreamsAsync(data: Uint8Array): Promise<string[]> {
  const text = new TextDecoder("latin1").decode(data);
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const payloadStart = m.index + m[0].length;
    const endTag = text.indexOf("endstream", payloadStart);
    if (endTag < 0) continue;
    let payloadEnd = endTag;
    if (text[payloadEnd - 1] === "\n") payloadEnd--;
    if (text[payloadEnd - 1] === "\r") payloadEnd--;
    const payload = data.subarray(payloadStart, payloadEnd);
    const dictStart = text.lastIndexOf("<<", m.index);
    const dictSlice = dictStart >= 0 ? text.slice(dictStart, m.index) : "";
    const looksFlate = /FlateDecode/.test(dictSlice) || payload[0] === 0x78;
    if (looksFlate) {
      const decoded = await inflateAsync(payload);
      if (decoded) out.push(decoded);
      continue;
    }
    const plain = new TextDecoder("latin1").decode(payload);
    if (/ [mlcvh] |^[mlcvh] |\s[mlcvh]\s/.test(plain)) out.push(plain);
  }
  return out;
}

type Pt = { x: number; y: number };
type M = [number, number, number, number, number, number];

type PathBuild = {
  segs: ImportedSeg[];
  closed: boolean;
  cur: Pt | null;
  start: Pt | null;
};

function emptySeg(p: Pt): ImportedSeg {
  return {
    point: { ...p },
    handleIn: { x: 0, y: 0 },
    handleOut: { x: 0, y: 0 },
  };
}

function parsePdfContent(content: string): ImportedPath[] {
  const tokens: (number | string)[] = [];
  const re =
    /([+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)|\/[A-Za-z0-9]+|[A-Za-z*]+|\[|\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] != null) tokens.push(parseFloat(m[1]));
    else tokens.push(m[0]);
  }

  const results: ImportedPath[] = [];
  let build: PathBuild = { segs: [], closed: false, cur: null, start: null };
  /** Completed subpaths waiting for a paint op (supports even-odd holes). */
  let rings: { segs: ImportedSeg[]; closed: boolean }[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let strokeRgb: [number, number, number] = [0, 0, 0];
  let strokePt = 1;
  const gStateStack: { strokeRgb: [number, number, number]; strokePt: number }[] =
    [];

  const apply = (p: Pt): Pt => ({
    x: ctm[0] * p.x + ctm[2] * p.y + ctm[4],
    y: ctm[1] * p.x + ctm[3] * p.y + ctm[5],
  });

  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  const cloneSegs = (segs: ImportedSeg[]) =>
    segs.map((s) => ({
      point: { ...s.point },
      handleIn: { ...s.handleIn },
      handleOut: { ...s.handleOut },
    }));

  const pushRing = () => {
    if (build.segs.length < 2) return;
    rings.push({
      segs: cloneSegs(build.segs),
      closed: build.closed,
    });
    build = { segs: [], closed: false, cur: null, start: null };
  };

  const flush = (closed: boolean, filled: boolean) => {
    pushRing();
    if (!rings.length) {
      build = { segs: [], closed: false, cur: null, start: null };
      return;
    }
    const outer = rings[0];
    const holeRings = rings.slice(1).filter((r) => r.segs.length >= 2);
    const cls = classifyStampColor(strokeRgb);
    const isRim =
      !!cls.stampRim ||
      (filled && holeRings.length > 0 && cls.role === "feature" && cls.raised);
    results.push({
      closed: closed || outer.closed,
      segments: outer.segs,
      holes:
        holeRings.length > 0
          ? holeRings.map((r) => r.segs)
          : undefined,
      strokeRgb: [...strokeRgb] as [number, number, number],
      filled,
      strokePt,
      role: cls.role,
      raised: cls.raised,
      stampRim: isRim || undefined,
      stampPlate: cls.stampPlate || undefined,
    });
    rings = [];
    build = { segs: [], closed: false, cur: null, start: null };
  };

  const nums: number[] = [];
  for (const tok of tokens) {
    if (typeof tok === "number") {
      nums.push(tok);
      continue;
    }
    const op = tok;
    const need = (n: number) => {
      if (nums.length < n) return null;
      return nums.splice(nums.length - n, n);
    };

    if (op === "q") {
      stack.push([...ctm] as M);
      gStateStack.push({ strokeRgb: [...strokeRgb] as [number, number, number], strokePt });
      nums.length = 0;
    } else if (op === "Q") {
      const prev = stack.pop();
      if (prev) ctm = prev;
      const gs = gStateStack.pop();
      if (gs) {
        strokeRgb = gs.strokeRgb;
        strokePt = gs.strokePt;
      }
      nums.length = 0;
    } else if (op === "cm") {
      const a = need(6);
      if (a) ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    } else if (op === "RG" || op === "rg") {
      const a = need(3);
      if (a) strokeRgb = [a[0], a[1], a[2]];
    } else if (op === "G" || op === "g") {
      const a = need(1);
      if (a) strokeRgb = [a[0], a[0], a[0]];
    } else if (op === "w") {
      const a = need(1);
      if (a) strokePt = Math.max(0.05, a[0]);
    } else if (op === "m") {
      const a = need(2);
      if (!a) continue;
      const p = apply({ x: a[0], y: a[1] });
      // New subpath — park the prior ring (outer/hole) until paint
      if (build.segs.length >= 2) pushRing();
      build.segs = [emptySeg(p)];
      build.cur = p;
      build.start = p;
      build.closed = false;
    } else if (op === "l") {
      const a = need(2);
      if (!a || !build.cur) continue;
      const p = apply({ x: a[0], y: a[1] });
      build.segs.push(emptySeg(p));
      build.cur = p;
    } else if (op === "c") {
      const a = need(6);
      if (!a || !build.cur) continue;
      const c1 = apply({ x: a[0], y: a[1] });
      const c2 = apply({ x: a[2], y: a[3] });
      const p = apply({ x: a[4], y: a[5] });
      const prev = build.segs[build.segs.length - 1];
      prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
      const seg = emptySeg(p);
      seg.handleIn = { x: c2.x - p.x, y: c2.y - p.y };
      build.segs.push(seg);
      build.cur = p;
    } else if (op === "v") {
      const a = need(4);
      if (!a || !build.cur) continue;
      const c1 = { ...build.cur };
      const c2 = apply({ x: a[0], y: a[1] });
      const p = apply({ x: a[2], y: a[3] });
      const prev = build.segs[build.segs.length - 1];
      prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
      const seg = emptySeg(p);
      seg.handleIn = { x: c2.x - p.x, y: c2.y - p.y };
      build.segs.push(seg);
      build.cur = p;
    } else if (op === "y") {
      const a = need(4);
      if (!a || !build.cur) continue;
      const c1 = apply({ x: a[0], y: a[1] });
      const p = apply({ x: a[2], y: a[3] });
      const prev = build.segs[build.segs.length - 1];
      prev.handleOut = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
      const seg = emptySeg(p);
      seg.handleIn = { x: 0, y: 0 };
      build.segs.push(seg);
      build.cur = p;
    } else if (op === "re") {
      const a = need(4);
      if (!a) continue;
      if (build.segs.length >= 2) pushRing();
      const [x, y, w, h] = a;
      const pts = [
        apply({ x, y }),
        apply({ x: x + w, y }),
        apply({ x: x + w, y: y + h }),
        apply({ x, y: y + h }),
      ];
      build.segs = pts.map(emptySeg);
      build.closed = true;
      build.cur = pts[0];
      build.start = pts[0];
    } else if (op === "h") {
      // Close subpath; Paper uses path.closed — don't duplicate the start point
      build.closed = true;
    } else if (
      op === "S" ||
      op === "s" ||
      op === "f" ||
      op === "f*" ||
      op === "F" ||
      op === "B" ||
      op === "B*" ||
      op === "b" ||
      op === "b*"
    ) {
      const paintClosed =
        build.closed ||
        rings.some((r) => r.closed) ||
        op === "s" ||
        op === "f" ||
        op === "f*" ||
        op === "F" ||
        op === "B" ||
        op === "B*" ||
        op === "b" ||
        op === "b*";
      const filled =
        op === "f" ||
        op === "f*" ||
        op === "F" ||
        op === "B" ||
        op === "B*" ||
        op === "b" ||
        op === "b*";
      flush(paintClosed, filled);
    } else if (op === "n") {
      rings = [];
      build = { segs: [], closed: false, cur: null, start: null };
      nums.length = 0;
    } else {
      nums.length = 0;
    }
  }
  if (build.segs.length >= 2) flush(build.closed, false);
  return results;
}

function pdfProducer(data: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(/\/Producer\s*\(([^)]*)\)/);
  return m ? m[1] : null;
}

/** Scale stored by our exporter in the Info dict (`/MmPerPx …`). */
export function pdfMmPerPx(data: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(/\/MmPerPx\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function pdfIsTrueScale(data: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(data);
  return /\/TrueScale\s+true\b/i.test(text);
}

export type SvgPhysicalSize = {
  widthMm: number | null;
  heightMm: number | null;
  viewBox: { x: number; y: number; w: number; h: number } | null;
};

function parseViewBoxAttr(vb: string | null): SvgPhysicalSize["viewBox"] {
  if (!vb) return null;
  const parts = vb.trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }
  return null;
}

/** Read declared physical size from an SVG root (Inkscape mm drawings, etc.). */
export function parseSvgPhysicalSize(svgText: string): SvgPhysicalSize {
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const root = doc.documentElement;
      if (root && root.tagName.toLowerCase() === "svg") {
        return {
          widthMm: root.getAttribute("width")
            ? lengthToMm(root.getAttribute("width")!)
            : null,
          heightMm: root.getAttribute("height")
            ? lengthToMm(root.getAttribute("height")!)
            : null,
          viewBox: parseViewBoxAttr(root.getAttribute("viewBox")),
        };
      }
    } catch {
      /* fall through to regex */
    }
  }
  const width = svgText.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1];
  const height = svgText.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1];
  const vb = svgText.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  return {
    widthMm: width ? lengthToMm(width) : null,
    heightMm: height ? lengthToMm(height) : null,
    viewBox: parseViewBoxAttr(vb ?? null),
  };
}

/**
 * mm per imported paper unit from SVG physical size vs path bounds
 * (or viewBox if bounds are unavailable).
 */
export function mmPerPxFromSvg(
  svgText: string,
  bounds: { width: number; height: number } | null,
): number | null {
  const { widthMm, heightMm, viewBox } = parseSvgPhysicalSize(svgText);
  if (bounds && bounds.width > 1e-6 && widthMm != null && widthMm > 0) {
    return widthMm / bounds.width;
  }
  if (bounds && bounds.height > 1e-6 && heightMm != null && heightMm > 0) {
    return heightMm / bounds.height;
  }
  // Fallback: viewBox user unit = mm when width is in mm and matches viewBox
  if (viewBox && widthMm != null && widthMm > 0) {
    return widthMm / viewBox.w;
  }
  if (viewBox && heightMm != null && heightMm > 0) {
    return heightMm / viewBox.h;
  }
  return null;
}

function pdfMediaBoxHeight(data: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(
    /\/MediaBox\s*\[\s*([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s*\]/,
  );
  if (!m) return null;
  const h = parseFloat(m[4]);
  return Number.isFinite(h) ? h : null;
}

/** Undo Inkscape-style Y-flip CTM for files we exported (Producer = Pernickovadlo). */
function unflipOurPdfPaths(paths: ImportedPath[], pageH: number): ImportedPath[] {
  return paths.map((p) => ({
    ...p,
    segments: p.segments.map((s) => ({
      point: { x: s.point.x, y: pageH - s.point.y },
      handleIn: { x: s.handleIn.x, y: -s.handleIn.y },
      handleOut: { x: s.handleOut.x, y: -s.handleOut.y },
    })),
  }));
}

/** Closed paths often repeat the start point before `h` — merge handles and drop it. */
function dedupeClosedEnds(paths: ImportedPath[]): ImportedPath[] {
  return paths.map((p) => {
    if (!p.closed || p.segments.length < 3) return p;
    const first = p.segments[0];
    const last = p.segments[p.segments.length - 1];
    const d = Math.hypot(first.point.x - last.point.x, first.point.y - last.point.y);
    if (d > 1e-3) return p;
    const segs = p.segments.slice(0, -1);
    segs[0] = {
      ...segs[0],
      handleIn: { ...last.handleIn },
    };
    return { ...p, closed: true, segments: segs };
  });
}

export type PdfBackground = {
  /** JPEG bytes embedded by our exporter. */
  jpeg: Uint8Array;
  /** Placement in the same coordinate space as imported path points. */
  rect: { x: number; y: number; width: number; height: number } | null;
};

export type PdfImportResult = {
  paths: ImportedPath[];
  /**
   * Paper → mm for imported coordinates.
   * True-scale / Inkscape PDFs use PDF points → {@link MM_PER_PT}.
   * Legacy Perníčkovadlo saves (pre-TrueScale) restore `/MmPerPx`.
   */
  mmPerPx: number | null;
  /** Raster from our PDFs that embedded a background image. */
  background: PdfBackground | null;
  /** Fit gap from `/StampGapMm` when present. */
  stampGapMm: number | null;
  /** Raised outline from `/StampOutline` when present. */
  stampOutlineEnabled: boolean | null;
  /** Outline rim width from `/StampOutlineWidthMm` when present. */
  stampOutlineWidthMm: number | null;
};

/** `/StampGapMm` written by our exporter. */
export function pdfStampGapMm(data: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(
    /\/StampGapMm\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/,
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `/StampOutline true|false` written by our exporter. */
export function pdfStampOutlineEnabled(data: Uint8Array): boolean | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(/\/StampOutline\s+(true|false)/i);
  if (!m) return null;
  return m[1].toLowerCase() === "true";
}

/** `/StampOutlineWidthMm` written by our exporter. */
export function pdfStampOutlineWidthMm(data: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(
    /\/StampOutlineWidthMm\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/,
  );
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `/BgRect [x y w h]` written by our exporter (content space = post-unflip paths). */
function pdfBgRect(
  data: Uint8Array,
): { x: number; y: number; width: number; height: number } | null {
  const text = new TextDecoder("latin1").decode(data);
  const m = text.match(
    /\/BgRect\s*\[\s*([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s+([+-]?\d*\.?\d+)\s*\]/,
  );
  if (!m) return null;
  const x = parseFloat(m[1]);
  const y = parseFloat(m[2]);
  const width = parseFloat(m[3]);
  const height = parseFloat(m[4]);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/** First DCTDecode Image XObject in a Perníčkovadlo PDF. */
function pdfEmbeddedJpeg(data: Uint8Array): Uint8Array | null {
  const text = new TextDecoder("latin1").decode(data);
  let from = 0;
  while (from < text.length) {
    const dct = text.indexOf("/DCTDecode", from);
    if (dct < 0) break;
    const dictStart = text.lastIndexOf("<<", dct);
    const streamWord = text.indexOf("stream", dct);
    if (dictStart < 0 || streamWord < 0) {
      from = dct + 1;
      continue;
    }
    const dict = text.slice(dictStart, streamWord);
    if (!/\/Subtype\s*\/Image/.test(dict)) {
      from = dct + 1;
      continue;
    }
    let payloadStart = streamWord + "stream".length;
    if (text[payloadStart] === "\r") payloadStart++;
    if (text[payloadStart] === "\n") payloadStart++;
    const endTag = text.indexOf("endstream", payloadStart);
    if (endTag < 0) break;
    let payloadEnd = endTag;
    if (text[payloadEnd - 1] === "\n") payloadEnd--;
    if (text[payloadEnd - 1] === "\r") payloadEnd--;
    const jpeg = data.subarray(payloadStart, payloadEnd);
    // JPEG SOI
    if (jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
      return jpeg.slice();
    }
    from = dct + 1;
  }
  return null;
}

/** Extract vector paths from a PDF (stroke/fill path operators). */
export async function pathsFromPdf(data: Uint8Array): Promise<PdfImportResult> {
  const streams = await pdfContentStreamsAsync(data);
  const all: ImportedPath[] = [];
  for (const s of streams) {
    if (s.length > 50_000 && !/\s[mlc]\s/.test(s)) continue;
    all.push(...parsePdfContent(s));
  }
  let paths = dedupeClosedEnds(all.filter((p) => p.segments.length >= 2));
  const producer = pdfProducer(data);
  const pageH = pdfMediaBoxHeight(data);
  const ours = !!producer?.includes("Pernickovadlo");
  const trueScale = pdfIsTrueScale(data);
  // Our exporter writes top-down content under a Y-flip CTM (viewer-upright).
  // After the CTM is applied on import, undo that flip so Paper coords match.
  if (ours && pageH != null && paths.length) {
    paths = unflipOurPdfPaths(paths, pageH);
  }

  let mmPerPx: number | null = null;
  if (trueScale || !ours) {
    // Coordinates are PDF points (1 pt = 1/72″) — print / Inkscape size.
    mmPerPx = MM_PER_PT;
  } else {
    // Legacy app PDFs: paper units + explicit MmPerPx
    mmPerPx = pdfMmPerPx(data);
  }

  let background: PdfBackground | null = null;
  if (ours) {
    const jpeg = pdfEmbeddedJpeg(data);
    if (jpeg) {
      background = { jpeg, rect: pdfBgRect(data) };
    }
  }

  // Derive widthMm for features from stroke width in PDF points
  for (const p of paths) {
    if (p.role === "feature" && p.strokePt != null && mmPerPx != null && mmPerPx > 0) {
      // strokePt is already in PDF points (= physical). 1 pt = MM_PER_PT mm.
      p.widthMm = Math.max(0.3, p.strokePt * MM_PER_PT);
    }
  }

  return {
    paths,
    mmPerPx,
    background,
    stampGapMm: pdfStampGapMm(data),
    stampOutlineEnabled: pdfStampOutlineEnabled(data),
    stampOutlineWidthMm: pdfStampOutlineWidthMm(data),
  };
}

export async function pathsFromPdfFile(file: File): Promise<PdfImportResult> {
  const buf = await file.arrayBuffer();
  return pathsFromPdf(new Uint8Array(buf));
}

export async function svgTextFromFile(file: File): Promise<string> {
  return file.text();
}
