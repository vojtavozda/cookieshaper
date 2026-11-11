import * as THREE from "three";
import {
  EndType,
  FillRule,
  JoinType,
  PointInPolygonResult,
  areaD,
  differenceD,
  inflatePathsD,
  pointInPolygonD,
  type PathD,
  type PathsD,
} from "clipper2-ts";
import type { CutterParams, Vec2 } from "../types";
import { meshFidelity } from "./pathEdit";
import { ensureCcw, signedArea } from "./offset";

const cutterMat = () =>
  new THREE.MeshStandardMaterial({
    color: 0xe8d5b7,
    metalness: 0.05,
    roughness: 0.7,
  });

function toPath(pts: Vec2[]): PathD {
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

function fromPath(path: PathD): Vec2[] {
  return path.map((p) => ({ x: p.x, y: p.y }));
}

function oppositeWinding(pts: Vec2[], outerArea: number): Vec2[] {
  const a = signedArea(pts);
  if (outerArea > 0 === a > 0) return [...pts].reverse();
  return pts;
}

function extrudeSolid(
  outerIn: Vec2[],
  holesIn: Vec2[][],
  height: number,
  z0: number,
): THREE.Mesh | null {
  if (outerIn.length < 3 || height <= 1e-4) return null;
  const outer = ensureCcw(outerIn);
  const shape = new THREE.Shape();
  shape.moveTo(outer[0].x, outer[0].y);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x, outer[i].y);
  shape.closePath();
  const outerArea = signedArea(outer);
  for (const hole of holesIn) {
    if (hole.length < 3) continue;
    const h = oppositeWinding(hole, outerArea);
    const path = new THREE.Path();
    path.moveTo(h[0].x, h[0].y);
    for (let i = 1; i < h.length; i++) path.lineTo(h[i].x, h[i].y);
    path.closePath();
    shape.holes.push(path);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, z0);
  return new THREE.Mesh(geo, cutterMat());
}

/** Pair positive outlines with the holes that sit inside them. */
function groupRings(paths: PathsD): { outer: Vec2[]; holes: Vec2[][] }[] {
  const pos = paths.filter((p) => p.length >= 3 && areaD(p) > 1e-3);
  const neg = paths.filter((p) => p.length >= 3 && areaD(p) < -1e-3);
  const hosts = [...pos].sort((a, b) => Math.abs(areaD(a)) - Math.abs(areaD(b)));
  const buckets = hosts.map((path) => ({
    path,
    outer: fromPath(path),
    holes: [] as Vec2[][],
  }));
  for (const hole of neg) {
    const probe = hole[0];
    const host = buckets.find(
      (b) => pointInPolygonD(probe, b.path) !== PointInPolygonResult.IsOutside,
    );
    if (host) host.holes.push(fromPath(hole));
  }
  return buckets;
}

function addRings(
  group: THREE.Group,
  paths: PathsD,
  height: number,
  z0: number,
): THREE.Mesh[] {
  const added: THREE.Mesh[] = [];
  for (const ring of groupRings(paths)) {
    const mesh = extrudeSolid(ring.outer, ring.holes, height, z0);
    if (mesh) {
      group.add(mesh);
      added.push(mesh);
    }
  }
  return added;
}

/** Horizontal offset of the quarter-circle fillet at height h above the flange. */
function filletReach(h: number, radius: number): number {
  const u = Math.min(1, Math.max(0, h / radius));
  return radius * (1 - Math.sqrt(Math.max(0, u * (2 - u))));
}

function inflate(
  mid: Vec2[],
  delta: number,
  join: JoinType,
  arcMm: number,
): PathsD {
  return inflatePathsD(
    [toPath(mid)],
    delta,
    join,
    EndType.Polygon,
    2,
    3,
    arcMm,
  );
}

/**
 * Wall, base and bevel from Clipper2 offsets.
 * Joins and self-intersections (sharp concave Vs) are resolved by the clipper.
 */
export function addClipperBody(group: THREE.Group, mid: Vec2[], params: CutterParams) {
  const arcMm = meshFidelity(params.meshQuality).arcMm;
  const half = params.wallThicknessMm / 2;
  const rim = Math.max(0, params.rimWidthMm);
  const baseH = Math.max(0, params.baseHeightMm);
  const wallH = params.wallHeightMm;
  const wantFlange = rim > half + 1e-6 && baseH > 1e-3;

  if (wallH > 1e-3 && half > 1e-3) {
    // Closed stroke: outer boundary + the hole where the wall isn't
    const stroke = inflatePathsD(
      [toPath(mid)],
      half,
      JoinType.Round,
      EndType.Joined,
      2,
      3,
      arcMm,
    );
    addRings(group, stroke, wallH, 0);
  }

  if (wantFlange) {
    // Same Round inflate as the bevel's outer slices (not Miter) so the flange
    // rim matches the stacked bevel contour in sharp corners.
    const grown = inflate(mid, rim, JoinType.Round, arcMm);
    const flange = differenceD(grown, [toPath(mid)], FillRule.NonZero, 3);
    addRings(group, flange, baseH, 0);
  }

  const maxR = Math.min(Math.max(0, rim - half), Math.max(0, wallH - baseH));
  const radius = Math.min(Math.max(0, params.filletRadiusMm), maxR);
  if (wantFlange && radius > 1e-3) {
    const step = Math.min(0.5, Math.max(0.1, params.bevelLayerMm || 0.2));
    const layers = Math.max(2, Math.min(40, Math.ceil(radius / step)));
    const dh = radius / layers;
    for (let i = 0; i < layers; i++) {
      const h0 = i * dh;
      const reach = filletReach(h0, radius);
      if (reach < 0.05) continue;
      const outer = inflate(mid, half + reach, JoinType.Round, arcMm);
      const inner = inflate(mid, half, JoinType.Round, arcMm);
      const slab = differenceD(outer, inner, FillRule.NonZero, 3);
      addRings(group, slab, dh, baseH + h0);
    }
  }
}

/**
 * Knife tip as stacked stroke rings tapering to the midline
 * (same idea as the bevel stack — avoids loft artefacts at concave corners).
 */
export function addStackedKnifeClipper(
  group: THREE.Group,
  mid: Vec2[],
  half: number,
  z0: number,
  knifeHeight: number,
  layerMm: number,
  tipWidthMm: number,
  arcMm = 0.15,
) {
  if (knifeHeight <= 1e-3 || half <= 1e-3) return;
  const tipHalf = Math.min(half, Math.max(0, tipWidthMm / 2));
  const step = Math.min(0.5, Math.max(0.1, layerMm || 0.2));
  const layers = Math.max(2, Math.min(40, Math.ceil(knifeHeight / step)));
  const dh = knifeHeight / layers;
  let tipMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < layers; i++) {
    const h0 = i * dh;
    // Width at the bottom of this slice — taper to a flat tip, not a point
    const t = Math.min(1, Math.max(0, h0 / knifeHeight));
    const halfT = tipHalf + (half - tipHalf) * (1 - t);
    if (halfT < 0.025) continue;
    // Same round join as the wall. A miter corner sits outside that arc
    // and leaves a lip over the wall, worst on the lowest knife slice.
    const stroke = inflatePathsD(
      [toPath(mid)],
      halfT,
      JoinType.Round,
      EndType.Joined,
      2,
      3,
      arcMm,
    );
    tipMeshes = addRings(group, stroke, dh, z0 + h0);
  }
  for (const m of tipMeshes) m.userData.knifeTip = true;
}
