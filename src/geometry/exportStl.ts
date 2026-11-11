import * as THREE from "three";
import { mergeGroupGeometry } from "./buildCutter";
import { saveBlob, type SaveResult } from "./saveBlob";
import { unionObjectGeometry } from "./unionSolid";

/** Let the browser paint / handle input between heavy sync chunks. */
function yieldToMain(): Promise<void> {
  const sched = (
    globalThis as unknown as {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function triangleCount(geo: THREE.BufferGeometry): number {
  const index = geo.index;
  if (index) return Math.floor(index.count / 3);
  const pos = geo.getAttribute("position");
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Binary STL (80-byte header + uint32 count + 50 bytes/triangle).
 * Far cheaper than ASCII string building, which was freezing the UI.
 */
async function geometryToBinaryStl(
  geo: THREE.BufferGeometry,
  solidName: string,
): Promise<Uint8Array> {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const index = geo.index;
  const nTri = triangleCount(geo);
  const out = new Uint8Array(84 + nTri * 50);
  const view = new DataView(out.buffer);
  const enc = new TextEncoder();
  const header = enc.encode(`binary ${solidName}`.slice(0, 80));
  out.set(header, 0);
  view.setUint32(80, nTri, true);

  const writeTri = (offset: number, a: number, b: number, c: number) => {
    const ax = pos.getX(a);
    const ay = pos.getY(a);
    const az = pos.getZ(a);
    const bx = pos.getX(b);
    const by = pos.getY(b);
    const bz = pos.getZ(b);
    const cx = pos.getX(c);
    const cy = pos.getY(c);
    const cz = pos.getZ(c);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
  };

  const YIELD_EVERY = 8000;
  let written = 0;
  let o = 84;

  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      writeTri(o, index.getX(i), index.getX(i + 1), index.getX(i + 2));
      o += 50;
      written++;
      if (written % YIELD_EVERY === 0) await yieldToMain();
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      writeTri(o, i, i + 1, i + 2);
      o += 50;
      written++;
      if (written % YIELD_EVERY === 0) await yieldToMain();
    }
  }

  return out;
}

/** Append triangles from `geo` into an existing binary STL buffer builder. */
async function appendBinaryTriangles(
  geos: THREE.BufferGeometry[],
  solidName: string,
): Promise<Uint8Array> {
  let nTri = 0;
  for (const g of geos) nTri += triangleCount(g);
  const out = new Uint8Array(84 + nTri * 50);
  const view = new DataView(out.buffer);
  const enc = new TextEncoder();
  out.set(enc.encode(`binary ${solidName}`.slice(0, 80)), 0);
  view.setUint32(80, nTri, true);

  const YIELD_EVERY = 8000;
  let written = 0;
  let o = 84;

  for (const geo of geos) {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const index = geo.index;
    const writeTri = (a: number, b: number, c: number) => {
      const ax = pos.getX(a);
      const ay = pos.getY(a);
      const az = pos.getZ(a);
      const bx = pos.getX(b);
      const by = pos.getY(b);
      const bz = pos.getZ(b);
      const cx = pos.getX(c);
      const cy = pos.getY(c);
      const cz = pos.getZ(c);
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      view.setFloat32(o, nx / nl, true);
      view.setFloat32(o + 4, ny / nl, true);
      view.setFloat32(o + 8, nz / nl, true);
      view.setFloat32(o + 12, ax, true);
      view.setFloat32(o + 16, ay, true);
      view.setFloat32(o + 20, az, true);
      view.setFloat32(o + 24, bx, true);
      view.setFloat32(o + 28, by, true);
      view.setFloat32(o + 32, bz, true);
      view.setFloat32(o + 36, cx, true);
      view.setFloat32(o + 40, cy, true);
      view.setFloat32(o + 44, cz, true);
      view.setUint16(o + 48, 0, true);
      o += 50;
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        writeTri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        written++;
        if (written % YIELD_EVERY === 0) await yieldToMain();
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        writeTri(i, i + 1, i + 2);
        written++;
        if (written % YIELD_EVERY === 0) await yieldToMain();
      }
    }
  }

  return out;
}

/** Minimal ZIP (store only) so cutter + stamp can download as one archive. */
function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length);
    local.set([0x50, 0x4b, 0x03, 0x04]);
    local.set(u16(20), 4);
    local.set(u16(0), 6);
    local.set(u16(0), 8); // store
    local.set(u16(0), 10);
    local.set(u16(0), 12);
    local.set(u32(crc), 14);
    local.set(u32(f.data.length), 18);
    local.set(u32(f.data.length), 22);
    local.set(u16(nameBytes.length), 26);
    local.set(u16(0), 28);
    local.set(nameBytes, 30);
    parts.push(local, f.data);

    const cen = new Uint8Array(46 + nameBytes.length);
    cen.set([0x50, 0x4b, 0x01, 0x02]);
    cen.set(u16(20), 4);
    cen.set(u16(20), 6);
    cen.set(u16(0), 8);
    cen.set(u16(0), 10);
    cen.set(u16(0), 12);
    cen.set(u16(0), 14);
    cen.set(u32(crc), 16);
    cen.set(u32(f.data.length), 20);
    cen.set(u32(f.data.length), 24);
    cen.set(u16(nameBytes.length), 28);
    cen.set(u16(0), 30);
    cen.set(u16(0), 32);
    cen.set(u16(0), 34);
    cen.set(u16(0), 36);
    cen.set(u32(0), 38);
    cen.set(u32(offset), 42);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + f.data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  end.set([0x50, 0x4b, 0x05, 0x06]);
  end.set(u16(0), 4);
  end.set(u16(0), 6);
  end.set(u16(files.length), 8);
  end.set(u16(files.length), 10);
  end.set(u32(centralSize), 12);
  end.set(u32(offset), 16);
  end.set(u16(0), 20);

  const total =
    parts.reduce((n, p) => n + p.length, 0) +
    centralSize +
    end.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  for (const p of central) {
    out.set(p, o);
    o += p.length;
  }
  out.set(end, o);
  return new Blob([out], { type: "application/zip" });
}

function partGroups(root: THREE.Group): {
  cutter: THREE.Object3D | null;
  stamp: THREE.Object3D | null;
} {
  let cutter: THREE.Object3D | null = null;
  let stamp: THREE.Object3D | null = null;
  for (const child of root.children) {
    if (child.userData.part === "stamp") stamp = child;
    else if (child.userData.part === "cutter") cutter = child;
  }
  // Fallback: treat whole root as cutter
  if (!cutter && !stamp) cutter = root;
  return { cutter, stamp };
}

async function stlBytesForPart(
  part: THREE.Object3D,
  solidName: string,
): Promise<Uint8Array> {
  await yieldToMain();
  const geo = mergeGroupGeometry(part as THREE.Group, { normals: false });
  await yieldToMain();
  const bytes = await geometryToBinaryStl(geo, solidName);
  geo.dispose();
  return bytes;
}

/**
 * Cutter and stamp in one STL: each is boolean-unioned into a single solid
 * so PrusaSlicer Split → To parts yields two parts, still nested.
 * Binary STL packs both disconnected shells into one file.
 */
export async function downloadAssemblyStl(
  group: THREE.Group,
  filename = "pernicek-cutter-stamp.stl",
): Promise<SaveResult | false> {
  const bytes = await cutterStampStlBytes(group);
  if (!bytes) return false;
  return saveBlob(new Blob([bytes], { type: "model/stl" }), filename);
}

/** Nested cutter + stamp in one binary STL, or null if either part is missing. */
export async function cutterStampStlBytes(
  group: THREE.Group,
): Promise<Uint8Array | null> {
  return assemblyStlBytes(group);
}

async function assemblyStlBytes(group: THREE.Group): Promise<Uint8Array | null> {
  const { cutter, stamp } = partGroups(group);
  if (!cutter || !stamp) return null;
  await yieldToMain();
  const cutterGeo = await unionObjectGeometry(cutter);
  await yieldToMain();
  const stampGeo = await unionObjectGeometry(stamp);
  await yieldToMain();
  const bytes = await appendBinaryTriangles(
    [cutterGeo, stampGeo],
    "cutter-stamp",
  );
  cutterGeo.dispose();
  stampGeo.dispose();
  return bytes;
}

export async function downloadCutterStl(
  group: THREE.Group,
  filename = "pernicek-cutter.stl",
): Promise<SaveResult | false> {
  const { cutter } = partGroups(group);
  if (!cutter) return false;
  return saveBlob(
    new Blob([await stlBytesForPart(cutter, "cutter")], { type: "model/stl" }),
    filename,
  );
}

export async function downloadStampStl(
  group: THREE.Group,
  filename = "pernicek-stamp.stl",
): Promise<SaveResult | false> {
  const { stamp } = partGroups(group);
  if (!stamp) return false;
  return saveBlob(
    new Blob([await stlBytesForPart(stamp, "stamp")], { type: "model/stl" }),
    filename,
  );
}

/** Static stamp-handle STL served from /public. */
export const HOLDER_STL_URL = "/pernickovadlo_holder.stl";
export const HOLDER_STL_NAME = "pernickovadlo_holder.stl";

export async function fetchHolderStlBytes(): Promise<Uint8Array> {
  const res = await fetch(HOLDER_STL_URL);
  if (!res.ok) throw new Error(`Could not load ${HOLDER_STL_NAME}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function downloadHolderStl(
  filename = HOLDER_STL_NAME,
): Promise<SaveResult | false> {
  const bytes = await fetchHolderStlBytes();
  return saveBlob(new Blob([bytes], { type: "model/stl" }), filename);
}

/** ZIP with cutter (+ stamp when present). Optional extra files (e.g. sketch PDF). */
export async function downloadProjectZip(
  group: THREE.Group,
  extras: { name: string; data: Uint8Array }[] = [],
  zipName = "pernicek.zip",
  /** Basename used for STL entries inside the ZIP (defaults from zipName). */
  fileBase?: string,
): Promise<SaveResult | false> {
  const base =
    (fileBase && fileBase.trim()) ||
    zipName.replace(/\.zip$/i, "").trim() ||
    "pernicek";
  const { cutter, stamp } = partGroups(group);
  const files: { name: string; data: Uint8Array }[] = [...extras];
  if (cutter) {
    files.push({
      name: `${base}-cutter.stl`,
      data: await stlBytesForPart(cutter, "cutter"),
    });
    await yieldToMain();
  }
  if (stamp) {
    files.push({
      name: `${base}-stamp.stl`,
      data: await stlBytesForPart(stamp, "stamp"),
    });
    await yieldToMain();
  }
  if (cutter && stamp) {
    const assembly = await assemblyStlBytes(group);
    if (assembly) {
      files.push({ name: `${base}-cutter-stamp.stl`, data: assembly });
    }
  }
  try {
    files.push({
      name: `${base}-holder.stl`,
      data: await fetchHolderStlBytes(),
    });
  } catch {
    // Keep the rest of the ZIP if the static holder asset is missing.
  }
  if (!files.length) return false;
  await yieldToMain();
  return saveBlob(zipStore(files), zipName);
}

/** Save an already-built file list as one ZIP. */
export async function downloadFilesZip(
  files: { name: string; data: Uint8Array }[],
  zipName = "pernicek.zip",
): Promise<SaveResult | false> {
  if (!files.length) return false;
  await yieldToMain();
  return saveBlob(zipStore(files), zipName);
}

/** @deprecated Prefer downloadCutterStl / downloadProjectZip. */
export async function downloadStl(
  group: THREE.Group,
  filename = "cookie-cutter.stl",
): Promise<SaveResult | false> {
  const { cutter, stamp } = partGroups(group);
  if (cutter && stamp) {
    return downloadProjectZip(group, [], filename.replace(/\.stl$/i, "") + ".zip");
  }
  return downloadCutterStl(group, filename);
}
