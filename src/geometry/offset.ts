import type { Vec2 } from "../types";

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function mul(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

function norm(a: Vec2): Vec2 {
  const l = len(a) || 1e-12;
  return { x: a.x / l, y: a.y / l };
}

/** Signed area (>0 ⇒ CCW). */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Ensure CCW winding. */
export function ensureCcw(pts: Vec2[]): Vec2[] {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts;
}

function nearlySame(a: Vec2, b: Vec2, eps = 1e-9) {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

function dedupeClosed(pts: Vec2[]): Vec2[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: Vec2[] = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    if (!nearlySame(pts[i], out[out.length - 1], 1e-7)) out.push({ ...pts[i] });
  }
  if (out.length >= 2 && nearlySame(out[0], out[out.length - 1], 1e-7)) out.pop();
  return out;
}

/** Segment intersection; t,u in (0,1) open interval (touches at ends ignored). */
function segIntersect(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { t: number; u: number; point: Vec2 } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t <= 1e-8 || t >= 1 - 1e-8 || u <= 1e-8 || u >= 1 - 1e-8) return null;
  return { t, u, point: { x: a.x + t * rx, y: a.y + t * ry } };
}

/**
 * Remove small self-intersection loops from a closed polyline (e.g. inset
 * offset curling into a circle at a sharp corner). Keeps the largest loop.
 */
export function cleanClosedPolyline(ptsIn: Vec2[]): Vec2[] {
  let pts = dedupeClosed(ptsIn);
  if (pts.length < 4) return pts;

  for (let iter = 0; iter < 48; iter++) {
    const n = pts.length;
    let found:
      | { i: number; j: number; point: Vec2 }
      | null = null;

    outer: for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      for (let j = i + 1; j < n; j++) {
        const j2 = (j + 1) % n;
        // Skip adjacent / shared-vertex edges
        if (i === j) continue;
        if (i2 === j || j2 === i) continue;
        if (i === j2 || j === i2) continue;
        // Closed ring: first and last edges also adjacent
        if (i === 0 && j2 === 0) continue;
        if (j === 0 && i2 === 0) continue;

        const hit = segIntersect(pts[i], pts[i2], pts[j], pts[j2]);
        if (!hit) continue;
        found = { i, j, point: hit.point };
        break outer;
      }
    }
    if (!found) break;

    const { i, j, point } = found;
    // Two loops meeting at the crossing
    const loopA = [point, ...pts.slice(i + 1, j + 1)];
    const loopB = [point, ...pts.slice(j + 1), ...pts.slice(0, i + 1)];
    const areaA = Math.abs(signedArea(loopA));
    const areaB = Math.abs(signedArea(loopB));
    pts = dedupeClosed(areaA >= areaB ? loopA : loopB);
    if (pts.length < 3) break;
  }
  return pts;
}

/**
 * Offset of a closed polyline.
 * Positive distance expands outward for a CCW polygon.
 *
 * Same capped-miter join for convex and concave. Bevel only when the miter
 * would exceed `miterLimit` (or normals cancel). Do not force-bevel mild
 * concave corners — that mismatched outer/inner joins and left wall artefacts.
 */
export function offsetClosed(
  ptsIn: Vec2[],
  distance: number,
  opts?: { miterLimit?: number },
): Vec2[] {
  if (ptsIn.length < 3 || distance === 0) return ptsIn.map((p) => ({ ...p }));
  const pts = ensureCcw(ptsIn);
  const n = pts.length;
  const out: Vec2[] = [];
  const miterLimit = opts?.miterLimit ?? 2.5;

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    // Edge normals pointing outward (right of CCW tangent = outward)
    const e1 = norm(sub(curr, prev));
    const e2 = norm(sub(next, curr));
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };

    let bis = add(n1, n2);
    const bl = len(bis);
    if (bl < 1e-8) {
      // Opposite normals — bevel
      out.push(add(curr, mul(n1, distance)));
      out.push(add(curr, mul(n2, distance)));
      continue;
    }
    bis = mul(bis, 1 / bl);
    const cosHalf = n1.x * bis.x + n1.y * bis.y;
    // cosHalf <= 0 ⇒ bisector points the wrong way; also cap long miters
    if (cosHalf < 1 / miterLimit) {
      out.push(add(curr, mul(n1, distance)));
      out.push(add(curr, mul(n2, distance)));
    } else {
      out.push(add(curr, mul(bis, distance / cosHalf)));
    }
  }
  return out;
}

/**
 * Outward offset with round joins — sharp corners become arcs of radius
 * `|distance|`, so a wider flange looks softer, not pointier.
 * Only real corners get arcs (angle threshold) and arc tessellation is capped.
 */
export function offsetClosedRound(
  ptsIn: Vec2[],
  distance: number,
  opts?: { minCornerRad?: number; maxArcSteps?: number },
): Vec2[] {
  if (ptsIn.length < 3 || Math.abs(distance) < 1e-9) {
    return ptsIn.map((p) => ({ ...p }));
  }
  if (distance < 0) return offsetClosed(ptsIn, distance);

  const minCornerRad = opts?.minCornerRad ?? 0.35; // ~20°
  const maxArcSteps = opts?.maxArcSteps ?? 6;

  const pts = ensureCcw(ptsIn);
  const n = pts.length;
  const out: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const e1 = norm(sub(curr, prev));
    const e2 = norm(sub(next, curr));
    const n1 = { x: e1.y, y: -e1.x };
    const n2 = { x: e2.y, y: -e2.x };
    const cross = e1.x * e2.y - e1.y * e2.x;
    const dot = Math.max(-1, Math.min(1, e1.x * e2.x + e1.y * e2.y));
    const turn = Math.acos(dot); // 0 = straight, π = hairpin

    if (cross > 1e-8 && turn >= minCornerRad) {
      const a1 = Math.atan2(n1.y, n1.x);
      let a2 = Math.atan2(n2.y, n2.x);
      let sweep = a2 - a1;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
      if (sweep > 0) sweep -= 2 * Math.PI;

      const steps = Math.max(1, Math.min(maxArcSteps, Math.ceil(turn / 0.4)));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (sweep * s) / steps;
        out.push({
          x: curr.x + Math.cos(a) * distance,
          y: curr.y + Math.sin(a) * distance,
        });
      }
    } else if (cross < -1e-8) {
      // Concave: bevel — avoids miter shooting into the interior
      out.push(add(curr, mul(n1, distance)));
      out.push(add(curr, mul(n2, distance)));
    } else {
      let bis = add(n1, n2);
      const bl = len(bis);
      if (bl < 1e-8) bis = n1;
      else bis = mul(bis, 1 / bl);
      const cosHalf = n1.x * bis.x + n1.y * bis.y;
      if (cosHalf < 0.4) {
        out.push(add(curr, mul(n1, distance)));
        out.push(add(curr, mul(n2, distance)));
      } else {
        out.push(add(curr, mul(bis, distance / cosHalf)));
      }
    }
  }
  return out;
}

function closedPolylineLength(pts: Vec2[]): {
  closed: Vec2[];
  segLens: number[];
  total: number;
} {
  const closed = [...pts];
  if (
    closed.length >= 2 &&
    Math.hypot(
      closed[0].x - closed[closed.length - 1].x,
      closed[0].y - closed[closed.length - 1].y,
    ) > 1e-6
  ) {
    closed.push({ ...closed[0] });
  }
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const d = Math.hypot(
      closed[i + 1].x - closed[i].x,
      closed[i + 1].y - closed[i].y,
    );
    segLens.push(d);
    total += d;
  }
  return { closed, segLens, total };
}

function sampleClosedAt(
  closed: Vec2[],
  segLens: number[],
  total: number,
  count: number,
): Vec2[] {
  if (total < 1e-6 || count < 2) return closed.slice(0, -1);
  const step = total / count;
  const out: Vec2[] = [];
  let seg = 0;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < segLens.length - 1 && acc + segLens[seg] < target) {
      acc += segLens[seg];
      seg++;
    }
    const t = segLens[seg] < 1e-12 ? 0 : (target - acc) / segLens[seg];
    out.push({
      x: closed[seg].x + (closed[seg + 1].x - closed[seg].x) * t,
      y: closed[seg].y + (closed[seg + 1].y - closed[seg].y) * t,
    });
  }
  return out;
}

export function resampleClosed(pts: Vec2[], spacing: number): Vec2[] {
  if (pts.length < 2) return pts;
  const { closed, segLens, total } = closedPolylineLength(pts);
  if (total < 1e-6) return pts;
  const count = Math.max(24, Math.min(220, Math.round(total / spacing)));
  return sampleClosedAt(closed, segLens, total, count);
}

/** Even arc-length resample to an exact vertex count (for lofting rings). */
export function resampleClosedToCount(pts: Vec2[], count: number): Vec2[] {
  if (pts.length < 2 || count < 3) return pts.map((p) => ({ ...p }));
  const { closed, segLens, total } = closedPolylineLength(pts);
  if (total < 1e-6) return pts.map((p) => ({ ...p }));
  return sampleClosedAt(closed, segLens, total, count);
}

export function bboxSize(pts: Vec2[]): { width: number; height: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * Scale & center path so the longer bbox side = sizeMm; flip Y (screen → CAD).
 * Returns mm points plus the resulting width×height.
 */
export type MmFrame = {
  s: number;
  minX: number;
  minY: number;
  cx: number;
  cy: number;
};

/** Same paper→mm mapping the cutter uses (scale, flip Y, center). */
export function mmFrame(pts: Vec2[], sizeMm: number): MmFrame {
  const { width: wPx, height: hPx } = bboxSize(pts);
  const longPx = Math.max(wPx, hPx);
  if (longPx <= 1e-9) throw new Error("Degenerate path size");
  const s = sizeMm / longPx;
  let minX = Infinity;
  let minY = Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += (p.x - minX) * s;
    cy += -(p.y - minY) * s;
  }
  cx /= pts.length;
  cy /= pts.length;
  return { s, minX, minY, cx, cy };
}

export function mapMm(p: Vec2, f: MmFrame): Vec2 {
  return {
    x: (p.x - f.minX) * f.s - f.cx,
    y: -(p.y - f.minY) * f.s - f.cy,
  };
}

export function toMm(
  pts: Vec2[],
  sizeMm: number,
): { points: Vec2[]; widthMm: number; heightMm: number } {
  const frame = mmFrame(pts, sizeMm);
  const points = pts.map((p) => mapMm(p, frame));
  const bb = bboxSize(points);
  return { points, widthMm: bb.width, heightMm: bb.height };
}
