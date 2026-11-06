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
export function offsetClosedClipper(pts: Vec2[], delta: number): Vec2[] | null {
  if (pts.length < 3 || Math.abs(delta) < 1e-9) return pts.map((p) => ({ ...p }));
  const out = inflatePathsD(
    [toPath(pts)],
    delta,
    JoinType.Round,
    EndType.Polygon,
    2,
    2,
    0.15,
  );
  return largest(out);
}

/** Closed ribbon (stroke) or open stroke, as one or more filled loops. */
export function strokePolygons(
  pts: Vec2[],
  closed: boolean,
  halfWidth: number,
): PathsD {
  if (pts.length < 2 || halfWidth <= 1e-6) return [];
  const path = toPath(pts);
  if (closed && pts.length >= 3) {
    const outer = inflatePathsD([path], halfWidth, JoinType.Round, EndType.Polygon, 2, 2, 0.15);
    const inner = inflatePathsD([path], -halfWidth, JoinType.Round, EndType.Polygon, 2, 2, 0.15);
    if (!inner.length) return outer;
    return differenceD(outer, inner, FillRule.NonZero, 2);
  }
  return inflatePathsD([path], halfWidth, JoinType.Round, EndType.Round, 2, 2, 0.15);
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
      0.15,
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
