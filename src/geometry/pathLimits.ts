import type { Vec2 } from "../types";

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas–Peucker on a closed ring. `i1 === n` means the wrap back to point 0. */
function dpRange(
  pts: Vec2[],
  eps: number,
  keep: boolean[],
  i0: number,
  i1: number,
) {
  const n = pts.length;
  const start = pts[i0];
  const end = pts[i1 % n];
  let maxD = 0;
  let idx = -1;
  for (let i = i0 + 1; i < i1; i++) {
    const d = distToSeg(pts[i], start, end);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (idx >= 0 && maxD > eps) {
    keep[idx] = true;
    dpRange(pts, eps, keep, i0, idx);
    dpRange(pts, eps, keep, idx, i1);
  }
}

/**
 * Drop vertices that lie on the straight span between their neighbors.
 * Corners and curves (deviation > eps) stay, so a 4-point polygon stays 4 points.
 */
export function simplifyClosed(pts: Vec2[], eps: number): Vec2[] {
  const n = pts.length;
  if (n <= 3) return pts.map((p) => ({ ...p }));
  let far = 1;
  let best = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (far === 0) return pts.map((p) => ({ ...p }));
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[far] = true;
  dpRange(pts, eps, keep, 0, far);
  dpRange(pts, eps, keep, far, n);
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts.map((p) => ({ ...p }));
}

/** Simplify, relaxing tolerance until the ring fits `maxPts`. */
export function simplifyClosedCapped(
  pts: Vec2[],
  eps: number,
  maxPts: number,
): Vec2[] {
  let tol = eps;
  let out = simplifyClosed(pts, tol);
  while (out.length > maxPts && tol < 4) {
    tol *= 1.7;
    out = simplifyClosed(pts, tol);
  }
  return out;
}

/** Douglas–Peucker on an open polyline (endpoints always kept). */
export function simplifyOpen(pts: Vec2[], eps: number): Vec2[] {
  const n = pts.length;
  if (n <= 2) return pts.map((p) => ({ ...p }));
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  dpRange(pts, eps, keep, 0, n - 1);
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 2 ? out : pts.map((p) => ({ ...p }));
}

/** Simplify an open polyline, relaxing until it fits `maxPts`. */
export function simplifyOpenCapped(
  pts: Vec2[],
  eps: number,
  maxPts: number,
): Vec2[] {
  let tol = eps;
  let out = simplifyOpen(pts, tol);
  while (out.length > maxPts && tol < 4) {
    tol *= 1.7;
    out = simplifyOpen(pts, tol);
  }
  return out;
}
