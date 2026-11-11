/**
 * Crash / refresh recovery for the sketch canvas.
 * Path JSON is tiny; optional background JPEG lives in IndexedDB (not localStorage).
 */

import type { SegSnap } from "./pathEdit";
import type { StampParams } from "../types";
import { DEFAULT_STAMP } from "../types";
import { DEFAULT_PROJECT_NAME, projectDisplayName } from "../projectName";

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
  hole?: boolean;
  widthMm?: number;
  filled?: boolean;
  /** Bézier that is the stamp rim’s outer edge. Cutter is derived. */
  stampPlate?: boolean;
  /** Cutter generated from the stamp-plate path with this id. */
  derivedFromId?: string;
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
const TABS_KEY = "sketchTabs";

export type SketchTab = { id: string; name: string };
export type SketchTabIndex = { activeId: string; tabs: SketchTab[] };

function tabMetaKey(id: string) {
  return `sketchTab:${id}`;
}
function tabBgKey(id: string) {
  return `sketchTabBg:${id}`;
}

export function newSketchTabId(): string {
  return crypto.randomUUID();
}

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

export type SketchDraftRecord = {
  meta: SketchDraftMeta;
  background: Blob | null;
};

async function readDraft(
  metaKey: string,
  bgKey: string,
): Promise<SketchDraftRecord | null> {
  const meta = await idbGet<SketchDraftMeta>(metaKey);
  if (!meta || meta.version !== SKETCH_DRAFT_VERSION) return null;
  if (!Array.isArray(meta.items)) return null;
  // A background-only draft is valid (no paths yet).
  if (meta.items.length === 0 && !meta.hasBackground) return null;
  let background: Blob | null = null;
  if (meta.hasBackground) {
    const bg = await idbGet<Blob>(bgKey);
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
}

async function writeDraft(
  metaKey: string,
  bgKey: string,
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
  await idbSet(metaKey, payload);
  if (payload.hasBackground && meta.background) {
    await idbSet(bgKey, meta.background);
  } else {
    await idbDel(bgKey);
  }
}

export async function loadSketchDraft(): Promise<SketchDraftRecord | null> {
  try {
    return await readDraft(META_KEY, BG_KEY);
  } catch {
    return null;
  }
}

export async function saveSketchDraft(
  meta: Omit<SketchDraftMeta, "version" | "savedAt" | "hasBackground"> & {
    background: Blob | null;
  },
): Promise<void> {
  await writeDraft(META_KEY, BG_KEY, meta);
}

export async function clearSketchDraft(): Promise<void> {
  try {
    await idbDel(META_KEY);
    await idbDel(BG_KEY);
  } catch {
    /* ignore */
  }
}

function normalizeTabs(raw: SketchTabIndex | undefined): SketchTabIndex | null {
  if (!raw || !Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs
    .filter((t) => t && typeof t.id === "string" && t.id)
    .map((t) => ({
      id: t.id,
      name: projectDisplayName(typeof t.name === "string" ? t.name : ""),
    }));
  if (!tabs.length) return null;
  const activeId = tabs.some((t) => t.id === raw.activeId)
    ? raw.activeId
    : tabs[0].id;
  return { activeId, tabs };
}

export async function loadSketchTabIndex(): Promise<SketchTabIndex | null> {
  try {
    return normalizeTabs(await idbGet<SketchTabIndex>(TABS_KEY));
  } catch {
    return null;
  }
}

export async function saveSketchTabIndex(index: SketchTabIndex): Promise<void> {
  const tabs = index.tabs.map((t) => ({
    id: t.id,
    name: projectDisplayName(t.name),
  }));
  const activeId = tabs.some((t) => t.id === index.activeId)
    ? index.activeId
    : tabs[0]?.id;
  if (!activeId) return;
  await idbSet(TABS_KEY, { activeId, tabs });
}

export async function loadTabDraft(id: string): Promise<SketchDraftRecord | null> {
  try {
    return await readDraft(tabMetaKey(id), tabBgKey(id));
  } catch {
    return null;
  }
}

export async function saveTabDraft(
  id: string,
  meta: Omit<SketchDraftMeta, "version" | "savedAt" | "hasBackground"> & {
    background: Blob | null;
  },
): Promise<void> {
  await writeDraft(tabMetaKey(id), tabBgKey(id), meta);
}

export async function deleteTabDraft(id: string): Promise<void> {
  try {
    await idbDel(tabMetaKey(id));
    await idbDel(tabBgKey(id));
  } catch {
    /* ignore */
  }
}

/** First launch: one tab, copying the legacy single draft when one exists. */
export async function ensureSketchTabs(fallbackName: string): Promise<SketchTabIndex> {
  const existing = await loadSketchTabIndex();
  if (existing) return existing;
  const id = newSketchTabId();
  const legacy = await loadSketchDraft();
  if (legacy) {
    await saveTabDraft(id, {
      items: legacy.meta.items,
      mmPerPx: legacy.meta.mmPerPx,
      stamp: legacy.meta.stamp,
      stampOwnerId: legacy.meta.stampOwnerId,
      bgPlace: legacy.meta.bgPlace,
      background: legacy.background,
    });
  }
  const index: SketchTabIndex = {
    activeId: id,
    tabs: [{ id, name: projectDisplayName(fallbackName || DEFAULT_PROJECT_NAME) }],
  };
  await saveSketchTabIndex(index);
  return index;
}
