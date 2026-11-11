import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  Button,
  Snackbar,
  SvgIcon,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import * as THREE from "three";
import { DrawCanvas, type CanvasSaveApi } from "./components/DrawCanvas";
import { ToolRail, type CanvasMode } from "./components/ToolRail";
import { ParamsPanel } from "./components/ParamsPanel";
import { Viewer3D } from "./components/Viewer3D";
import { CrossSection } from "./components/CrossSection";
import { SplitPane } from "./components/SplitPane";
import {
  SketchTabsBar,
  SKETCH_TAB_BG,
  SKETCH_TAB_FG,
} from "./components/SketchTabsBar";
import {
  CoffeeFollowUpDialog,
  DownloadDialog,
  type DownloadChoice,
} from "./components/DownloadDialog";
import type { SketchTab } from "./geometry/sketchDraft";
import { buildCutter } from "./geometry/buildCutter";
import {
  cutterStampStlBytes,
  downloadAssemblyStl,
  downloadCutterStl,
  downloadFilesZip,
  downloadHolderStl,
  fetchHolderStlBytes,
  downloadStampStl,
} from "./geometry/exportStl";
import { bboxSize } from "./geometry/offset";
import {
  DEFAULT_STAMP,
  THICKNESS_PRESETS,
  type CutterParams,
  type BuildMethod,
  type SizeReadout,
  type StampFeatureIn,
  type StampParams,
  type Vec2,
  type WallProfileMode,
} from "./types";
import {
  loadBuildMethod,
  loadCoffeeFollowUpHidden,
  loadMmPerPx,
  loadParams,
  loadProjectName,
  loadSketchTabsBarVisible,
  loadSnapGrid,
  loadSplitLayout,
  loadWallProfileMode,
  saveBuildMethod,
  saveMmPerPx,
  saveParams,
  saveProjectName,
  saveSketchTabsBarVisible,
  saveSnapGrid,
  saveSplitLayout,
  saveWallProfileMode,
} from "./storage";
import { buildCookie, buildStamp } from "./geometry/buildStamp";
import { projectExportNames, uniqueFileBase } from "./projectName";
import { ChevronDown, Coffee, SaveCheck, Star, Upload } from "lucide-react";

const BMC_HREF = "https://www.buymeacoffee.com/vojtavozda";
const BMC_SHOW_CLASS = "bmc-show-widget";

/** Open the Buy Me a Coffee iframe widget (script in index.html), not a new tab. */
function openBuyMeACoffeeWidget() {
  const btn = document.getElementById("bmc-wbtn");
  if (!(btn instanceof HTMLElement)) {
    window.open(BMC_HREF, "_blank", "noopener,noreferrer");
    return;
  }
  // Floater is CSS-hidden until this class is set; click opens the BMC overlay.
  document.body.classList.add(BMC_SHOW_CLASS);
  btn.click();
  // Hide the floating button again; the overlay stays open on its own.
  requestAnimationFrame(() => {
    document.body.classList.remove(BMC_SHOW_CLASS);
  });
}

/** Lucide no longer ships brand marks — classic GitHub glyph. */
function GithubIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.09.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12c0-5.523-4.477-10-10-10z" />
    </SvgIcon>
  );
}

/** Subtle keycap for hint-bar shortcuts. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: "inline-block",
        px: 0.5,
        py: "1px",
        mx: "1px",
        borderRadius: 0.5,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: "action.hover",
        fontFamily: "inherit",
        fontSize: "0.92em",
        fontWeight: 600,
        lineHeight: 1.25,
        color: "text.primary",
        boxShadow: "0 1px 0 rgba(0,0,0,0.06)",
      }}
    >
      {children}
    </Box>
  );
}

function exportSizeMm(
  pts: Vec2[],
  mmPerPx: number | null,
  fallback: number,
): number {
  if (mmPerPx == null || mmPerPx <= 0) return fallback;
  const { width, height } = bboxSize(pts);
  const longPx = Math.max(width, height);
  if (longPx <= 1e-9) return fallback;
  return Math.min(300, Math.max(10, Math.round(longPx * mmPerPx * 10) / 10));
}

function buildDownloadRoot(
  pts: Vec2[],
  p: CutterParams,
  method: BuildMethod,
  features: StampFeatureIn[],
  sp: StampParams,
  outlinePx: Vec2[] | null,
): THREE.Group {
  const { group } = buildCutter(pts, p, method);
  group.userData.part = "cutter";
  group.traverse((o) => {
    o.userData.part = "cutter";
  });
  const root = new THREE.Group();
  root.add(group);
  root.add(
    buildStamp({
      cutterPx: pts,
      sizeMm: p.sizeMm,
      wallMm: p.wallThicknessMm,
      gapMm: sp.gapMm,
      plateMm: sp.plateMm,
      raiseMm: sp.raiseMm,
      recessMm: sp.recessMm,
      features,
      outlineEnabled: sp.outlineEnabled,
      outlineWidthMm: sp.outlineWidthMm,
      outlinePx,
    }),
  );
  return root;
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}

function hintParts(...parts: ReactNode[]) {
  return parts.reduce<ReactNode[]>((acc, part, i) => {
    if (i > 0) acc.push(" · ");
    acc.push(<span key={i}>{part}</span>);
    return acc;
  }, []);
}

export default function App() {
  const [stars, setStars] = useState<number | null>(null);
  const [params, setParams] = useState<CutterParams>(() => loadParams());
  const [liveUpdate, setLiveUpdate] = useState(true);
  const [path, setPath] = useState<Vec2[] | null>(null);
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [deleteToken, setDeleteToken] = useState(0);
  const [clearToken, setClearToken] = useState(0);
  const [imagePanelToken, setImagePanelToken] = useState(0);
  const [imagePanelOpen, setImagePanelOpen] = useState(false);
  const [undoToken, setUndoToken] = useState(0);
  const [redoToken, setRedoToken] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [smoothAvailable, setSmoothAvailable] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [simplifyTolerance, setSimplifyTolerance] = useState(1);
  const [snapGrid, setSnapGrid] = useState(() => loadSnapGrid());
  const [snapCurves, setSnapCurves] = useState(false);
  const [stamp, setStamp] = useState<StampParams>({ ...DEFAULT_STAMP });
  const [stampFeatures, setStampFeatures] = useState<StampFeatureIn[] | null>(null);
  /** Plate-edge samples when the stamp outline was drawn before the cutter. */
  const [stampOutlinePx, setStampOutlinePx] = useState<Vec2[] | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("draw");
  const [buildMethod, setBuildMethod] = useState<BuildMethod>(() =>
    loadBuildMethod("clipper2"),
  );
  const [lastDrawMode, setLastDrawMode] = useState<
    "draw" | "polygon" | "ellipse"
  >("draw");
  const [wallProfileMode, setWallProfileMode] = useState<WallProfileMode>(() =>
    loadWallProfileMode("hidden"),
  );
  const [presetRevert, setPresetRevert] = useState<{
    params: CutterParams;
    stamp: StampParams;
  } | null>(null);
  const [meshGroup, setMeshGroup] = useState<THREE.Group | null>(null);
  const [sizeReadout, setSizeReadout] = useState<SizeReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** Paper → mm; calibrated by measure or Size. Independent of having a closed path. */
  const [mmPerPx, setMmPerPx] = useState<number | null>(() => loadMmPerPx());
  const meshRef = useRef<THREE.Group | null>(null);
  const saveApiRef = useRef<CanvasSaveApi | null>(null);
  const [hasCurves, setHasCurves] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [coffeeFollowUp, setCoffeeFollowUp] = useState(false);
  const [projectName, setProjectName] = useState(() => loadProjectName());
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const [sketchTabs, setSketchTabs] = useState<SketchTab[]>([]);
  const [activeSketchId, setActiveSketchId] = useState<string | null>(null);
  const [tabsBarVisible, setTabsBarVisible] = useState(() =>
    loadSketchTabsBarVisible(),
  );

  const hasClosedPath = !!path && path.length >= 3;
  const pathLongPx = useMemo(() => {
    if (!path || path.length < 3) return null;
    const { width, height } = bboxSize(path);
    const longPx = Math.max(width, height);
    return longPx > 1e-9 ? longPx : null;
  }, [path]);
  const rebuildTimer = useRef<number | null>(null);
  const appliedKeyRef = useRef("");
  const [needsApply, setNeedsApply] = useState(false);

  const sceneKey = useCallback(
    (
      pts: Vec2[],
      p: CutterParams,
      method: BuildMethod,
      features: StampFeatureIn[] | null,
      sp: StampParams,
      outlinePx: Vec2[] | null,
    ) => JSON.stringify({ pts, p, method, features, sp, outlinePx }),
    [],
  );

  const rebuild = useCallback(
    (
      pts: Vec2[],
      p: CutterParams,
      method: BuildMethod,
      features: StampFeatureIn[] | null,
      sp: StampParams,
      outlinePx: Vec2[] | null,
    ) => {
      try {
        const { group, widthMm, heightMm } = buildCutter(pts, p, method);
        group.userData.part = "cutter";
        group.traverse((o) => {
          o.userData.part = "cutter";
        });
        const root = new THREE.Group();
        root.add(group);
        const stampArgs = {
          cutterPx: pts,
          sizeMm: p.sizeMm,
          wallMm: p.wallThicknessMm,
          gapMm: sp.gapMm,
          plateMm: sp.plateMm,
          raiseMm: sp.raiseMm,
          recessMm: sp.recessMm,
          features: features ?? [],
          outlineEnabled: sp.outlineEnabled,
          outlineWidthMm: sp.outlineWidthMm,
          outlinePx,
        };
        if (features) root.add(buildStamp(stampArgs));
        const cookie = buildCookie(stampArgs);
        cookie.visible = false;
        cookie.traverse((o) => {
          o.userData.part = "cookie";
        });
        root.add(cookie);
        meshRef.current = root;
        setMeshGroup(root);
        setSizeReadout({ widthMm, heightMm });
        setError(null);
        appliedKeyRef.current = sceneKey(pts, p, method, features, sp, outlinePx);
        setNeedsApply(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to build cutter");
      }
    },
    [sceneKey],
  );

  const scheduleRebuild = useCallback(
    (
      pts: Vec2[],
      p: CutterParams,
      method: BuildMethod,
      features: StampFeatureIn[] | null,
      sp: StampParams,
      outlinePx: Vec2[] | null,
      delayMs: number,
    ) => {
      if (rebuildTimer.current != null) window.clearTimeout(rebuildTimer.current);
      rebuildTimer.current = window.setTimeout(() => {
        rebuildTimer.current = null;
        rebuild(pts, p, method, features, sp, outlinePx);
      }, delayMs);
    },
    [rebuild],
  );

  useEffect(() => {
    saveParams(params);
  }, [params]);

  useEffect(() => {
    fetch("https://api.github.com/repos/vojtavozda/cookieshaper")
      .then((res) => res.json())
      .then((data: { stargazers_count?: number }) => {
        if (typeof data.stargazers_count === "number") setStars(data.stargazers_count);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    saveBuildMethod(buildMethod);
  }, [buildMethod]);

  useEffect(() => {
    saveSnapGrid(snapGrid);
  }, [snapGrid]);

  useEffect(() => {
    saveWallProfileMode(wallProfileMode);
  }, [wallProfileMode]);

  useEffect(() => {
    if (mmPerPx != null && mmPerPx > 0) saveMmPerPx(mmPerPx);
  }, [mmPerPx]);

  useEffect(() => {
    saveProjectName(projectName);
  }, [projectName]);

  // Keep Size in sync with the calibrated scale when the outline changes
  useEffect(() => {
    if (mmPerPx == null || pathLongPx == null) return;
    const next = Math.min(300, Math.max(10, Math.round(pathLongPx * mmPerPx * 10) / 10));
    setParams((p) => (Math.abs(p.sizeMm - next) < 0.05 ? p : { ...p, sizeMm: next }));
  }, [pathLongPx, mmPerPx]);

  useEffect(() => {
    if (!hasClosedPath || !path) {
      if (rebuildTimer.current != null) window.clearTimeout(rebuildTimer.current);
      setMeshGroup(null);
      meshRef.current = null;
      setSizeReadout(null);
      appliedKeyRef.current = "";
      setNeedsApply(false);
      return;
    }
    if (liveUpdate) {
      scheduleRebuild(path, params, buildMethod, stampFeatures, stamp, stampOutlinePx, 50);
    } else {
      setNeedsApply(
        sceneKey(path, params, buildMethod, stampFeatures, stamp, stampOutlinePx) !==
          appliedKeyRef.current,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, hasClosedPath, buildMethod, liveUpdate, scheduleRebuild, sceneKey, stampFeatures, stamp, stampOutlinePx]);

  useEffect(() => {
    if (!hasClosedPath || !path) return;
    if (liveUpdate) {
      scheduleRebuild(path, params, buildMethod, stampFeatures, stamp, stampOutlinePx, 120);
    } else {
      setNeedsApply(
        sceneKey(path, params, buildMethod, stampFeatures, stamp, stampOutlinePx) !==
          appliedKeyRef.current,
      );
    }
  }, [params, buildMethod, liveUpdate, hasClosedPath, path, scheduleRebuild, sceneKey, stamp, stampFeatures, stampOutlinePx]);

  /** Always-defined scale for measure UI (fallback 1 mm per paper unit). */
  const measureMmPerPx =
    mmPerPx ??
    (pathLongPx != null ? params.sizeMm / pathLongPx : 1);

  const canStamp = !!(meshGroup && stampFeatures);
  const canCutter = !!meshGroup;

  const handleDownloadChoice = useCallback(
    async (
      choice: DownloadChoice,
      onProgress?: (done: number, total: number) => void,
    ) => {
    const mesh = meshRef.current;
    const names = projectExportNames(projectNameRef.current);
    if (choice === "sketch") {
      const result = await saveApiRef.current?.savePdf();
      return result === "saved";
    }
    if (choice === "cutter") {
      const result = mesh ? await downloadCutterStl(mesh, names.cutter) : false;
      if (!result) throw new Error("No cutter mesh to export");
      return result === "saved";
    }
    if (choice === "stamp") {
      const result = mesh ? await downloadStampStl(mesh, names.stamp) : false;
      if (!result) throw new Error("No stamp mesh to export");
      return result === "saved";
    }
    if (choice === "assembly") {
      const result = mesh
        ? await downloadAssemblyStl(mesh, names.assembly)
        : false;
      if (!result) throw new Error("Need both a cutter and a stamp");
      return result === "saved";
    }
    if (choice === "holder") {
      const result = await downloadHolderStl(names.holder);
      if (!result) throw new Error("Could not download stamp holder");
      return result === "saved";
    }
    const sketches = (await saveApiRef.current?.collectZipSketches()) ?? [];
    const files: { name: string; data: Uint8Array }[] = [];
    const used = new Set<string>();
    const total = sketches.length;
    const paint = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    for (let i = 0; i < sketches.length; i++) {
      const sk = sketches[i];
      onProgress?.(i, total);
      await paint();
      const base = uniqueFileBase(sk.name, used);
      if (sk.pdf) files.push({ name: `${base}.pdf`, data: sk.pdf });
      if (!sk.pts || sk.pts.length < 3 || !sk.features) {
        onProgress?.(i + 1, total);
        continue;
      }
      try {
        const root = buildDownloadRoot(
          sk.pts,
          { ...params, sizeMm: exportSizeMm(sk.pts, sk.mmPerPx, params.sizeMm) },
          buildMethod,
          sk.features,
          sk.stamp,
          sk.outlinePx,
        );
        const stl = await cutterStampStlBytes(root);
        disposeObject3D(root);
        if (stl) files.push({ name: `${base}-cutter-stamp.stl`, data: stl });
      } catch {
        /* This tab stays in the ZIP as a sketch only. */
      }
      onProgress?.(i + 1, total);
    }
    if (!files.length) throw new Error("Nothing to put in the ZIP");
    try {
      files.push({
        name: "stamp-holder.stl",
        data: await fetchHolderStlBytes(),
      });
    } catch {
      /* Keep the sketches if the static holder asset is missing. */
    }
    const zipName =
      sketches.length > 1 ? "pernickovadla.zip" : names.zip;
    const result = await downloadFilesZip(files, zipName);
    if (!result) throw new Error("Nothing to put in the ZIP");
    return result === "saved";
  },
  [params, buildMethod],
  );

  const sketchHint = useMemo(() => {
    const ctrlZ = (
      <>
        <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd>
      </>
    );
    if (canvasMode === "edit") {
      return hintParts(
        "Edit",
        "drag box / curve to move",
        "corners scale · outside rotates",
        "double-click for curve edit",
        <>
          <Kbd>Esc</Kbd> deselect
        </>,
        <>
          <Kbd>Space</Kbd>/middle pan
        </>,
        ctrlZ,
      );
    }
    if (canvasMode === "curveEdit") {
      return hintParts(
        "Curve edit",
        <>
          <Kbd>Shift</Kbd>+click adds point
        </>,
        <>
          <Kbd>Del</Kbd> removes hover
        </>,
        <>
          <Kbd>Esc</Kbd> back to edit
        </>,
        <>
          <Kbd>Space</Kbd>/middle pan
        </>,
        ctrlZ,
      );
    }
    if (canvasMode === "measure") {
      return hintParts(
        "Measure",
        "click segment or point→point",
        "drag free measure",
        "edit length sets scale",
        <>
          <Kbd>Space</Kbd>/middle pan
        </>,
        <>
          <Kbd>Esc</Kbd> cancel
        </>,
      );
    }
    if (canvasMode === "polygon") {
      return hintParts(
        snapGrid ? "Polygon · grid on" : "Polygon: click vertices",
        <>
          <Kbd>Ctrl</Kbd> snaps 15°
        </>,
        "snap ends to continue",
        "click first to close",
        <>
          <Kbd>Enter</Kbd> open finish
        </>,
        <>
          <Kbd>Esc</Kbd>
          {snapGrid ? "" : " cancel"}
        </>,
        <>
          <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> removes last point
        </>,
      );
    }
    if (canvasMode === "ellipse") {
      return hintParts(
        "Ellipse",
        "drag corner to corner",
        <>
          <Kbd>Ctrl</Kbd> circle
        </>,
        <>
          <Kbd>Shift</Kbd> from pinned center
        </>,
        <>
          <Kbd>Space</Kbd>/middle pan
        </>,
        ctrlZ,
      );
    }
    return hintParts(
      snapGrid ? "Draw · grid on" : "Draw",
      "snap ends to continue",
      <>
        <Kbd>Space</Kbd>/middle pan
      </>,
      <>
        <Kbd>Esc</Kbd>
        {snapGrid ? "" : " cancel"}
      </>,
      <>
        {ctrlZ}
        {snapGrid ? "" : " undo"}
      </>,
    );
  }, [canvasMode, snapGrid]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box
        sx={{
          px: 2,
          py: 0.75,
          bgcolor: "primary.main",
          color: "primary.contrastText",
          display: "flex",
          alignItems: "stretch",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "stretch",
            gap: 1,
            minWidth: 0,
            alignSelf: "stretch",
          }}
        >
          {!tabsBarVisible && (
            <Tooltip title="Show tabs">
              <Button
                size="small"
                aria-label="Show tabs"
                onClick={() => {
                  setTabsBarVisible(true);
                  saveSketchTabsBarVisible(true);
                }}
                sx={{
                  textTransform: "none",
                  color: SKETCH_TAB_FG,
                  minWidth: 0,
                  px: 0.85,
                  py: 0.15,
                  minHeight: 0,
                  alignSelf: "stretch",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  bgcolor: SKETCH_TAB_BG ?? "transparent",
                  "&:hover": {
                    bgcolor: "rgba(0,0,0,0.28)",
                    color: "#fff8f3",
                  },
                }}
              >
                <ChevronDown size={16} strokeWidth={2} />
              </Button>
            </Tooltip>
          )}
          <Box
            component="span"
            sx={{
              fontWeight: 700,
              letterSpacing: 0.3,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Perníčkovadlo — Cookie shaper
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "stretch", gap: 0.75 }}>
          <Button
            component="a"
            href="https://github.com/vojtavozda/cookieshaper"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            startIcon={<GithubIcon sx={{ fontSize: 16 }} />}
            sx={{
              textTransform: "none",
              color: "primary.contrastText",
              borderColor: "rgba(255,255,255,0.55)",
              px: 1.25,
              py: 0.15,
              minHeight: 0,
              "&:hover": {
                borderColor: "#111",
                bgcolor: "#111",
                color: "#fff",
              },
            }}
            variant="outlined"
          >
            GitHub
            {stars != null && (
              <>
                <Box
                  component="span"
                  aria-hidden
                  sx={{
                    width: "1px",
                    height: 14,
                    mx: 0.85,
                    bgcolor: "currentColor",
                    opacity: 0.55,
                  }}
                />
                <Star size={14} strokeWidth={2} />
                <Box
                  component="span"
                  sx={{ ml: 0.4, fontVariantNumeric: "tabular-nums" }}
                >
                  {stars}
                </Box>
              </>
            )}
          </Button>
          <Tooltip title="Hate ads? Support this project and buy me a coffee!" enterDelay={300}>
            <Button
              size="small"
              aria-label="Hate ads? Support this project and buy me a coffee!"
              onClick={openBuyMeACoffeeWidget}
              sx={{
                textTransform: "none",
                color: "primary.contrastText",
                borderColor: "rgba(255,255,255,0.55)",
                minWidth: 0,
                px: 0.85,
                py: 0.15,
                minHeight: 0,
                alignSelf: "stretch",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                "&:hover": {
                  borderColor: "#FFDD00",
                  bgcolor: "#FFDD00",
                  color: "#000",
                },
              }}
              variant="outlined"
            >
              <Coffee size={16} strokeWidth={2} />
            </Button>
          </Tooltip>
        </Box>
      </Box>

      {tabsBarVisible && (
        <SketchTabsBar
          tabs={sketchTabs}
          activeId={activeSketchId}
          onSelect={(id) => {
            void saveApiRef.current?.switchSketchTab(id);
          }}
          onCloseTab={(id) => {
            void saveApiRef.current?.requestCloseTab(id);
          }}
          onNewTab={() => {
            void saveApiRef.current?.openFreshTab();
          }}
          onOpenLibrary={() => {
            saveApiRef.current?.openLibrary();
          }}
          onHide={() => {
            setTabsBarVisible(false);
            saveSketchTabsBarVisible(false);
          }}
        />
      )}

      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <ToolRail
          mode={canvasMode}
          onModeChange={(m) => {
            if (m === "draw" || m === "polygon" || m === "ellipse")
              setLastDrawMode(m);
            setCanvasMode(m);
          }}
          simplifyTolerance={simplifyTolerance}
          onSimplifyChange={setSimplifyTolerance}
          showSmooth={smoothAvailable}
          snapGrid={snapGrid}
          onSnapGridChange={setSnapGrid}
          snapCurves={snapCurves}
          onSnapCurvesChange={setSnapCurves}
          imagePanelOpen={imagePanelOpen}
          onOpenImagePanel={() => {
            setImagePanelToken((t) => t + 1);
            setImagePanelOpen(true);
          }}
          canDelete={hasSelection}
          onDeleteCurrent={() => setDeleteToken((t) => t + 1)}
          canClearCanvas={hasCurves || !!bgUrl || !!path || !!stampFeatures}
          onClearCanvas={() => setClearToken((t) => t + 1)}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={() => setUndoToken((t) => t + 1)}
          onRedo={() => setRedoToken((t) => t + 1)}
          canSaveDraft={hasCurves}
          onSaveDraft={() => {
            void saveApiRef.current?.saveDraft?.();
          }}
        />

        <SplitPane
          initialLeftFrac={loadSplitLayout().leftFrac}
          initialCollapsed={loadSplitLayout().collapsed}
          onLayoutChange={saveSplitLayout}
          left={
            <Box
              sx={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
                <DrawCanvas
                  backgroundUrl={bgUrl}
                  mode={canvasMode}
                  simplifyTolerance={simplifyTolerance}
                  snapGrid={snapGrid}
                  snapCurves={snapCurves}
                  wallThicknessMm={params.wallThicknessMm}
                  stampGapMm={stamp.gapMm}
                  onStampGapChange={(gapMm) => setStamp((s) => ({ ...s, gapMm }))}
                  stampOutlineEnabled={stamp.outlineEnabled}
                  onStampOutlineEnabledChange={(outlineEnabled) =>
                    setStamp((s) => ({ ...s, outlineEnabled }))
                  }
                  stampOutlineWidthMm={stamp.outlineWidthMm}
                  onStampOutlineWidthChange={(outlineWidthMm) =>
                    setStamp((s) => ({ ...s, outlineWidthMm }))
                  }
                  stamp={stamp}
                  onStampChange={setStamp}
                  onDraftSaved={setToast}
                  onSketchPdfSaved={() => {
                    if (!loadCoffeeFollowUpHidden()) setCoffeeFollowUp(true);
                  }}
                  projectName={projectName}
                  onProjectNameChange={setProjectName}
                  onSketchTabsChange={(tabs, activeId) => {
                    setSketchTabs(tabs);
                    setActiveSketchId(activeId);
                  }}
                  meshQuality={params.meshQuality}
                  onStampFeatures={(features, outline) => {
                    setStampFeatures(features);
                    setStampOutlinePx(
                      outline && outline.length >= 3 ? outline : null,
                    );
                  }}
                  mmPerPx={measureMmPerPx}
                  onMmPerPxChange={setMmPerPx}
                  onClosedPathChange={setPath}
                  onHasSelectionChange={setHasSelection}
                  onSelectedSimplifyChange={(tol) => {
                    setSmoothAvailable(tol != null);
                    if (tol != null) setSimplifyTolerance(tol);
                  }}
                  onModeChange={(m) => {
                    if (m === "draw" || m === "polygon" || m === "ellipse")
                      setLastDrawMode(m);
                    setCanvasMode(m);
                  }}
                  onHistoryChange={(u, r) => {
                    setCanUndo(u);
                    setCanRedo(r);
                  }}
                  onCurveClosed={() => {
                    // Keep freehand / polygon / ellipse active so the next shape
                    // can be drawn immediately (important in stamp mode).
                    setCanvasMode((m) =>
                      m === "draw" || m === "polygon" || m === "ellipse"
                        ? m
                        : "edit",
                    );
                  }}
                  onCurvesEmpty={() => setCanvasMode(lastDrawMode)}
                  onImportBackground={(url) => {
                    if (bgUrl) URL.revokeObjectURL(bgUrl);
                    setBgUrl(url);
                  }}
                  onClearBackground={() => {
                    if (bgUrl) URL.revokeObjectURL(bgUrl);
                    setBgUrl(null);
                  }}
                  imagePanelToken={imagePanelToken}
                  onImagePanelOpenChange={setImagePanelOpen}
                  deleteToken={deleteToken}
                  clearToken={clearToken}
                  undoToken={undoToken}
                  redoToken={redoToken}
                  onHasCurvesChange={setHasCurves}
                  saveApiRef={saveApiRef}
                />
              </Box>
              <Box
                sx={{
                  flexShrink: 0,
                  px: 1.5,
                  py: 0.75,
                  borderTop: 1,
                  borderColor: "divider",
                  bgcolor: "background.paper",
                  color: "text.secondary",
                  fontSize: 12,
                  lineHeight: 1.4,
                  userSelect: "none",
                }}
              >
                {sketchHint}
              </Box>
            </Box>
          }
          right={
            <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
              {hasClosedPath ? (
                <Viewer3D
                  group={meshGroup}
                  liveUpdate={liveUpdate}
                  needsApply={needsApply}
                  onLiveUpdateChange={setLiveUpdate}
                  onApply={() =>
                    path &&
                      rebuild(path, params, buildMethod, stampFeatures, stamp, stampOutlinePx)
                  }
                />
              ) : (
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "#f0f2f5",
                    px: 3,
                  }}
                >
                  <Typography
                    color="text.secondary"
                    align="center"
                    sx={{ userSelect: "none" }}
                  >
                    Close a path on the left to preview the 3D cutter here
                  </Typography>
                </Box>
              )}
              {wallProfileMode !== "hidden" && (
                <Box
                  sx={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    zIndex: 3,
                    maxWidth: "calc(100% - 60px)",
                    maxHeight: "calc(100% - 16px)",
                  }}
                >
                  <CrossSection
                    params={params}
                    stamp={stampFeatures ? stamp : null}
                    onHide={() => setWallProfileMode("hidden")}
                  />
                </Box>
              )}
            </Box>
          }
        />

        <ParamsPanel
          params={params}
          sizeReadout={sizeReadout}
          enabled
          wallProfileMode={wallProfileMode}
          method={buildMethod}
          onMethodChange={setBuildMethod}
          onChange={(next) => {
            // Manual slider edit invalidates the one-step preset revert.
            setPresetRevert(null);
            setParams(next);
            if (
              pathLongPx != null &&
              Math.abs(next.sizeMm - params.sizeMm) > 1e-6
            ) {
              setMmPerPx(next.sizeMm / pathLongPx);
            }
          }}
          onThicknessPreset={(id) => {
            const preset = THICKNESS_PRESETS.find((p) => p.id === id);
            if (!preset) return;
            setPresetRevert({ params: { ...params }, stamp: { ...stamp } });
            // Keep current Size — it's driven by the drawing / measure
            setParams((p) => ({
              ...preset.params,
              sizeMm: p.sizeMm,
              meshQuality: p.meshQuality,
            }));
            // Fit gap and raised outline are independent of thickness presets
            setStamp((s) => ({
              ...preset.stamp,
              gapMm: s.gapMm,
              outlineEnabled: s.outlineEnabled,
              outlineWidthMm: s.outlineWidthMm,
            }));
          }}
          canRevertPreset={presetRevert != null}
          onRevertPreset={() => {
            if (!presetRevert) return;
            setParams(presetRevert.params);
            setStamp(presetRevert.stamp);
            setPresetRevert(null);
          }}
          onShowWallProfile={() => setWallProfileMode("large")}
          onHideWallProfile={() => setWallProfileMode("hidden")}
          stamp={stampFeatures ? stamp : null}
          onStampChange={(next) => {
            setPresetRevert(null);
            setStamp(next);
          }}
          onDownload={() => setDownloadOpen(true)}
        />
      </Box>

      <DownloadDialog
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        canSketch={hasCurves}
        canCutter={canCutter}
        canStamp={canStamp}
        onChoose={handleDownloadChoice}
      />
      <CoffeeFollowUpDialog
        open={coffeeFollowUp}
        onClose={() => setCoffeeFollowUp(false)}
      />

      <Snackbar
        open={!!error}
        autoHideDuration={5000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!toast}
        autoHideDuration={2500}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1.25,
            minWidth: 280,
            px: 2.5,
            py: 1.25,
            borderRadius: 1,
            bgcolor: "grey.900",
            color: "common.white",
            boxShadow: 3,
          }}
          role="status"
        >
          {toast?.toLowerCase().includes("restored") ? (
            <Upload size={18} strokeWidth={2} aria-hidden />
          ) : (
            <SaveCheck size={18} strokeWidth={2} aria-hidden />
          )}
          <Typography component="span" variant="body2">
            {toast}
          </Typography>
        </Box>
      </Snackbar>
    </Box>
  );
}
