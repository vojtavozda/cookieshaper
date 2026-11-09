/**
 * Boolean-union every mesh under an object into one connected solid.
 * PrusaSlicer splits an STL by triangle connectivity, so stacked bevel
 * slabs stay separate until they are unioned.
 */

import * as THREE from "three";
import Module from "manifold-3d";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url";

type ManifoldWasm = Awaited<ReturnType<typeof Module>>;

let wasmPromise: Promise<ManifoldWasm> | null = null;

function wasm(): Promise<ManifoldWasm> {
  if (!wasmPromise) {
    wasmPromise = Module({
      // Bundled JS would otherwise request manifold.wasm next to the script
      // and receive index.html (not a wasm module).
      locateFile: () => manifoldWasmUrl,
    })
      .then((m) => {
        m.setup();
        return m;
      })
      .catch((err) => {
        wasmPromise = null;
        throw err;
      });
  }
  return wasmPromise;
}

/** Warm the wasm module so the first assembly/ZIP export is snappier. */
export function preloadUnionWasm(): void {
  void wasm();
}

function yieldToMain(): Promise<void> {
  const sched = (
    globalThis as unknown as {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function indexedMesh(geo: THREE.BufferGeometry): {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
} | null {
  const attr = geo.getAttribute("position");
  if (!attr || attr.count < 3) return null;
  const vertProperties = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    vertProperties[i * 3] = attr.getX(i);
    vertProperties[i * 3 + 1] = attr.getY(i);
    vertProperties[i * 3 + 2] = attr.getZ(i);
  }
  const index = geo.getIndex();
  const triVerts = index
    ? Uint32Array.from(index.array as ArrayLike<number>)
    : Uint32Array.from({ length: attr.count }, (_, i) => i);
  if (triVerts.length < 3 || triVerts.length % 3 !== 0) return null;
  return { vertProperties, triVerts };
}

/** One watertight solid from all meshes in `root` (world space). */
export async function unionObjectGeometry(
  root: THREE.Object3D,
): Promise<THREE.BufferGeometry> {
  const api = await wasm();
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
  });

  const parts: InstanceType<ManifoldWasm["Manifold"]>[] = [];
  let firstError: unknown = null;
  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    const data = indexedMesh(g);
    g.dispose();
    if (!data) continue;
    try {
      // Extrusions don't share vertices, so weld coincident ones first.
      const gl = new api.Mesh({
        numProp: 3,
        vertProperties: data.vertProperties,
        triVerts: data.triVerts,
      });
      gl.merge();
      parts.push(new api.Manifold(gl));
    } catch (err) {
      firstError ??= err;
      console.warn("Skipped a non-manifold piece while unioning", err);
    }
    // Yield periodically so the UI stays responsive during large unions.
    if ((mi + 1) % 4 === 0) await yieldToMain();
  }
  if (!parts.length) {
    const detail =
      firstError instanceof Error ? firstError.message : "mesh was not solid";
    throw new Error(`No solid geometry to export (${detail})`);
  }
  await yieldToMain();
  const merged = parts.length === 1 ? parts[0] : api.Manifold.union(parts);
  if (parts.length > 1) {
    for (const p of parts) p.delete();
  }
  const out = merged.getMesh();
  const pieces = merged.decompose();
  for (const p of pieces) p.delete();
  merged.delete();
  if (pieces.length > 1) {
    console.warn(
      `Union left ${pieces.length} shells — slicer split may still separate them`,
    );
  }
  const geo = new THREE.BufferGeometry();
  const stride = out.numProp;
  const n = out.vertProperties.length / stride;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = out.vertProperties[i * stride];
    positions[i * 3 + 1] = out.vertProperties[i * stride + 1];
    positions[i * 3 + 2] = out.vertProperties[i * stride + 2];
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(Array.from(out.triVerts));
  return geo;
}
