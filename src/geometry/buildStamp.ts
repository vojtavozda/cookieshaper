/**
 * Stamp plate that nests in the cutter, plus raised / recessed features on the top face.
 */

import * as THREE from "three";
import {
  FillRule,
  areaD,
  differenceD,
  type PathD,
  type PathsD,
} from "clipper2-ts";
import type { StampFeatureIn, Vec2 } from "../types";
import { ensureCcw, mapMm, mmFrame, signedArea } from "./offset";
import {
  featureFootprints,
  offsetClosedClipper,
  rimAnnulus,
} from "./stampGeom";

const PLATE_COLOR = 0xd9c4a0;
/** Slightly darker floor so recessed pockets read against the top face. */
const RECESS_FLOOR_COLOR = 0xb89a72;
/** Lighter than the plate so raised pads read clearly. */
const RAISE_COLOR = 0xf3e6d0;
const RECESS_EDGE_COLOR = 0x5c4030;

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

function stampMat(color: number, opts?: { raised?: boolean }) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: opts?.raised ? 0.08 : 0.05,
    roughness: opts?.raised ? 0.38 : 0.65,
    emissive: opts?.raised ? 0x6a4a28 : 0x000000,
    emissiveIntensity: opts?.raised ? 0.35 : 0,
  });
}

function extrude(
  outerIn: Vec2[],
  holes: Vec2[][],
  height: number,
  z0: number,
  color: number,
  opts?: { raised?: boolean },
): THREE.Mesh | null {
  if (outerIn.length < 3 || height <= 1e-4) return null;
  const outer = ensureCcw(outerIn);
  const shape = new THREE.Shape();
  shape.moveTo(outer[0].x, outer[0].y);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x, outer[i].y);
  shape.closePath();
  const outerArea = signedArea(outer);
  for (const hole of holes) {
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
  const mesh = new THREE.Mesh(geo, stampMat(color, opts));
  mesh.userData.part = "stamp";
  return mesh;
}

function ringCentroid(path: PathD): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of path) {
    x += p.x;
    y += p.y;
  }
  const n = path.length || 1;
  return { x: x / n, y: y / n };
}

function pointInRing(outer: Vec2[], probe: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const yi = outer[i].y;
    const yj = outer[j].y;
    const xi = outer[i].x;
    const xj = outer[j].x;
    const den = yj - yi;
    if (
      yi > probe.y !== yj > probe.y &&
      probe.x < ((xj - xi) * (probe.y - yi)) / (den || 1e-12) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Positive loops with the negative holes that belong inside them.
 * A hole only nests in a larger loop that contains its centroid — otherwise
 * the stamp rim's inner cut (almost as big as the plate) gets stolen by a
 * feature that happens to cover one vertex, and the rim extrudes solid.
 */
function groupRings(paths: PathsD): { outer: Vec2[]; holes: Vec2[][] }[] {
  const pos = paths.filter((p) => p.length >= 3 && areaD(p) > 1e-4);
  const neg = paths.filter((p) => p.length >= 3 && areaD(p) < -1e-4);
  const hosts = [...pos].sort((a, b) => Math.abs(areaD(b)) - Math.abs(areaD(a)));
  const buckets = hosts.map((path) => ({
    path,
    outer: fromPath(path),
    holes: [] as Vec2[][],
  }));
  for (const hole of neg) {
    const holeA = Math.abs(areaD(hole));
    const probe = ringCentroid(hole);
    let best: (typeof buckets)[number] | null = null;
    let bestA = Infinity;
    for (const b of buckets) {
      const hostA = Math.abs(areaD(b.path));
      if (hostA <= holeA + 1e-4 || hostA >= bestA) continue;
      if (pointInRing(b.outer, probe)) {
        best = b;
        bestA = hostA;
      }
    }
    if (best) best.holes.push(fromPath(hole));
  }
  return buckets;
}

function footprintsToPaths(loops: Vec2[][]): PathsD {
  return loops.filter((l) => l.length >= 3).map(toPath);
}

/** Dark outline on the plate top so recess / raise boundaries stay visible. */
function addFeatureEdges(
  group: THREE.Group,
  loops: Vec2[][],
  z: number,
  color: number,
) {
  const mat = new THREE.LineBasicMaterial({
    color,
    depthTest: true,
    transparent: true,
    opacity: 0.92,
  });
  for (const loop of loops) {
    if (loop.length < 2) continue;
    const pts: number[] = [];
    for (const p of loop) {
      pts.push(p.x, p.y, z);
    }
    pts.push(loop[0].x, loop[0].y, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.Line(geo, mat);
    line.userData.part = "stamp";
    group.add(line);
  }
}

export type BuildStampArgs = {
  cutterPx: Vec2[];
  sizeMm: number;
  wallMm: number;
  gapMm: number;
  plateMm: number;
  raiseMm: number;
  recessMm: number;
  features: StampFeatureIn[];
  /** Raised rim along plate edge (annulus inward from outline). */
  outlineEnabled?: boolean;
  outlineWidthMm?: number;
};

export function buildStamp(args: BuildStampArgs): THREE.Group {
  const group = new THREE.Group();
  group.userData.part = "stamp";
  const plate = Math.max(0.4, args.plateMm);
  const frame = mmFrame(args.cutterPx, args.sizeMm);
  const cutterMm = args.cutterPx.map((p) => mapMm(p, frame));
  const inset = Math.max(0.05, args.wallMm / 2 + Math.max(0, args.gapMm));
  const outline = offsetClosedClipper(cutterMm, -inset);
  if (!outline || outline.length < 3) return group;

  const raisedPaths: PathsD = [];
  const recessedPaths: PathsD = [];

  if (args.outlineEnabled !== false) {
    const rimW = Math.max(0.05, args.outlineWidthMm ?? 0.6);
    const rim = rimAnnulus(outline, rimW);
    raisedPaths.push(...footprintsToPaths(rim));
  }

  for (const f of args.features) {
    if (f.points.length < 2) continue;
    const mmPts = f.points.map((p) => mapMm(p, frame));
    const half = Math.max(0.05, f.widthMm / 2);
    const loops = featureFootprints(mmPts, f.closed, f.filled, half, outline);
    const paths = footprintsToPaths(loops);
    if (f.raised) raisedPaths.push(...paths);
    else recessedPaths.push(...paths);
  }

  const wantRecess = recessedPaths.length > 0 && args.recessMm > 1e-4;
  const throughHole = wantRecess && args.recessMm >= plate - 1e-6;
  const recessDepth = wantRecess
    ? throughHole
      ? plate
      : Math.min(Math.max(0.05, args.recessMm), plate)
    : 0;

  if (throughHole) {
    // Full cut-outs through the plate
    const platePaths = differenceD(
      [toPath(outline)],
      recessedPaths,
      FillRule.NonZero,
      2,
    );
    for (const ring of groupRings(platePaths)) {
      const mesh = extrude(ring.outer, ring.holes, plate, 0, PLATE_COLOR);
      if (mesh) group.add(mesh);
    }
    const recessLoops = groupRings(recessedPaths).flatMap((r) => [
      r.outer,
      ...r.holes,
    ]);
    // Edge of the hole on the top face
    addFeatureEdges(group, recessLoops, plate + 0.02, RECESS_EDGE_COLOR);
  } else {
    const baseH = plate - recessDepth;
    if (baseH > 1e-4) {
      const base = extrude(
        outline,
        [],
        baseH,
        0,
        recessDepth > 1e-4 ? RECESS_FLOOR_COLOR : PLATE_COLOR,
      );
      if (base) group.add(base);
    }
    if (recessDepth > 1e-4) {
      const topPaths = differenceD(
        [toPath(outline)],
        recessedPaths,
        FillRule.NonZero,
        2,
      );
      for (const ring of groupRings(topPaths)) {
        const mesh = extrude(ring.outer, ring.holes, recessDepth, baseH, PLATE_COLOR);
        if (mesh) group.add(mesh);
      }
      const recessLoops = groupRings(recessedPaths).flatMap((r) => [
        r.outer,
        ...r.holes,
      ]);
      // Outline the recess pocket on top + floor (makes flat walls readable)
      addFeatureEdges(group, recessLoops, plate + 0.02, RECESS_EDGE_COLOR);
      addFeatureEdges(group, recessLoops, baseH + 0.02, RECESS_EDGE_COLOR);
    }
  }

  const raiseH = Math.max(0, args.raiseMm);
  if (raiseH > 1e-4 && raisedPaths.length) {
    for (const ring of groupRings(raisedPaths)) {
      const mesh = extrude(ring.outer, ring.holes, raiseH, plate, RAISE_COLOR, {
        raised: true,
      });
      if (mesh) group.add(mesh);
    }
  }
  return group;
}
