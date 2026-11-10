/**
 * Stamp outline and feature footprints via Clipper2.
 * Outline = cutter midline inset by wall/2 + fit gap (interior of the cutter).
 */

import {
  EndType,
  FillRule,
  JoinType,
  areaD,
  differenceD,
  inflatePathsD,
  intersectD,
  type PathD,
  type PathsD,
} from "clipper2-ts";
import type { Vec2 } from "../types";

function toPath(pts: Vec2[]): PathD {
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

function fromPath(path: PathD): Vec2[] {
  return path.map((p) => ({ x: p.x, y: p.y }));
}

function largest(paths: PathsD): Vec2[] | null {
  let best: PathD | null = null;
  let bestA = 0;
  for (const p of paths) {
    if (p.length < 3) continue;
    const a = Math.abs(areaD(p));
    if (a > bestA) {
      bestA = a;
      best = p;
    }
  }
  return best ? fromPath(best) : null;
}

/** Inset (negative delta) or outset a closed ring. Returns the largest loop. */
export function offsetClosedClipper(
  pts: Vec2[],
  delta: number,
  arcTolerance = 0.15,
  join: JoinType = JoinType.Round,
  miterLimit = 2,
): Vec2[] | null {
  if (pts.length < 3 || Math.abs(delta) < 1e-9) return pts.map((p) => ({ ...p }));
  const out = inflatePathsD(
    [toPath(pts)],
    delta,
    join,
    EndType.Polygon,
    miterLimit,
    2,
    arcTolerance,
  );
  return largest(out);
}

/**
 * Raised rim band flush with the stamp plate edge: outer = outline,
 * inner = outline inset by `width` (inward thickness).
 */
export function rimAnnulus(outline: Vec2[], width: number): Vec2[][] {
  if (outline.length < 3 || width <= 1e-6) return [];
  const inner = offsetClosedClipper(outline, -width);
  if (!inner || inner.length < 3) return [];
  const rings = differenceD(
    [toPath(outline)],
    [toPath(inner)],
    FillRule.NonZero,
    2,
  );
  return rings
    .filter((p) => p.length >= 3 && Math.abs(areaD(p)) > 1e-4)
    .map(fromPath);
}

/**
 * Paper-space stamp rim loops: plate edge (outer) inset from the cutter by
 * wall/2 + gap, and the inner edge of the raised rim band.
 */
export function stampRimLoopsPx(
  cutterPts: Vec2[],
  wallMm: number,
  gapMm: number,
  outlineWidthMm: number,
  mmPerPx: number,
): { outer: Vec2[]; inner: Vec2[] } | null {
  if (cutterPts.length < 3 || mmPerPx <= 1e-9) return null;
  const insetPx = (wallMm / 2 + Math.max(0, gapMm)) / mmPerPx;
  const outer = offsetClosedClipper(cutterPts, -insetPx);
  if (!outer || outer.length < 3) return null;
  const wPx = Math.max(0.05, outlineWidthMm) / mmPerPx;
  const inner = offsetClosedClipper(outer, -wPx);
  if (!inner || inner.length < 3) return null;
  return { outer, inner };
}

/**
 * Clipper2 arcTolerance (double units, ×10^precision internally).
 * 0 → library default (~0.2% of radius) so round endcaps stay smooth.
 * A fixed 0.15 used to leave open strokes with ~1–2 points per semicircle.
 */
const ROUND_ARC_TOL = 0;

/** Closed ribbon (stroke) or open stroke, as one or more filled loops. */
export function strokePolygons(
  pts: Vec2[],
  closed: boolean,
  halfWidth: number,
): PathsD {
  if (pts.length < 2 || halfWidth <= 1e-6) return [];
  const path = toPath(pts);
  if (closed && pts.length >= 3) {
    const outer = inflatePathsD(
      [path],
      halfWidth,
      JoinType.Round,
      EndType.Polygon,
      2,
      2,
      ROUND_ARC_TOL,
    );
    const inner = inflatePathsD(
      [path],
      -halfWidth,
      JoinType.Round,
      EndType.Polygon,
      2,
      2,
      ROUND_ARC_TOL,
    );
    if (!inner.length) return outer;
    return differenceD(outer, inner, FillRule.NonZero, 2);
  }
  return inflatePathsD(
    [path],
    halfWidth,
    JoinType.Round,
    EndType.Round,
    2,
    2,
    ROUND_ARC_TOL,
  );
}

/**
 * Feature area clipped to the stamp outline.
 * - stroke → ribbon (open or closed ring)
 * - filled closed → solid pad (interior); outline stroke is the pad edge
 * Returns Clipper paths including negative hole loops for rings.
 */
export function featureFootprints(
  pts: Vec2[],
  closed: boolean,
  filled: boolean,
  halfWidth: number,
  outline: Vec2[],
): Vec2[][] {
  if (outline.length < 3) return [];
  const clip = [toPath(outline)];
  let shapes: PathsD;
  if (filled && closed && pts.length >= 3) {
    // Solid pad — inflate slightly so the edge reads like the canvas stroke
    const pad = inflatePathsD(
      [toPath(pts)],
      halfWidth,
      JoinType.Round,
      EndType.Polygon,
      2,
      2,
      ROUND_ARC_TOL,
    );
    shapes = pad.length ? pad : [toPath(pts)];
  } else {
    shapes = strokePolygons(pts, closed, halfWidth);
  }
  if (!shapes.length) return [];
  const hit = intersectD(shapes, clip, FillRule.NonZero, 2);
  // Keep both positive outers and negative holes (rings need holes in 3D)
  return hit
    .filter((p) => p.length >= 3 && Math.abs(areaD(p)) > 1e-4)
    .map(fromPath);
}
