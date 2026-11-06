import type { Vec2 } from "../types";
import { simplifyClosedCapped } from "./pathLimits";

export type Contour = Vec2[];

/** Luminance 0–255 from RGBA. */
function grayAt(data: Uint8ClampedArray, i: number): number {
  const o = i * 4;
  return (data[o] + data[o + 1] + data[o + 2]) / 3;
}

/**
 * Threshold like the Python pipeline (dark foreground).
 * Returns a binary mask (1 = ink).
 */
export function thresholdMask(
  imageData: ImageData,
  threshold: number,
): Uint8Array {
  const n = imageData.width * imageData.height;
  const bin = new Uint8Array(n);
  const data = imageData.data;
  for (let i = 0; i < n; i++) {
    bin[i] = grayAt(data, i) < threshold ? 1 : 0;
  }
  return bin;
}

const N8: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Moore-neighborhood border follow starting at a foreground pixel that has a
 * background left neighbor (external contour seed).
 */
function traceBorder(
  bin: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  seen: Uint8Array,
): Contour | null {
  const idx = (x: number, y: number) => y * w + x;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && bin[idx(x, y)] === 1;

  const contour: Contour = [];
  let x = sx;
  let y = sy;
  // Enter from the left of the seed
  let dir = 0; // pointing right after coming from left
  const maxSteps = w * h * 2;
  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x, y });
    seen[idx(x, y)] = 1;
    // Start search from dir+6 (turn left relative to arrival) — classic Moore
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8;
      const [dx, dy] = N8[nd];
      const nx = x + dx;
      const ny = y + dy;
      if (inside(nx, ny)) {
        x = nx;
        y = ny;
        dir = nd;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (x === sx && y === sy && contour.length > 2) break;
  }
  if (contour.length < 12) return null;
  return contour;
}

/** Decimate a closed ring by keeping every `step`-th point (and endpoints). */
function strideContour(pts: Contour, step: number): Contour {
  if (pts.length <= 3 || step <= 1) return pts.map((p) => ({ ...p }));
  const out: Contour = [];
  for (let i = 0; i < pts.length; i += step) out.push({ ...pts[i] });
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) out.pop();
  }
  return out.length >= 3 ? out : pts.map((p) => ({ ...p }));
}

/**
 * Find external contours of dark regions (image pixel coords, y down).
 * Skips tiny loops; returns largest first.
 * `simplifyAmount` 0 = keep pixel border (stride 1); higher = coarser stride.
 */
export function findContours(
  imageData: ImageData,
  threshold: number,
  opts?: { maxContours?: number; minPoints?: number; simplifyAmount?: number },
): Contour[] {
  const w = imageData.width;
  const h = imageData.height;
  const bin = thresholdMask(imageData, threshold);
  const seen = new Uint8Array(w * h);
  const contours: Contour[] = [];
  const minPts = opts?.minPoints ?? 40;
  const maxN = opts?.maxContours ?? 24;
  const amt = Math.min(1, Math.max(0, opts?.simplifyAmount ?? 0.45));

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (bin[i] !== 1 || seen[i]) continue;
      // External seed: FG with BG on the left
      if (bin[i - 1] !== 0) continue;
      const c = traceBorder(bin, w, h, x, y, seen);
      if (c && c.length >= minPts) {
        // Pre-thin dense Moore borders (still leave plenty for DP). Higher Simplify → coarser.
        const target = Math.round(520 - amt * 400); // ~520 at 0 → ~120 at 1
        const step = Math.max(1, Math.floor(c.length / Math.max(120, target)));
        contours.push(strideContour(c, step));
      }
      if (contours.length >= maxN) {
        return contours.sort((a, b) => b.length - a.length);
      }
    }
  }
  return contours.sort((a, b) => b.length - a.length);
}

/** Periodic moving-average smooth for a closed polyline. `amount` 0–1. */
export function smoothClosedContour(pts: Contour, amount: number): Contour {
  if (pts.length < 3 || amount <= 0.01) return pts.map((p) => ({ ...p }));
  const n = pts.length;
  const radius = Math.max(1, Math.round(amount * 8));
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const p = pts[(i + k + n * 8) % n];
      const w = radius + 1 - Math.abs(k);
      sx += p.x * w;
      sy += p.y * w;
      wsum += w;
    }
    out.push({ x: sx / wsum, y: sy / wsum });
  }
  return out;
}

/**
 * Prepare a traced border for editing: optional smooth + Douglas–Peucker.
 * `amount` 0–1 (panel Simplify slider).
 * Even at 0 we apply a light DP floor so edit mode isn't stuck with thousands
 * of pixel-border vertices (3D can sample densely; gizmos cannot).
 */
export function prepareContourForEdit(pts: Contour, amount: number): Contour {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  const amt = Math.min(1, Math.max(0, amount));
  const smoothed =
    amt <= 0.02
      ? pts.map((p) => ({ ...p }))
      : smoothClosedContour(pts, Math.min(1, amt * 0.85));
  // Image-pixel epsilon — floor ~1px so collinear border jaggies collapse
  const eps = 0.9 + amt * 5.5;
  // Cap anchors for editability: ~240 at 0 → ~48 at 1
  const maxPts = Math.max(24, Math.round(240 - amt * 192));
  return simplifyClosedCapped(smoothed, eps, maxPts);
}

/** Map image-pixel contours into Paper project space given a placed raster. */
export function contoursToProject(
  contours: Contour[],
  raster: {
    width: number;
    height: number;
    bounds: { left: number; top: number; width: number; height: number };
  },
): Contour[] {
  const sx = raster.bounds.width / Math.max(raster.width, 1);
  const sy = raster.bounds.height / Math.max(raster.height, 1);
  const ox = raster.bounds.left;
  const oy = raster.bounds.top;
  return contours.map((c) =>
    c.map((p) => ({
      x: ox + p.x * sx,
      y: oy + p.y * sy,
    })),
  );
}

/** Read ImageData from a URL (blob or http), optionally downscaled for tracing. */
export async function loadImageData(
  url: string,
  maxSide = 1600,
): Promise<{ imageData: ImageData; width: number; height: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Failed to load image"));
    el.src = url;
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("No 2d context");
  ctx.drawImage(img, 0, 0, w, h);
  return { imageData: ctx.getImageData(0, 0, w, h), width: w, height: h };
}
