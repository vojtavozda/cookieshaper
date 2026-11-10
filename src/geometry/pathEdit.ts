import paper from "paper";

type PaperPath = InstanceType<typeof paper.Path>;
type PaperScope = InstanceType<typeof paper.PaperScope>;
type PaperSegment = InstanceType<typeof paper.Segment>;

export type SegSnap = {
  point: { x: number; y: number };
  handleIn: { x: number; y: number };
  handleOut: { x: number; y: number };
};

export function cloneRaw(path: PaperPath): SegSnap[] {
  return path.segments.map((s) => ({
    point: { x: s.point.x, y: s.point.y },
    handleIn: { x: s.handleIn.x, y: s.handleIn.y },
    handleOut: { x: s.handleOut.x, y: s.handleOut.y },
  }));
}

export function applyRaw(path: PaperPath, raw: SegSnap[], scope: PaperScope) {
  const closed = path.closed;
  path.removeSegments();
  for (const s of raw) {
    path.add(
      new scope.Segment(
        new scope.Point(s.point.x, s.point.y),
        new scope.Point(s.handleIn.x, s.handleIn.y),
        new scope.Point(s.handleOut.x, s.handleOut.y),
      ),
    );
  }
  path.closed = closed;
}

export function reverseRaw(raw: SegSnap[]) {
  raw.reverse();
  for (const s of raw) {
    const tmp = s.handleIn;
    s.handleIn = s.handleOut;
    s.handleOut = tmp;
  }
}

/** Infer smooth vs corner from handle geometry after simplify. */
export function detectSmoothFlags(path: PaperPath): boolean[] {
  return path.segments.map((seg) => {
    const hi = seg.handleIn;
    const ho = seg.handleOut;
    if (hi.length < 0.5 || ho.length < 0.5) return false;
    // Smooth ≈ opposite colinear handles
    return hi.normalize().dot(ho.normalize()) < -0.9;
  });
}

/**
 * Simplify only the stroke tail after `anchorIndex` (inclusive join point).
 * Earlier segments stay untouched — important when continuing a curve.
 * Join handleOut is taken from the simplified tail so the seam stays smooth.
 */
export function simplifyTail(
  path: PaperPath,
  anchorIndex: number,
  tol: number,
  scope: PaperScope,
) {
  if (tol <= 0.05) return;
  if (path.segments.length <= anchorIndex + 2) return;
  const closed = path.closed;
  const temp = new scope.Path();
  for (let i = anchorIndex; i < path.segments.length; i++) {
    temp.add(path.segments[i].clone());
  }
  temp.simplify(tol);
  while (path.segments.length > anchorIndex + 1) {
    path.removeSegment(path.segments.length - 1);
  }
  const join = path.segments[anchorIndex];
  if (join && temp.firstSegment) {
    join.handleOut = temp.firstSegment.handleOut.clone();
  }
  for (let i = 1; i < temp.segments.length; i++) {
    path.add(temp.segments[i].clone());
  }
  temp.remove();
  path.closed = closed;
}

/**
 * Sample a closed (or open) Paper path into polyline points.
 * Straight spans keep only their anchors; curved spans are densely sampled.
 */
export function samplePathPoints(
  path: PaperPath,
  opts?: { flatness?: number; minPerCurve?: number; maxPoints?: number },
): { x: number; y: number }[] {
  const flatness = opts?.flatness ?? 0.5;
  const minPerCurve = opts?.minPerCurve ?? 12;
  const maxPoints = opts?.maxPoints ?? 400;

  const pts: { x: number; y: number }[] = [];
  const anchorAt: number[] = [];
  const curves = path.curves;
  if (!curves.length) {
    return path.segments.map((s) => ({ x: s.point.x, y: s.point.y }));
  }

  for (let ci = 0; ci < curves.length; ci++) {
    const curve = curves[ci];
    // Real corners / polygonal edges: no extra samples on the chord
    if (curve.isStraight()) {
      anchorAt.push(pts.length);
      const p0 = curve.point1;
      pts.push({ x: p0.x, y: p0.y });
      if (ci === curves.length - 1 && !path.closed) {
        const p1 = curve.point2;
        pts.push({ x: p1.x, y: p1.y });
      }
      continue;
    }
    // Estimate subdivisions from length and flatness; never under-sample a span
    const len = Math.max(curve.length, 1);
    const byLen = Math.ceil(len / Math.max(flatness * 4, 1));
    const samples = Math.max(minPerCurve, byLen);
    // Skip last point of each curve (shared with next) except on final open end
    const last = ci === curves.length - 1 && !path.closed ? samples : samples - 1;
    anchorAt.push(pts.length);
    for (let i = 0; i <= last; i++) {
      const t = i / samples;
      const p = curve.getPointAtTime(t);
      pts.push({ x: p.x, y: p.y });
    }
  }

  if (pts.length <= maxPoints) return pts;
  // Uniform thinning used to skip segment anchors, so a sharp corner vanished
  // from the offset cutter. Always keep those points.
  const anchors = anchorAt.filter((i) => i >= 0 && i < pts.length);
  if (anchors.length >= maxPoints) return anchors.map((i) => pts[i]);
  const keep = new Set(anchors);
  const interior: number[] = [];
  for (let i = 0; i < pts.length; i++) if (!keep.has(i)) interior.push(i);
  const budget = maxPoints - anchors.length;
  if (interior.length > 0 && budget > 0) {
    const step = interior.length / budget;
    for (let i = 0; i < budget; i++) {
      keep.add(interior[Math.min(interior.length - 1, Math.floor(i * step))]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
}

export function makeSegmentSmooth(seg: PaperSegment, scope: PaperScope) {
  const minLen = 12;
  let out = seg.handleOut.clone();
  let inn = seg.handleIn.clone();
  if (out.length < 1e-3 && inn.length < 1e-3) {
    const prev = seg.previous?.point;
    const next = seg.next?.point;
    if (prev && next) {
      const t = next.subtract(prev).normalize();
      out = t.multiply(minLen);
      inn = t.multiply(-minLen);
    } else {
      out = new scope.Point(minLen, 0);
      inn = new scope.Point(-minLen, 0);
    }
  }
  const dir =
    out.length >= inn.length ? out.normalize() : inn.normalize().multiply(-1);
  seg.handleOut = dir.multiply(Math.max(out.length, minLen));
  seg.handleIn = dir.multiply(-Math.max(inn.length, minLen));
}

/** Clear Bézier handles so the segment is a hard corner. */
export function makeSegmentCorner(seg: PaperSegment, scope: PaperScope) {
  seg.handleIn = new scope.Point(0, 0);
  seg.handleOut = new scope.Point(0, 0);
}

/**
 * After `path.divideAt`, style the new anchor: corner+zero handles on a
 * straight span, otherwise smooth with handles.
 * @returns whether the new point is smooth
 */
export function styleInsertedSegment(
  newSeg: PaperSegment,
  wasStraight: boolean,
  scope: PaperScope,
): boolean {
  if (wasStraight) {
    makeSegmentCorner(newSeg, scope);
    return false;
  }
  makeSegmentSmooth(newSeg, scope);
  return true;
}
