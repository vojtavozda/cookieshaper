import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Box, Snackbar, Typography } from "@mui/material";
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
  downloadCutterStl,
  downloadProjectZip,
  downloadStampStl,
} from "./geometry/exportStl";
import { bboxSize } from "./geometry/offset";
import {
  DEFAULT_PARAMS,
  DEFAULT_STAMP,
  type CutterParams,
  type BuildMethod,
  type SizeReadout,
  type StampFeatureIn,
  type StampParams,
  type Vec2,
} from "./types";
import {
  loadBuildMethod,
  loadMmPerPx,
  loadParams,
  loadSnapGrid,
  saveBuildMethod,
  saveMmPerPx,
  saveParams,
  saveSnapGrid,
} from "./storage";
import { buildStamp } from "./geometry/buildStamp";

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
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("draw");
  const [buildMethod, setBuildMethod] = useState<BuildMethod>(() =>
    loadBuildMethod("clipper2"),
  );
  const [lastDrawMode, setLastDrawMode] = useState<
    "draw" | "polygon" | "ellipse"
  >("draw");
  const [showWallProfile, setShowWallProfile] = useState(true);
  const [meshGroup, setMeshGroup] = useState<THREE.Group | null>(null);
  const [sizeReadout, setSizeReadout] = useState<SizeReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    ) => JSON.stringify({ pts, p, method, features, sp }),
    [],
  );

  const rebuild = useCallback(
    (
      pts: Vec2[],
      p: CutterParams,
      method: BuildMethod,
      features: StampFeatureIn[] | null,
      sp: StampParams,
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
          });
          root.add(stampGroup);
        }
        meshRef.current = root;
        setMeshGroup(root);
        setSizeReadout({ widthMm, heightMm });
        setError(null);
        appliedKeyRef.current = sceneKey(pts, p, method, features, sp);
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
      delayMs: number,
    ) => {
      if (rebuildTimer.current != null) window.clearTimeout(rebuildTimer.current);
      rebuildTimer.current = window.setTimeout(() => {
        rebuildTimer.current = null;
        rebuild(pts, p, method, features, sp);
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
      scheduleRebuild(path, params, buildMethod, stampFeatures, stamp, 50);
    } else {
      setNeedsApply(
        sceneKey(path, params, buildMethod, stampFeatures, stamp) !== appliedKeyRef.current,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, hasClosedPath, buildMethod, liveUpdate, scheduleRebuild, sceneKey, stampFeatures, stamp]);

  useEffect(() => {
    if (!hasClosedPath || !path) return;
    if (liveUpdate) {
      scheduleRebuild(path, params, buildMethod, stampFeatures, stamp, 120);
    } else {
      setNeedsApply(
        sceneKey(path, params, buildMethod, stampFeatures, stamp) !== appliedKeyRef.current,
      );
    }
  }, [params, buildMethod, liveUpdate, hasClosedPath, path, scheduleRebuild, sceneKey, stamp, stampFeatures]);

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
        }}
      >
        <Box component="span" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
          Perníčkovadlo — Cookie shaper
        </Box>
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
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={() => setUndoToken((t) => t + 1)}
          onRedo={() => setRedoToken((t) => t + 1)}
        />

        <SplitPane
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
                  onStampFeatures={setStampFeatures}
                  mmPerPx={measureMmPerPx}
                  onMmPerPxChange={setMmPerPx}
                  onClosedPathChange={setPath}
                  onHasSelectionChange={setHasSelection}
                  onSelectedSimplifyChange={(tol) => {
                    setSmoothAvailable(tol != null);
                    if (tol != null) setSimplifyTolerance(tol);
                  }}
                  onModeChange={setCanvasMode}
                  onHistoryChange={(u, r) => {
                    setCanUndo(u);
                    setCanRedo(r);
                  }}
                  onCurveClosed={() => setCanvasMode("edit")}
                  onCurvesEmpty={() => setCanvasMode(lastDrawMode)}
                  onImportBackground={(url) => {
                    if (bgUrl) URL.revokeObjectURL(bgUrl);
                    setBgUrl(url);
                  }}
                  imagePanelToken={imagePanelToken}
                  onImagePanelOpenChange={setImagePanelOpen}
                  deleteToken={deleteToken}
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
                  <Viewer3D group={meshGroup} />
                  {showWallProfile && (
                    <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 3 }}>
                      <CrossSection
                        params={params}
                        onHide={() => setShowWallProfile(false)}
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
                  <Typography color="text.secondary" align="center">
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
          liveUpdate={liveUpdate}
          needsApply={needsApply}
          enabled={hasClosedPath}
          wallProfileVisible={showWallProfile}
          method={buildMethod}
          onMethodChange={setBuildMethod}
          onChange={(next) => {
            setParams(next);
            if (
              pathLongPx != null &&
              Math.abs(next.sizeMm - params.sizeMm) > 1e-6
            ) {
              setMmPerPx(next.sizeMm / pathLongPx);
            }
          }}
          onLiveUpdateChange={setLiveUpdate}
          onResetDefaults={() => setParams({ ...DEFAULT_PARAMS })}
          onApply={() =>
            path && rebuild(path, params, buildMethod, stampFeatures, stamp)
          }
          onShowWallProfile={() => setShowWallProfile(true)}
          stamp={stampFeatures ? stamp : null}
          onStampChange={setStamp}
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
    </Box>
  );
}
