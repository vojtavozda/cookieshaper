import {
  DEFAULT_PARAMS,
  type BuildMethod,
  type CutterParams,
  type WallProfileMode,
} from "./types";
import { DEFAULT_PROJECT_NAME, projectDisplayName } from "./projectName";

const PARAMS_KEY = "pernickovac.params";
const METHOD_KEY = "pernickovac.buildMethod";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Merge stored slider values onto defaults (unknown keys ignored). */
export function loadParams(): CutterParams {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return { ...DEFAULT_PARAMS };
    const parsed = JSON.parse(raw) as Partial<CutterParams>;
    const next = { ...DEFAULT_PARAMS };
    (Object.keys(DEFAULT_PARAMS) as (keyof CutterParams)[]).forEach((key) => {
      if (isFiniteNumber(parsed[key])) next[key] = parsed[key] as number;
    });
    return next;
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export function saveParams(params: CutterParams) {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
  } catch {
    /* private mode / quota */
  }
}

export function loadBuildMethod(fallback: BuildMethod = "clipper2"): BuildMethod {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    if (v === "current" || v === "stacked" || v === "clipper2") return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function saveBuildMethod(method: BuildMethod) {
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    /* ignore */
  }
}

const GRID_KEY = "pernickovac.snapGrid";

export function loadSnapGrid(): boolean {
  try {
    return localStorage.getItem(GRID_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSnapGrid(on: boolean) {
  try {
    localStorage.setItem(GRID_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const ORTHO_KEY = "pernickovac.orthographic";
const TIP_HL_KEY = "pernickovac.highlightTip";
const WALL_PROFILE_KEY = "pernickovac.wallProfile";

export function loadWallProfileMode(
  fallback: WallProfileMode = "hidden",
): WallProfileMode {
  try {
    const v = localStorage.getItem(WALL_PROFILE_KEY);
    if (v === "hidden" || v === "large") return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function saveWallProfileMode(mode: WallProfileMode) {
  try {
    localStorage.setItem(WALL_PROFILE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function loadOrthographic(): boolean {
  try {
    return localStorage.getItem(ORTHO_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOrthographic(on: boolean) {
  try {
    localStorage.setItem(ORTHO_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadHighlightTip(): boolean {
  try {
    return localStorage.getItem(TIP_HL_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHighlightTip(on: boolean) {
  try {
    localStorage.setItem(TIP_HL_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const WIRE_KEY = "pernickovac.wireframe";
const SHOW_COOKIE_KEY = "pernickovac.showCookie";
const EDGE_HL_KEY = "pernickovac.edgeHighlights";
const COOKIE_EDGE_HL_KEY = "pernickovac.cookieEdgeHighlights";

export function loadWireframe(): boolean {
  try {
    return localStorage.getItem(WIRE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveWireframe(on: boolean) {
  try {
    localStorage.setItem(WIRE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadShowCookie(): boolean {
  try {
    return localStorage.getItem(SHOW_COOKIE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowCookie(on: boolean) {
  try {
    localStorage.setItem(SHOW_COOKIE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Edge overlays in cutter/stamp view (default on). */
export function loadEdgeHighlights(): boolean {
  try {
    const v = localStorage.getItem(EDGE_HL_KEY);
    if (v == null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

export function saveEdgeHighlights(on: boolean) {
  try {
    localStorage.setItem(EDGE_HL_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Edge overlays in cookie view (default off). */
export function loadCookieEdgeHighlights(): boolean {
  try {
    return localStorage.getItem(COOKIE_EDGE_HL_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCookieEdgeHighlights(on: boolean) {
  try {
    localStorage.setItem(COOKIE_EDGE_HL_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const SCALE_KEY = "pernickovac.mmPerPx";

/** Paper-unit → mm scale from measure / Size. null = not calibrated yet. */
export function loadMmPerPx(): number | null {
  try {
    const v = localStorage.getItem(SCALE_KEY);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveMmPerPx(mmPerPx: number) {
  try {
    localStorage.setItem(SCALE_KEY, String(mmPerPx));
  } catch {
    /* ignore */
  }
}

const BMC_STYLE_KEY = "pernickovac.bmcStyle";

export type BmcStyle = "button" | "widget";

/** Panel button (default) vs floating Buy Me a Coffee widget. */
export function loadBmcStyle(): BmcStyle {
  try {
    const v = localStorage.getItem(BMC_STYLE_KEY);
    if (v === "widget" || v === "button") return v;
  } catch {
    /* ignore */
  }
  return "button";
}

export function saveBmcStyle(style: BmcStyle) {
  try {
    localStorage.setItem(BMC_STYLE_KEY, style);
  } catch {
    /* ignore */
  }
}

const SPLIT_KEY = "pernickovac.splitLeftFrac";
const SPLIT_COLLAPSED_KEY = "pernickovac.splitCollapsed";
const SPLIT_DEFAULT = 0.45;

export type SplitLayout = {
  /** Canvas width while the 3D pane is open (0.25–0.75). */
  leftFrac: number;
  collapsed: boolean;
};

function clampSplitFrac(n: number, fallback = SPLIT_DEFAULT): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.75, Math.max(0.25, n));
}

/** Canvas | 3D divider, including a fully hidden 3D pane. */
export function loadSplitLayout(): SplitLayout {
  try {
    const v = localStorage.getItem(SPLIT_KEY);
    const n = v == null ? SPLIT_DEFAULT : Number(v);
    const collapsed = localStorage.getItem(SPLIT_COLLAPSED_KEY) === "1";
    return { leftFrac: clampSplitFrac(n), collapsed };
  } catch {
    return { leftFrac: SPLIT_DEFAULT, collapsed: false };
  }
}

export function saveSplitLayout(layout: SplitLayout) {
  try {
    localStorage.setItem(SPLIT_KEY, String(clampSplitFrac(layout.leftFrac)));
    localStorage.setItem(SPLIT_COLLAPSED_KEY, layout.collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const PROJECT_NAME_KEY = "pernickovac.projectName";
const COFFEE_FOLLOW_SHOWS_KEY = "pernickovac.coffeeFollowShows";
const COFFEE_FOLLOW_HIDE_KEY = "pernickovac.coffeeFollowHide";

/** Canvas project title used for downloads (default Pernickovadlo). */
export function loadProjectName(): string {
  try {
    const v = localStorage.getItem(PROJECT_NAME_KEY);
    if (v == null || !v.trim()) return DEFAULT_PROJECT_NAME;
    return projectDisplayName(v);
  } catch {
    return DEFAULT_PROJECT_NAME;
  }
}

export function saveProjectName(name: string) {
  try {
    localStorage.setItem(PROJECT_NAME_KEY, projectDisplayName(name));
  } catch {
    /* ignore */
  }
}

const SKETCH_TABS_BAR_VISIBLE_KEY = "pernickovac.sketchTabsBarVisible";

/** Whether the full-width sketch tab strip is shown. */
export function loadSketchTabsBarVisible(): boolean {
  try {
    const v = localStorage.getItem(SKETCH_TABS_BAR_VISIBLE_KEY);
    if (v === null) return true;
    return v !== "0";
  } catch {
    return true;
  }
}

export function saveSketchTabsBarVisible(visible: boolean) {
  try {
    localStorage.setItem(SKETCH_TABS_BAR_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const CLOSE_TAB_CONFIRM_HIDE_KEY = "pernickovac.closeTabConfirmHide";

/** Skip the “delete this sketch tab?” confirmation. */
export function loadCloseTabConfirmHidden(): boolean {
  try {
    return localStorage.getItem(CLOSE_TAB_CONFIRM_HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCloseTabConfirmHidden(hidden: boolean) {
  try {
    localStorage.setItem(CLOSE_TAB_CONFIRM_HIDE_KEY, hidden ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** User opted out of the post-download coffee / issue dialog. */
export function loadCoffeeFollowUpHidden(): boolean {
  try {
    return localStorage.getItem(COFFEE_FOLLOW_HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCoffeeFollowUpHidden(hidden: boolean) {
  try {
    localStorage.setItem(COFFEE_FOLLOW_HIDE_KEY, hidden ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadCoffeeFollowUpShows(): number {
  try {
    const n = Number(localStorage.getItem(COFFEE_FOLLOW_SHOWS_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Bump and persist how many times the follow-up dialog was shown. */
export function bumpCoffeeFollowUpShows(): number {
  const next = loadCoffeeFollowUpShows() + 1;
  try {
    localStorage.setItem(COFFEE_FOLLOW_SHOWS_KEY, String(next));
  } catch {
    /* ignore */
  }
  return next;
}
