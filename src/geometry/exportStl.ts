import * as THREE from "three";
import { mergeGroupGeometry } from "./buildCutter";
import { saveBlob, type SaveResult } from "./saveBlob";

function geometryToAsciiStl(geo: THREE.BufferGeometry, solidName: string): string {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const index = geo.index;
  let triangles = "";

  const writeTri = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ) => {
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
    triangles += `facet normal ${nx} ${ny} ${nz}\n outer loop\n`;
    triangles += `  vertex ${ax} ${ay} ${az}\n`;
    triangles += `  vertex ${bx} ${by} ${bz}\n`;
    triangles += `  vertex ${cx} ${cy} ${cz}\n`;
    triangles += ` endloop\nendfacet\n`;
  };

  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      writeTri(
        pos.getX(a),
        pos.getY(a),
        pos.getZ(a),
        pos.getX(b),
        pos.getY(b),
        pos.getZ(b),
        pos.getX(c),
        pos.getY(c),
        pos.getZ(c),
      );
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      writeTri(
        pos.getX(i),
        pos.getY(i),
        pos.getZ(i),
        pos.getX(i + 1),
        pos.getY(i + 1),
        pos.getZ(i + 1),
        pos.getX(i + 2),
        pos.getY(i + 2),
        pos.getZ(i + 2),
      );
    }
  }

  return `solid ${solidName}\n${triangles}endsolid ${solidName}\n`;
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

function stlBytesForPart(part: THREE.Object3D, solidName: string): Uint8Array {
  const geo = mergeGroupGeometry(part as THREE.Group);
  const stl = geometryToAsciiStl(geo, solidName);
  geo.dispose();
  return new TextEncoder().encode(stl);
}

export async function downloadCutterStl(
  group: THREE.Group,
  filename = "pernicek-cutter.stl",
): Promise<SaveResult | false> {
  const { cutter } = partGroups(group);
  if (!cutter) return false;
  return saveBlob(
    new Blob([stlBytesForPart(cutter, "cutter")], { type: "model/stl" }),
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
    new Blob([stlBytesForPart(stamp, "stamp")], { type: "model/stl" }),
    filename,
  );
}

/** ZIP with cutter (+ stamp when present). Optional extra files (e.g. sketch PDF). */
export async function downloadProjectZip(
  group: THREE.Group,
  extras: { name: string; data: Uint8Array }[] = [],
  zipName = "pernicek.zip",
): Promise<SaveResult | false> {
  const { cutter, stamp } = partGroups(group);
  const files: { name: string; data: Uint8Array }[] = [...extras];
  if (cutter) {
    files.push({ name: "pernicek-cutter.stl", data: stlBytesForPart(cutter, "cutter") });
  }
  if (stamp) {
    files.push({ name: "pernicek-stamp.stl", data: stlBytesForPart(stamp, "stamp") });
  }
  if (!files.length) return false;
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
