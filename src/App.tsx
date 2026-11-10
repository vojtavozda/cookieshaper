import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Box, Button, Snackbar, SvgIcon, Typography } from "@mui/material";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import * as THREE from "three";
import { DrawCanvas, type CanvasSaveApi } from "./components/DrawCanvas";
import { ToolRail, type CanvasMode } from "./components/ToolRail";
import { ParamsPanel } from "./components/ParamsPanel";
import { Viewer3D } from "./components/Viewer3D";
import { CrossSection } from "./components/CrossSection";
import { SplitPane } from "./components/SplitPane";
import {
  DownloadDialog,
  type DownloadChoice,
} from "./components/DownloadDialog";
import { buildCutter } from "./geometry/buildCutter";
import {
  downloadAssemblyStl,
  downloadCutterStl,
  downloadHolderStl,
  downloadProjectZip,
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
  loadMmPerPx,
  loadParams,
  loadSnapGrid,
  loadSplitLayout,
  saveBuildMethod,
  saveMmPerPx,
  saveParams,
  saveSnapGrid,
  saveSplitLayout,
} from "./storage";
import { buildStamp } from "./geometry/buildStamp";

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

function hintParts(...parts: ReactNode[]) {
  return parts.reduce<ReactNode[]>((acc, part, i) => {
    if (i > 0) acc.push(" · ");
    acc.push(<span key={i}>{part}</span>);
    return acc;
  }, []);
}

export default function App() {
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
  const [wallProfileMode, setWallProfileMode] = useState<WallProfileMode>("large");
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
        if (features) {
          const stampGroup = buildStamp({
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
          });
          root.add(stampGroup);
        }
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
    saveBuildMethod(buildMethod);
  }, [buildMethod]);

  useEffect(() => {
    saveSnapGrid(snapGrid);
  }, [snapGrid]);

  useEffect(() => {
    if (mmPerPx != null && mmPerPx > 0) saveMmPerPx(mmPerPx);
  }, [mmPerPx]);

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

  const handleDownloadChoice = useCallback(async (choice: DownloadChoice) => {
    const mesh = meshRef.current;
    if (choice === "sketch") {
      const result = await saveApiRef.current?.savePdf();
      return result === "saved";
    }
    if (choice === "cutter") {
      const result = mesh ? await downloadCutterStl(mesh) : false;
      if (!result) throw new Error("No cutter mesh to export");
      return result === "saved";
    }
    if (choice === "stamp") {
      const result = mesh ? await downloadStampStl(mesh) : false;
      if (!result) throw new Error("No stamp mesh to export");
      return result === "saved";
    }
    if (choice === "assembly") {
      const result = mesh ? await downloadAssemblyStl(mesh) : false;
      if (!result) throw new Error("Need both a cutter and a stamp");
      return result === "saved";
    }
    if (choice === "holder") {
      const result = await downloadHolderStl();
      if (!result) throw new Error("Could not download stamp holder");
      return result === "saved";
    }
    const extras: { name: string; data: Uint8Array }[] = [];
    const pdf = await saveApiRef.current?.buildPdfBytes();
    if (pdf) extras.push({ name: "pernicek.pdf", data: pdf });
    const root = mesh ?? new THREE.Group();
    const result = await downloadProjectZip(root, extras);
    if (!result) throw new Error("Nothing to put in the ZIP");
    return result === "saved";
  }, []);

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
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Box component="span" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
          Perníčkovadlo — Cookie shaper
        </Box>
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
              borderColor: "primary.contrastText",
              bgcolor: "rgba(255,255,255,0.12)",
            },
          }}
          variant="outlined"
        >
          GitHub
        </Button>
      </Box>

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
                <>
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
                  {wallProfileMode !== "hidden" && (
                    <Box
                      sx={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        left: 52,
                        zIndex: 3,
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
                </>
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
            </Box>
          }
        />

        <ParamsPanel
          params={params}
          sizeReadout={sizeReadout}
          enabled={hasClosedPath}
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
            setParams((p) => ({ ...preset.params, sizeMm: p.sizeMm }));
            setStamp({ ...preset.stamp });
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
        message={toast}
      />
    </Box>
  );
}
