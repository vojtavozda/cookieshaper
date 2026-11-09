/**
 * Crash / refresh recovery for the sketch canvas.
 * Path JSON is tiny; optional background JPEG lives in IndexedDB (not localStorage).
 */

import type { SegSnap } from "./pathEdit";
import type { StampParams } from "../types";
import { DEFAULT_STAMP } from "../types";

export const SKETCH_DRAFT_VERSION = 1 as const;

export type SketchDraftItem = {
  raw: SegSnap[];
  smooth: boolean[];
  closed: boolean;
  lockIndex: number;
  simplifyTol?: number;
  noSimplify?: boolean;
  id?: string;
  role?: "cutter" | "feature";
  stampId?: string;
  ownerId?: string;
  raised?: boolean;
  widthMm?: number;
  filled?: boolean;
};

export type SketchDraftMeta = {
  version: typeof SKETCH_DRAFT_VERSION;
  savedAt: number;
  items: SketchDraftItem[];
  mmPerPx: number | null;
  stamp: StampParams;
  /** Cutter currently open in stamp-edit mode, if any. */
  stampOwnerId: string | null;
  bgPlace: { x: number; y: number; width: number; height: number } | null;
  /** True when a background blob was stored alongside this draft. */
  hasBackground: boolean;
};

const DB_NAME = "cookieshaper";
const DB_VERSION = 1;
const STORE = "kv";
const META_KEY = "sketchDraft";
const BG_KEY = "sketchDraftBg";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

function idbSet(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
      }),
  );
}

function idbDel(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
      }),
  );
}

function normalizeStamp(raw: unknown): StampParams {
  const s = (raw ?? {}) as Partial<StampParams>;
  return {
    gapMm: Number.isFinite(s.gapMm) ? (s.gapMm as number) : DEFAULT_STAMP.gapMm,
    plateMm: Number.isFinite(s.plateMm)
      ? (s.plateMm as number)
      : DEFAULT_STAMP.plateMm,
    raiseMm: Number.isFinite(s.raiseMm)
      ? (s.raiseMm as number)
      : DEFAULT_STAMP.raiseMm,
    recessMm: Number.isFinite(s.recessMm)
      ? (s.recessMm as number)
      : DEFAULT_STAMP.recessMm,
    outlineEnabled:
      typeof s.outlineEnabled === "boolean"
        ? s.outlineEnabled
        : DEFAULT_STAMP.outlineEnabled,
    outlineWidthMm: Number.isFinite(s.outlineWidthMm)
      ? (s.outlineWidthMm as number)
      : DEFAULT_STAMP.outlineWidthMm,
  };
}

export async function loadSketchDraft(): Promise<{
  meta: SketchDraftMeta;
  background: Blob | null;
} | null> {
  try {
    const meta = await idbGet<SketchDraftMeta>(META_KEY);
    if (!meta || meta.version !== SKETCH_DRAFT_VERSION) return null;
    if (!Array.isArray(meta.items) || meta.items.length === 0) return null;
    let background: Blob | null = null;
    if (meta.hasBackground) {
      const bg = await idbGet<Blob>(BG_KEY);
      if (bg instanceof Blob && bg.size > 0) background = bg;
    }
    return {
      meta: {
        ...meta,
        stamp: normalizeStamp(meta.stamp),
        mmPerPx:
          meta.mmPerPx != null &&
          Number.isFinite(meta.mmPerPx) &&
          meta.mmPerPx > 0
            ? meta.mmPerPx
            : null,
      },
      background,
    };
  } catch {
    return null;
  }
}

export async function saveSketchDraft(
  meta: Omit<SketchDraftMeta, "version" | "savedAt" | "hasBackground"> & {
    background: Blob | null;
  },
): Promise<void> {
  const payload: SketchDraftMeta = {
    version: SKETCH_DRAFT_VERSION,
    savedAt: Date.now(),
    items: meta.items,
    mmPerPx: meta.mmPerPx,
    stamp: normalizeStamp(meta.stamp),
    stampOwnerId: meta.stampOwnerId,
    bgPlace: meta.bgPlace,
    hasBackground: !!(meta.background && meta.background.size > 0),
  };
  await idbSet(META_KEY, payload);
  if (payload.hasBackground && meta.background) {
    await idbSet(BG_KEY, meta.background);
  } else {
    await idbDel(BG_KEY);
  }
}

export async function clearSketchDraft(): Promise<void> {
  try {
    await idbDel(META_KEY);
    await idbDel(BG_KEY);
  } catch {
    /* ignore */
  }
}
