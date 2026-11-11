/**
 * True-scale PDF writer for sketch paths.
 * Geometry is written in PDF points (1 pt = 1/72″) so print / Inkscape show
 * real millimetre size. Paper coords are converted with mmPerPx.
 * Optional background JPEG is embedded when the image is shown in the editor.
 */

import type { ImportedPath, ImportedSeg } from "./importVector";
import { saveBlob, type SaveResult } from "./saveBlob";
import { MM_PER_PT, PT_PER_MM } from "./units";

export const PDF_PRODUCER = "Pernickovadlo";
/** Info flag: coordinates are true-scale PDF points (not raw paper units). */
export const PDF_TRUE_SCALE_KEY = "TrueScale";

const PAD_MM = 10;

function fmt(n: number): string {
  const v = Math.round(n * 1000) / 1000;
  if (Object.is(v, -0)) return "0";
  return String(v);
}

/**
 * PDF text string (Info dict): UTF-16BE with BOM as a hex string,
 * so titles can keep accents and other non-Latin1 characters.
 */
export function pdfInfoText(value: string): string {
  const units: number[] = [0xfe, 0xff];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      units.push((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
    } else {
      units.push((cp >> 8) & 0xff, cp & 0xff);
    }
  }
  return `<${units.map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
}

function ringOps(
  segs: ImportedSeg[],
  closed: boolean,
  ox: number,
  oy: number,
): string[] {
  if (segs.length < 2) return [];
  const parts: string[] = [];
  const x = (s: ImportedSeg) => s.point.x - ox;
  const y = (s: ImportedSeg) => s.point.y - oy;

  parts.push(`${fmt(x(segs[0]))} ${fmt(y(segs[0]))} m`);

  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    const hoLen = Math.hypot(a.handleOut.x, a.handleOut.y);
    const hiLen = Math.hypot(b.handleIn.x, b.handleIn.y);
    if (hoLen < 1e-4 && hiLen < 1e-4) {
      parts.push(`${fmt(x(b))} ${fmt(y(b))} l`);
    } else {
      const c1x = a.point.x + a.handleOut.x - ox;
      const c1y = a.point.y + a.handleOut.y - oy;
      const c2x = b.point.x + b.handleIn.x - ox;
      const c2y = b.point.y + b.handleIn.y - oy;
      parts.push(
        `${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x(b))} ${fmt(y(b))} c`,
      );
    }
  }

  if (closed) {
    const a = segs[segs.length - 1];
    const b = segs[0];
    const hoLen = Math.hypot(a.handleOut.x, a.handleOut.y);
    const hiLen = Math.hypot(b.handleIn.x, b.handleIn.y);
    const already =
      Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < 1e-4;
    if (!already) {
      if (hoLen < 1e-4 && hiLen < 1e-4) {
        parts.push(`${fmt(x(b))} ${fmt(y(b))} l`);
      } else {
        const c1x = a.point.x + a.handleOut.x - ox;
        const c1y = a.point.y + a.handleOut.y - oy;
        const c2x = b.point.x + b.handleIn.x - ox;
        const c2y = b.point.y + b.handleIn.y - oy;
        parts.push(
          `${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x(b))} ${fmt(y(b))} c`,
        );
      }
    }
    parts.push("h");
  }
  return parts;
}

function pathOps(
  segs: ImportedSeg[],
  closed: boolean,
  ox: number,
  oy: number,
  paint: "S" | "B" | "f*" = "S",
  holes?: ImportedSeg[][],
): string {
  if (segs.length < 2) return "";
  const parts = ringOps(segs, closed, ox, oy);
  if (holes?.length) {
    for (const hole of holes) {
      parts.push(...ringOps(hole, true, ox, oy));
    }
  }
  parts.push(paint);
  return parts.join("\n") + "\n";
}

function scaleSegs(segs: ImportedSeg[], k: number): ImportedSeg[] {
  return segs.map((s) => ({
    point: { x: s.point.x * k, y: s.point.y * k },
    handleIn: { x: s.handleIn.x * k, y: s.handleIn.y * k },
    handleOut: { x: s.handleOut.x * k, y: s.handleOut.y * k },
  }));
}

/** Scale paper-space paths into PDF points (true millimetres). */
function toPdfPoints(paths: ImportedPath[], mmPerPx: number): ImportedPath[] {
  const k = mmPerPx * PT_PER_MM; // paper → pt
  return paths.map((p) => ({
    ...p,
    segments: scaleSegs(p.segments, k),
    holes: p.holes?.map((h) => scaleSegs(h, k)),
    // widthMm → stroke in PDF points
    strokePt:
      p.strokePt ??
      (p.widthMm != null && p.widthMm > 0 ? p.widthMm * PT_PER_MM : undefined),
  }));
}

/** Background image in paper space (same coords as path points). */
export type SketchPdfBackground = {
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SketchPdfOptions = {
  /** Paper units → mm (required for true-scale export). */
  mmPerPx?: number | null;
  /** When set (and image is shown), embed under the curves. */
  background?: SketchPdfBackground | null;
  /** Stamp fit gap (mm) stored in PDF Info for round-trip. */
  stampGapMm?: number | null;
  /** Raised outline rim toggle for round-trip. */
  stampOutlineEnabled?: boolean | null;
  /** Raised outline rim width (mm) for round-trip. */
  stampOutlineWidthMm?: number | null;
  /** Project / cookie title stored as PDF `/Title` (Unicode-safe). */
  projectName?: string | null;
};

/** Encode a raster URL / data-URL as JPEG for PDF embedding. */
export async function jpegFromImageUrl(
  url: string,
  maxSide = 2048,
  quality = 0.85,
): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load background image"));
    img.src = url;
  });
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w < 1 || h < 1) throw new Error("Empty background image");
  const scale = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))),
      "image/jpeg",
      quality,
    );
  });
  return {
    jpeg: new Uint8Array(await blob.arrayBuffer()),
    width: w,
    height: h,
  };
}

/** Build a single-page PDF at 1:1 physical scale (MediaBox in pt). */
export function buildSketchPdf(
  paths: ImportedPath[],
  options: SketchPdfOptions = {},
): Uint8Array {
  if (!paths.length) throw new Error("Nothing to save");
  const mmPerPx =
    options.mmPerPx != null && options.mmPerPx > 0 ? options.mmPerPx : MM_PER_PT;
  const bg = options.background ?? null;
  const k = mmPerPx * PT_PER_MM;

  const ptPaths = toPdfPoints(paths, mmPerPx);
  const pad = PAD_MM * PT_PER_MM;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ptPaths) {
    for (const s of p.segments) {
      minX = Math.min(minX, s.point.x, s.point.x + s.handleIn.x, s.point.x + s.handleOut.x);
      maxX = Math.max(maxX, s.point.x, s.point.x + s.handleIn.x, s.point.x + s.handleOut.x);
      minY = Math.min(minY, s.point.y, s.point.y + s.handleIn.y, s.point.y + s.handleOut.y);
      maxY = Math.max(maxY, s.point.y, s.point.y + s.handleIn.y, s.point.y + s.handleOut.y);
    }
  }
  if (!Number.isFinite(minX)) throw new Error("Nothing to save");

  // Paper-space bg → PDF points (same space as path points before ox/oy).
  let bgPt: { left: number; top: number; width: number; height: number } | null =
    null;
  if (bg && bg.width > 0 && bg.height > 0 && bg.jpeg.length > 0) {
    bgPt = {
      left: bg.left * k,
      top: bg.top * k,
      width: bg.width * k,
      height: bg.height * k,
    };
    minX = Math.min(minX, bgPt.left);
    minY = Math.min(minY, bgPt.top);
    maxX = Math.max(maxX, bgPt.left + bgPt.width);
    maxY = Math.max(maxY, bgPt.top + bgPt.height);
  }

  const ox = minX - pad;
  const oy = minY - pad;
  const pageW = Math.max(maxX - minX + 2 * pad, 72);
  const pageH = Math.max(maxY - minY + 2 * pad, 72);

  const defaultStrokePt = 0.4 * PT_PER_MM;

  // Content-space rect for round-trip (matches path coords after import unflip).
  let bgRectContent: { x: number; y: number; w: number; h: number } | null =
    null;

  // Inkscape-style Y-flip so top-down content appears upright when printed.
  const body: string[] = [
    "q",
    `1 0 0 -1 0 ${fmt(pageH)} cm`,
  ];

  if (bgPt) {
    const x = bgPt.left - ox;
    const y = bgPt.top - oy;
    const w = bgPt.width;
    const h = bgPt.height;
    bgRectContent = { x, y, w, h };
    // PDF image origin is bottom-left; negate height for y-down content space.
    body.push("q");
    body.push(`${fmt(w)} 0 0 ${fmt(-h)} ${fmt(x)} ${fmt(y + h)} cm`);
    body.push("/Im0 Do");
    body.push("Q");
  }

  body.push("1 J", "1 j");
  for (const p of ptPaths) {
    if (p.segments.length < 2) continue;
    const rgb = p.strokeRgb ?? [0, 0, 0];
    const w = p.strokePt != null && p.strokePt > 0 ? p.strokePt : defaultStrokePt;
    body.push(
      `${fmt(rgb[0])} ${fmt(rgb[1])} ${fmt(rgb[2])} RG`,
      `${fmt(rgb[0])} ${fmt(rgb[1])} ${fmt(rgb[2])} rg`,
      `${fmt(w)} w`,
    );
    const hasHoles = !!(p.holes && p.holes.length > 0);
    // Rim annulus: even-odd fill only. Features: fill+stroke. Else stroke.
    const paint: "S" | "B" | "f*" = p.stampRim
      ? "f*"
      : hasHoles && p.filled
        ? "f*"
        : p.filled && p.closed
          ? "B"
          : "S";
    body.push(
      pathOps(p.segments, p.closed, ox, oy, paint, p.holes).trimEnd(),
    );
  }
  body.push("Q");
  const stream = body.join("\n") + "\n";

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let pos = 0;
  const push = (s: string | Uint8Array) => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    parts.push(b);
    pos += b.length;
  };
  const startObj = (n: number) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
  };
  const endObj = () => push("endobj\n");

  const hasImage = !!(bg && bgPt);
  // 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Info, [6 Image]
  const infoObj = 5;
  const imageObj = 6;
  const objCount = hasImage ? 7 : 6;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObj();

  startObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
  endObj();

  startObj(3);
  const resources = hasImage
    ? `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> `
    : `/Resources << >> `;
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pageW)} ${fmt(pageH)}] ` +
      `/Contents 4 0 R ${resources}>>\n`,
  );
  endObj();

  const streamBytes = enc.encode(stream);
  startObj(4);
  push(`<< /Length ${streamBytes.length} >>\nstream\n`);
  push(streamBytes);
  push("\nendstream\n");
  endObj();

  // TrueScale + optional BgRect / Title for round-trip.
  startObj(infoObj);
  let info =
    `<< /Producer (${PDF_PRODUCER}) /Creator (${PDF_PRODUCER}) ` +
    `/TrueScale true /MmPerPx ${fmt(mmPerPx)}`;
  const title = options.projectName?.trim();
  if (title) {
    info += ` /Title ${pdfInfoText(title)}`;
  }
  if (bgRectContent) {
    info +=
      ` /BgRect [${fmt(bgRectContent.x)} ${fmt(bgRectContent.y)} ` +
      `${fmt(bgRectContent.w)} ${fmt(bgRectContent.h)}]`;
  }
  if (options.stampGapMm != null && Number.isFinite(options.stampGapMm)) {
    info += ` /StampGapMm ${fmt(options.stampGapMm)}`;
  }
  if (options.stampOutlineEnabled != null) {
    info += ` /StampOutline ${options.stampOutlineEnabled ? "true" : "false"}`;
  }
  if (
    options.stampOutlineWidthMm != null &&
    Number.isFinite(options.stampOutlineWidthMm)
  ) {
    info += ` /StampOutlineWidthMm ${fmt(options.stampOutlineWidthMm)}`;
  }
  info += " >>\n";
  push(info);
  endObj();

  if (hasImage && bg) {
    startObj(imageObj);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${bg.widthPx} /Height ${bg.heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${bg.jpeg.length} >>\nstream\n`,
    );
    push(bg.jpeg);
    push("\nendstream\n");
    endObj();
  }

  const xrefStart = pos;
  push(`xref\n0 ${objCount}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i < objCount; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objCount} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function downloadSketchPdf(
  paths: ImportedPath[],
  filename = "pernicek.pdf",
  options: SketchPdfOptions = {},
): Promise<SaveResult> {
  const bytes = buildSketchPdf(paths, options);
  return saveBlob(new Blob([bytes], { type: "application/pdf" }), filename);
}
