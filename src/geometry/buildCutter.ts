import * as THREE from "three";
import type { BuildMethod, CutterParams, Vec2 } from "../types";
import { addClipperBody, addStackedKnifeClipper } from "./buildClipper";
import {
  cleanClosedPolyline,
  ensureCcw,
  offsetClosed,
  offsetClosedRound,
  signedArea,
  toMm,
} from "./offset";
import { simplifyClosedCapped } from "./pathLimits";

const MAX_MID_PTS = 160;

function shapeFrom(pts: Vec2[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
  s.closePath();
  return s;
}

/** Opposite winding of `pts` (Three.js holes must oppose the outer path). */
function oppositeWinding(pts: Vec2[], outerArea: number): Vec2[] {
  const a = signedArea(pts);
  // Outer CCW (area>0) ⇒ hole CW (area<0), and vice versa
  if (outerArea > 0 === a > 0) return [...pts].reverse();
  return pts;
}

function extrudeRing(outer: Vec2[], inner: Vec2[] | null, height: number, z0 = 0): THREE.Mesh {
  const outerCCW = ensureCcw(outer);
  const shape = shapeFrom(outerCCW);
  if (inner && inner.length >= 3) {
    const holePts = oppositeWinding(inner, signedArea(outerCCW));
    const hole = new THREE.Path();
    hole.moveTo(holePts[0].x, holePts[0].y);
    for (let i = 1; i < holePts.length; i++) hole.lineTo(holePts[i].x, holePts[i].y);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, z0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe8d5b7,
    metalness: 0.05,
    roughness: 0.7,
  });
  return new THREE.Mesh(geo, mat);
}

/** 1 at convex/straight stations, fades to 0 on concave turns (no outward fillet). */
function filletOutwardWeight(mid: Vec2[], i: number): number {
  const n = mid.length;
  const prev = mid[(i - 1 + n) % n];
  const curr = mid[i];
  const next = mid[(i + 1) % n];
  const e1x = curr.x - prev.x;
  const e1y = curr.y - prev.y;
  const e2x = next.x - curr.x;
  const e2y = next.y - curr.y;
  const l1 = Math.hypot(e1x, e1y) || 1;
  const l2 = Math.hypot(e2x, e2y) || 1;
  const cross = (e1x / l1) * (e2y / l2) - (e1y / l1) * (e2x / l2);
  if (cross >= -1e-8) return 1; // convex or straight — full fillet
  const dot = Math.max(
    -1,
    Math.min(1, (e1x / l1) * (e2x / l2) + (e1y / l1) * (e2y / l2)),
  );
  const turn = Math.acos(dot); // radians of right turn
  // Mild dents keep some fillet; sharp concave Vs go to 0
  if (turn < 0.2) return 1;
  return Math.max(0, 1 - (turn - 0.2) / 1.2);
}

/** Distance along a ray to the first crossing of a closed polyline (Infinity if none). */
function rayHitDistance(origin: Vec2, dir: Vec2, ring: Vec2[], minT: number): number {
  let best = Infinity;
  const m = ring.length;
  for (let k = 0; k < m; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % m];
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const den = dir.x * sy - dir.y * sx;
    if (Math.abs(den) < 1e-12) continue;
    const qx = a.x - origin.x;
    const qy = a.y - origin.y;
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * dir.y - qy * dir.x) / den;
    if (t > minT && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

/**
 * Per-station fillet radius limited by the free space in front of the wall.
 * In a sharp concave V the opposite arm is close, and both arms carry a
 * fillet, so each side may use at most half the gap.
 */
function filletRadii(
  mid: Vec2[],
  wallOuter: Vec2[],
  normals: Vec2[],
  wallRing: Vec2[],
  radius: number,
): number[] {
  const n = wallOuter.length;
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const gap = rayHitDistance(wallOuter[i], normals[i], wallRing, 1e-3);
    const byGap = Number.isFinite(gap) ? gap * 0.45 : radius;
    radii.push(Math.max(0, Math.min(radius * filletOutwardWeight(mid, i), byGap)));
  }
  // Limit how fast the radius can grow between stations so it tapers smoothly
  // into the corner instead of jumping.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 2 * n; k++) {
      const i = k % n;
      const p = (i - 1 + n) % n;
      const step = Math.hypot(wallOuter[i].x - wallOuter[p].x, wallOuter[i].y - wallOuter[p].y);
      radii[i] = Math.min(radii[i], radii[p] + step);
    }
    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = k % n;
      const q = (i + 1) % n;
      const step = Math.hypot(wallOuter[i].x - wallOuter[q].x, wallOuter[i].y - wallOuter[q].y);
      radii[i] = Math.min(radii[i], radii[q] + step);
    }
  }
  return radii;
}

/**
 * Quarter-circle fillet between flange top and outer wall face.
 * 1:1 stations with the wall; each station's radius is clamped to the space
 * available in front of it so the sweep never crosses the opposite wall.
 */
function filletMesh(
  mid: Vec2[],
  wallOuter: Vec2[],
  normals: Vec2[],
  wallRing: Vec2[],
  baseHeight: number,
  radius: number,
  nArc = 4,
): THREE.Mesh | null {
  if (radius <= 0.05) return null;
  const n = Math.min(mid.length, wallOuter.length, normals.length);
  if (n < 3) return null;

  const radii = filletRadii(mid, wallOuter, normals, wallRing, radius);

  const stride = nArc + 2;
  const positions = new Float32Array(n * stride * 3);
  const thetas: number[] = [];
  for (let k = 0; k <= nArc; k++) thetas.push(Math.PI + (k / nArc) * (Math.PI / 2));

  for (let i = 0; i < n; i++) {
    const base = i * stride * 3;
    const localR = radii[i];
    const no = normals[i];
    const wx = wallOuter[i].x;
    const wy = wallOuter[i].y;
    for (let k = 0; k <= nArc; k++) {
      const theta = thetas[k];
      const s = localR * (1 + Math.cos(theta));
      const z = baseHeight + localR * (1 + Math.sin(theta));
      const idx = base + k * 3;
      positions[idx] = wx + no.x * s;
      positions[idx + 1] = wy + no.y * s;
      positions[idx + 2] = z;
    }
    // Right-angle corner: wall ∩ flange top
    const c = base + (nArc + 1) * 3;
    positions[c] = wx;
    positions[c + 1] = wy;
    positions[c + 2] = baseHeight;
  }

  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ci = i * stride + nArc + 1;
    const cj = j * stride + nArc + 1;
    for (let k = 0; k < nArc; k++) {
      const a0 = i * stride + k;
      const a1 = i * stride + k + 1;
      const b0 = j * stride + k;
      const b1 = j * stride + k + 1;
      indices.push(a0, a1, b1, a0, b1, b0);
    }
    const a0 = i * stride;
    const b0 = j * stride;
    indices.push(ci, a0, b0, ci, b0, cj);
    const aEnd = i * stride + nArc;
    const bEnd = j * stride + nArc;
    indices.push(ci, cj, bEnd, ci, bEnd, aEnd);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xe8d5b7, metalness: 0.05, roughness: 0.7 }),
  );
}

/**
 * Per-vertex outer/inner wall stations sharing one normal — keeps 1:1 topology
 * so deep concave Vs never need ExtrudeGeometry hole triangulation (which
 * invents artefact planes when offsets self-intersect).
 */
function offsetStations(
  mid: Vec2[],
  half: number,
  miterLimit = 2.5,
): { outer: Vec2[]; inner: Vec2[]; normals: Vec2[] } {
  const n = mid.length;
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = mid[(i - 1 + n) % n];
    const curr = mid[i];
    const next = mid[(i + 1) % n];
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n1x = e1y / l1;
    const n1y = -e1x / l1;
    const n2x = e2y / l2;
    const n2y = -e2x / l2;
    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    let nx: number;
    let ny: number;
    let scale: number;
    if (bl < 1e-8) {
      nx = n1x;
      ny = n1y;
      scale = half;
    } else {
      nx = bx / bl;
      ny = by / bl;
      const cosHalf = n1x * nx + n1y * ny;
      if (cosHalf < 1 / miterLimit) {
        // Sharp / deep V: no miter amplification (avoids crossing arms)
        scale = half;
      } else {
        scale = Math.min(half / cosHalf, miterLimit * half);
      }
    }
    normals.push({ x: nx, y: ny });
    outer.push({ x: curr.x + nx * scale, y: curr.y + ny * scale });
    inner.push({ x: curr.x - nx * scale, y: curr.y - ny * scale });
  }
  return { outer, inner, normals };
}

/**
 * Knife tip as stacked rings tapering to the midline (same approach as the bevel).
 * Topmost layer is tagged `userData.knifeTip` for viewer highlighting.
 */
function addStackedKnife(
  group: THREE.Group,
  mid: Vec2[],
  half: number,
  z0: number,
  knifeHeight: number,
  layerMm: number,
) {
  if (knifeHeight <= 1e-3 || half <= 1e-3) return;
  const step = Math.min(0.5, Math.max(0.1, layerMm || 0.2));
  const layers = Math.max(2, Math.min(40, Math.ceil(knifeHeight / step)));
  const dh = knifeHeight / layers;
  let tipMesh: THREE.Mesh | null = null;
  for (let i = 0; i < layers; i++) {
    const h0 = i * dh;
    const halfT = half * (1 - h0 / knifeHeight);
    if (halfT < 0.025) continue;
    const outer = ensureCcw(cleanClosedPolyline(offsetClosed(mid, halfT)));
    const inner = ensureCcw(cleanClosedPolyline(offsetClosed(mid, -halfT)));
    if (outer.length < 3 || inner.length < 3) continue;
    tipMesh = extrudeRing(outer, inner, dh, z0 + h0);
    group.add(tipMesh);
  }
  if (tipMesh) tipMesh.userData.knifeTip = true;
}

export type CutterBuild = {
  group: THREE.Group;
  midMm: Vec2[];
  widthMm: number;
  heightMm: number;
};

/** Horizontal reach of the quarter-circle fillet at height h above the flange. */
function filletReach(h: number, radius: number): number {
  const u = Math.min(1, Math.max(0, h / radius));
  return radius * (1 - Math.sqrt(Math.max(0, u * (2 - u))));
}

/**
 * Bevel as a stack of thin rings. Each ring is the outline offset by that
 * slice's reach, with self-intersection loops removed, so a sharp V is cut
 * instead of swept through.
 */
function addStackedFillet(
  group: THREE.Group,
  mid: Vec2[],
  half: number,
  radius: number,
  baseHeight: number,
  layerMm: number,
) {
  const step = Math.min(0.5, Math.max(0.1, layerMm || 0.25));
  const layers = Math.max(2, Math.min(40, Math.ceil(radius / step)));
  const dh = radius / layers;
  const inner = ensureCcw(cleanClosedPolyline(offsetClosed(mid, half)));
  for (let i = 0; i < layers; i++) {
    const h0 = i * dh;
    const reach = filletReach(h0, radius);
    if (reach < 0.05) continue;
    const outer = ensureCcw(cleanClosedPolyline(offsetClosed(mid, half + reach)));
    if (outer.length < 3) continue;
    group.add(extrudeRing(outer, inner, dh, baseHeight + h0));
  }
}

/**
 * Build cookie-cutter meshes from a closed screen-space path.
 * `current` and `stacked` share wall and base; only the bevel differs.
 * `clipper2` rebuilds wall, base and bevel from Clipper2 offsets.
 */
export function buildCutter(
  pathPx: Vec2[],
  params: CutterParams,
  method: BuildMethod = "current",
): CutterBuild {
  const scaled = toMm(pathPx, params.sizeMm);
  // Keep sketch corners. Only drop points that sit on a straight edge
  // (uniform resampling used to miss corners once sides were unequal).
  const mid = ensureCcw(simplifyClosedCapped(scaled.points, 0.05, MAX_MID_PTS));
  const half = params.wallThicknessMm / 2;
  const rim = Math.max(0, params.rimWidthMm);
  const baseH = Math.max(0, params.baseHeightMm);
  // Flange must extend past the outer wall face (rim > half)
  const wantBase = rim > half + 1e-6 && baseH > 1e-3;
  const { outer: stationOuter, normals: wallNormals } = offsetStations(mid, half);

  const group = new THREE.Group();
  if (method === "clipper2") {
    addClipperBody(group, mid, params);
  } else {
    const wallOuter = ensureCcw(cleanClosedPolyline(offsetClosed(mid, half)));
    const wallInner = ensureCcw(cleanClosedPolyline(offsetClosed(mid, -half)));

    if (wantBase) {
      // Round joins + loop cleanup — same idea as the stacked bevel outer rings
      const flangeOuter = cleanClosedPolyline(offsetClosedRound(mid, rim));
      group.add(extrudeRing(flangeOuter, mid, baseH, 0));
    }
    if (params.wallHeightMm > 1e-3) {
      group.add(extrudeRing(wallOuter, wallInner, params.wallHeightMm, 0));
    }

    if (wantBase && params.filletRadiusMm > 1e-3) {
      const maxR = Math.min(
        Math.max(0, rim - half),
        Math.max(0, params.wallHeightMm - baseH),
      );
      const r = Math.min(params.filletRadiusMm, maxR);
      if (r > 1e-3) {
        if (method === "stacked") {
          addStackedFillet(group, mid, half, r, baseH, params.bevelLayerMm);
        } else {
          const fillet = filletMesh(
            mid,
            stationOuter,
            wallNormals,
            wallOuter,
            baseH,
            r,
          );
          if (fillet) group.add(fillet);
        }
      }
    }
  }

  if (params.knifeHeightMm > 1e-3 && params.wallHeightMm > 1e-3) {
    if (method === "clipper2") {
      addStackedKnifeClipper(
        group,
        mid,
        half,
        params.wallHeightMm,
        params.knifeHeightMm,
        params.bevelLayerMm,
      );
    } else {
      addStackedKnife(
        group,
        mid,
        half,
        params.wallHeightMm,
        params.knifeHeightMm,
        params.bevelLayerMm,
      );
    }
  }

  return {
    group,
    midMm: mid,
    widthMm: scaled.widthMm,
    heightMm: scaled.heightMm,
  };
}

/** Merge all meshes in the group into one BufferGeometry for STL export. */
export function mergeGroupGeometry(group: THREE.Group): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  group.updateMatrixWorld(true);
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      geos.push(g);
    }
  });
  if (geos.length === 0) return new THREE.BufferGeometry();
  // Manual merge (avoid deprecated GeometryUtils dependency issues)
  let vertCount = 0;
  let idxCount = 0;
  for (const g of geos) {
    vertCount += g.getAttribute("position").count;
    idxCount += g.index ? g.index.count : g.getAttribute("position").count;
  }
  const positions = new Float32Array(vertCount * 3);
  const indices: number[] = [];
  let vOffset = 0;
  let pOffset = 0;
  for (const g of geos) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      positions[pOffset++] = pos.getX(i);
      positions[pOffset++] = pos.getY(i);
      positions[pOffset++] = pos.getZ(i);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + vOffset);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(vOffset + i);
    }
    vOffset += pos.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  return merged;
}
