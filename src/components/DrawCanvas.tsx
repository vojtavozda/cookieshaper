import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import paper from "paper";
import {
  Box,
  Button,
  Divider,
  FormControlLabel,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  Tooltip,
} from "@mui/material";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import ApprovalOutlinedIcon from "@mui/icons-material/ApprovalOutlined";
import type { Vec2 } from "../types";
import type { CanvasMode } from "./ToolRail";
import { ExamplesDialog } from "./ExamplesDialog";
import { ImageTracePanel } from "./ImageTracePanel";
import { WheelSlider } from "./WheelSlider";
import {
  applyRaw,
  cloneRaw,
  detectSmoothFlags,
  makeSegmentCorner,
  makeSegmentSmooth,
  reverseRaw,
  samplePathPoints,
  simplifyTail,
  styleInsertedSegment,
  type SegSnap,
} from "../geometry/pathEdit";
import {
  findContours,
  findStrokeCenterlines,
  loadImageData,
  prepareContourForEdit,
  prepareOpenContourForEdit,
  type Contour,
  type TraceMode,
} from "../geometry/imageContours";
import {
  classifyStampColor,
  isRasterImageFile,
  isVectorFile,
  mmPerPxFromSvg,
  pathsFromPdfFile,
  STAMP_RAISE_RGB,
  STAMP_RECESS_RGB,
  svgTextFromFile,
  type ImportedPath,
} from "../geometry/importVector";
import {
  buildSketchPdf,
  downloadSketchPdf,
  jpegFromImageUrl,
  type SketchPdfBackground,
} from "../geometry/exportSketchPdf";
import { ensureCcw } from "../geometry/offset";
import { offsetClosedClipper } from "../geometry/stampGeom";
import {
  clearSketchDraft,
  loadSketchDraft,
  saveSketchDraft,
  type SketchDraftItem,
} from "../geometry/sketchDraft";
import type { StampFeatureIn, StampParams } from "../types";
import { DEFAULT_STAMP } from "../types";

const SNAP_SCREEN = 16;
const NODE_SCREEN = 5;
const HANDLE_SCREEN = 4;
const MAGNET_SCREEN = 18;
/** Project-space grid cell (Paper has no built-in snap grid). */
const GRID_STEP = 20;

type PathMeta = {
  path: paper.Path;
  raw: SegSnap[];
  smooth: boolean[];
  /** Smooth slider / re-simplify only affects segments from this index onward. */
  lockIndex: number;
  /** Per-curve Smooth slider value (Paper simplify tolerance). */
  simplifyTol?: number;
  /** Grid freehand: keep corners, never re-simplify. */
  noSimplify?: boolean;
  id?: string;
  /** Cutter outline vs a mark drawn on a stamp. */
  role?: "cutter" | "feature";
  /** Set on a cutter once it has a stamp. */
  stampId?: string;
  /** Feature → owning cutter id. */
  ownerId?: string;
  raised?: boolean;
  widthMm?: number;
  filled?: boolean;
  /** Special raised rim along the stamp plate edge (not in metasRef). */
  stampRim?: boolean;
};

type OpenEnd = { meta: PathMeta; which: "first" | "last"; marker: paper.Item };

type EditGizmo = {
  meta: PathMeta;
  index: number;
  node: paper.Item;
  hIn?: paper.Path.Circle;
  hOut?: paper.Path.Circle;
  lineIn?: paper.Path;
  lineOut?: paper.Path;
};

type DragEdit =
  | {
      kind: "node";
      meta: PathMeta;
      index: number;
      origin: paper.Point;
      started: boolean;
    }
  | { kind: "handle-in"; meta: PathMeta; index: number }
  | { kind: "handle-out"; meta: PathMeta; index: number }
      | {
      kind: "curve";
      meta: PathMeta;
      segIndex: number;
      t: number;
      last: paper.Point;
      started: boolean;
      /** Straight span: place tangent handles along the chord, not the pull normal. */
      bendStraight: boolean;
    }
  | {
      kind: "xform-move";
      meta: PathMeta;
      last: paper.Point;
      started: boolean;
      linked: PathMeta[];
    }
  | {
      kind: "xform-scale";
      meta: PathMeta;
      corner: number;
      pivot: paper.Point;
      startCorner: paper.Point;
      startRaw: SegSnap[];
      linkedStarts: { meta: PathMeta; raw: SegSnap[] }[];
      started: boolean;
    }
  | {
      kind: "xform-rotate";
      meta: PathMeta;
      center: paper.Point;
      startAngle: number;
      startRaw: SegSnap[];
      linkedStarts: { meta: PathMeta; raw: SegSnap[] }[];
      started: boolean;
    };

type XformHit =
  | { kind: "move" }
  | { kind: "scale"; corner: number }
  | { kind: "rotate"; corner: number };

type CtxMenu =
  | { kind: "point"; x: number; y: number; meta: PathMeta; index: number }
  | {
      kind: "curve";
      x: number;
      y: number;
      meta: PathMeta;
      segIndex: number;
      loc: paper.Point;
    }
  | { kind: "stamp"; x: number; y: number; meta: PathMeta }
  | { kind: "object"; x: number; y: number; meta: PathMeta };

type Snapshot = {
  items: {
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
  }[];
};

type Props = {
  backgroundUrl: string | null;
  mode: CanvasMode;
  simplifyTolerance: number;
  snapGrid: boolean;
  /** Snap the pointer to existing curves (stamp outline and strokes). */
  snapCurves: boolean;
  /** Cutter wall thickness (mm) — stamp inset includes half of this. */
  wallThicknessMm: number;
  stampGapMm: number;
  onStampGapChange: (gapMm: number) => void;
  /** Raised rim along the stamp plate edge (default on). */
  stampOutlineEnabled: boolean;
  onStampOutlineEnabledChange: (enabled: boolean) => void;
  stampOutlineWidthMm: number;
  onStampOutlineWidthChange: (widthMm: number) => void;
  /** Full stamp params (for draft persistence). */
  stamp: StampParams;
  onStampChange: (next: StampParams) => void;
  /** Features of the cutter curve currently driving the 3D view; null = no stamp. */
  onStampFeatures: (features: StampFeatureIn[] | null) => void;
  /** Short status after Ctrl+S draft flush. */
  onDraftSaved?: (message: string) => void;
  /** Paper units → mm (always defined; from measure calibration or Size). */
  mmPerPx: number;
  onMmPerPxChange: (mmPerPx: number) => void;
  onClosedPathChange: (path: Vec2[] | null) => void;
  onHasSelectionChange: (has: boolean) => void;
  /** Sync Smooth slider to the selected curve's stored tolerance (null = none). */
  onSelectedSimplifyChange?: (tol: number | null) => void;
  /** Request a tool change (double-click / Esc from curve edit). */
  onModeChange: (m: CanvasMode) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  /** Fired when a curve is successfully closed (switch to edit). */
  onCurveClosed: () => void;
  /** Fired when the last curve is removed (restore last draw tool). */
  onCurvesEmpty: () => void;
  onImportBackground: (url: string) => void;
  /** Increment to open the image-trace floating panel. */
  imagePanelToken: number;
  onImagePanelOpenChange: (open: boolean) => void;
  deleteToken: number;
  /** Increment to wipe all curves, stamps, and the background. */
  clearToken: number;
  /** Called when clear-all should also drop the App background URL. */
  onClearBackground: () => void;
  undoToken: number;
  redoToken: number;
  /** Whether the canvas has drawable curves (for Download dialog). */
  onHasCurvesChange?: (has: boolean) => void;
  /** Increment to trigger sketch PDF download. */
  saveSketchToken?: number;
  /** Live API for sketch export (PDF / ZIP). */
  saveApiRef?: MutableRefObject<CanvasSaveApi | null>;
};

export type CanvasSaveApi = {
  savePdf: () => Promise<"saved" | "cancelled" | void>;
  buildPdfBytes: () => Promise<Uint8Array | null>;
  /** Flush IndexedDB sketch draft (Ctrl+S / floppy). */
  saveDraft: () => Promise<void>;
};

type MeasureEdit = {
  /** Bumps only when the popup opens — used to focus/select once. */
  key: number;
  left: number;
  top: number;
  value: string;
  lengthPx: number;
};

type ScopeExtras = {
  /** Re-simplify only the selected curve to the given tolerance. */
  __applySelectedSimplify?: (tol: number) => void;
  __setMode?: () => void;
  __setSnapGrid?: () => void;
  __syncStamp?: () => void;
  __toggleStamp?: () => void;
  __setFeatureWidth?: (widthMm: number) => void;
  __setFeatureRaised?: (raised: boolean) => void;
  __toggleFeatureFill?: () => void;
  __mirrorObject?: (axis: "h" | "v") => void;
  /** Clipper2 outset/inset by a fixed mm amount (closed curves only). */
  __offsetClosedByMm?: (mm: number) => void;
  __deleteCurrent?: () => void;
  __clearCanvas?: () => void;
  __undo?: () => void;
  __redo?: () => void;
  __escape?: () => void;
  __deleteHoverPoint?: () => void;
  __deleteSegmentAt?: (meta: PathMeta, segIndex: number) => void;
  __clearMeasure?: () => void;
  __setBgVisible?: (v: boolean) => void;
  __setBgOpacity?: (opacity: number) => void;
  __rebuildImageContours?: (threshold: number, smooth: number) => number;
  __clearImageContours?: () => void;
  __importVectorFile?: (file: File) => Promise<void>;
  __saveSketchPdf?: () => void | Promise<"saved" | "cancelled" | void>;
  /** Build sketch PDF bytes without downloading (for ZIP). */
  __buildSketchPdfBytes?: () => Promise<Uint8Array | null>;
  __scheduleDraftSave?: () => void;
  __flushDraftSave?: (toast?: boolean) => void;
};

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) {
    return !["range", "button", "checkbox", "radio", "submit", "reset", "file"].includes(
      t.type,
    );
  }
  return false;
}

function ensureSmoothFlags(meta: PathMeta) {
  while (meta.smooth.length < meta.path.segments.length) meta.smooth.push(false);
  meta.smooth.length = meta.path.segments.length;
}

/** Paper's ToolEvent carries the DOM event at runtime; typings omit it. */
function toolDomEvent(e: paper.ToolEvent): MouseEvent | undefined {
  return (e as paper.ToolEvent & { event?: MouseEvent }).event;
}

function toolCtrlOrMeta(e: paper.ToolEvent): boolean {
  const native = toolDomEvent(e);
  return !!(native?.ctrlKey || native?.metaKey || e.modifiers?.control || e.modifiers?.meta);
}

function toolShift(e: paper.ToolEvent): boolean {
  const native = toolDomEvent(e);
  return !!(native?.shiftKey || e.modifiers?.shift);
}

export function DrawCanvas({
  backgroundUrl,
  mode,
  simplifyTolerance,
  snapGrid,
  snapCurves,
  wallThicknessMm,
  stampGapMm,
  onStampGapChange,
  stampOutlineEnabled,
  onStampOutlineEnabledChange,
  stampOutlineWidthMm,
  onStampOutlineWidthChange,
  stamp,
  onStampChange,
  onStampFeatures,
  onDraftSaved,
  mmPerPx,
  onMmPerPxChange,
  onClosedPathChange,
  onHasSelectionChange,
  onSelectedSimplifyChange,
  onModeChange,
  onHistoryChange,
  onCurveClosed,
  onCurvesEmpty,
  onImportBackground,
  onClearBackground,
  imagePanelToken,
  onImagePanelOpenChange,
  deleteToken,
  clearToken,
  undoToken,
  redoToken,
  onHasCurvesChange,
  saveSketchToken = 0,
  saveApiRef,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<paper.PaperScope | null>(null);
  const metasRef = useRef<PathMeta[]>([]);
  const endsRef = useRef<OpenEnd[]>([]);
  const gizmosRef = useRef<EditGizmo[]>([]);
  /** Object-edit transform overlays (box, corners, orange points). */
  const xformItemsRef = useRef<paper.Item[]>([]);
  const selectedRef = useRef<PathMeta | null>(null);
  const drawingRef = useRef<paper.Path | null>(null);
  const [canvasEmpty, setCanvasEmpty] = useState(true);
  const [examplesOpen, setExamplesOpen] = useState(false);
  /** Finished curves on the canvas (enables Save). */
  const [hasCurves, setHasCurves] = useState(false);
  /** At least one closed outline — Save gets orange emphasis. */
  const [hasClosedCurve, setHasClosedCurve] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  // Higher = stricter: only darker ink (0 ≈ all, 255 = pure black only).
  const [traceThreshold, setTraceThreshold] = useState(205);
  const [traceSmooth, setTraceSmooth] = useState(0.45);
  const [showBackground, setShowBackground] = useState(true);
  /** Blue click-to-import contours over the background image. */
  const [showTraceCurves, setShowTraceCurves] = useState(true);
  /** Outlines of dark regions vs stroke centerlines. */
  const [traceMode, setTraceMode] = useState<TraceMode>("outlines");
  /** Opacity while the background image is shown (default matches prior hard-coded 0.45). */
  const [bgOpacity, setBgOpacity] = useState(0.45);
  const [traceCurveCount, setTraceCurveCount] = useState(0);
  const [measureReadout, setMeasureReadout] = useState<string | null>(null);
  const [measureEdit, setMeasureEdit] = useState<MeasureEdit | null>(null);
  const measureEditRef = useRef<MeasureEdit | null>(null);
  measureEditRef.current = measureEdit;
  const measureInputRef = useRef<HTMLInputElement>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const imageSizeRef = useRef<{ w: number; h: number } | null>(null);
  const continueMetaRef = useRef<PathMeta | null>(null);
  const continueAnchorRef = useRef(0);
  const drawStartMarkerRef = useRef<paper.Item | null>(null);
  const magnetRingRef = useRef<paper.Path.Circle | null>(null);
  const dragRef = useRef<DragEdit | null>(null);
  const curveHoverRef = useRef<paper.Item | null>(null);
  const measureLineRef = useRef<paper.Item | null>(null);
  const measureDotsRef = useRef<paper.Item[]>([]);
  const hoverNodeRef = useRef<{ meta: PathMeta; index: number } | null>(null);
  /** Curve-edit: segment under cursor (Delete → delete-segment). */
  const hoverSegmentRef = useRef<{ meta: PathMeta; segIndex: number } | null>(
    null,
  );
  /** Curve-edit: segment selected by click (Delete → delete-segment). */
  const selectedSegmentRef = useRef<{ meta: PathMeta; segIndex: number } | null>(
    null,
  );
  /** Curve-edit: point selected by click (Delete → delete-point). */
  const selectedPointRef = useRef<{ meta: PathMeta; index: number } | null>(
    null,
  );
  const bgRef = useRef<paper.Raster | null>(null);
  const polygonRef = useRef<paper.Path | null>(null);
  const polyPreviewRef = useRef<paper.Path | null>(null);
  const polyHandleDragRef = useRef<{ index: number } | null>(null);
  const addPointMarkRef = useRef<paper.Group | null>(null);
  const snapPreviewRef = useRef<paper.Path.Circle | null>(null);
  const shiftRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const simplifyRef = useRef(simplifyTolerance);
  simplifyRef.current = simplifyTolerance;
  const snapGridRef = useRef(snapGrid);
  snapGridRef.current = snapGrid;
  const snapCurvesRef = useRef(snapCurves);
  snapCurvesRef.current = snapCurves;
  const wallMmRef = useRef(wallThicknessMm);
  wallMmRef.current = wallThicknessMm;
  const gapMmRef = useRef(stampGapMm);
  gapMmRef.current = stampGapMm;
  const onStampGapChangeRef = useRef(onStampGapChange);
  onStampGapChangeRef.current = onStampGapChange;
  const outlineEnabledRef = useRef(stampOutlineEnabled);
  outlineEnabledRef.current = stampOutlineEnabled;
  const onOutlineEnabledChangeRef = useRef(onStampOutlineEnabledChange);
  onOutlineEnabledChangeRef.current = onStampOutlineEnabledChange;
  const outlineWidthMmRef = useRef(stampOutlineWidthMm);
  outlineWidthMmRef.current = stampOutlineWidthMm;
  const onOutlineWidthChangeRef = useRef(onStampOutlineWidthChange);
  onOutlineWidthChangeRef.current = onStampOutlineWidthChange;
  const stampRef = useRef(stamp);
  stampRef.current = stamp;
  const onStampChangeRef = useRef(onStampChange);
  onStampChangeRef.current = onStampChange;
  const onStampFeaturesRef = useRef(onStampFeatures);
  onStampFeaturesRef.current = onStampFeatures;
  const onDraftSavedRef = useRef(onDraftSaved);
  onDraftSavedRef.current = onDraftSaved;
  const [stampUi, setStampUi] = useState<"off" | "add" | "edit" | "back">("off");
  const [featureHud, setFeatureHud] = useState<{
    rim?: boolean;
    widthMm: number;
    raised: boolean;
    filled: boolean;
    closed: boolean;
  } | null>(null);
  const setStampUiRef = useRef(setStampUi);
  setStampUiRef.current = setStampUi;
  const setFeatureHudRef = useRef(setFeatureHud);
  setFeatureHudRef.current = setFeatureHud;
  const mmPerPxRef = useRef(mmPerPx);
  mmPerPxRef.current = mmPerPx;
  const showBackgroundRef = useRef(showBackground);
  showBackgroundRef.current = showBackground;
  const showTraceCurvesRef = useRef(showTraceCurves);
  showTraceCurvesRef.current = showTraceCurves;
  const traceModeRef = useRef(traceMode);
  traceModeRef.current = traceMode;
  const bgOpacityRef = useRef(bgOpacity);
  bgOpacityRef.current = bgOpacity;
  const backgroundUrlRef = useRef(backgroundUrl);
  backgroundUrlRef.current = backgroundUrl;
  /** When set, next background raster uses this paper rect instead of view-center fit. */
  const bgPlaceRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  /** Paths waiting to be committed once a PDF background raster has loaded. */
  const pendingPdfImportRef = useRef<{
    paths: paper.Path[];
    scaleMmPerPx: number | null;
    imported?: ImportedPath[];
    stampGapMm?: number | null;
    stampOutlineEnabled?: boolean | null;
    stampOutlineWidthMm?: number | null;
  } | null>(null);
  /** Draft restore waiting for background raster placement. */
  const pendingDraftRestoreRef = useRef<{
    items: SketchDraftItem[];
    stampOwnerId: string | null;
    mmPerPx: number | null;
  } | null>(null);
  const finishPendingDraftRestoreRef = useRef<(() => void) | null>(null);
  const finishPendingPdfImportRef = useRef<
    ((raster: paper.Raster | null) => void) | null
  >(null);
  const onMmPerPxChangeRef = useRef(onMmPerPxChange);
  onMmPerPxChangeRef.current = onMmPerPxChange;
  const onClosedRef = useRef(onClosedPathChange);
  onClosedRef.current = onClosedPathChange;
  const onHasSelRef = useRef(onHasSelectionChange);
  onHasSelRef.current = onHasSelectionChange;
  const onSimplifySyncRef = useRef(onSelectedSimplifyChange);
  onSimplifySyncRef.current = onSelectedSimplifyChange;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const onHistoryRef = useRef(onHistoryChange);
  onHistoryRef.current = onHistoryChange;
  const onCurveClosedRef = useRef(onCurveClosed);
  onCurveClosedRef.current = onCurveClosed;
  const onCurvesEmptyRef = useRef(onCurvesEmpty);
  onCurvesEmptyRef.current = onCurvesEmpty;
  const onImportBgRef = useRef(onImportBackground);
  onImportBgRef.current = onImportBackground;
  const onClearBackgroundRef = useRef(onClearBackground);
  onClearBackgroundRef.current = onClearBackground;
  const onImagePanelOpenChangeRef = useRef(onImagePanelOpenChange);
  onImagePanelOpenChangeRef.current = onImagePanelOpenChange;

  const spaceRef = useRef(false);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scope = new paper.PaperScope();
    scope.setup(canvas);
    scopeRef.current = scope;
    const extras = scope as unknown as ScopeExtras;
    const screen = (px: number) => px / scope.view.zoom;
    canvas.style.cursor = "crosshair";

    const syncEmpty = () => {
      const empty =
        metasRef.current.length === 0 &&
        !drawingRef.current &&
        !(polygonRef.current && polygonRef.current.segments.length > 0);
      setCanvasEmpty(empty);
      setHasCurves(metasRef.current.some((m) => m.path.segments.length >= 2));
      setHasClosedCurve(metasRef.current.some((m) => m.path.closed));
    };

    let gridGroup: paper.Group | null = null;
    const imagePreviewPaths: (paper.Path | null)[] = [];
    let imageProjectContours: Contour[] = [];
    let hoverContourIndex = -1;

    const clearImageContours = () => {
      for (const p of imagePreviewPaths) p?.remove();
      imagePreviewPaths.length = 0;
      imageProjectContours = [];
      hoverContourIndex = -1;
    };

    const paintImageContour = (index: number, hover: boolean) => {
      const p = imagePreviewPaths[index];
      if (!p) return;
      p.strokeColor = new scope.Color(hover ? "#e53935" : "#1e88e5");
      p.strokeWidth = hover ? screen(2.4) : screen(1.5);
      p.opacity = hover ? 1 : 0.75;
    };

    const rebuildImageContours = (threshold: number, smoothAmt: number) => {
      clearImageContours();
      if (!showTraceCurvesRef.current) return 0;
      const img = imageDataRef.current;
      const sz = imageSizeRef.current;
      const raster = bgRef.current;
      if (!img || !sz || !raster || !raster.bounds) return 0;
      const lines = traceModeRef.current === "lines";
      const raw = lines
        ? findStrokeCenterlines(img, threshold, { simplifyAmount: smoothAmt })
        : findContours(img, threshold, { simplifyAmount: smoothAmt });
      const prepared = raw.map((c) =>
        lines
          ? prepareOpenContourForEdit(c, smoothAmt)
          : prepareContourForEdit(c, smoothAmt),
      );
      const b = raster.bounds;
      imageProjectContours = [];
      for (let i = 0; i < prepared.length; i++) {
        const pts = prepared[i].map((p) => ({
          x: b.left + (p.x / sz.w) * b.width,
          y: b.top + (p.y / sz.h) * b.height,
        }));
        if (pts.length < (lines ? 2 : 3)) continue;
        // Closed if first≈last after thinning (true loops); lines stay open
        let closed = !lines;
        if (lines && pts.length >= 3) {
          const a = pts[0];
          const b0 = pts[pts.length - 1];
          if (Math.hypot(a.x - b0.x, a.y - b0.y) <= 1.5) {
            pts.pop();
            closed = true;
          }
        }
        const path = new scope.Path({
          segments: pts.map((p) => new scope.Point(p.x, p.y)),
          closed,
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: screen(1.5),
          fillColor: null,
          opacity: 0.75,
          strokeCap: "round",
          strokeJoin: "round",
        });
        if (smoothAmt > 0.02) {
          path.simplify(0.5 + smoothAmt * 12);
        }
        path.data.imageContour = true;
        path.data.contourIndex = imagePreviewPaths.length;
        path.data.traceOpen = !closed;
        path.bringToFront();
        imagePreviewPaths.push(path);
        imageProjectContours.push(
          path.segments.map((s) => ({ x: s.point.x, y: s.point.y })),
        );
      }
      return imagePreviewPaths.filter(Boolean).length;
    };

    const hitImageContour = (pt: paper.Point): number => {
      const hit = scope.project.hitTest(pt, {
        stroke: true,
        tolerance: screen(8),
      });
      if (hit?.item && (hit.item as paper.Path).data?.imageContour) {
        return (hit.item as paper.Path).data.contourIndex as number;
      }
      return -1;
    };

    const importImageContour = (index: number) => {
      const preview = imagePreviewPaths[index];
      if (!preview || preview.segments.length < 2) return;
      const asOpen = !!preview.data.traceOpen || !preview.closed;
      if (!asOpen && preview.segments.length < 3) return;
      pushUndo();
      // Clone the already-simplified Bézier path (same as a freehand stroke)
      const path = preview.clone() as paper.Path;
      path.data = {};
      path.closed = !asOpen;
      path.strokeCap = "round";
      path.strokeJoin = "round";
      path.opacity = 1;
      path.fullySelected = false;
      path.selected = false;
      const meta: PathMeta = {
        path,
        raw: cloneRaw(path),
        smooth: detectSmoothFlags(path),
        lockIndex: 0,
      };
      metasRef.current.push(meta);
      imagePreviewPaths[index]?.remove();
      imagePreviewPaths[index] = null;
      // In stamp mode, traced contours become stamp features
      if (stampOwnerRef.current) {
        tagFeature(meta);
        syncStampChrome();
      } else if (asOpen) {
        path.strokeColor = new scope.Color("#111");
        path.strokeWidth = 1.5;
      } else {
        path.strokeColor = new scope.Color("#c45c26");
        path.strokeWidth = 2.2;
      }
      setSelection(meta, true);
      syncEmpty();
      if (!asOpen) notifyClosedCurve();
    };

    const stampOwnerRef: { current: PathMeta | null } = { current: null };
    /** Outer fit-gap edge (mask hole; dashed chrome when rim is off). */
    const stampOutlineRef: { current: paper.Path | null } = { current: null };
    /** Filled annulus matching 3D rim (outer − inward width). */
    const stampRimFillRef: { current: paper.CompoundPath | null } = {
      current: null,
    };
    const stampRimMetaRef: { current: PathMeta | null } = { current: null };
    const stampMaskRef: { current: paper.CompoundPath | null } = { current: null };
    let metaSeq = 1;
    const lastWidthMm = { current: 0.6 };

    const ensureId = (m: PathMeta) => {
      if (!m.id) m.id = `p${metaSeq++}`;
      return m.id;
    };

    /** Stamp features belonging to this cutter (follow move/scale/rotate). */
    const linkedStampFeatures = (cutter: PathMeta): PathMeta[] => {
      if (!cutter.id || cutter.role === "feature") return [];
      return metasRef.current.filter(
        (m) => m.role === "feature" && m.ownerId === cutter.id,
      );
    };

    const featureColor = (m: PathMeta) =>
      m.raised === false ? "#1e3a8a" : "#7f1d1d";

    const styleFeature = (m: PathMeta, gray = false) => {
      const color = gray ? "#9aa3ab" : featureColor(m);
      const w = Math.max(0.2, m.widthMm ?? lastWidthMm.current);
      m.widthMm = w;
      const px = mmPerPxRef.current > 1e-6 ? w / mmPerPxRef.current : 1.5;
      m.path.strokeColor = new scope.Color(color);
      m.path.strokeWidth = Math.max(1, px);
      m.path.strokeCap = "round";
      m.path.strokeJoin = "round";
      m.path.fillColor = m.filled ? new scope.Color(color) : null;
      m.path.opacity = gray ? 0.4 : m.filled ? 0.9 : 1;
      m.path.data = { ...(m.path.data || {}), kind: "feature" };
    };

    const cutterStroke = (m: PathMeta, grey: boolean) => {
      m.path.strokeColor = new scope.Color(
        grey ? "#9aa3ab" : m.path.closed ? "#c45c26" : "#111",
      );
      m.path.strokeWidth = m.path.closed ? 2.2 : 1.5;
      m.path.fillColor = null;
      m.path.opacity = grey ? 0.55 : 1;
      m.path.locked = grey;
    };

    const maybeSnap = (pt: paper.Point) => {
      if (snapCurvesRef.current) {
        const lim = screen(14);
        let best: paper.Point | null = null;
        let bestD = lim;
        const consider = (
          item: paper.Path | paper.CompoundPath | null | undefined,
        ) => {
          if (!item || !item.visible) return;
          const loc = item.getNearestLocation(pt);
          if (loc && loc.distance < bestD) {
            bestD = loc.distance;
            best = loc.point;
          }
        };
        if (outlineEnabledRef.current && stampRimFillRef.current) {
          consider(stampRimFillRef.current);
        } else {
          consider(stampOutlineRef.current);
        }
        const owner = stampOwnerRef.current;
        if (owner) {
          for (const m of metasRef.current) {
            if (m.role === "feature" && m.ownerId === owner.id) consider(m.path);
          }
        } else {
          for (const m of metasRef.current) {
            if (m.role !== "feature") consider(m.path);
          }
        }
        if (best) return best;
      }
      if (!snapGridRef.current) return pt;
      const g = GRID_STEP;
      return new scope.Point(Math.round(pt.x / g) * g, Math.round(pt.y / g) * g);
    };

    const clearSnapPreview = () => {
      snapPreviewRef.current?.remove();
      snapPreviewRef.current = null;
    };

    const showSnapPreview = (raw: paper.Point) => {
      if (!snapGridRef.current && !snapCurvesRef.current) {
        clearSnapPreview();
        return;
      }
      const at = maybeSnap(raw);
      const r = screen(4);
      if (!snapPreviewRef.current) {
        snapPreviewRef.current = new scope.Path.Circle({
          center: at,
          radius: r,
          fillColor: new scope.Color(0.55, 0.55, 0.58, 0.85),
          strokeColor: new scope.Color(0.45, 0.45, 0.48, 0.9),
          strokeWidth: screen(1),
        });
        snapPreviewRef.current.locked = true;
      } else {
        snapPreviewRef.current.position = at;
        snapPreviewRef.current.bounds = new scope.Rectangle(
          at.x - r,
          at.y - r,
          r * 2,
          r * 2,
        );
      }
    };

    const rebuildGrid = () => {
      gridGroup?.remove();
      gridGroup = null;
      if (!snapGridRef.current) return;
      const bounds = scope.view.bounds;
      const g = GRID_STEP;
      const pad = g * 2;
      const x0 = Math.floor((bounds.left - pad) / g) * g;
      const y0 = Math.floor((bounds.top - pad) / g) * g;
      const x1 = Math.ceil((bounds.right + pad) / g) * g;
      const y1 = Math.ceil((bounds.bottom + pad) / g) * g;
      const group = new scope.Group();
      group.locked = true;
      const minor = new scope.Color(0.82, 0.84, 0.88, 0.9);
      const major = new scope.Color(0.7, 0.73, 0.78, 1);
      const sw = screen(1);
      for (let x = x0; x <= x1; x += g) {
        const majorLine = Math.round(x / g) % 5 === 0;
        group.addChild(
          new scope.Path.Line({
            from: new scope.Point(x, y0),
            to: new scope.Point(x, y1),
            strokeColor: majorLine ? major : minor,
            strokeWidth: majorLine ? sw * 1.2 : sw,
          }),
        );
      }
      for (let y = y0; y <= y1; y += g) {
        const majorLine = Math.round(y / g) % 5 === 0;
        group.addChild(
          new scope.Path.Line({
            from: new scope.Point(x0, y),
            to: new scope.Point(x1, y),
            strokeColor: majorLine ? major : minor,
            strokeWidth: majorLine ? sw * 1.2 : sw,
          }),
        );
      }
      if (bgRef.current) group.insertAbove(bgRef.current);
      else group.sendToBack();
      gridGroup = group;
    };

    const makeEndMarker = (center: paper.Point, blue = false) =>
      new scope.Path.Circle({
        center,
        radius: screen(NODE_SCREEN),
        fillColor: new scope.Color(blue ? "#1e88e5" : "#e53935"),
        strokeColor: new scope.Color("#ffffff"),
        strokeWidth: screen(1.5),
      });

    const clearMagnet = () => {
      magnetRingRef.current?.remove();
      magnetRingRef.current = null;
    };

    const showMagnet = (at: paper.Point) => {
      if (!magnetRingRef.current) {
        magnetRingRef.current = new scope.Path.Circle({
          center: at,
          radius: screen(MAGNET_SCREEN),
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: screen(1.5),
          dashArray: [4, 3],
          fillColor: new scope.Color(0.12, 0.53, 0.9, 0.08),
        });
      } else {
        magnetRingRef.current.position = at;
        const r = screen(MAGNET_SCREEN);
        magnetRingRef.current.bounds = new scope.Rectangle(
          at.x - r,
          at.y - r,
          r * 2,
          r * 2,
        );
      }
    };

    const clearCurveHover = () => {
      curveHoverRef.current?.remove();
      curveHoverRef.current = null;
      hoverSegmentRef.current = null;
    };

    /** Thin outline of an entire path (edit-mode hover to hint selection). */
    const showPathHover = (meta: PathMeta) => {
      clearCurveHover();
      if (meta.stampRim && stampRimFillRef.current) {
        const highlight = stampRimFillRef.current.clone({
          insert: false,
        }) as paper.CompoundPath;
        highlight.fillColor = new scope.Color(0.12, 0.53, 0.9, 0.28);
        highlight.strokeColor = new scope.Color("#1e88e5");
        highlight.strokeWidth = screen(1.6);
        highlight.locked = true;
        scope.project.activeLayer.addChild(highlight);
        highlight.bringToFront();
        curveHoverRef.current = highlight;
        return;
      }
      const stroke = meta.path.closed ? "#1e88e5" : "#e53935";
      const highlight = meta.path.clone({ insert: false }) as paper.Path;
      highlight.strokeColor = new scope.Color(stroke);
      highlight.strokeWidth = screen(2.2);
      highlight.fillColor = null;
      highlight.dashArray = [];
      highlight.locked = true;
      scope.project.activeLayer.addChild(highlight);
      highlight.bringToFront();
      curveHoverRef.current = highlight;
    };

    /** Closest editable curve near the pointer (nested curves win over large parents). */
    const pickEditableMeta = (pt: paper.Point): PathMeta | null => {
      const lim = screen(8);
      let best: PathMeta | null = null;
      let bestD = lim;
      const owner = stampOwnerRef.current;
      for (const m of metasRef.current) {
        if (!m.path.visible || m.path.locked) continue;
        if (owner) {
          if (m.role !== "feature" || m.ownerId !== owner.id) continue;
        } else if (m.role === "feature") {
          continue;
        }
        const loc = m.path.getNearestLocation(pt);
        if (!loc || loc.distance >= bestD) continue;
        bestD = loc.distance;
        best = m;
      }
      // Raised outline rim — filled annulus, clickable / not point-editable
      if (owner && outlineEnabledRef.current && stampRimMetaRef.current) {
        const rim = stampRimMetaRef.current;
        const fill = stampRimFillRef.current;
        if (fill) {
          if (fill.contains(pt)) {
            return rim;
          }
          const loc = fill.getNearestLocation(pt);
          if (loc && loc.distance < bestD) {
            bestD = loc.distance;
            best = rim;
          }
        }
      }
      return best;
    };

    const resolveStampTarget = (): PathMeta | null => {
      const sel = selectedRef.current;
      if (sel && sel.role !== "feature" && sel.path.closed) return sel;
      const closed = metasRef.current.filter(
        (m) => m.role !== "feature" && m.path.closed && m.path.visible,
      );
      return closed.length === 1 ? closed[0] : null;
    };

    const clearMeasureLine = () => {
      measureLineRef.current?.remove();
      measureLineRef.current = null;
    };

    const clearMeasureDots = () => {
      for (const d of measureDotsRef.current) d.remove();
      measureDotsRef.current = [];
    };

    type MeasureDot = {
      meta: PathMeta;
      index: number;
      item: paper.Path.Circle;
    };
    let measureDotHits: MeasureDot[] = [];

    /** Same orange as closed curves; hover → bright red (size stays fixed). */
    const MEASURE_DOT = "#c45c26";
    const MEASURE_DOT_HOVER = "#1e88e5";

    const rebuildMeasureDots = () => {
      clearMeasureDots();
      measureDotHits = [];
      if (modeRef.current !== "measure") return;
      const r = screen(3);
      for (const meta of metasRef.current) {
        for (let i = 0; i < meta.path.segments.length; i++) {
          const pt = meta.path.segments[i].point;
          const item = new scope.Path.Circle({
            center: pt,
            radius: r,
            fillColor: new scope.Color(MEASURE_DOT),
            strokeWidth: 0,
          });
          measureDotsRef.current.push(item);
          measureDotHits.push({ meta, index: i, item });
        }
      }
    };

    const paintMeasureDotHover = (hit: MeasureDot | null) => {
      for (const d of measureDotHits) {
        d.item.fillColor = new scope.Color(MEASURE_DOT);
      }
      if (hit) hit.item.fillColor = new scope.Color(MEASURE_DOT_HOVER);
    };

    const formatMeasure = (lengthPx: number) =>
      `${(lengthPx * mmPerPxRef.current).toFixed(1)} mm`;

    const projectToLocal = (pt: paper.Point) => {
      const view = scope.view.projectToView(pt);
      return { left: view.x, top: view.y };
    };

    let measureEditKeySeq = 0;
    const openMeasureEdit = (lengthPx: number, at: paper.Point) => {
      if (lengthPx < 1e-6) return;
      const value = (lengthPx * mmPerPxRef.current).toFixed(1);
      const { left, top } = projectToLocal(at);
      const edit: MeasureEdit = {
        key: ++measureEditKeySeq,
        left: left + 8,
        top: top - 14,
        value,
        lengthPx,
      };
      measureEditRef.current = edit;
      setMeasureEdit(edit);
      setMeasureReadout(formatMeasure(lengthPx));
    };

    const showMeasureLine = (from: paper.Point, to: paper.Point) => {
      clearMeasureLine();
      const line = new scope.Path.Line({
        from,
        to,
        strokeColor: new scope.Color("#1565c0"),
        strokeWidth: screen(1.25),
        strokeCap: "round",
        dashArray: [screen(7), screen(5)],
      });
      const r = screen(3.5);
      const a = new scope.Path.Circle({
        center: from,
        radius: r,
        fillColor: new scope.Color("#1565c0"),
        strokeColor: new scope.Color("#fff"),
        strokeWidth: screen(1),
      });
      const b = new scope.Path.Circle({
        center: to,
        radius: r,
        fillColor: new scope.Color("#1565c0"),
        strokeColor: new scope.Color("#fff"),
        strokeWidth: screen(1),
      });
      measureLineRef.current = new scope.Group([line, a, b]);
    };

    const segmentChord = (
      meta: PathMeta,
      segIndex: number,
    ): { lengthPx: number; mid: paper.Point; a: paper.Point; b: paper.Point } | null => {
      const curve = meta.path.curves[segIndex];
      if (!curve) return null;
      const a = curve.point1;
      const b = curve.point2;
      return {
        lengthPx: a.getDistance(b),
        mid: a.add(b).multiply(0.5),
        a: a.clone(),
        b: b.clone(),
      };
    };

    const hitAnySegment = (
      pt: paper.Point,
    ): { meta: PathMeta; segIndex: number; dist: number } | null => {
      let best: { meta: PathMeta; segIndex: number; dist: number } | null = null;
      for (const meta of metasRef.current) {
        const ch = hitCurveSegment(meta, pt);
        if (ch && (!best || ch.dist < best.dist)) {
          best = { meta, segIndex: ch.segIndex, dist: ch.dist };
        }
      }
      return best;
    };

    const hitAnyPoint = (
      pt: paper.Point,
    ): { meta: PathMeta; index: number; point: paper.Point; dist: number } | null => {
      const lim = screen(NODE_SCREEN + 5);
      let best: {
        meta: PathMeta;
        index: number;
        point: paper.Point;
        dist: number;
      } | null = null;
      for (const meta of metasRef.current) {
        for (let i = 0; i < meta.path.segments.length; i++) {
          const p = meta.path.segments[i].point;
          const dist = p.getDistance(pt);
          if (dist <= lim && (!best || dist < best.dist)) {
            best = { meta, index: i, point: p.clone(), dist };
          }
        }
      }
      return best;
    };

    type MeasureDrag = {
      start: paper.Point;
      moved: boolean;
      fromPoint: boolean;
      segment: { meta: PathMeta; segIndex: number } | null;
      /** Completing a point→point measure on mouseup */
      finishTo: paper.Point | null;
    };
    let measureDrag: MeasureDrag | null = null;
    /** First point of a two-click measure */
    let measureAnchor: paper.Point | null = null;
    /**
     * Ellipse / circle drag.
     * Default: corner→corner. Ctrl = circle. Shift = pinned start is the center.
     */
    /** Segments that existed before this polygon stroke (0 for a new shape). */
    let polyBaseCount = 0;
    let ellipseDrag: {
      from: paper.Point;
      path: paper.Path | null;
      pin: paper.Item | null;
    } | null = null;

    const clearMeasureUi = () => {
      measureDrag = null;
      measureAnchor = null;
      clearMeasureLine();
      clearCurveHover();
      paintMeasureDotHover(null);
      measureEditRef.current = null;
      setMeasureReadout(null);
      setMeasureEdit(null);
    };

    const clearEllipseDrag = () => {
      if (ellipseDrag?.path) ellipseDrag.path.remove();
      ellipseDrag?.pin?.remove();
      ellipseDrag = null;
    };

    const makeEllipsePin = (at: paper.Point) => {
      const g = new scope.Group();
      g.locked = true;
      const arm = screen(9);
      const color = new scope.Color("#1e88e5");
      const sw = screen(1.8);
      g.addChild(
        new scope.Path.Line({
          from: at.add(new scope.Point(-arm, 0)),
          to: at.add(new scope.Point(arm, 0)),
          strokeColor: color,
          strokeWidth: sw,
          strokeCap: "round",
        }),
      );
      g.addChild(
        new scope.Path.Line({
          from: at.add(new scope.Point(0, -arm)),
          to: at.add(new scope.Point(0, arm)),
          strokeColor: color,
          strokeWidth: sw,
          strokeCap: "round",
        }),
      );
      g.addChild(
        new scope.Path.Circle({
          center: at,
          radius: screen(2.2),
          fillColor: color,
          strokeColor: null,
        }),
      );
      return g;
    };

    const updateEllipsePath = (
      from: paper.Point,
      to: paper.Point,
      circle: boolean,
      fromCenter: boolean,
    ): paper.Path => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      let center: paper.Point;
      let rx: number;
      let ry: number;
      if (fromCenter) {
        // Pinned start is the center; cursor defines the radii
        center = from;
        if (circle) {
          const r = Math.max(Math.hypot(dx, dy), 1);
          rx = r;
          ry = r;
        } else {
          rx = Math.max(Math.abs(dx), 1);
          ry = Math.max(Math.abs(dy), 1);
        }
      } else {
        // Corner→corner: keep the drag-start corner fixed. Ctrl (circle) must
        // not re-center on the raw drag rect — that makes the shape jump.
        const sx = dx >= 0 ? 1 : -1;
        const sy = dy >= 0 ? 1 : -1;
        let w = Math.max(Math.abs(dx), 1);
        let h = Math.max(Math.abs(dy), 1);
        if (circle) {
          const s = Math.max(Math.min(w, h), 1);
          w = s;
          h = s;
        }
        rx = w / 2;
        ry = h / 2;
        center = new scope.Point(from.x + sx * rx, from.y + sy * ry);
      }
      if (ellipseDrag?.path) {
        ellipseDrag.path.remove();
      }
      const path = new scope.Path.Ellipse({
        center,
        radius: [rx, ry],
        strokeColor: new scope.Color(
          stampOwnerRef.current ? "#7f1d1d" : "#c45c26",
        ),
        strokeWidth: stampOwnerRef.current ? 2 : 2.2,
        fillColor: null,
        strokeCap: "round",
        strokeJoin: "round",
      });
      path.closed = true;
      if (ellipseDrag) ellipseDrag.path = path;
      return path;
    };

    extras.__clearMeasure = clearMeasureUi;

    const snapPointAngle15 = (
      from: paper.Point,
      to: paper.Point,
      enable: boolean,
    ): paper.Point => {
      if (!enable) return to;
      const v = to.subtract(from);
      const len = v.length;
      if (len < 1e-6) return to;
      const snapped = Math.round(v.angle / 15) * 15;
      return from.add(new scope.Point({ length: len, angle: snapped }));
    };

    const updateMeasureDragVisual = (
      from: paper.Point,
      to: paper.Point,
      ctrl = false,
    ) => {
      const snap = hitAnyPoint(to);
      // Point snap wins; otherwise Ctrl locks the measure ray to 15° steps
      const end = snap
        ? snap.point
        : snapPointAngle15(from, to, ctrl);
      showMeasureLine(from, end);
      setMeasureReadout(formatMeasure(from.getDistance(end)));
      if (snap) {
        const dot = measureDotHits.find(
          (d) => d.meta === snap.meta && d.index === snap.index,
        );
        paintMeasureDotHover(dot ?? null);
      } else {
        paintMeasureDotHover(null);
      }
      return end;
    };

    const showCurveHover = (meta: PathMeta, segIndex: number) => {
      clearCurveHover();
      const a = meta.path.segments[segIndex];
      const b = meta.path.segments[(segIndex + 1) % meta.path.segments.length];
      if (!a || !b) return;
      hoverSegmentRef.current = { meta, segIndex };
      // Closed paths are already orange — use blue so the hover stays visible
      const stroke = meta.path.closed ? "#1e88e5" : "#e53935";
      const highlight = new scope.Path({
        strokeColor: new scope.Color(stroke),
        strokeWidth: screen(2.5),
        strokeCap: "round",
      });
      const p0 = a.point;
      const p1 = a.point.add(a.handleOut);
      const p2 = b.point.add(b.handleIn);
      const p3 = b.point;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        const pt = p0
          .multiply(u * u * u)
          .add(p1.multiply(3 * u * u * t))
          .add(p2.multiply(3 * u * t * t))
          .add(p3.multiply(t * t * t));
        if (i === 0) highlight.moveTo(pt);
        else highlight.lineTo(pt);
      }
      curveHoverRef.current = highlight;
    };

    const clearPolyPreview = () => {
      polyPreviewRef.current?.remove();
      polyPreviewRef.current = null;
    };

    const clearAddPointMark = () => {
      addPointMarkRef.current?.remove();
      addPointMarkRef.current = null;
    };

    const showAddPointMark = (at: paper.Point) => {
      clearAddPointMark();
      const g = new scope.Group();
      const r = screen(7);
      g.addChild(
        new scope.Path.Circle({
          center: at,
          radius: r,
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: screen(1.5),
          fillColor: new scope.Color(1, 1, 1, 0.9),
        }),
      );
      const arm = screen(4);
      g.addChild(
        new scope.Path.Line({
          from: at.add(new scope.Point(-arm, 0)),
          to: at.add(new scope.Point(arm, 0)),
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: screen(1.8),
          strokeCap: "round",
        }),
      );
      g.addChild(
        new scope.Path.Line({
          from: at.add(new scope.Point(0, -arm)),
          to: at.add(new scope.Point(0, arm)),
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: screen(1.8),
          strokeCap: "round",
        }),
      );
      addPointMarkRef.current = g;
    };

    const insertSmoothPointAt = (meta: PathMeta, pt: paper.Point) => {
      const nearest = meta.path.getNearestLocation(pt);
      if (!nearest) return;
      pushUndo();
      const wasStraight = nearest.curve?.isStraight() ?? false;
      const newSeg = meta.path.divideAt(nearest);
      if (!newSeg) return;
      const idx = newSeg.index;
      const smooth = styleInsertedSegment(newSeg, wasStraight, scope);
      while (meta.smooth.length < idx) meta.smooth.push(false);
      meta.smooth.splice(idx, 0, smooth);
      ensureSmoothFlags(meta);
      meta.raw = cloneRaw(meta.path);
      clearAddPointMark();
      setSelection(meta, true);
    };

    /** Ctrl: snap ray from last vertex to 15° steps (Paper Point.angle). */
    const snapPolyPoint = (from: paper.Point, to: paper.Point, ctrl: boolean) => {
      if (!ctrl) return to;
      const delta = to.subtract(from);
      if (delta.length < 1e-6) return to;
      delta.angle = Math.round(delta.angle / 15) * 15;
      return from.add(delta);
    };

    const updatePolyPreview = (to: paper.Point) => {
      const poly = polygonRef.current;
      if (!poly?.lastSegment) {
        clearPolyPreview();
        return;
      }
      const from = poly.lastSegment.point;
      if (!polyPreviewRef.current) {
        polyPreviewRef.current = new scope.Path({
          strokeColor: new scope.Color("#e53935"),
          strokeWidth: screen(1.2),
          strokeCap: "round",
          dashArray: [4, 3],
        });
      }
      const preview = polyPreviewRef.current;
      preview.strokeWidth = screen(1.2);
      preview.dashArray = [screen(5), screen(4)];
      preview.removeSegments();
      const ho = poly.lastSegment.handleOut;
      // One cubic so the dash stays visible. A polyline of short chords
      // drops the dash, which hid the preview off a dragged first point.
      if (ho.length > 0.5) {
        preview.add(new scope.Segment(from, new scope.Point(0, 0), ho));
        preview.add(new scope.Segment(to));
      } else {
        preview.add(from);
        preview.add(to);
      }
      preview.bringToFront();
    };

    const clearGizmos = () => {
      for (const g of gizmosRef.current) {
        g.node.remove();
        g.hIn?.remove();
        g.hOut?.remove();
        g.lineIn?.remove();
        g.lineOut?.remove();
      }
      gizmosRef.current = [];
    };

    const clearXformGizmos = () => {
      for (const it of xformItemsRef.current) it.remove();
      xformItemsRef.current = [];
    };

    const colorNode = (g: EditGizmo, fill: string, handleFill = "#555", line = "#888") => {
      (g.node as paper.Path).fillColor = new scope.Color(fill);
      if (g.hIn) g.hIn.fillColor = new scope.Color(handleFill);
      if (g.hOut) g.hOut.fillColor = new scope.Color(handleFill);
      if (g.lineIn) g.lineIn.strokeColor = new scope.Color(line);
      if (g.lineOut) g.lineOut.strokeColor = new scope.Color(line);
    };

    const applyEndpointColors = (snapBlue: Set<number> | null) => {
      const meta = selectedRef.current;
      if (!meta || meta.path.closed || modeRef.current !== "curveEdit") return;
      const n = meta.path.segments.length;
      for (const g of gizmosRef.current) {
        if (g.index === 0 || g.index === n - 1) {
          colorNode(g, snapBlue?.has(g.index) ? "#1e88e5" : "#e53935");
        }
      }
    };

    const selectionPadBounds = (meta: PathMeta) => {
      const src =
        meta.stampRim && stampRimFillRef.current
          ? stampRimFillRef.current
          : meta.path;
      const b = src.bounds.clone();
      const pad = screen(6);
      return new scope.Rectangle(
        b.x - pad,
        b.y - pad,
        Math.max(b.width + pad * 2, screen(12)),
        Math.max(b.height + pad * 2, screen(12)),
      );
    };

    const cornerOf = (b: paper.Rectangle, i: number) => {
      if (i === 0) return b.topLeft;
      if (i === 1) return b.topRight;
      if (i === 2) return b.bottomRight;
      return b.bottomLeft;
    };

    const distToRectEdge = (pt: paper.Point, b: paper.Rectangle) => {
      const inside =
        pt.x >= b.left && pt.x <= b.right && pt.y >= b.top && pt.y <= b.bottom;
      if (inside) {
        return Math.min(
          pt.x - b.left,
          b.right - pt.x,
          pt.y - b.top,
          b.bottom - pt.y,
        );
      }
      const cx = Math.min(Math.max(pt.x, b.left), b.right);
      const cy = Math.min(Math.max(pt.y, b.top), b.bottom);
      return pt.getDistance(new scope.Point(cx, cy));
    };

    const hitXform = (pt: paper.Point, meta: PathMeta): XformHit | null => {
      if (meta.stampRim) return null;
      const b = selectionPadBounds(meta);
      // Scale gets the near-corner zone; rotate sits further out so scale wins.
      const scaleR = screen(11);
      const rotMin = screen(18);
      const rotMax = screen(32);
      const edgeTol = screen(7);
      const center = b.center;

      // Scale first (on the corner handles)
      for (let i = 0; i < 4; i++) {
        if (cornerOf(b, i).getDistance(pt) <= scaleR) {
          return { kind: "scale", corner: i };
        }
      }

      // Rotate: outside the box, in a ring beyond the scale handle
      for (let i = 0; i < 4; i++) {
        const c = cornerOf(b, i);
        const d = c.getDistance(pt);
        const outside = !b.contains(pt);
        if (outside && d >= rotMin && d <= rotMax) {
          const outward = pt.subtract(center);
          const cornerDir = c.subtract(center);
          if (outward.dot(cornerDir) > 0) return { kind: "rotate", corner: i };
        }
      }

      // Move: box edge
      if (distToRectEdge(pt, b) <= edgeTol) return { kind: "move" };

      // Move: on the curve itself
      const loc = meta.path.getNearestLocation(pt);
      if (loc && loc.distance <= screen(8)) return { kind: "move" };

      return null;
    };

    const xformCursor = (hit: XformHit | null): string => {
      if (!hit) return "default";
      if (hit.kind === "move") return "move";
      // CSS has no rotate cursor — `grab` is the usual standard stand-in
      if (hit.kind === "rotate") return "grab";
      if (hit.corner === 0 || hit.corner === 2) return "nwse-resize";
      return "nesw-resize";
    };

    const rebuildTransformGizmos = () => {
      clearXformGizmos();
      const meta = selectedRef.current;
      if (!meta) return;
      meta.path.fullySelected = false;
      meta.path.selected = false;
      const b = selectionPadBounds(meta);
      const strokeW = screen(1.1);
      const box = new scope.Path.Rectangle(b);
      box.strokeColor = new scope.Color("#1e88e5");
      box.strokeWidth = strokeW;
      box.dashArray = [screen(5), screen(3)];
      box.fillColor = null;
      box.locked = true;
      xformItemsRef.current.push(box);

      // Outline rim: selection chrome only (no move/scale/rotate handles)
      if (meta.stampRim) return;

      const cornerSize = screen(7);
      for (let i = 0; i < 4; i++) {
        const c = cornerOf(b, i);
        const sq = new scope.Path.Rectangle({
          center: c,
          size: new scope.Size(cornerSize, cornerSize),
          fillColor: new scope.Color("#fff"),
          strokeColor: new scope.Color("#1e88e5"),
          strokeWidth: strokeW,
        });
        sq.locked = true;
        xformItemsRef.current.push(sq);
      }

      // Small orange anchors (visual only)
      const pr = screen(2.6);
      for (const seg of meta.path.segments) {
        const dot = new scope.Path.Circle({
          center: seg.point,
          radius: pr,
          fillColor: new scope.Color("#c45c26"),
          strokeColor: null,
        });
        dot.locked = true;
        xformItemsRef.current.push(dot);
      }
    };

    const rebuildCurveEditGizmos = () => {
      clearGizmos();
      const meta = selectedRef.current;
      if (!meta || meta.stampRim) return;
      ensureSmoothFlags(meta);
      meta.path.fullySelected = false;
      meta.path.selected = false;
      const nodeR = screen(NODE_SCREEN);
      const handleR = screen(HANDLE_SCREEN);
      const strokeW = screen(1.2);
      const n = meta.path.segments.length;
      const openEnds = !meta.path.closed;

      meta.path.segments.forEach((seg, index) => {
        const smooth = meta.smooth[index] ?? false;
        const isEnd = openEnds && (index === 0 || index === n - 1);
        const fill = isEnd ? "#e53935" : "#222222";
        const node = smooth
          ? new scope.Path.Circle({
              center: seg.point,
              radius: nodeR,
              fillColor: new scope.Color(fill),
              strokeColor: new scope.Color("#fff"),
              strokeWidth: strokeW,
            })
          : new scope.Path.Rectangle({
              center: seg.point,
              size: new scope.Size(nodeR * 2, nodeR * 2),
              fillColor: new scope.Color(fill),
              strokeColor: new scope.Color("#fff"),
              strokeWidth: strokeW,
            });
        const g: EditGizmo = { meta, index, node };
        if (seg.handleIn.length > 0.5) {
          const tip = seg.point.add(seg.handleIn);
          g.lineIn = new scope.Path.Line({
            from: seg.point,
            to: tip,
            strokeColor: new scope.Color("#888"),
            strokeWidth: strokeW,
          });
          g.hIn = new scope.Path.Circle({
            center: tip,
            radius: handleR,
            fillColor: new scope.Color("#555"),
            strokeColor: new scope.Color("#fff"),
            strokeWidth: strokeW,
          });
        }
        if (seg.handleOut.length > 0.5) {
          const tip = seg.point.add(seg.handleOut);
          g.lineOut = new scope.Path.Line({
            from: seg.point,
            to: tip,
            strokeColor: new scope.Color("#888"),
            strokeWidth: strokeW,
          });
          g.hOut = new scope.Path.Circle({
            center: tip,
            radius: handleR,
            fillColor: new scope.Color("#555"),
            strokeColor: new scope.Color("#fff"),
            strokeWidth: strokeW,
          });
        }
        gizmosRef.current.push(g);
      });
      for (const g of gizmosRef.current) g.node.bringToFront();
    };

    const rebuildEditGizmos = () => {
      clearGizmos();
      clearXformGizmos();
      clearCurveHover();
      hoverNodeRef.current = null;
      const mode = modeRef.current;
      if (mode === "edit") rebuildTransformGizmos();
      else if (mode === "curveEdit") {
        rebuildCurveEditGizmos();
        const ptSel = selectedPointRef.current;
        if (ptSel) {
          const g = gizmosRef.current.find(
            (x) => x.meta === ptSel.meta && x.index === ptSel.index,
          );
          if (g) (g.node as paper.Path).fillColor = new scope.Color("#1e88e5");
        }
        const segSel = selectedSegmentRef.current;
        if (segSel) showCurveHover(segSel.meta, segSel.segIndex);
      }
    };

    const clearDrawMarkers = () => {
      for (const e of endsRef.current) e.marker.remove();
      endsRef.current = [];
      drawStartMarkerRef.current?.remove();
      drawStartMarkerRef.current = null;
      clearMagnet();
    };

    const refreshDrawMarkers = () => {
      for (const e of endsRef.current) e.marker.remove();
      endsRef.current = [];
      // Show open endpoints in freehand and polygon so new strokes can continue / join
      if (modeRef.current !== "draw" && modeRef.current !== "polygon") return;
      const activePoly = polygonRef.current;
      const activeDraw = drawingRef.current;
      const continuing = !!continueMetaRef.current;
      for (const meta of metasRef.current) {
        if (meta.path.closed || meta.path.segments.length < 1) continue;
        if (stampOwnerRef.current) {
          if (meta.role !== "feature" || meta.ownerId !== stampOwnerRef.current.id) continue;
        } else if (meta.role === "feature") continue;
        for (const which of ["first", "last"] as const) {
          // While extending a path, don't mark the live tip as a snap target
          if (activePoly === meta.path && which === "last") continue;
          if (activeDraw === meta.path && which === "last") continue;
          // Brand-new stroke: start is the red start-marker, not an end chip
          if (activeDraw === meta.path && which === "first" && !continuing) continue;
          const pt =
            which === "first"
              ? meta.path.firstSegment.point
              : meta.path.lastSegment.point;
          endsRef.current.push({ meta, which, marker: makeEndMarker(pt) });
        }
      }
    };

    /** Prefer an open-curve endpoint under the cursor (for continue / join). */
    const openEndAt = (
      pt: paper.Point,
      opts?: { ignoreLastOf?: paper.Path },
    ): { end: OpenEnd; point: paper.Point } | null => {
      refreshDrawMarkers();
      const near = findDrawEndsNear(pt, opts);
      if (!near.length) return null;
      const end = near[0];
      const point =
        end.which === "first"
          ? end.meta.path.firstSegment.point.clone()
          : end.meta.path.lastSegment.point.clone();
      return { end, point };
    };

    const snapDist = () => screen(SNAP_SCREEN);

    const findDrawEndsNear = (
      pt: paper.Point,
      opts?: { ignoreLastOf?: paper.Path },
    ): OpenEnd[] => {
      const hits: OpenEnd[] = [];
      const lim = snapDist();
      for (const e of endsRef.current) {
        if (
          opts?.ignoreLastOf &&
          e.meta.path === opts.ignoreLastOf &&
          e.which === "last"
        )
          continue;
        const live =
          e.which === "first"
            ? e.meta.path.firstSegment.point
            : e.meta.path.lastSegment.point;
        e.marker.position = live;
        if (live.getDistance(pt) <= lim) hits.push(e);
      }
      return hits;
    };

    const captureSnapshot = (): Snapshot => ({
      items: metasRef.current.map((m) => ({
        raw: cloneRaw(m.path),
        smooth: [...m.smooth],
        closed: m.path.closed,
        lockIndex: m.lockIndex,
        simplifyTol: m.simplifyTol,
        noSimplify: m.noSimplify,
        id: m.id,
        role: m.role,
        stampId: m.stampId,
        ownerId: m.ownerId,
        raised: m.raised,
        widthMm: m.widthMm,
        filled: m.filled,
      })),
    });

    const notifyHistory = () => {
      onHistoryRef.current(undoRef.current.length > 0, redoRef.current.length > 0);
    };

    const pushUndo = () => {
      undoRef.current.push(captureSnapshot());
      if (undoRef.current.length > 40) undoRef.current.shift();
      redoRef.current = [];
      notifyHistory();
      scheduleDraftSave();
    };

    let draftSaveTimer: number | null = null;
    let draftSavePending = false;
    const draftRestoringRef = { current: false };

    const collectDraftItems = (): SketchDraftItem[] =>
      metasRef.current.map((m) => ({
        raw: cloneRaw(m.path),
        smooth: [...m.smooth],
        closed: m.path.closed,
        lockIndex: m.lockIndex,
        simplifyTol: m.simplifyTol,
        noSimplify: m.noSimplify,
        id: m.id,
        role: m.role,
        stampId: m.stampId,
        ownerId: m.ownerId,
        raised: m.raised,
        widthMm: m.widthMm,
        filled: m.filled,
      }));

    const captureBackgroundBlob = async (): Promise<{
      blob: Blob | null;
      place: { x: number; y: number; width: number; height: number } | null;
    }> => {
      const url = backgroundUrlRef.current;
      const raster = bgRef.current;
      if (!url || !raster || raster.width <= 0) {
        return { blob: null, place: null };
      }
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const b = raster.bounds;
        return {
          blob,
          place: { x: b.x, y: b.y, width: b.width, height: b.height },
        };
      } catch {
        return { blob: null, place: null };
      }
    };

    const flushDraftSave = async (opts?: { toast?: boolean }) => {
      if (draftRestoringRef.current) return;
      if (draftSaveTimer != null) {
        window.clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
      }
      draftSavePending = false;
      const items = collectDraftItems().filter((it) => it.raw.length >= 2);
      if (!items.length) {
        await clearSketchDraft();
        return;
      }
      const bg = await captureBackgroundBlob();
      try {
        await saveSketchDraft({
          items,
          mmPerPx: mmPerPxRef.current > 0 ? mmPerPxRef.current : null,
          stamp: stampRef.current ?? { ...DEFAULT_STAMP },
          stampOwnerId: stampOwnerRef.current?.id ?? null,
          bgPlace: bg.place,
          background: bg.blob,
        });
        if (opts?.toast) {
          onDraftSavedRef.current?.("Sketch saved in this browser");
        }
      } catch {
        if (opts?.toast) {
          onDraftSavedRef.current?.("Could not save sketch draft");
        }
      }
    };

    const scheduleDraftSave = () => {
      if (draftRestoringRef.current) return;
      draftSavePending = true;
      if (draftSaveTimer != null) window.clearTimeout(draftSaveTimer);
      draftSaveTimer = window.setTimeout(() => {
        draftSaveTimer = null;
        void flushDraftSave();
      }, 700);
    };

    const restoreSnapshot = (snap: Snapshot) => {
      for (const m of metasRef.current) m.path.remove();
      metasRef.current = [];
      selectedRef.current = null;
      for (const item of snap.items) {
        const path = new scope.Path({
          strokeColor: new scope.Color(item.closed ? "#c45c26" : "#111"),
          strokeWidth: item.closed ? 2.2 : 1.5,
          strokeCap: "round",
          strokeJoin: "round",
        });
        applyRaw(path, item.raw, scope);
        path.closed = item.closed;
        metasRef.current.push({
          path,
          raw: item.raw,
          smooth: item.smooth.length
            ? item.smooth
            : detectSmoothFlags(path),
          lockIndex: item.lockIndex ?? 0,
          simplifyTol: item.simplifyTol,
          noSimplify: item.noSimplify,
          id: item.id,
          role: item.role,
          stampId: item.stampId,
          ownerId: item.ownerId,
          raised: item.raised,
          widthMm: item.widthMm,
          filled: item.filled,
        });
      }
      const ownerId = stampOwnerRef.current?.id;
      stampOwnerRef.current =
        metasRef.current.find((m) => m.id && m.id === ownerId) ?? null;
      for (const m of metasRef.current) {
        if (m.role === "feature") styleFeature(m);
      }
      clearGizmos();
      clearDrawMarkers();
      clearCurveHover();
      clearSnapPreview();
      refreshDrawMarkers();
      syncStampChrome();
      rebuildEditGizmos();
      onHasSelRef.current(false);
      onSimplifySyncRef.current?.(null);
      emitClosedNow();
      syncEmpty();
      if (!draftRestoringRef.current) scheduleDraftSave();
    };

    const applyDraftItems = (
      items: SketchDraftItem[],
      stampOwnerId: string | null,
    ) => {
      restoreSnapshot({ items });
      if (stampOwnerId) {
        const owner =
          metasRef.current.find((m) => m.id === stampOwnerId) ?? null;
        if (owner?.path.closed) {
          stampOwnerRef.current = owner;
          syncStampChrome();
          setSelection(null, true);
        }
      } else {
        const preferClosed =
          metasRef.current.find((m) => m.role !== "feature" && m.path.closed) ??
          metasRef.current[metasRef.current.length - 1] ??
          null;
        if (preferClosed) setSelection(preferClosed, true);
      }
      if (metasRef.current.some((m) => m.path.closed)) notifyClosedCurve();
    };

    let emitTimer: number | null = null;
    const emitClosedNow = () => {
      const cutters = metasRef.current.filter((m) => m.role !== "feature");
      setHasClosedCurve(cutters.some((m) => m.path.closed));
      setHasCurves(cutters.some((m) => m.path.segments.length >= 2));
      const sel = selectedRef.current;
      // Prefer the stamp being edited so 3D keeps its plate while drawing features.
      const closed =
        (stampOwnerRef.current?.path.closed ? stampOwnerRef.current : null) ??
        (sel && sel.role !== "feature" && sel.path.closed ? sel : null) ??
        (sel?.role === "feature"
          ? cutters.find((m) => m.id && m.id === sel.ownerId && m.path.closed)
          : null) ??
        cutters.find((m) => m.path.closed && m.stampId) ??
        cutters.find((m) => m.path.closed) ??
        null;
      if (!closed) {
        onClosedRef.current(null);
        onStampFeaturesRef.current(null);
        return;
      }
      ensureId(closed);
      const pts = samplePathPoints(closed.path, {
        flatness: 0.45,
        minPerCurve: 16,
        maxPoints: 400,
      });
      onClosedRef.current(pts.length >= 3 ? pts : null);
      if (!closed.stampId) {
        onStampFeaturesRef.current(null);
        return;
      }
      const features: StampFeatureIn[] = metasRef.current
        .filter((m) => m.role === "feature" && m.ownerId === closed.id)
        .filter((m) => m.path.segments.length >= 2)
        .map((m) => ({
          points: samplePathPoints(m.path, {
            flatness: 0.45,
            minPerCurve: 8,
            maxPoints: 240,
          }),
          closed: m.path.closed,
          filled: !!m.filled,
          raised: m.raised !== false,
          widthMm: m.widthMm ?? 0.6,
        }));
      onStampFeaturesRef.current(features);
    };

    const clearStampChrome = () => {
      if (selectedRef.current?.stampRim) {
        selectedRef.current = null;
        onHasSelRef.current(false);
        onSimplifySyncRef.current?.(null);
        clearXformGizmos();
      }
      stampOutlineRef.current?.remove();
      stampOutlineRef.current = null;
      stampRimFillRef.current?.remove();
      stampRimFillRef.current = null;
      stampRimMetaRef.current = null;
      stampMaskRef.current?.remove();
      stampMaskRef.current = null;
    };

    const ensureStampRimMeta = (path: paper.Path): PathMeta => {
      let m = stampRimMetaRef.current;
      if (!m) {
        m = {
          path,
          raw: [],
          smooth: [],
          lockIndex: 0,
          noSimplify: true,
          role: "feature",
          stampRim: true,
          raised: true,
          filled: true,
          widthMm: outlineWidthMmRef.current,
        };
        stampRimMetaRef.current = m;
      } else {
        m.path = path;
        m.widthMm = outlineWidthMmRef.current;
        m.filled = true;
      }
      return m;
    };

    const rebuildStampOutline = () => {
      const keepRim = !!selectedRef.current?.stampRim;
      stampOutlineRef.current?.remove();
      stampOutlineRef.current = null;
      stampRimFillRef.current?.remove();
      stampRimFillRef.current = null;
      const owner = stampOwnerRef.current;
      if (!owner || owner.path.segments.length < 3 || !owner.path.closed) {
        stampRimMetaRef.current = null;
        if (keepRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
        return;
      }
      const pts = samplePathPoints(owner.path, {
        flatness: 0.4,
        minPerCurve: 12,
        maxPoints: 360,
      });
      const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      const insetPx = (wallMmRef.current / 2 + Math.max(0, gapMmRef.current)) / mm;
      const loop = offsetClosedClipper(pts, -insetPx);
      if (!loop || loop.length < 3) {
        stampRimMetaRef.current = null;
        if (keepRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
        return;
      }
      // Outer plate edge — always kept for the mask hole
      const path = new scope.Path({
        closed: true,
        fillColor: null,
      });
      for (const p of loop) path.add(new scope.Point(p.x, p.y));
      path.closed = true;
      path.data = { kind: "stamp-outline" };

      if (outlineEnabledRef.current) {
        const wPx = Math.max(0.05, outlineWidthMmRef.current) / mm;
        const innerLoop = offsetClosedClipper(loop, -wPx);
        if (innerLoop && innerLoop.length >= 3) {
          // Keep edge path in the scene (mask hole needs a visible child);
          // no stroke — the filled annulus is the visual.
          path.strokeColor = null;
          path.strokeWidth = 0;
          path.fillColor = null;
          path.visible = true;
          path.locked = true;

          const outer = new scope.Path({ insert: false, closed: true });
          for (const p of loop) outer.add(new scope.Point(p.x, p.y));
          outer.closed = true;
          outer.clockwise = true;

          const hole = new scope.Path({ insert: false, closed: true });
          for (const p of innerLoop) hole.add(new scope.Point(p.x, p.y));
          hole.closed = true;
          hole.clockwise = false;

          const fill = new scope.CompoundPath({
            children: [outer, hole],
            fillColor: new scope.Color("#7f1d1d"),
            strokeColor: null,
            strokeWidth: 0,
            opacity: 0.92,
            locked: false,
          });
          fill.data = { kind: "stamp-rim" };
          stampRimFillRef.current = fill;
        } else {
          // Too narrow to inset — fall back to a thin edge mark
          path.strokeColor = new scope.Color("#7f1d1d");
          path.strokeWidth = screen(1.6);
          path.dashArray = [];
          path.visible = true;
          path.locked = false;
        }
      } else {
        path.strokeColor = new scope.Color("#455a64");
        path.strokeWidth = screen(1.4);
        path.dashArray = [screen(6), screen(4)];
        path.visible = true;
        path.locked = true;
      }

      stampOutlineRef.current = path;
      const rim = ensureStampRimMeta(path);
      if (keepRim) {
        if (outlineEnabledRef.current) {
          selectedRef.current = rim;
        } else {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
      }
    };

    const rebuildStampMask = () => {
      stampMaskRef.current?.remove();
      stampMaskRef.current = null;
      const outline = stampOutlineRef.current;
      if (!outline || !stampOwnerRef.current) return;
      const b = scope.view.bounds.expand(400);
      const frame = new scope.Path.Rectangle(b);
      const hole = outline.clone({ insert: false }) as paper.Path;
      // Clone keeps stroke/visibility from the edge path; force a clean hole punch
      hole.visible = true;
      hole.strokeColor = null;
      hole.strokeWidth = 0;
      hole.fillColor = null;
      hole.dashArray = [];
      frame.clockwise = true;
      hole.clockwise = false;
      const mask = new scope.CompoundPath({
        children: [frame, hole],
        fillColor: new scope.Color(0.45, 0.48, 0.5, 0.42),
        strokeColor: null,
        locked: true,
      });
      mask.data = { kind: "stamp-mask" };
      stampMaskRef.current = mask;
    };

    const refreshStampUi = () => {
      if (stampOwnerRef.current) {
        setStampUiRef.current("back");
        return;
      }
      const target = resolveStampTarget();
      if (!target) {
        setStampUiRef.current("off");
        return;
      }
      // Enabled when a closed curve is selected, or there is exactly one
      const sel = selectedRef.current;
      const sole =
        metasRef.current.filter(
          (m) => m.role !== "feature" && m.path.closed && m.path.visible,
        ).length === 1;
      if (
        modeRef.current === "edit" &&
        ((sel && sel === target) || sole)
      ) {
        setStampUiRef.current(target.stampId ? "edit" : "add");
      } else {
        setStampUiRef.current("off");
      }
    };

    const refreshFeatureHud = () => {
      const sel = selectedRef.current;
      if (stampOwnerRef.current && sel?.stampRim) {
        setFeatureHudRef.current({
          rim: true,
          widthMm: outlineWidthMmRef.current,
          raised: true,
          filled: false,
          closed: true,
        });
      } else if (stampOwnerRef.current && sel && sel.role === "feature") {
        setFeatureHudRef.current({
          widthMm: sel.widthMm ?? 0.6,
          raised: sel.raised !== false,
          filled: !!sel.filled,
          closed: sel.path.closed,
        });
      } else {
        setFeatureHudRef.current(null);
      }
    };

    const syncStampChrome = () => {
      const owner = stampOwnerRef.current;
      for (const m of metasRef.current) {
        ensureId(m);
        if (m.role === "feature") {
          if (owner) {
            const show = m.ownerId === owner.id;
            m.path.visible = show;
            if (show) {
              styleFeature(m);
              m.path.locked = false;
            }
          } else {
            // Cutter-edit mode: keep stamp marks visible but grayed / locked
            const host = metasRef.current.find(
              (c) => c.id && c.id === m.ownerId && c.stampId,
            );
            if (host) {
              m.path.visible = true;
              styleFeature(m, true);
              m.path.locked = true;
            } else {
              m.path.visible = false;
              m.path.locked = true;
            }
          }
        } else if (!owner) {
          m.path.visible = true;
          m.path.locked = false;
          cutterStroke(m, false);
        } else if (m === owner) {
          m.path.visible = true;
          cutterStroke(m, true);
          // Locked so hit-tests / selection never pick the cutter in stamp mode
          m.path.locked = true;
        } else {
          m.path.visible = false;
          m.path.locked = false;
        }
      }
      if (owner) {
        rebuildStampOutline();
        rebuildStampMask();
        const mask = stampMaskRef.current;
        const outline = stampOutlineRef.current;
        for (const m of metasRef.current) {
          if (m.role === "feature" && m.ownerId === owner.id) m.path.sendToBack();
        }
        mask?.sendToBack();
        // Features under the mask so the part outside the outline reads grey.
        for (const m of metasRef.current) {
          if (m.role === "feature" && m.ownerId === owner.id) {
            if (mask) m.path.insertBelow(mask);
          }
        }
        owner.path.bringToFront();
        outline?.bringToFront();
        stampRimFillRef.current?.bringToFront();
      } else {
        clearStampChrome();
        // Gray features under their cutters
        for (const m of metasRef.current) {
          if (m.role === "feature" && m.path.visible) m.path.sendToBack();
        }
      }
      refreshStampUi();
      refreshFeatureHud();
      // Outline path is rebuilt on sync — refresh selection chrome
      rebuildEditGizmos();
    };

    const tagFeature = (meta: PathMeta) => {
      const owner = stampOwnerRef.current;
      if (!owner) return;
      ensureId(owner);
      if (!owner.stampId) owner.stampId = `stamp-${owner.id}`;
      ensureId(meta);
      meta.role = "feature";
      meta.ownerId = owner.id;
      meta.stampId = owner.stampId;
      if (meta.raised == null) meta.raised = true;
      if (meta.filled == null) meta.filled = false;
      if (meta.widthMm == null) meta.widthMm = lastWidthMm.current;
      styleFeature(meta);
    };

    const notifyClosedCurve = () => {
      onCurveClosedRef.current();
    };

    const notifyMaybeEmpty = () => {
      syncEmpty();
      if (metasRef.current.length === 0) onCurvesEmptyRef.current();
    };

    const emitClosed = (immediate = false) => {
      if (emitTimer != null) window.clearTimeout(emitTimer);
      if (immediate) {
        emitTimer = null;
        emitClosedNow();
        return;
      }
      emitTimer = window.setTimeout(() => {
        emitTimer = null;
        emitClosedNow();
      }, 280);
    };

    const setSelection = (meta: PathMeta | null, emitImmediate = true) => {
      for (const m of metasRef.current) {
        m.path.fullySelected = false;
        m.path.selected = false;
      }
      if (stampRimMetaRef.current) {
        stampRimMetaRef.current.path.fullySelected = false;
        stampRimMetaRef.current.path.selected = false;
      }
      if (
        selectedSegmentRef.current &&
        selectedSegmentRef.current.meta !== meta
      ) {
        selectedSegmentRef.current = null;
      }
      if (selectedPointRef.current && selectedPointRef.current.meta !== meta) {
        selectedPointRef.current = null;
      }
      selectedRef.current = meta;
      onHasSelRef.current(!!meta);
      onSimplifySyncRef.current?.(
        meta && !meta.noSimplify && !meta.stampRim
          ? (meta.simplifyTol ?? 1)
          : null,
      );
      rebuildEditGizmos();
      rebuildMeasureDots();
      emitClosed(emitImmediate);
      refreshStampUi();
      refreshFeatureHud();
    };

    const reapplySimplify = (meta: PathMeta) => {
      // Only re-smooth from lockIndex so continued strokes don't reshape earlier parts
      applyRaw(meta.path, meta.raw, scope);
      if (!meta.noSimplify) {
        const tol = meta.simplifyTol ?? 1;
        simplifyTail(meta.path, meta.lockIndex, tol, scope);
        meta.smooth = detectSmoothFlags(meta.path);
      } else {
        for (const seg of meta.path.segments) makeSegmentCorner(seg, scope);
        meta.smooth = meta.path.segments.map(() => false);
      }
      meta.path.fullySelected = false;
      meta.path.selected = false;
      if (meta.role === "feature") styleFeature(meta);
      else {
        meta.path.strokeColor = new scope.Color(
          meta.path.closed ? "#c45c26" : "#111",
        );
      }
    };

    extras.__applySelectedSimplify = (tol: number) => {
      const meta = selectedRef.current;
      if (!meta || meta.noSimplify) return;
      if (Math.abs((meta.simplifyTol ?? 1) - tol) < 1e-9) return;
      meta.simplifyTol = tol;
      reapplySimplify(meta);
      refreshDrawMarkers();
      rebuildEditGizmos();
      rebuildMeasureDots();
      emitClosed(false);
      refreshStampUi();
      refreshFeatureHud();
    };

    extras.__deleteCurrent = () => {
      const meta = selectedRef.current;
      if (!meta) return;
      // Outline rim is toggled off — not deleted
      if (meta.stampRim) return;
      // Never delete the locked cutter while editing its stamp
      if (stampOwnerRef.current && meta.role !== "feature") return;
      pushUndo();
      if (stampOwnerRef.current === meta) stampOwnerRef.current = null;
      const drop = new Set<PathMeta>([meta]);
      if (meta.role !== "feature" && meta.id) {
        for (const m of metasRef.current) {
          if (m.ownerId === meta.id) drop.add(m);
        }
      }
      for (const m of drop) m.path.remove();
      metasRef.current = metasRef.current.filter((m) => !drop.has(m));
      const owner = stampOwnerRef.current;
      const next = owner
        ? (metasRef.current.find(
            (m) =>
              m.role === "feature" &&
              m.ownerId === owner.id &&
              m.path.visible,
          ) ?? null)
        : (metasRef.current.find((m) => m.role !== "feature" && m.path.visible) ??
          metasRef.current.find((m) => m.path.visible) ??
          null);
      selectedSegmentRef.current = null;
      selectedPointRef.current = null;
      clearCurveHover();
      refreshDrawMarkers();
      syncStampChrome();
      setSelection(next, true);
      notifyMaybeEmpty();
    };

    extras.__clearCanvas = () => {
      const hadPaths = metasRef.current.length > 0;
      const hadBg = !!bgRef.current || !!backgroundUrlRef.current;
      const hadDraft =
        hadPaths ||
        !!drawingRef.current ||
        !!polygonRef.current ||
        !!ellipseDrag;
      if (!hadPaths && !hadBg && !hadDraft) return;
      if (hadPaths) pushUndo();

      drawingRef.current?.remove();
      drawingRef.current = null;
      if (polygonRef.current && !metasRef.current.some((m) => m.path === polygonRef.current)) {
        polygonRef.current.remove();
      }
      polygonRef.current = null;
      clearPolyPreview();
      clearEllipseDrag();
      clearMeasureUi();
      clearImageContours();
      clearDrawMarkers();
      clearCurveHover();
      clearAddPointMark();
      selectedSegmentRef.current = null;
      selectedPointRef.current = null;
      continueMetaRef.current = null;

      stampOwnerRef.current = null;
      clearStampChrome();
      for (const m of metasRef.current) m.path.remove();
      metasRef.current = [];

      selectedRef.current = null;
      onHasSelRef.current(false);
      onSimplifySyncRef.current?.(null);
      clearGizmos();
      clearXformGizmos();
      rebuildEditGizmos();
      refreshFeatureHud();
      refreshStampUi();
      syncEmpty();
      onClosedRef.current(null);
      onStampFeaturesRef.current(null);
      onCurvesEmptyRef.current();
      onClearBackgroundRef.current();
      setTraceOpen(false);
      onImagePanelOpenChangeRef.current(false);
      void clearSketchDraft();
      notifyHistory();
    };

    extras.__undo = () => {
      const snap = undoRef.current.pop();
      if (!snap) return;
      redoRef.current.push(captureSnapshot());
      if (redoRef.current.length > 40) redoRef.current.shift();
      restoreSnapshot(snap);
      notifyHistory();
      extras.__setMode?.();
    };

    extras.__redo = () => {
      const snap = redoRef.current.pop();
      if (!snap) return;
      undoRef.current.push(captureSnapshot());
      if (undoRef.current.length > 40) undoRef.current.shift();
      restoreSnapshot(snap);
      notifyHistory();
      extras.__setMode?.();
    };

    extras.__escape = () => {
      setCtxMenu(null);
      if (modeRef.current === "measure") {
        clearMeasureUi();
        onModeChangeRef.current("edit");
        return;
      }
      // Curve-edit → object edit (keep selection)
      if (modeRef.current === "curveEdit") {
        dragRef.current = null;
        selectedSegmentRef.current = null;
        selectedPointRef.current = null;
        clearCurveHover();
        onModeChangeRef.current("edit");
        return;
      }
      // Object edit with selection → deselect
      if (modeRef.current === "edit" && selectedRef.current) {
        dragRef.current = null;
        selectedRef.current = null;
        onHasSelRef.current(false);
        onSimplifySyncRef.current?.(null);
        clearGizmos();
        clearXformGizmos();
        clearCurveHover();
        syncEmpty();
        refreshStampUi();
        refreshFeatureHud();
        emitClosed(true);
        canvas.style.cursor = "default";
        return;
      }
      if (modeRef.current === "ellipse" && ellipseDrag) {
        clearEllipseDrag();
        return;
      }
      // Draw / polygon / ellipse idle → object edit
      if (
        (modeRef.current === "draw" ||
          modeRef.current === "polygon" ||
          modeRef.current === "ellipse") &&
        !drawingRef.current &&
        !polygonRef.current &&
        !ellipseDrag
      ) {
        onModeChangeRef.current("edit");
        return;
      }
      const continuing = continueMetaRef.current;
      const drawing = drawingRef.current;
      if (drawing && continuing) {
        // Drop the in-progress tail; keep the already-finished part
        const anchor = continueAnchorRef.current;
        while (drawing.segments.length > anchor + 1) {
          drawing.removeSegment(drawing.segments.length - 1);
        }
        applyRaw(drawing, continuing.raw, scope);
        continuing.smooth = detectSmoothFlags(drawing);
      } else if (drawing && !continuing) {
        drawing.remove();
      }
      drawingRef.current = null;
      continueMetaRef.current = null;
      if (polygonRef.current) {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
      polyHandleDragRef.current = null;
      clearPolyPreview();
      drawStartMarkerRef.current?.remove();
      drawStartMarkerRef.current = null;
      clearMagnet();
      clearSnapPreview();
      selectedRef.current = null;
      onHasSelRef.current(false);
      onSimplifySyncRef.current?.(null);
      clearGizmos();
      clearXformGizmos();
      syncEmpty();
      clearCurveHover();
      refreshDrawMarkers();
      emitClosed(true);
    };

    extras.__deleteSegmentAt = (meta: PathMeta, segIndex: number) => {
      const path = meta.path;
      const n = path.segments.length;
      const i = segIndex;
      if (n < 2 || i < 0 || i >= (path.closed ? n : n - 1)) return;

      const styleOpen = (p: paper.Path) => {
        p.closed = false;
        p.strokeColor = new scope.Color("#111");
        p.strokeWidth = 1.5;
        p.strokeCap = "round";
        p.strokeJoin = "round";
      };

      if (path.closed) {
        const raw = cloneRaw(path);
        ensureSmoothFlags(meta);
        const smooth = [...meta.smooth];
        const orderedRaw = [...raw.slice(i + 1), ...raw.slice(0, i + 1)];
        const orderedSmooth = [...smooth.slice(i + 1), ...smooth.slice(0, i + 1)];
        orderedRaw[0].handleIn = { x: 0, y: 0 };
        orderedRaw[orderedRaw.length - 1].handleOut = { x: 0, y: 0 };
        styleOpen(path);
        applyRaw(path, orderedRaw, scope);
        meta.smooth = orderedSmooth;
        meta.raw = cloneRaw(path);
        meta.lockIndex = 0;
      } else {
        const raw = cloneRaw(path);
        ensureSmoothFlags(meta);
        const smooth = [...meta.smooth];
        const leftRaw = raw.slice(0, i + 1);
        const rightRaw = raw.slice(i + 1);
        leftRaw[leftRaw.length - 1].handleOut = { x: 0, y: 0 };
        rightRaw[0].handleIn = { x: 0, y: 0 };
        const leftSmooth = smooth.slice(0, i + 1);
        const rightSmooth = smooth.slice(i + 1);
        const keepLeft = leftRaw.length >= 2;
        const keepRight = rightRaw.length >= 2;

        if (!keepLeft && !keepRight) {
          meta.path.remove();
          metasRef.current = metasRef.current.filter((m) => m !== meta);
          const next = metasRef.current[0] ?? null;
          selectedRef.current = next;
          onHasSelRef.current(!!next);
          rebuildEditGizmos();
          if (!next) {
            emitClosed(true);
            notifyMaybeEmpty();
          } else emitClosed(true);
          return;
        }

        if (keepLeft) {
          styleOpen(path);
          applyRaw(path, leftRaw, scope);
          meta.smooth = leftSmooth;
          meta.raw = cloneRaw(path);
          meta.lockIndex = 0;
        } else {
          meta.path.remove();
          metasRef.current = metasRef.current.filter((m) => m !== meta);
        }

        if (keepRight) {
          const rightPath = new scope.Path({
            strokeColor: new scope.Color("#111"),
            strokeWidth: 1.5,
            strokeCap: "round",
            strokeJoin: "round",
          });
          styleOpen(rightPath);
          applyRaw(rightPath, rightRaw, scope);
          const rightMeta: PathMeta = {
            path: rightPath,
            raw: cloneRaw(rightPath),
            smooth: rightSmooth,
            lockIndex: 0,
            simplifyTol: meta.simplifyTol,
            noSimplify: meta.noSimplify,
            role: meta.role,
            raised: meta.raised,
            filled: meta.filled,
            widthMm: meta.widthMm,
            stampId: meta.stampId,
            ownerId: meta.ownerId,
          };
          // Left discarded → transfer cutter identity so stamp features stay linked
          if (!keepLeft) {
            rightMeta.id = meta.id;
            rightMeta.stampId = meta.stampId;
            selectedRef.current = rightMeta;
          }
          metasRef.current.push(rightMeta);
        }
      }

      selectedSegmentRef.current = null;
      if (!metasRef.current.includes(meta) && metasRef.current.length) {
        selectedRef.current = metasRef.current[metasRef.current.length - 1];
      } else if (metasRef.current.includes(meta)) {
        selectedRef.current = meta;
      }
      onHasSelRef.current(!!selectedRef.current);
      syncStampChrome();
      rebuildEditGizmos();
      emitClosed(true);
      notifyMaybeEmpty();
    };

    extras.__deleteHoverPoint = () => {
      if (modeRef.current === "edit") {
        extras.__deleteCurrent?.();
        return;
      }
      if (modeRef.current !== "curveEdit") return;

      const deletePointAt = (meta: PathMeta, index: number) => {
        if (meta.path.segments.length <= (meta.path.closed ? 3 : 2)) return;
        pushUndo();
        const open = !meta.path.closed;
        const wasFirst = index === 0;
        const wasLast = index === meta.path.segments.length - 1;
        meta.path.removeSegment(index);
        meta.smooth.splice(index, 1);
        meta.raw = cloneRaw(meta.path);
        hoverNodeRef.current = null;
        selectedSegmentRef.current = null;
        // Open curve: keep deleting from the new tip on repeated Delete
        if (open && meta.path.segments.length >= 1 && (wasFirst || wasLast)) {
          selectedPointRef.current = {
            meta,
            index: wasFirst ? 0 : meta.path.segments.length - 1,
          };
        } else {
          selectedPointRef.current = null;
        }
        setSelection(meta, true);
      };

      const ptSel = selectedPointRef.current;
      if (ptSel) {
        deletePointAt(ptSel.meta, ptSel.index);
        return;
      }
      const h = hoverNodeRef.current;
      if (h) {
        deletePointAt(h.meta, h.index);
        return;
      }
      const segSel = selectedSegmentRef.current;
      if (segSel) {
        pushUndo();
        extras.__deleteSegmentAt?.(segSel.meta, segSel.segIndex);
        return;
      }
      const segHover = hoverSegmentRef.current;
      if (segHover) {
        pushUndo();
        extras.__deleteSegmentAt?.(segHover.meta, segHover.segIndex);
        return;
      }
      // No point / segment — delete the active curve
      extras.__deleteCurrent?.();
    };

    const updateDrawSnap = (pt: paper.Point, drawing?: paper.Path | null) => {
      for (const e of endsRef.current) {
        const live =
          e.which === "first"
            ? e.meta.path.firstSegment.point
            : e.meta.path.lastSegment.point;
        e.marker.position = live;
      }
      if (drawStartMarkerRef.current && drawingRef.current?.firstSegment) {
        drawStartMarkerRef.current.position = drawingRef.current.firstSegment.point;
      }
      const near = findDrawEndsNear(pt, { ignoreLastOf: drawing ?? undefined });
      for (const e of endsRef.current) {
        (e.marker as paper.Path).fillColor = new scope.Color(
          near.includes(e) ? "#1e88e5" : "#e53935",
        );
      }
      let magnetAt: paper.Point | null = null;
      if (drawing?.firstSegment && drawStartMarkerRef.current) {
        const d = drawing.firstSegment.point.getDistance(pt);
        const hot = d <= snapDist();
        (drawStartMarkerRef.current as paper.Path).fillColor = new scope.Color(
          hot ? "#1e88e5" : "#e53935",
        );
        if (hot) magnetAt = drawing.firstSegment.point;
      }
      if (near.length) magnetAt = near[0].marker.position as paper.Point;
      if (magnetAt) showMagnet(magnetAt);
      else clearMagnet();
    };

    const hitGizmo = (
      pt: paper.Point,
    ): { kind: "node" | "handle-in" | "handle-out"; g: EditGizmo } | null => {
      const lim = screen(NODE_SCREEN + 2);
      // Points win over handles when they overlap
      for (const g of gizmosRef.current) {
        if (g.node.position.getDistance(pt) <= lim) return { kind: "node", g };
      }
      for (const g of gizmosRef.current) {
        if (g.hIn && g.hIn.position.getDistance(pt) <= lim)
          return { kind: "handle-in", g };
        if (g.hOut && g.hOut.position.getDistance(pt) <= lim)
          return { kind: "handle-out", g };
      }
      return null;
    };

    const resetGizmoPaint = () => {
      const meta = selectedRef.current;
      for (const g of gizmosRef.current) {
        const openEnd =
          meta &&
          !meta.path.closed &&
          (g.index === 0 || g.index === meta.path.segments.length - 1);
        colorNode(g, openEnd ? "#e53935" : "#222");
      }
    };

    const paintHandleHover = (g: EditGizmo, which: "in" | "out") => {
      resetGizmoPaint();
      if (which === "in") {
        if (g.hIn) g.hIn.fillColor = new scope.Color("#e53935");
        if (g.lineIn) g.lineIn.strokeColor = new scope.Color("#e53935");
      } else {
        if (g.hOut) g.hOut.fillColor = new scope.Color("#e53935");
        if (g.lineOut) g.lineOut.strokeColor = new scope.Color("#e53935");
      }
    };

    const hitCurveSegment = (
      meta: PathMeta,
      pt: paper.Point,
    ): { segIndex: number; t: number; dist: number } | null => {
      const lim = screen(8);
      // Hit the actual Bézier stroke, not the straight chord between anchors
      const loc = meta.path.getNearestLocation(pt);
      if (!loc || loc.distance > lim) return null;
      return {
        segIndex: loc.index,
        t: loc.time,
        dist: loc.distance,
      };
    };

    /**
     * Join open tip `aWhich` of `aMeta` to open tip `bWhich` of `bMeta`.
     * Same curve → close. Different curves → merge into `aMeta`, remove `bMeta`.
     * Returns the surviving meta (always aMeta after orientation).
     */
    const joinOpenEnds = (
      aMeta: PathMeta,
      aWhich: "first" | "last",
      bMeta: PathMeta,
      bWhich: "first" | "last",
      joinPt: paper.Point,
    ): PathMeta => {
      // Orient A so the join sits at the last segment
      if (aWhich === "first") {
        aMeta.path.reverse();
        reverseRaw(aMeta.raw);
        aMeta.smooth.reverse();
      }
      aMeta.path.lastSegment.point = joinPt.clone();

      if (aMeta === bMeta) {
        // Close self: drop the duplicate first after snapping last→first
        if (aMeta.path.segments.length < 3) return aMeta;
        aMeta.path.removeSegment(aMeta.path.segments.length - 1);
        aMeta.smooth.pop();
        aMeta.path.closed = true;
        aMeta.raw = cloneRaw(aMeta.path);
        ensureSmoothFlags(aMeta);
        aMeta.path.strokeColor = new scope.Color("#c45c26");
        aMeta.path.strokeWidth = 2.2;
        return aMeta;
      }

      // Orient B so the join sits at the first segment
      if (bWhich === "last") {
        bMeta.path.reverse();
        reverseRaw(bMeta.raw);
        bMeta.smooth.reverse();
      }
      // Drop B's duplicate join vertex, append the rest onto A
      const bSegs = bMeta.path.segments.map((s) => s.clone());
      const bSmooth = [...bMeta.smooth];
      if (bSegs.length) {
        bSegs.shift();
        bSmooth.shift();
      }
      // Keep stamp association when merging two open pieces of a cutter
      ensureId(aMeta);
      if (!aMeta.stampId && bMeta.stampId) aMeta.stampId = bMeta.stampId;
      if (bMeta.id) {
        for (const m of metasRef.current) {
          if (m.ownerId === bMeta.id) m.ownerId = aMeta.id;
        }
      }
      bMeta.path.remove();
      metasRef.current = metasRef.current.filter((m) => m !== bMeta);
      for (const s of bSegs) aMeta.path.add(s);
      aMeta.smooth.push(...bSmooth);
      aMeta.raw = cloneRaw(aMeta.path);
      ensureSmoothFlags(aMeta);
      aMeta.path.strokeColor = new scope.Color("#111");
      aMeta.path.strokeWidth = 1.5;
      return aMeta;
    };

    const findOpenEndNear = (
      pt: paper.Point,
      exclude?: { meta: PathMeta; which: "first" | "last" },
    ): { meta: PathMeta; which: "first" | "last"; point: paper.Point } | null => {
      const lim = snapDist();
      let best: { meta: PathMeta; which: "first" | "last"; point: paper.Point } | null =
        null;
      let bestD = lim;
      for (const m of metasRef.current) {
        if (m.path.closed || m.path.segments.length < 1) continue;
        for (const which of ["first", "last"] as const) {
          if (exclude && exclude.meta === m && exclude.which === which) continue;
          const point =
            which === "first"
              ? m.path.firstSegment.point
              : m.path.lastSegment.point;
          const d = point.getDistance(pt);
          if (d <= bestD) {
            bestD = d;
            best = { meta: m, which, point: point.clone() };
          }
        }
      }
      return best;
    };

    const tryCloseJoinDraw = (path: paper.Path, meta: PathMeta, at: paper.Point) => {
      // New freehand uses a start marker (not endsRef) — close when tip is near start
      if (
        !path.closed &&
        path.firstSegment &&
        path.segments.length >= 3 &&
        path.firstSegment.point.getDistance(at) <= snapDist()
      ) {
        path.lastSegment.point = path.firstSegment.point.clone();
        path.closePath();
        return;
      }
      refreshDrawMarkers();
      const snap = findDrawEndsNear(at, { ignoreLastOf: path });
      if (!snap.length) return;
      const target = snap[0];
      // Can't join the live tip to itself
      if (target.meta === meta && target.which === "last") return;
      const joinPt =
        target.which === "first"
          ? target.meta.path.firstSegment.point.clone()
          : target.meta.path.lastSegment.point.clone();
      // Own start → close (need a real loop) — continuing strokes via endsRef
      if (target.meta === meta && target.which === "first") {
        if (path.segments.length < 3) return;
        path.lastSegment.point = joinPt;
        path.closePath();
        return;
      }
      // Other curve's endpoint → merge into this stroke and stop drawing
      joinOpenEnds(meta, "last", target.meta, target.which, joinPt);
    };

    const mergeCloseEdit = (meta: PathMeta, draggedWhich: "first" | "last") => {
      const tip =
        draggedWhich === "first"
          ? meta.path.firstSegment.point
          : meta.path.lastSegment.point;
      const hit = findOpenEndNear(tip, { meta, which: draggedWhich });
      if (!hit) return;
      const surviving = joinOpenEnds(
        meta,
        draggedWhich,
        hit.meta,
        hit.which,
        hit.point,
      );
      surviving.raw = cloneRaw(surviving.path);
      ensureSmoothFlags(surviving);
      if (surviving.role === "feature" || stampOwnerRef.current) {
        if (surviving.role !== "feature") tagFeature(surviving);
        else styleFeature(surviving);
        syncStampChrome();
      } else if (surviving.path.closed) {
        surviving.path.strokeColor = new scope.Color("#c45c26");
        surviving.path.strokeWidth = 2.2;
        notifyClosedCurve();
      }
      setSelection(surviving, true);
    };

    const finishStroke = (path: paper.Path, meta: PathMeta, at: paper.Point) => {
      tryCloseJoinDraw(path, meta, at);
      const continuing = !!continueMetaRef.current;
      const anchor = continuing ? continueAnchorRef.current : 0;
      meta.lockIndex = continuing ? anchor : 0;
      if (snapGridRef.current) {
        // Grid freehand: keep snapped corners, no simplify / Bézier handles
        for (let i = anchor; i < path.segments.length; i++) {
          makeSegmentCorner(path.segments[i], scope);
        }
        meta.raw = cloneRaw(path);
        ensureSmoothFlags(meta);
        for (let i = anchor; i < path.segments.length; i++) {
          meta.smooth[i] = false;
        }
        meta.noSimplify = true;
      } else {
        // Store dense raw, then only smooth the new tail
        meta.raw = cloneRaw(path);
        if (meta.simplifyTol == null) meta.simplifyTol = simplifyRef.current;
        simplifyTail(path, anchor, meta.simplifyTol, scope);
        meta.smooth = detectSmoothFlags(path);
        meta.noSimplify = false;
      }
      path.fullySelected = false;
      path.selected = false;
      path.strokeColor = new scope.Color(path.closed ? "#c45c26" : "#111");
      path.strokeWidth = path.closed ? 2.2 : 1.5;
      if (stampOwnerRef.current) {
        tagFeature(meta);
        drawStartMarkerRef.current?.remove();
        drawStartMarkerRef.current = null;
        clearMagnet();
        clearSnapPreview();
        syncStampChrome();
        setSelection(meta);
        refreshDrawMarkers();
        syncEmpty();
        return;
      }
      drawStartMarkerRef.current?.remove();
      drawStartMarkerRef.current = null;
      clearMagnet();
      clearSnapPreview();
      setSelection(meta);
      refreshDrawMarkers();
      syncEmpty();
      if (path.closed) notifyClosedCurve();
    };

    const commitPolygon = (path: paper.Path, closed: boolean) => {
      const existing = metasRef.current.find((m) => m.path === path);
      // New polygon: one undo for the whole shape. Continue already pushed on attach.
      if (!existing) pushUndo();
      path.closed = closed;
      path.strokeColor = new scope.Color(closed ? "#c45c26" : "#111");
      path.strokeWidth = closed ? 2.2 : 1.5;
      path.fullySelected = false;
      path.selected = false;
      // Click+drag points keep their smooth handles; plain clicks stay corners
      const raw = cloneRaw(path);
      const smooth = detectSmoothFlags(path);
      let meta: PathMeta;
      if (existing) {
        existing.raw = raw;
        existing.smooth = smooth;
        existing.lockIndex = 0;
        meta = existing;
      } else {
        meta = { path, raw, smooth, lockIndex: 0 };
        metasRef.current.push(meta);
      }
      polygonRef.current = null;
      polyHandleDragRef.current = null;
      clearPolyPreview();
      clearMagnet();
      clearSnapPreview();
      if (stampOwnerRef.current) {
        tagFeature(meta);
        syncStampChrome();
        setSelection(meta);
        refreshDrawMarkers();
        syncEmpty();
        return;
      }
      setSelection(meta);
      refreshDrawMarkers();
      syncEmpty();
      // Only leave polygon mode when the shape was closed
      if (closed) notifyClosedCurve();
    };

    const finishPolygon = (path: paper.Path) => {
      if (path.segments.length < 3) return;
      commitPolygon(path, true);
    };

    /**
     * Clicking an open endpoint while drawing a polygon: snap, merge/close, and
     * finish the stroke (same idea as freehand join).
     */
    const finishPolygonJoin = (
      path: paper.Path,
      join: { end: OpenEnd; point: paper.Point },
    ) => {
      // Snap tip onto the target endpoint
      if (path.lastSegment.point.getDistance(join.point) > 1e-3) {
        path.add(join.point.clone());
      } else {
        path.lastSegment.point = join.point.clone();
      }

      // Closing back on our own start
      if (join.end.meta.path === path && join.end.which === "first") {
        finishPolygon(path);
        return;
      }

      let meta = metasRef.current.find((m) => m.path === path);
      if (!meta) {
        // New polygon not yet committed — register before merge
        pushUndo();
        meta = {
          path,
          raw: cloneRaw(path),
          smooth: path.segments.map(() => false),
          lockIndex: 0,
        };
        metasRef.current.push(meta);
      }

      joinOpenEnds(
        meta,
        "last",
        join.end.meta,
        join.end.which,
        join.point.clone(),
      );

      meta.raw = cloneRaw(meta.path);
      meta.smooth = detectSmoothFlags(meta.path);
      if (stampOwnerRef.current || meta.role === "feature") {
        tagFeature(meta);
      } else {
        meta.path.strokeColor = new scope.Color(
          meta.path.closed ? "#c45c26" : "#111",
        );
        meta.path.strokeWidth = meta.path.closed ? 2.2 : 1.5;
      }
      meta.path.fullySelected = false;
      meta.path.selected = false;

      polygonRef.current = null;
      polyHandleDragRef.current = null;
      clearPolyPreview();
      clearMagnet();
      clearSnapPreview();
      setSelection(meta, true);
      refreshDrawMarkers();
      syncEmpty();
      if (meta.role === "feature") {
        styleFeature(meta);
        syncStampChrome();
      } else if (meta.path.closed) notifyClosedCurve();
    };

    /** Enter: end polygon as an open polyline (no close); stay in polygon mode. */
    const finishPolygonOpen = () => {
      const path = polygonRef.current;
      if (!path || modeRef.current !== "polygon") return;
      if (path.segments.length < 2) {
        path.remove();
        polygonRef.current = null;
        polyHandleDragRef.current = null;
        clearPolyPreview();
        clearMagnet();
        clearSnapPreview();
        refreshDrawMarkers();
        syncEmpty();
        return;
      }
      commitPolygon(path, false);
    };

    // ---- Screen-space pan (no jitter) ----
    const panByScreenDelta = (dx: number, dy: number) => {
      scope.view.center = scope.view.center.add(
        new scope.Point(-dx / scope.view.zoom, -dy / scope.view.zoom),
      );
      rebuildGrid();
      if (stampOwnerRef.current) rebuildStampMask();
    };

    const onNativeDown = (ev: MouseEvent) => {
      if (ev.button === 1 || (ev.button === 0 && spaceRef.current)) {
        ev.preventDefault();
        ev.stopPropagation();
        panRef.current = { x: ev.clientX, y: ev.clientY };
        canvas.style.cursor = "grabbing";
      }
    };
    const onNativeMove = (ev: MouseEvent) => {
      if (!panRef.current) return;
      ev.preventDefault();
      const dx = ev.clientX - panRef.current.x;
      const dy = ev.clientY - panRef.current.y;
      panRef.current = { x: ev.clientX, y: ev.clientY };
      panByScreenDelta(dx, dy);
      canvas.style.cursor = "grabbing";
    };
    const onNativeUp = (ev: MouseEvent) => {
      if (panRef.current) {
        ev.preventDefault();
        panRef.current = null;
        canvas.style.cursor = spaceRef.current ? "grab" : "crosshair";
      }
    };
    const onAuxClick = (ev: MouseEvent) => {
      // Block browser middle-click autoscroll / paste quirks
      if (ev.button === 1) ev.preventDefault();
    };

    const tool = new scope.Tool();

    tool.onMouseMove = (e: paper.ToolEvent) => {
      if (panRef.current) return;
      canvas.style.cursor = spaceRef.current ? "move" : "crosshair";
      if (dragRef.current) return;

      // Measure: rubber-band, hover point / segment
      if (modeRef.current === "measure") {
        if (measureDrag?.moved) {
          updateMeasureDragVisual(measureDrag.start, e.point);
          canvas.style.cursor = "crosshair";
          return;
        }
        if (measureEditRef.current) return;

        const ptHit = hitAnyPoint(e.point);
        if (ptHit) {
          clearCurveHover();
          const dot = measureDotHits.find(
            (d) => d.meta === ptHit.meta && d.index === ptHit.index,
          );
          paintMeasureDotHover(dot ?? null);
          canvas.style.cursor = "pointer";
          if (measureAnchor) {
            showMeasureLine(measureAnchor, ptHit.point);
            setMeasureReadout(formatMeasure(measureAnchor.getDistance(ptHit.point)));
          } else {
            setMeasureReadout(null);
          }
          return;
        }
        paintMeasureDotHover(null);

        if (measureAnchor) {
          const ctrl = !!(e.modifiers && e.modifiers.control);
          updateMeasureDragVisual(measureAnchor, e.point, ctrl);
          canvas.style.cursor = "crosshair";
          return;
        }

        const hit = hitAnySegment(e.point);
        if (hit) {
          const chord = segmentChord(hit.meta, hit.segIndex);
          if (chord) {
            showCurveHover(hit.meta, hit.segIndex);
            setMeasureReadout(formatMeasure(chord.lengthPx));
            canvas.style.cursor = "pointer";
            return;
          }
        }
        clearCurveHover();
        setMeasureReadout(null);
        return;
      }

      // Image-trace previews: hover highlight
      if (imagePreviewPaths.some(Boolean)) {
        const ci = hitImageContour(e.point);
        if (ci !== hoverContourIndex) {
          if (hoverContourIndex >= 0) paintImageContour(hoverContourIndex, false);
          hoverContourIndex = ci;
          if (ci >= 0) {
            paintImageContour(ci, true);
            canvas.style.cursor = "pointer";
          }
        } else if (ci >= 0) {
          canvas.style.cursor = "pointer";
        }
        if (ci >= 0) return;
      }

      if (modeRef.current === "polygon") {
        showSnapPreview(e.point);
        refreshDrawMarkers();
        if (polygonRef.current?.segments.length) {
          const poly = polygonRef.current;
          const first = poly.firstSegment.point;
          const from = poly.lastSegment.point;
          const ctrl = !!(e.modifiers && e.modifiers.control);
          const nearClose =
            poly.segments.length >= 3 &&
            first.getDistance(e.point) <= snapDist();
          if (nearClose) {
            showMagnet(first);
            updatePolyPreview(first);
          } else {
            const join = openEndAt(e.point, { ignoreLastOf: poly });
            if (join) {
              showMagnet(join.point);
              updatePolyPreview(join.point);
            } else {
              clearMagnet();
              updatePolyPreview(maybeSnap(snapPolyPoint(from, e.point, ctrl)));
            }
          }
        } else {
          // Before first vertex: highlight open ends to continue an existing curve
          clearPolyPreview();
          updateDrawSnap(e.point);
        }
        return;
      }

      if (modeRef.current === "edit") {
        clearAddPointMark();
        clearSnapPreview();
        const meta = selectedRef.current;
        if (meta) {
          const hit = hitXform(e.point, meta);
          if (hit) {
            clearCurveHover();
            canvas.style.cursor = xformCursor(hit);
            return;
          }
          // Hover another curve → thin highlight so click-target is clear
          const other = pickEditableMeta(e.point);
          if (other && other !== meta) {
            showPathHover(other);
            canvas.style.cursor = "pointer";
            return;
          }
          clearCurveHover();
          canvas.style.cursor = "default";
          return;
        }
        // No selection — hover paths to hint select
        const m = pickEditableMeta(e.point);
        if (m) {
          showPathHover(m);
          canvas.style.cursor = "pointer";
        } else {
          clearCurveHover();
          canvas.style.cursor = "default";
        }
        return;
      }

      if (modeRef.current === "curveEdit") {
        showSnapPreview(e.point);
        const shift = shiftRef.current || !!(e.modifiers && e.modifiers.shift);
        if (shift) {
          canvas.style.cursor = "copy";
          const meta = selectedRef.current;
          if (meta) {
            const loc = meta.path.getNearestLocation(e.point);
            if (loc && loc.distance <= screen(10)) {
              showCurveHover(meta, loc.index);
              showAddPointMark(loc.point);
              return;
            }
          }
          clearCurveHover();
          clearAddPointMark();
          return;
        }
        clearAddPointMark();

        const gh = hitGizmo(e.point);
        if (gh) {
          clearCurveHover();
          if (gh.kind === "node") {
            resetGizmoPaint();
            (gh.g.node as paper.Path).fillColor = new scope.Color("#e53935");
            hoverNodeRef.current = { meta: gh.g.meta, index: gh.g.index };
          } else {
            hoverNodeRef.current = null;
            paintHandleHover(gh.g, gh.kind === "handle-in" ? "in" : "out");
          }
          // Keep selected point visible under hover paint
          const ptSel = selectedPointRef.current;
          if (ptSel) {
            const g = gizmosRef.current.find(
              (x) => x.meta === ptSel.meta && x.index === ptSel.index,
            );
            if (g && (!gh || gh.g !== g))
              (g.node as paper.Path).fillColor = new scope.Color("#1e88e5");
          }
          canvas.style.cursor = "pointer";
          return;
        }
        hoverNodeRef.current = null;
        resetGizmoPaint();
        // Paint selected point
        const ptSel = selectedPointRef.current;
        if (ptSel) {
          const g = gizmosRef.current.find(
            (x) => x.meta === ptSel.meta && x.index === ptSel.index,
          );
          if (g) (g.node as paper.Path).fillColor = new scope.Color("#1e88e5");
        }
        const meta = selectedRef.current;
        if (meta) {
          const ch = hitCurveSegment(meta, e.point);
          if (ch) {
            showCurveHover(meta, ch.segIndex);
            canvas.style.cursor = "pointer";
            return;
          }
          // Hover another editable curve
          const other = pickEditableMeta(e.point);
          if (other && other !== meta) {
            showPathHover(other);
            canvas.style.cursor = "pointer";
            return;
          }
        } else {
          const m = pickEditableMeta(e.point);
          if (m) {
            showPathHover(m);
            canvas.style.cursor = "pointer";
            return;
          }
        }
        // Keep click-selected segment highlighted
        const segSel = selectedSegmentRef.current;
        if (segSel) {
          showCurveHover(segSel.meta, segSel.segIndex);
        } else {
          clearCurveHover();
        }
        clearMagnet();
        canvas.style.cursor = "default";
        return;
      }

      showSnapPreview(e.point);
      refreshDrawMarkers();
      if (drawingRef.current) updateDrawSnap(e.point, drawingRef.current);
      else updateDrawSnap(e.point);
    };

    tool.onMouseDown = (e: paper.ToolEvent) => {
      if (panRef.current || spaceRef.current) return;

      if (modeRef.current === "measure") {
        measureEditRef.current = null;
        setMeasureEdit(null);

        const ptHit = hitAnyPoint(e.point);

        // Second click on a point finishes point→point measure
        if (measureAnchor && ptHit) {
          measureDrag = {
            start: measureAnchor.clone(),
            moved: false,
            fromPoint: true,
            segment: null,
            finishTo: ptHit.point.clone(),
          };
          return;
        }

        // New gesture — drop pending anchor unless continuing from empty drag
        if (measureAnchor && !ptHit) {
          measureAnchor = null;
          clearMeasureLine();
        }

        const segHit = ptHit ? null : hitAnySegment(e.point);
        const start = ptHit ? ptHit.point.clone() : e.point.clone();
        measureDrag = {
          start,
          moved: false,
          fromPoint: !!ptHit,
          segment: segHit
            ? { meta: segHit.meta, segIndex: segHit.segIndex }
            : null,
          finishTo: null,
        };
        return;
      }

      if (imagePreviewPaths.some(Boolean)) {
        const ci = hitImageContour(e.point);
        if (ci >= 0) {
          importImageContour(ci);
          return;
        }
      }

      if (modeRef.current === "ellipse") {
        clearEllipseDrag();
        const from = maybeSnap(e.point);
        ellipseDrag = {
          from,
          path: null,
          pin: makeEllipsePin(from),
        };
        return;
      }

      if (modeRef.current === "polygon") {
        if (!polygonRef.current) {
          const attach = openEndAt(e.point);
          if (attach) {
            // Continue an existing open curve from that endpoint
            const { end } = attach;
            const meta = end.meta;
            pushUndo();
            if (end.which === "first") {
              meta.path.reverse();
              reverseRaw(meta.raw);
              meta.smooth.reverse();
            }
            meta.raw = cloneRaw(meta.path);
            polygonRef.current = meta.path;
            polyBaseCount = meta.path.segments.length;
            polyHandleDragRef.current = {
              index: meta.path.segments.length - 1,
            };
            clearPolyPreview();
            clearMagnet();
            setSelection(meta, false);
            syncEmpty();
            return;
          }
          polygonRef.current = new scope.Path({
            segments: [maybeSnap(e.point)],
            strokeColor: new scope.Color("#111"),
            strokeWidth: 1.5,
            fullySelected: false,
            selected: false,
          });
          polyBaseCount = 0;
          polyHandleDragRef.current = { index: 0 };
          clearPolyPreview();
          syncEmpty();
          return;
        }
        const poly = polygonRef.current;
        const first = poly.firstSegment.point;
        if (poly.segments.length >= 3 && first.getDistance(e.point) <= snapDist()) {
          finishPolygon(poly);
          return;
        }
        // Join to any other open endpoint → merge/close and finish (like freehand)
        const join = openEndAt(e.point, { ignoreLastOf: poly });
        if (join) {
          finishPolygonJoin(poly, join);
          return;
        }
        const ctrl = !!(e.modifiers && e.modifiers.control);
        const pt = maybeSnap(
          snapPolyPoint(poly.lastSegment.point, e.point, ctrl),
        );
        poly.add(pt);
        polyHandleDragRef.current = { index: poly.segments.length - 1 };
        clearPolyPreview();
        return;
      }

      if (modeRef.current === "edit") {
        const meta = selectedRef.current;
        // Double-click → curve-edit mode
        if (toolDomEvent(e)?.detail === 2) {
          dragRef.current = null;
          let target = meta;
          if (!target) {
            target = pickEditableMeta(e.point);
          } else {
            const hit = hitXform(e.point, target);
            const onCurve = hitCurveSegment(target, e.point);
            if (!hit && !onCurve) {
              target = pickEditableMeta(e.point);
            }
          }
          if (target) {
            setSelection(target, true);
            // Outline rim is width-only — no point editing
            if (!target.stampRim) onModeChangeRef.current("curveEdit");
          }
          return;
        }

        // Prefer a nested / closer curve before transform handles of the selection
        {
          const nested = pickEditableMeta(e.point);
          if (nested && nested !== meta) {
            setSelection(nested, false);
            return;
          }
        }

        if (meta) {
          const hit = hitXform(e.point, meta);
          if (hit) {
            // Undo is pushed on first drag move so double-click stays clean
            if (hit.kind === "move") {
              dragRef.current = {
                kind: "xform-move",
                meta,
                last: e.point.clone(),
                started: false,
                linked: linkedStampFeatures(meta),
              };
            } else if (hit.kind === "scale") {
              const b = selectionPadBounds(meta);
              const pivot = cornerOf(b, (hit.corner + 2) % 4).clone();
              dragRef.current = {
                kind: "xform-scale",
                meta,
                corner: hit.corner,
                pivot,
                startCorner: cornerOf(b, hit.corner).clone(),
                startRaw: cloneRaw(meta.path),
                linkedStarts: linkedStampFeatures(meta).map((m) => ({
                  meta: m,
                  raw: cloneRaw(m.path),
                })),
                started: false,
              };
            } else {
              const center = meta.path.bounds.center.clone();
              dragRef.current = {
                kind: "xform-rotate",
                meta,
                center,
                startAngle: e.point.subtract(center).angle,
                startRaw: cloneRaw(meta.path),
                linkedStarts: linkedStampFeatures(meta).map((m) => ({
                  meta: m,
                  raw: cloneRaw(m.path),
                })),
                started: false,
              };
            }
            return;
          }
        }

        // Click inside the selection box (but not on a handle) keeps selection
        if (meta && selectionPadBounds(meta).contains(e.point)) return;

        const m = pickEditableMeta(e.point);
        if (m) {
          setSelection(m, false);
          return;
        }
        // Empty click outside deselects
        if (meta) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
          rebuildEditGizmos();
          emitClosed(true);
        }
        return;
      }

      if (modeRef.current === "curveEdit") {
        const shift = shiftRef.current || !!(e.modifiers && e.modifiers.shift);
        const meta = selectedRef.current;
        if (shift && meta) {
          const loc = meta.path.getNearestLocation(e.point);
          if (loc && loc.distance <= screen(10)) {
            insertSmoothPointAt(meta, e.point);
            return;
          }
        }

        const gh = hitGizmo(e.point);
        if (gh) {
          selectedSegmentRef.current = null;
          setSelection(gh.g.meta, false);
          if (gh.kind === "node")
            dragRef.current = {
              kind: "node",
              meta: gh.g.meta,
              index: gh.g.index,
              origin: e.point.clone(),
              started: false,
            };
          else if (gh.kind === "handle-in")
            dragRef.current = {
              kind: "handle-in",
              meta: gh.g.meta,
              index: gh.g.index,
            };
          else
            dragRef.current = {
              kind: "handle-out",
              meta: gh.g.meta,
              index: gh.g.index,
            };
          return;
        }
        if (meta) {
          const ch = hitCurveSegment(meta, e.point);
          if (ch) {
            selectedPointRef.current = null;
            dragRef.current = {
              kind: "curve",
              meta,
              segIndex: ch.segIndex,
              t: ch.t,
              last: e.point.clone(),
              started: false,
              bendStraight: false,
            };
            return;
          }
        }
        // Click empty → clear point/segment selection; maybe switch curve
        selectedSegmentRef.current = null;
        selectedPointRef.current = null;
        clearCurveHover();
        const m = pickEditableMeta(e.point);
        if (m) setSelection(m, false);
        return;
      }

      // draw
      refreshDrawMarkers();
      const near = findDrawEndsNear(e.point);
      if (near.length > 0) {
        const { meta, which } = near[0];
        pushUndo();
        if (which === "first") {
          meta.path.reverse();
          reverseRaw(meta.raw);
          meta.smooth.reverse();
          meta.lockIndex = Math.max(
            0,
            meta.path.segments.length - 1 - meta.lockIndex,
          );
        }
        // Bake current (already-smoothed) geometry so the next Smooth only
        // touches the newly drawn tail.
        meta.raw = cloneRaw(meta.path);
        continueMetaRef.current = meta;
        continueAnchorRef.current = meta.path.segments.length - 1;
        meta.lockIndex = continueAnchorRef.current;
        drawingRef.current = meta.path;
        setSelection(meta, false);
        drawStartMarkerRef.current?.remove();
        drawStartMarkerRef.current = makeEndMarker(meta.path.firstSegment.point);
        // Keep other open ends visible so we can join mid-stroke
        refreshDrawMarkers();
        return;
      }

      pushUndo();
      continueMetaRef.current = null;
      continueAnchorRef.current = 0;
      for (const meta of metasRef.current) {
        meta.path.fullySelected = false;
        meta.path.selected = false;
      }
      const start = maybeSnap(e.point);
      const path = new scope.Path({
        segments: [start],
        strokeColor: new scope.Color("#111"),
        strokeWidth: 1.5,
        strokeCap: "round",
        strokeJoin: "round",
        fullySelected: false,
        selected: false,
      });
      drawingRef.current = path;
      drawStartMarkerRef.current?.remove();
      drawStartMarkerRef.current = makeEndMarker(start);
      // Keep other curves' endpoints visible for joining
      refreshDrawMarkers();
      syncEmpty();
    };

    tool.onMouseDrag = (e: paper.ToolEvent) => {
      if (panRef.current) return;

      if (modeRef.current === "measure" && measureDrag) {
        const dist = measureDrag.start.getDistance(e.point);
        if (dist > screen(3)) {
          measureDrag.moved = true;
          measureDrag.finishTo = null;
          measureAnchor = null;
          clearCurveHover();
          const ctrl = toolCtrlOrMeta(e);
          updateMeasureDragVisual(measureDrag.start, e.point, ctrl);
        }
        return;
      }

      if (modeRef.current === "ellipse" && ellipseDrag) {
        const ctrl = toolCtrlOrMeta(e);
        const fromCenter = toolShift(e) || shiftRef.current;
        updateEllipsePath(
          ellipseDrag.from,
          maybeSnap(e.point),
          ctrl,
          fromCenter,
        );
        return;
      }

      if (modeRef.current === "polygon" && polyHandleDragRef.current && polygonRef.current) {
        const idx = polyHandleDragRef.current.index;
        const seg = polygonRef.current.segments[idx];
        if (seg) {
          const delta = e.point.subtract(seg.point);
          if (delta.length > screen(3)) {
            seg.handleOut = delta;
            seg.handleIn = delta.multiply(-1);
          }
        }
        updatePolyPreview(e.point);
        return;
      }

      const drag = dragRef.current;
      if (!drag) {
        if (modeRef.current === "draw" && drawingRef.current) {
          const pt = maybeSnap(e.point);
          const last = drawingRef.current.lastSegment?.point;
          // Grid: one vertex per cell (skip duplicates while dragging)
          if (
            !last ||
            Math.hypot(pt.x - last.x, pt.y - last.y) >
              (snapGridRef.current ? GRID_STEP * 0.4 : 0.5)
          ) {
            drawingRef.current.add(pt);
          }
          updateDrawSnap(pt, drawingRef.current);
          showSnapPreview(e.point);
        }
        return;
      }

      if (drag.kind === "xform-move") {
        if (!drag.started) {
          if (e.point.getDistance(drag.last) < screen(2)) return;
          pushUndo();
          drag.started = true;
        }
        const delta = e.point.subtract(drag.last);
        drag.last = e.point.clone();
        drag.meta.path.translate(delta);
        for (const m of drag.linked) m.path.translate(delta);
        rebuildTransformGizmos();
        return;
      }
      if (drag.kind === "xform-scale") {
        if (!drag.started) {
          pushUndo();
          drag.started = true;
        }
        applyRaw(drag.meta.path, drag.startRaw, scope);
        for (const f of drag.linkedStarts) applyRaw(f.meta.path, f.raw, scope);
        const dx0 = drag.startCorner.x - drag.pivot.x;
        const dy0 = drag.startCorner.y - drag.pivot.y;
        const dx1 = e.point.x - drag.pivot.x;
        const dy1 = e.point.y - drag.pivot.y;
        let sx = Math.abs(dx0) > 1e-4 ? dx1 / dx0 : 1;
        let sy = Math.abs(dy0) > 1e-4 ? dy1 / dy0 : 1;
        // Avoid flipping through zero
        if (Math.abs(sx) < 0.05) sx = sx < 0 ? -0.05 : 0.05;
        if (Math.abs(sy) < 0.05) sy = sy < 0 ? -0.05 : 0.05;
        const ctrl = toolCtrlOrMeta(e);
        if (ctrl) {
          const len0 = Math.hypot(dx0, dy0) || 1;
          const s = Math.max(0.05, Math.hypot(dx1, dy1) / len0);
          sx = (Math.sign(sx) || 1) * s;
          sy = (Math.sign(sy) || 1) * s;
        }
        drag.meta.path.scale(sx, sy, drag.pivot);
        for (const f of drag.linkedStarts) f.meta.path.scale(sx, sy, drag.pivot);
        rebuildTransformGizmos();
        return;
      }
      if (drag.kind === "xform-rotate") {
        if (!drag.started) {
          pushUndo();
          drag.started = true;
        }
        applyRaw(drag.meta.path, drag.startRaw, scope);
        for (const f of drag.linkedStarts) applyRaw(f.meta.path, f.raw, scope);
        let ang = e.point.subtract(drag.center).angle;
        const ctrl = toolCtrlOrMeta(e);
        let delta = ang - drag.startAngle;
        if (ctrl) delta = Math.round(delta / 15) * 15;
        drag.meta.path.rotate(delta, drag.center);
        for (const f of drag.linkedStarts) {
          f.meta.path.rotate(delta, drag.center);
        }
        rebuildTransformGizmos();
        return;
      }

      if (drag.kind === "node") {
        if (!drag.started) {
          if (e.point.getDistance(drag.origin) < screen(3)) return;
          pushUndo();
          drag.started = true;
          selectedPointRef.current = null;
          selectedSegmentRef.current = null;
        }
        const seg = drag.meta.path.segments[drag.index];
        seg.point = maybeSnap(e.point);
        const n = drag.meta.path.segments.length;
        const open = !drag.meta.path.closed;
        rebuildEditGizmos();
        if (open && (drag.index === 0 || drag.index === n - 1)) {
          const which = drag.index === 0 ? "first" : "last";
          const hit = findOpenEndNear(e.point, {
            meta: drag.meta,
            which,
          });
          const blue = new Set<number>();
          if (hit) {
            blue.add(drag.index);
            if (hit.meta === drag.meta) {
              blue.add(which === "first" ? n - 1 : 0);
            }
            showMagnet(hit.point);
          } else clearMagnet();
          applyEndpointColors(blue.size ? blue : null);
        }
        return;
      }
      if (drag.kind === "handle-in") {
        const seg = drag.meta.path.segments[drag.index];
        seg.handleIn = e.point.subtract(seg.point);
        if (drag.meta.smooth[drag.index]) {
          const len = Math.max(seg.handleOut.length, 1);
          seg.handleOut = seg.handleIn.normalize().multiply(-len);
        }
        rebuildEditGizmos();
        return;
      }
      if (drag.kind === "handle-out") {
        const seg = drag.meta.path.segments[drag.index];
        seg.handleOut = e.point.subtract(seg.point);
        if (drag.meta.smooth[drag.index]) {
          const len = Math.max(seg.handleIn.length, 1);
          seg.handleIn = seg.handleOut.normalize().multiply(-len);
        }
        rebuildEditGizmos();
        return;
      }
      if (drag.kind === "curve") {
        const segs = drag.meta.path.segments;
        const a = segs[drag.segIndex];
        const b = segs[(drag.segIndex + 1) % segs.length];
        if (!a || !b) return;
        if (!drag.started) {
          if (e.point.getDistance(drag.last) < screen(3)) return;
          pushUndo();
          drag.started = true;
          drag.bendStraight =
            a.handleOut.length < 0.5 && b.handleIn.length < 0.5;
          selectedSegmentRef.current = null;
        }
        if (drag.bendStraight) {
          // Handles stay along the chord (tangent), plus the bulge needed to
          // pass through the pointer. Pulling a line used to grow handles
          // straight out along the normal, which then needed a second edit.
          const t = Math.min(0.85, Math.max(0.15, drag.t));
          const chord = b.point.subtract(a.point);
          const onChord = a.point.add(chord.multiply(t));
          const denom = 3 * (1 - t) * t;
          const bulge = e.point.subtract(onChord).divide(denom);
          a.handleOut = chord.multiply(1 / 3).add(bulge);
          b.handleIn = chord.multiply(-1 / 3).add(bulge);
        } else {
          const delta = e.point.subtract(drag.last);
          drag.last = e.point.clone();
          a.handleOut = a.handleOut.add(delta.multiply(1 - drag.t));
          b.handleIn = b.handleIn.add(delta.multiply(drag.t));
        }
        rebuildEditGizmos();
        showCurveHover(drag.meta, drag.segIndex);
      }
    };

    tool.onMouseUp = (e: paper.ToolEvent) => {
      if (panRef.current) return;

      if (modeRef.current === "ellipse" && ellipseDrag) {
        const dragE = ellipseDrag;
        ellipseDrag = null;
        dragE.path?.remove();
        dragE.pin?.remove();
        const ctrl = toolCtrlOrMeta(e);
        const fromCenter = toolShift(e) || shiftRef.current;
        const path = updateEllipsePath(
          dragE.from,
          maybeSnap(e.point),
          ctrl,
          fromCenter,
        );
        const rx = path.bounds.width / 2;
        const ry = path.bounds.height / 2;
        if (rx < screen(2) && ry < screen(2)) {
          path.remove();
          return;
        }
        pushUndo();
        const meta: PathMeta = {
          path,
          raw: cloneRaw(path),
          smooth: detectSmoothFlags(path),
          lockIndex: 0,
          noSimplify: true,
        };
        metasRef.current.push(meta);
        if (stampOwnerRef.current) {
          tagFeature(meta);
          syncStampChrome();
        }
        setSelection(meta, true);
        syncEmpty();
        notifyClosedCurve();
        return;
      }

      if (modeRef.current === "measure" && measureDrag) {
        const dragM = measureDrag;
        measureDrag = null;

        if (dragM.moved) {
          const ctrl = toolCtrlOrMeta(e);
          const end = updateMeasureDragVisual(dragM.start, e.point, ctrl);
          const lengthPx = dragM.start.getDistance(end);
          if (lengthPx < 1e-3) {
            clearMeasureLine();
            setMeasureReadout(null);
            return;
          }
          showMeasureLine(dragM.start, end);
          openMeasureEdit(lengthPx, dragM.start.add(end).multiply(0.5));
          measureAnchor = null;
          return;
        }

        // Finish point→point (second click)
        if (dragM.finishTo) {
          const lengthPx = dragM.start.getDistance(dragM.finishTo);
          if (lengthPx > 1e-6) {
            showMeasureLine(dragM.start, dragM.finishTo);
            openMeasureEdit(
              lengthPx,
              dragM.start.add(dragM.finishTo).multiply(0.5),
            );
          }
          measureAnchor = null;
          return;
        }

        // First click on a point — wait for second
        if (dragM.fromPoint) {
          measureAnchor = dragM.start.clone();
          showMeasureLine(measureAnchor, measureAnchor);
          setMeasureReadout(null);
          return;
        }

        // Click on segment chord
        if (dragM.segment) {
          const chord = segmentChord(dragM.segment.meta, dragM.segment.segIndex);
          if (chord && chord.lengthPx > 1e-6) {
            showCurveHover(dragM.segment.meta, dragM.segment.segIndex);
            showMeasureLine(chord.a, chord.b);
            openMeasureEdit(chord.lengthPx, chord.mid);
            measureAnchor = null;
            return;
          }
        }

        clearMeasureLine();
        clearCurveHover();
        setMeasureReadout(null);
        return;
      }

      if (polyHandleDragRef.current) {
        polyHandleDragRef.current = null;
        if (modeRef.current === "polygon" && polygonRef.current) {
          updatePolyPreview(e.point);
        }
      }
      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        if (
          drag.kind === "xform-move" ||
          drag.kind === "xform-scale" ||
          drag.kind === "xform-rotate"
        ) {
          if (drag.started) {
            drag.meta.raw = cloneRaw(drag.meta.path);
            drag.meta.smooth = detectSmoothFlags(drag.meta.path);
            const linked =
              drag.kind === "xform-move"
                ? drag.linked
                : drag.linkedStarts.map((f) => f.meta);
            for (const m of linked) {
              m.raw = cloneRaw(m.path);
              m.smooth = detectSmoothFlags(m.path);
            }
            syncStampChrome();
            setSelection(drag.meta, true);
          }
          clearCurveHover();
          return;
        }
        if (drag.kind === "node") {
          selectedSegmentRef.current = null;
          const meta = drag.meta;
          if (!drag.started) {
            // Click without drag → select the point
            selectedPointRef.current = { meta, index: drag.index };
            setSelection(meta, false);
            const g = gizmosRef.current.find(
              (x) => x.meta === meta && x.index === drag.index,
            );
            if (g)
              (g.node as paper.Path).fillColor = new scope.Color("#1e88e5");
            clearMagnet();
            return;
          }
          const n = meta.path.segments.length;
          if (!meta.path.closed && (drag.index === 0 || drag.index === n - 1)) {
            const which = drag.index === 0 ? "first" : "last";
            const hit = findOpenEndNear(e.point, { meta, which });
            if (hit) {
              meta.path.segments[drag.index].point = hit.point.clone();
              mergeCloseEdit(meta, which);
              clearMagnet();
              return;
            }
          }
          meta.raw = cloneRaw(meta.path);
          clearMagnet();
          setSelection(meta, true);
          return;
        }
        if (drag.kind === "curve") {
          if (!drag.started) {
            // Click without drag → select the segment
            selectedPointRef.current = null;
            selectedSegmentRef.current = {
              meta: drag.meta,
              segIndex: drag.segIndex,
            };
            setSelection(drag.meta, false);
            showCurveHover(drag.meta, drag.segIndex);
            return;
          }
          drag.meta.raw = cloneRaw(drag.meta.path);
          setSelection(drag.meta, true);
          clearCurveHover();
          return;
        }
        pushUndo();
        drag.meta.raw = cloneRaw(drag.meta.path);
        setSelection(drag.meta, true);
        clearCurveHover();
        return;
      }

      if (modeRef.current !== "draw" || !drawingRef.current) return;
      const path = drawingRef.current;
      drawingRef.current = null;
      const continuing = continueMetaRef.current;
      const anchor = continuing ? continueAnchorRef.current : 0;
      const newPts = continuing
        ? path.segments.length - (anchor + 1)
        : path.segments.length;
      // Single click / no drag → only a lone point; discard
      if (newPts < 2) {
        if (continuing) {
          while (path.segments.length > anchor + 1) {
            path.removeSegment(path.segments.length - 1);
          }
          applyRaw(path, continuing.raw, scope);
        } else {
          path.remove();
        }
        continueMetaRef.current = null;
        drawStartMarkerRef.current?.remove();
        drawStartMarkerRef.current = null;
        clearMagnet();
        clearSnapPreview();
        refreshDrawMarkers();
        syncEmpty();
        return;
      }
      let meta: PathMeta;
      if (continuing) meta = continuing;
      else {
        meta = { path, raw: [], smooth: [], lockIndex: 0 };
        metasRef.current.push(meta);
      }
      finishStroke(path, meta, e.point);
      continueMetaRef.current = null;
    };

    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      if (modeRef.current === "edit" && stampOwnerRef.current) {
        const pt = scope.view.viewToProject(new scope.Point(ev.offsetX, ev.offsetY));
        const meta = metasRef.current.find(
          (m) =>
            m.role === "feature" &&
            m.ownerId === stampOwnerRef.current?.id &&
            m.path.getNearestLocation(pt)?.distance! <= screen(8),
        );
        if (meta) {
          setSelection(meta, false);
          setCtxMenu({ kind: "stamp", x: ev.clientX, y: ev.clientY, meta });
        }
        return;
      }
      if (modeRef.current === "edit") {
        const pt = scope.view.viewToProject(new scope.Point(ev.offsetX, ev.offsetY));
        const hit = pickEditableMeta(pt);
        const meta =
          hit ??
          (selectedRef.current &&
          selectionPadBounds(selectedRef.current).contains(pt)
            ? selectedRef.current
            : null);
        if (meta) {
          setSelection(meta, false);
          setCtxMenu({ kind: "object", x: ev.clientX, y: ev.clientY, meta });
        }
        return;
      }
      if (modeRef.current !== "curveEdit") return;
      const pt = scope.view.viewToProject(new scope.Point(ev.offsetX, ev.offsetY));
      const gh = hitGizmo(pt);
      if (gh?.kind === "node") {
        setCtxMenu({
          kind: "point",
          x: ev.clientX,
          y: ev.clientY,
          meta: gh.g.meta,
          index: gh.g.index,
        });
        return;
      }
      const meta = selectedRef.current;
      if (meta) {
        const ch = hitCurveSegment(meta, pt);
        if (ch) {
          setCtxMenu({
            kind: "curve",
            x: ev.clientX,
            y: ev.clientY,
            meta,
            segIndex: ch.segIndex,
            loc: pt.clone(),
          });
        }
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return;
      if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
        shiftRef.current = true;
        if (modeRef.current === "curveEdit") canvas.style.cursor = "copy";
      }
      if (ev.code === "Space" && !ev.repeat) {
        spaceRef.current = true;
        canvas.style.cursor = "move";
        ev.preventDefault();
      }
      if (ev.key === "Escape") {
        extras.__escape?.();
        ev.preventDefault();
      }
      if (ev.key === "Enter" && modeRef.current === "polygon") {
        finishPolygonOpen();
        ev.preventDefault();
      }
      if ((ev.key === "z" || ev.key === "Z") && (ev.ctrlKey || ev.metaKey)) {
        if (
          !ev.shiftKey &&
          modeRef.current === "polygon" &&
          polygonRef.current
        ) {
          const poly = polygonRef.current;
          if (poly.segments.length > polyBaseCount) {
            poly.removeSegment(poly.segments.length - 1);
            const meta = metasRef.current.find((m) => m.path === poly);
            if (meta) meta.smooth = detectSmoothFlags(poly);
          }
          polyHandleDragRef.current = null;
          if (poly.segments.length <= polyBaseCount) {
            if (polyBaseCount === 0) poly.remove();
            polygonRef.current = null;
          }
          clearPolyPreview();
          clearMagnet();
          clearSnapPreview();
          refreshDrawMarkers();
          syncEmpty();
        } else if (ev.shiftKey) extras.__redo?.();
        else extras.__undo?.();
        ev.preventDefault();
      }
      if ((ev.key === "y" || ev.key === "Y") && (ev.ctrlKey || ev.metaKey)) {
        extras.__redo?.();
        ev.preventDefault();
      }
      if ((ev.key === "s" || ev.key === "S") && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        void flushDraftSave({ toast: true });
      }
      if (
        (ev.key === "Delete" || ev.key === "Backspace") &&
        (modeRef.current === "edit" || modeRef.current === "curveEdit")
      ) {
        extras.__deleteHoverPoint?.();
        ev.preventDefault();
      }
    };
    const defaultCursor = () => {
      if (modeRef.current === "edit" || modeRef.current === "curveEdit") return "default";
      return "crosshair";
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
        shiftRef.current = false;
        clearAddPointMark();
        if (!panRef.current && !spaceRef.current) {
          canvas.style.cursor =
            modeRef.current === "curveEdit" ? "default" : defaultCursor();
        }
      }
      if (ev.code === "Space") {
        spaceRef.current = false;
        if (!panRef.current) {
          canvas.style.cursor =
            shiftRef.current && modeRef.current === "curveEdit"
              ? "copy"
              : defaultCursor();
        }
      }
    };

    extras.__setMode = () => {
      drawingRef.current = null;
      dragRef.current = null;
      continueMetaRef.current = null;
      polyHandleDragRef.current = null;
      if (polygonRef.current && modeRef.current !== "polygon") {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
      if (modeRef.current !== "polygon") clearPolyPreview();
      if (modeRef.current !== "ellipse") clearEllipseDrag();
      setCtxMenu(null);
      clearDrawMarkers();
      clearCurveHover();
      clearAddPointMark();
      clearMagnet();
      clearSnapPreview();
      clearMeasureUi();
      for (const m of metasRef.current) {
        m.path.fullySelected = false;
        m.path.selected = false;
      }
      refreshDrawMarkers();
      rebuildEditGizmos();
      rebuildMeasureDots();
      syncStampChrome();
      if (!panRef.current && !spaceRef.current) {
        canvas.style.cursor =
          modeRef.current === "edit" || modeRef.current === "curveEdit"
            ? "default"
            : "crosshair";
      }
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w < 2 || h < 2) return;
      scope.view.viewSize = new scope.Size(w, h);
      rebuildGrid();
      rebuildEditGizmos();
      rebuildMeasureDots();
      refreshDrawMarkers();
      if (stampOwnerRef.current) rebuildStampMask();
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(6, Math.max(0.3, scope.view.zoom * factor));
      const ratio = next / scope.view.zoom;
      if (Math.abs(ratio - 1) < 1e-6) return;
      const pt = scope.view.viewToProject(new scope.Point(ev.offsetX, ev.offsetY));
      scope.view.scale(ratio, pt);
      rebuildGrid();
      rebuildEditGizmos();
      rebuildMeasureDots();
      refreshDrawMarkers();
      if (stampOwnerRef.current) {
        rebuildStampMask();
        stampOutlineRef.current?.bringToFront();
      }
    };

    extras.__syncStamp = () => {
      syncStampChrome();
      emitClosed(true);
    };

    extras.__toggleStamp = () => {
      if (stampOwnerRef.current) {
        const owner = stampOwnerRef.current;
        stampOwnerRef.current = null;
        syncStampChrome();
        setSelection(owner, true);
        return;
      }
      const target = resolveStampTarget();
      if (!target) return;
      if (modeRef.current !== "edit") onModeChangeRef.current("edit");
      ensureId(target);
      if (!target.stampId) target.stampId = `stamp-${target.id}`;
      stampOwnerRef.current = target;
      syncStampChrome();
      setSelection(null, true);
    };

    extras.__setFeatureWidth = (widthMm: number) => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature") return;
      const w = Math.max(0.3, widthMm);
      if (m.stampRim) {
        m.widthMm = w;
        onOutlineWidthChangeRef.current(w);
        rebuildStampOutline();
        rebuildStampMask();
        const mask = stampMaskRef.current;
        if (mask) {
          for (const f of metasRef.current) {
            if (
              f.role === "feature" &&
              f.ownerId === stampOwnerRef.current?.id
            ) {
              f.path.insertBelow(mask);
            }
          }
          mask.sendToBack();
        }
        stampOwnerRef.current?.path.bringToFront();
        stampOutlineRef.current?.bringToFront();
        stampRimFillRef.current?.bringToFront();
        refreshFeatureHud();
        rebuildEditGizmos();
        return;
      }
      m.widthMm = w;
      lastWidthMm.current = w;
      styleFeature(m);
      refreshFeatureHud();
      emitClosed(true);
    };

    extras.__setFeatureRaised = (raised: boolean) => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim) return;
      m.raised = raised;
      styleFeature(m);
      syncStampChrome();
      refreshFeatureHud();
      emitClosed(true);
    };

    extras.__toggleFeatureFill = () => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim || !m.path.closed) return;
      pushUndo();
      m.filled = !m.filled;
      styleFeature(m);
      syncStampChrome();
      refreshFeatureHud();
      emitClosed(true);
    };

    extras.__mirrorObject = (axis: "h" | "v") => {
      const meta = selectedRef.current;
      if (!meta || meta.stampRim) return;
      pushUndo();
      const center = meta.path.bounds.center.clone();
      // h = flip across vertical axis (negate X); v = flip across horizontal (negate Y)
      const sx = axis === "h" ? -1 : 1;
      const sy = axis === "v" ? -1 : 1;
      meta.path.scale(sx, sy, center);
      meta.raw = cloneRaw(meta.path);
      meta.smooth = detectSmoothFlags(meta.path);
      if (meta.role !== "feature") {
        for (const f of linkedStampFeatures(meta)) {
          f.path.scale(sx, sy, center);
          f.raw = cloneRaw(f.path);
          f.smooth = detectSmoothFlags(f.path);
        }
      }
      syncStampChrome();
      setSelection(meta, true);
    };

    /** Grow (positive mm) or shrink (negative) via Clipper2 — not a scale. */
    extras.__offsetClosedByMm = (mm: number) => {
      const meta = selectedRef.current;
      if (
        !meta ||
        meta.stampRim ||
        !meta.path.closed ||
        meta.path.segments.length < 3 ||
        Math.abs(mm) < 1e-9
      ) {
        return;
      }
      const scale = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      const pts = ensureCcw(
        samplePathPoints(meta.path, {
          flatness: 0.4,
          minPerCurve: 12,
          maxPoints: 360,
        }),
      );
      const loop = offsetClosedClipper(pts, mm / scale);
      if (!loop || loop.length < 3) return;
      pushUndo();
      meta.path.removeSegments();
      for (const p of loop) meta.path.add(new scope.Point(p.x, p.y));
      meta.path.closed = true;
      meta.raw = cloneRaw(meta.path);
      // Offset yields a polyline — treat every vertex as a corner
      meta.smooth = meta.path.segments.map(() => false);
      if (meta.role === "feature") styleFeature(meta);
      syncStampChrome();
      setSelection(meta, true);
    };

    extras.__setSnapGrid = () => {
      rebuildGrid();
      if (!snapGridRef.current) clearSnapPreview();
    };

    extras.__setBgVisible = (v: boolean) => {
      if (bgRef.current) {
        bgRef.current.visible = v;
        bgRef.current.opacity = v ? bgOpacityRef.current : 0;
      }
    };

    extras.__setBgOpacity = (opacity: number) => {
      if (bgRef.current && showBackgroundRef.current) {
        bgRef.current.opacity = opacity;
        bgRef.current.visible = opacity > 0;
      }
    };

    extras.__rebuildImageContours = (threshold: number, smoothAmt: number) =>
      rebuildImageContours(threshold, smoothAmt);

    extras.__clearImageContours = () => clearImageContours();

    /** Fit paths (+ optional item) into the view; returns the uniform scale applied (1 if none). */
    const fitPathsInView = (
      paths: paper.Path[],
      extra: paper.Item | null = null,
    ): number => {
      if (!paths.length) return 1;
      let bounds = paths[0].bounds.clone();
      for (let i = 1; i < paths.length; i++) bounds = bounds.unite(paths[i].bounds);
      if (extra) bounds = bounds.unite(extra.bounds);
      if (bounds.width < 1e-6 || bounds.height < 1e-6) return 1;
      const pad = 0.85;
      const s = Math.min(
        (scope.view.size.width * pad) / bounds.width,
        (scope.view.size.height * pad) / bounds.height,
      );
      if (!Number.isFinite(s) || s <= 0) return 1;
      const center = bounds.center;
      const viewCenter = scope.view.center;
      for (const p of paths) {
        p.scale(s, center);
        p.translate(viewCenter.subtract(center));
      }
      if (extra) {
        extra.scale(s, center);
        extra.translate(viewCenter.subtract(center));
      }
      return s;
    };

    /** Fresh sketch paths — strips SVG/PDF styling that can leave strokes invisible. */
    const makeSketchPath = (
      segments: paper.Segment[] | ImportedPath["segments"],
      closed: boolean,
    ) => {
      const path = new scope.Path({
        strokeColor: new scope.Color(closed ? "#c45c26" : "#111"),
        strokeWidth: closed ? 2.2 : 1.5,
        strokeCap: "round",
        strokeJoin: "round",
        fillColor: null,
        fullySelected: false,
        selected: false,
      });
      path.strokeScaling = true;
      path.opacity = 1;
      for (const s of segments) {
        if (s instanceof scope.Segment) {
          path.add(s.clone());
        } else {
          path.add(
            new scope.Segment(
              new scope.Point(s.point.x, s.point.y),
              new scope.Point(s.handleIn.x, s.handleIn.y),
              new scope.Point(s.handleOut.x, s.handleOut.y),
            ),
          );
        }
      }
      path.closed = closed;
      path.applyMatrix = true;
      return path;
    };

    const pathGroupBounds = (paths: paper.Path[]) => {
      if (!paths.length) return null;
      let bounds = paths[0].bounds.clone();
      for (let i = 1; i < paths.length; i++) bounds = bounds.unite(paths[i].bounds);
      return bounds;
    };

    const pointInPath = (path: paper.Path, pt: paper.Point): boolean => {
      if (!path.closed || path.segments.length < 3) return false;
      // Paper hitTest fill is reliable for closed paths
      const hit = path.hitTest(pt, { fill: true, stroke: false, tolerance: 0 });
      if (hit) return true;
      // Fallback winding for thin paths without fill
      let inside = false;
      const segs = path.segments;
      for (let i = 0, j = segs.length - 1; i < segs.length; j = i++) {
        const yi = segs[i].point.y;
        const yj = segs[j].point.y;
        const xi = segs[i].point.x;
        const xj = segs[j].point.x;
        if (
          yi > pt.y !== yj > pt.y &&
          pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi
        ) {
          inside = !inside;
        }
      }
      return inside;
    };

    /**
     * @param scaleMmPerPx mm per paper-unit *before* view-fit (physical size).
     * After fitting, scale is divided by the fit factor so mm stay correct.
     * @param extra fitted together with paths (e.g. restored PDF background).
     * @param imported optional source metadata (stamp colors / roles from PDF).
     */
    const commitImportedPaths = (
      paths: paper.Path[],
      scaleMmPerPx: number | null = null,
      extra: paper.Item | null = null,
      imported?: ImportedPath[] | null,
    ) => {
      if (!paths.length) return;
      pushUndo();
      const fitS = fitPathsInView(paths, extra);
      // Re-assert stroke after fit (scale can interact badly with SVG strokeScaling)
      const metas: PathMeta[] = [];
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const src = imported?.[i];
        // Prefer color heuristic when RGB is present (our PDF export)
        const fromColor = src?.strokeRgb
          ? classifyStampColor(src.strokeRgb)
          : null;
        const cls = fromColor
          ? fromColor
          : {
              role: (src?.role ?? "cutter") as "cutter" | "feature",
              raised: src?.raised !== false,
            };
        path.strokeCap = "round";
        path.strokeJoin = "round";
        path.strokeScaling = true;
        path.dashArray = [];
        path.fullySelected = false;
        path.selected = false;
        path.bringToFront();
        const meta: PathMeta = {
          path,
          raw: cloneRaw(path),
          smooth: detectSmoothFlags(path),
          lockIndex: 0,
        };
        if (cls.role === "feature") {
          meta.role = "feature";
          meta.raised = cls.raised;
          meta.filled = !!src?.filled;
          meta.widthMm = src?.widthMm ?? 0.6;
          styleFeature(meta);
        } else {
          path.strokeColor = new scope.Color(path.closed ? "#c45c26" : "#111");
          path.strokeWidth = path.closed ? 2.2 : 1.5;
          path.fillColor = null;
          path.opacity = 1;
        }
        metasRef.current.push(meta);
        metas.push(meta);
      }
      // Associate features to the smallest containing closed cutter
      const cutters = metas.filter((m) => m.role !== "feature" && m.path.closed);
      for (const c of cutters) {
        ensureId(c);
        const feats = metas.filter((m) => {
          if (m.role !== "feature") return false;
          const mid = m.path.bounds.center;
          return pointInPath(c.path, mid);
        });
        if (!feats.length) continue;
        if (!c.stampId) c.stampId = `stamp-${c.id}`;
        for (const f of feats) {
          // Prefer smallest containing cutter
          const host = cutters
            .filter((h) => pointInPath(h.path, f.path.bounds.center))
            .sort(
              (a, b) =>
                Math.abs(a.path.area) - Math.abs(b.path.area),
            )[0];
          const owner = host ?? c;
          ensureId(owner);
          if (!owner.stampId) owner.stampId = `stamp-${owner.id}`;
          f.ownerId = owner.id;
          f.stampId = owner.stampId;
        }
      }
      if (extra) extra.sendToBack();
      if (scaleMmPerPx != null && scaleMmPerPx > 0 && fitS > 1e-12) {
        onMmPerPxChangeRef.current(scaleMmPerPx / fitS);
      }
      syncStampChrome();
      const preferClosed =
        metas.find((m) => m.role !== "feature" && m.path.closed) ??
        metas[metas.length - 1];
      setSelection(preferClosed, true);
      syncEmpty();
      notifyClosedCurve(); // enter edit mode for the imported curve(s)
    };

    finishPendingPdfImportRef.current = (raster) => {
      const pending = pendingPdfImportRef.current;
      if (!pending) return;
      pendingPdfImportRef.current = null;
      if (pending.stampGapMm != null) {
        onStampGapChangeRef.current(pending.stampGapMm);
      }
      if (pending.stampOutlineEnabled != null) {
        onOutlineEnabledChangeRef.current(pending.stampOutlineEnabled);
      }
      if (pending.stampOutlineWidthMm != null) {
        onOutlineWidthChangeRef.current(pending.stampOutlineWidthMm);
      }
      commitImportedPaths(
        pending.paths,
        pending.scaleMmPerPx,
        raster,
        pending.imported,
      );
    };

    finishPendingDraftRestoreRef.current = () => {
      const pending = pendingDraftRestoreRef.current;
      if (!pending) return;
      pendingDraftRestoreRef.current = null;
      applyDraftItems(pending.items, pending.stampOwnerId);
      draftRestoringRef.current = false;
      onDraftSavedRef.current?.("Restored sketch from this browser");
      void flushDraftSave();
    };

    extras.__scheduleDraftSave = scheduleDraftSave;
    extras.__flushDraftSave = (toast) => {
      void flushDraftSave({ toast: !!toast });
    };

    const pathsFromImported = (
      imported: ImportedPath[],
    ): { paths: paper.Path[]; kept: ImportedPath[] } => {
      const paths: paper.Path[] = [];
      const kept: ImportedPath[] = [];
      for (const ip of imported) {
        if (ip.segments.length < 2) continue;
        paths.push(makeSketchPath(ip.segments, ip.closed));
        kept.push(ip);
      }
      return { paths, kept };
    };

    const collectSvgPaths = (item: paper.Item, out: paper.Path[]) => {
      if (item instanceof scope.Path && item.segments.length >= 2) {
        out.push(item);
        return;
      }
      const children = item.children;
      if (children?.length) {
        for (const child of [...children]) collectSvgPaths(child, out);
      }
    };

    const collectSketchPaths = (): ImportedPath[] => {
      const toSegs = (m: PathMeta): ImportedPath["segments"] =>
        m.path.segments.map((s) => ({
          point: { x: s.point.x, y: s.point.y },
          handleIn: { x: s.handleIn.x, y: s.handleIn.y },
          handleOut: { x: s.handleOut.x, y: s.handleOut.y },
        }));
      const paths: ImportedPath[] = [];
      for (const m of metasRef.current) {
        if (m.path.segments.length < 2) continue;
        if (m.role === "feature") {
          const raised = m.raised !== false;
          paths.push({
            closed: m.path.closed,
            segments: toSegs(m),
            role: "feature",
            raised,
            filled: !!m.filled,
            widthMm: m.widthMm ?? 0.6,
            strokeRgb: raised ? STAMP_RAISE_RGB : STAMP_RECESS_RGB,
          });
        } else {
          paths.push({
            closed: m.path.closed,
            segments: toSegs(m),
            role: "cutter",
            // Black in PDF for all cutters (closedness is path geometry, not hue)
            strokeRgb: [0, 0, 0],
          });
        }
      }
      return paths;
    };

    const buildSketchPdfPayload = async (): Promise<{
      paths: ImportedPath[];
      background: SketchPdfBackground | null;
    } | null> => {
      const paths = collectSketchPaths();
      if (!paths.length) return null;
      let background: SketchPdfBackground | null = null;
      const url = backgroundUrlRef.current;
      const raster = bgRef.current;
      if (showBackgroundRef.current && url && raster && raster.width > 0) {
        try {
          const enc = await jpegFromImageUrl(url);
          const b = raster.bounds;
          background = {
            jpeg: enc.jpeg,
            widthPx: enc.width,
            heightPx: enc.height,
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
          };
        } catch {
          /* curves only */
        }
      }
      return { paths, background };
    };

    extras.__buildSketchPdfBytes = async () => {
      const payload = await buildSketchPdfPayload();
      if (!payload) return null;
      return buildSketchPdf(payload.paths, {
        mmPerPx: mmPerPxRef.current,
        background: payload.background,
        stampGapMm: gapMmRef.current,
        stampOutlineEnabled: outlineEnabledRef.current,
        stampOutlineWidthMm: outlineWidthMmRef.current,
      });
    };

    extras.__saveSketchPdf = async () => {
      const payload = await buildSketchPdfPayload();
      if (!payload) {
        window.alert("Nothing to save — draw or import a curve first.");
        return;
      }
      void flushDraftSave();
      return downloadSketchPdf(payload.paths, "pernicek.pdf", {
        mmPerPx: mmPerPxRef.current,
        background: payload.background,
        stampGapMm: gapMmRef.current,
        stampOutlineEnabled: outlineEnabledRef.current,
        stampOutlineWidthMm: outlineWidthMmRef.current,
      });
    };

    extras.__importVectorFile = async (file: File) => {
      const name = file.name.toLowerCase();
      try {
        if (name.endsWith(".svg") || file.type === "image/svg+xml") {
          const svg = await svgTextFromFile(file);
          const imported = scope.project.importSVG(svg, {
            expandShapes: true,
            applyMatrix: true,
            insert: true,
          }) as paper.Item | null;
          if (!imported) throw new Error("Could not read SVG");
          const found: paper.Path[] = [];
          collectSvgPaths(imported, found);
          // Rebuild clean paths in world space (SVG stroke ~0.35 / styles hide the curve)
          const clean: paper.Path[] = [];
          for (const src of found) {
            const world = src.globalMatrix.clone();
            const p = makeSketchPath(
              src.segments.map((seg) => seg.clone()),
              !!src.closed,
            );
            p.transform(world);
            clean.push(p);
          }
          imported.remove();
          if (!clean.length) throw new Error("No paths found in SVG");
          const b = pathGroupBounds(clean);
          const scale = mmPerPxFromSvg(
            svg,
            b ? { width: b.width, height: b.height } : null,
          );
          commitImportedPaths(clean, scale);
          return;
        }
        if (name.endsWith(".pdf") || file.type === "application/pdf") {
          const {
            paths: imported,
            mmPerPx: scale,
            background,
            stampGapMm,
            stampOutlineEnabled,
            stampOutlineWidthMm,
          } = await pathsFromPdfFile(file);
          const { paths, kept } = pathsFromImported(imported);
          if (!paths.length) throw new Error("No vector paths found in PDF");
          if (stampGapMm != null) onStampGapChangeRef.current(stampGapMm);
          if (stampOutlineEnabled != null) {
            onOutlineEnabledChangeRef.current(stampOutlineEnabled);
          }
          if (stampOutlineWidthMm != null) {
            onOutlineWidthChangeRef.current(stampOutlineWidthMm);
          }
          if (background?.jpeg.length) {
            const blobUrl = URL.createObjectURL(
              new Blob([background.jpeg], { type: "image/jpeg" }),
            );
            if (background.rect) {
              bgPlaceRef.current = { ...background.rect };
            } else {
              bgPlaceRef.current = null;
            }
            pendingPdfImportRef.current = {
              paths,
              scaleMmPerPx: scale,
              imported: kept,
              stampGapMm,
              stampOutlineEnabled,
              stampOutlineWidthMm,
            };
            onImportBgRef.current(blobUrl);
            // commitImportedPaths runs from raster.onLoad once the image is placed
            return;
          }
          commitImportedPaths(paths, scale, null, kept);
          return;
        }
        throw new Error("Unsupported vector format");
      } catch (err) {
        console.error(err);
        window.alert(
          err instanceof Error ? err.message : "Failed to import vector file",
        );
      }
    };

    resize();
    rebuildGrid();
    const ro = new ResizeObserver(() => resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("mousedown", onNativeDown, { capture: true });
    canvas.addEventListener("auxclick", onAuxClick);
    window.addEventListener("mousemove", onNativeMove, { passive: false });
    window.addEventListener("mouseup", onNativeUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    const onPageHide = () => {
      if (draftSavePending || metasRef.current.length > 0) {
        void flushDraftSave();
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === "hidden") onPageHide();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisChange);

    // Restore last sketch from IndexedDB (paths + optional background)
    draftRestoringRef.current = true;
    void (async () => {
      try {
        const draft = await loadSketchDraft();
        if (!draft || scopeRef.current !== scope) {
          draftRestoringRef.current = false;
          return;
        }
        const { meta, background } = draft;
        onStampChangeRef.current(meta.stamp);
        if (meta.mmPerPx != null) onMmPerPxChangeRef.current(meta.mmPerPx);
        if (background) {
          const blobUrl = URL.createObjectURL(background);
          if (meta.bgPlace) bgPlaceRef.current = { ...meta.bgPlace };
          pendingDraftRestoreRef.current = {
            items: meta.items,
            stampOwnerId: meta.stampOwnerId,
            mmPerPx: meta.mmPerPx,
          };
          onImportBgRef.current(blobUrl);
        } else {
          applyDraftItems(meta.items, meta.stampOwnerId);
          draftRestoringRef.current = false;
          onDraftSavedRef.current?.("Restored sketch from this browser");
        }
      } catch {
        draftRestoringRef.current = false;
      }
    })();

    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("mousedown", onNativeDown, true);
      canvas.removeEventListener("auxclick", onAuxClick);
      window.removeEventListener("mousemove", onNativeMove);
      window.removeEventListener("mouseup", onNativeUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisChange);
      if (draftSaveTimer != null) window.clearTimeout(draftSaveTimer);
      void flushDraftSave();
      ro.disconnect();
      clearDrawMarkers();
      clearGizmos();
      clearXformGizmos();
      clearCurveHover();
      clearMeasureDots();
      clearMeasureLine();
      clearMagnet();
      scope.project.clear();
      scope.remove();
      scopeRef.current = null;
    };
  }, []);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__setMode?.();
  }, [mode]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__setSnapGrid?.();
  }, [snapGrid]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__syncStamp?.();
  }, [
    stampGapMm,
    wallThicknessMm,
    mmPerPx,
    stampOutlineEnabled,
    stampOutlineWidthMm,
  ]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__scheduleDraftSave?.();
  }, [stamp]);

  useEffect(() => {
    if (imagePanelToken === 0) return;
    setTraceOpen(true);
    setShowBackground(true);
    onImagePanelOpenChangeRef.current(true);
  }, [imagePanelToken]);

  useEffect(() => {
    if (deleteToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__deleteCurrent?.();
  }, [deleteToken]);

  useEffect(() => {
    if (clearToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__clearCanvas?.();
  }, [clearToken]);

  useEffect(() => {
    if (undoToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__undo?.();
  }, [undoToken]);

  useEffect(() => {
    if (redoToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__redo?.();
  }, [redoToken]);

  useEffect(() => {
    onHasCurvesChange?.(hasCurves);
  }, [hasCurves, onHasCurvesChange]);

  useEffect(() => {
    if (!saveApiRef) return;
    saveApiRef.current = {
      savePdf: async () =>
        (await (scopeRef.current as unknown as ScopeExtras | null)?.__saveSketchPdf?.()) ??
        undefined,
      buildPdfBytes: async () =>
        (await (scopeRef.current as unknown as ScopeExtras | null)?.__buildSketchPdfBytes?.()) ??
        null,
      saveDraft: async () => {
        (scopeRef.current as unknown as ScopeExtras | null)?.__flushDraftSave?.(
          true,
        );
      },
    };
    return () => {
      saveApiRef.current = null;
    };
  }, [saveApiRef]);

  useEffect(() => {
    if (!saveSketchToken) return;
    void (scopeRef.current as unknown as ScopeExtras | null)?.__saveSketchPdf?.();
  }, [saveSketchToken]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || !backgroundUrl) {
      bgRef.current?.remove();
      bgRef.current = null;
      imageDataRef.current = null;
      imageSizeRef.current = null;
      setTraceCurveCount(0);
      (scope as unknown as ScopeExtras | null)?.__clearImageContours?.();
      return;
    }
    bgRef.current?.remove();
    setTraceOpen(true);
    onImagePanelOpenChangeRef.current(true);
    setShowBackground(true);
    const raster = new scope.Raster({
      source: backgroundUrl,
      position: scope.view.center,
    });
    raster.onLoad = () => {
      const place = bgPlaceRef.current;
      bgPlaceRef.current = null;
      if (place && place.width > 0 && place.height > 0) {
        raster.bounds = new scope.Rectangle(
          place.x,
          place.y,
          place.width,
          place.height,
        );
      } else {
        const scale = Math.min(
          (scope.view.size.width * 0.9) / raster.width,
          (scope.view.size.height * 0.9) / raster.height,
          1,
        );
        raster.scale(scale);
        raster.position = scope.view.center;
      }
      raster.opacity = showBackgroundRef.current ? bgOpacityRef.current : 0;
      raster.visible = showBackgroundRef.current;
      raster.sendToBack();
      raster.locked = true;
      (scope as unknown as ScopeExtras).__setSnapGrid?.();
      if (pendingPdfImportRef.current) {
        finishPendingPdfImportRef.current?.(raster);
      } else if (pendingDraftRestoreRef.current) {
        finishPendingDraftRestoreRef.current?.();
      }
      const n = (scope as unknown as ScopeExtras).__rebuildImageContours?.(
        traceThreshold,
        traceSmooth,
      );
      if (typeof n === "number") setTraceCurveCount(n);
    };
    raster.onError = () => {
      bgPlaceRef.current = null;
      if (pendingPdfImportRef.current) {
        finishPendingPdfImportRef.current?.(null);
      } else if (pendingDraftRestoreRef.current) {
        // Still restore vectors even if background decode failed
        finishPendingDraftRestoreRef.current?.();
      }
    };
    bgRef.current = raster;

    let cancelled = false;
    loadImageData(backgroundUrl)
      .then(({ imageData, width, height }) => {
        if (cancelled) return;
        imageDataRef.current = imageData;
        imageSizeRef.current = { w: width, h: height };
        const n = (scope as unknown as ScopeExtras).__rebuildImageContours?.(
          traceThreshold,
          traceSmooth,
        );
        if (typeof n === "number") setTraceCurveCount(n);
      })
      .catch(() => {
        /* ignore decode errors */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- threshold/smooth have their own effect
  }, [backgroundUrl]);

  useEffect(() => {
    const scope = scopeRef.current as unknown as ScopeExtras | null;
    if (!scope || !imageDataRef.current || !traceOpen) return;
    if (!showTraceCurves) {
      scope.__clearImageContours?.();
      setTraceCurveCount(0);
      return;
    }
    const id = window.setTimeout(() => {
      const n = scope.__rebuildImageContours?.(traceThreshold, traceSmooth);
      if (typeof n === "number") setTraceCurveCount(n);
    }, 60);
    return () => window.clearTimeout(id);
  }, [traceThreshold, traceSmooth, traceOpen, showTraceCurves, traceMode]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__setBgVisible?.(
      showBackground,
    );
  }, [showBackground]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__setBgOpacity?.(
      bgOpacity,
    );
  }, [bgOpacity]);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const id = requestAnimationFrame(() => {
      (scope as unknown as ScopeExtras).__applySelectedSimplify?.(
        simplifyTolerance,
      );
    });
    return () => cancelAnimationFrame(id);
  }, [simplifyTolerance]);

  const closeMenu = () => setCtxMenu(null);

  const notifySelectionUi = (meta: PathMeta | null) => {
    onHasSelectionChange(!!meta);
    onSelectedSimplifyChange?.(
      meta && !meta.noSimplify ? (meta.simplifyTol ?? 1) : null,
    );
  };

  const applyPointMenu = (
    action: "corner" | "smooth" | "clear-handles" | "delete",
  ) => {
    if (!ctxMenu || ctxMenu.kind !== "point" || !scopeRef.current) return;
    const scope = scopeRef.current;
    const { meta, index } = ctxMenu;
    ensureSmoothFlags(meta);
    undoRef.current.push({
      items: metasRef.current.map((m) => ({
        raw: cloneRaw(m.path),
        smooth: [...m.smooth],
        closed: m.path.closed,
        lockIndex: m.lockIndex,
        noSimplify: m.noSimplify,
      })),
    });
    if (action === "delete") {
      if (meta.path.segments.length <= (meta.path.closed ? 3 : 2)) {
        closeMenu();
        return;
      }
      meta.path.removeSegment(index);
      meta.smooth.splice(index, 1);
    } else if (action === "smooth") {
      meta.smooth[index] = true;
      makeSegmentSmooth(meta.path.segments[index], scope);
    } else if (action === "clear-handles") {
      const seg = meta.path.segments[index];
      seg.handleIn = new scope.Point(0, 0);
      seg.handleOut = new scope.Point(0, 0);
      meta.smooth[index] = false;
    } else meta.smooth[index] = false;
    meta.raw = cloneRaw(meta.path);
    closeMenu();
    selectedRef.current = meta;
    notifySelectionUi(meta);
    (scope as unknown as ScopeExtras).__setMode?.();
    if (meta.path.closed) {
      onClosedPathChange(
        samplePathPoints(meta.path, {
          flatness: 0.45,
          minPerCurve: 16,
          maxPoints: 400,
        }),
      );
    }
  };

  const emitClosedFromMetas = () => {
    const closed =
      (selectedRef.current?.path.closed ? selectedRef.current : null) ??
      metasRef.current.find((m) => m.path.closed) ??
      null;
    if (!closed) {
      onClosedPathChange(null);
      return;
    }
    onClosedPathChange(
      samplePathPoints(closed.path, {
        flatness: 0.45,
        minPerCurve: 16,
        maxPoints: 400,
      }),
    );
  };

  const applyCurveMenu = (
    action: "add" | "delete" | "close" | "delete-segment",
  ) => {
    if (!ctxMenu || ctxMenu.kind !== "curve" || !scopeRef.current) return;
    const scope = scopeRef.current;
    const { meta, loc, segIndex } = ctxMenu;
    undoRef.current.push({
      items: metasRef.current.map((m) => ({
        raw: cloneRaw(m.path),
        smooth: [...m.smooth],
        closed: m.path.closed,
        lockIndex: m.lockIndex,
        noSimplify: m.noSimplify,
      })),
    });
    if (action === "delete") {
      meta.path.remove();
      metasRef.current = metasRef.current.filter((m) => m !== meta);
      const next = metasRef.current[0] ?? null;
      selectedRef.current = next;
      notifySelectionUi(next);
      closeMenu();
      (scope as unknown as ScopeExtras).__setMode?.();
      if (!next) {
        onClosedPathChange(null);
        onCurvesEmpty();
      } else {
        emitClosedFromMetas();
      }
      return;
    }
    if (action === "delete-segment") {
      closeMenu();
      (scope as unknown as ScopeExtras).__deleteSegmentAt?.(meta, segIndex);
      return;
    }
    if (action === "close" && !meta.path.closed && meta.path.segments.length >= 3) {
      meta.path.closePath();
      meta.path.strokeColor = new scope.Color("#c45c26");
      meta.path.strokeWidth = 2.2;
      meta.raw = cloneRaw(meta.path);
      closeMenu();
      selectedRef.current = meta;
      notifySelectionUi(meta);
      (scope as unknown as ScopeExtras).__setMode?.();
      onClosedPathChange(
        samplePathPoints(meta.path, {
          flatness: 0.45,
          minPerCurve: 16,
          maxPoints: 400,
        }),
      );
      onCurveClosed();
      return;
    }
    if (action === "add") {
      const nearest = meta.path.getNearestLocation(loc);
      if (nearest) {
        const wasStraight = nearest.curve?.isStraight() ?? false;
        const newSeg = meta.path.divideAt(nearest);
        if (newSeg) {
          const idx = newSeg.index;
          const smooth = styleInsertedSegment(newSeg, wasStraight, scope);
          while (meta.smooth.length < idx) meta.smooth.push(false);
          meta.smooth.splice(idx, 0, smooth);
        }
      }
      ensureSmoothFlags(meta);
    }
    meta.raw = cloneRaw(meta.path);
    closeMenu();
    selectedRef.current = meta;
    notifySelectionUi(meta);
    (scope as unknown as ScopeExtras).__setMode?.();
    if (meta.path.closed) {
      onClosedPathChange(
        samplePathPoints(meta.path, {
          flatness: 0.45,
          minPerCurve: 16,
          maxPoints: 400,
        }),
      );
    }
  };

  const onDragOver = (ev: DragEvent) => {
    if (![...ev.dataTransfer.types].includes("Files")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  };

  const importDroppedOrPickedFile = (file: File) => {
    if (isVectorFile(file)) {
      void (scopeRef.current as unknown as ScopeExtras | null)?.__importVectorFile?.(
        file,
      );
      return;
    }
    if (isRasterImageFile(file) || file.type.startsWith("image/")) {
      onImportBgRef.current(URL.createObjectURL(file));
    }
  };

  const pickImportableFile = (files: Iterable<File>): File | null => {
    const list = [...files];
    return (
      list.find(isVectorFile) ??
      list.find((f) => isRasterImageFile(f) || f.type.startsWith("image/")) ??
      null
    );
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const file = pickImportableFile(ev.dataTransfer.files);
    if (file) importDroppedOrPickedFile(file);
  };

  // Document-level so Ctrl+V works even when focus isn't on the canvas.
  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const cd = ev.clipboardData;
      if (!cd) return;
      const fromItems: File[] = [];
      for (const item of cd.items) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f) fromItems.push(f);
      }
      const file =
        [...fromItems, ...cd.files].find(isVectorFile) ??
        [...fromItems, ...cd.files].find(
          (f) => isRasterImageFile(f) || f.type.startsWith("image/"),
        ) ??
        null;
      if (!file) return;
      ev.preventDefault();
      if (isVectorFile(file)) {
        void (
          scopeRef.current as unknown as ScopeExtras | null
        )?.__importVectorFile?.(file);
      } else {
        onImportBgRef.current(URL.createObjectURL(file));
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    if (!measureEdit) return;
    const el = measureInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
    // Only when the popup opens (key), not on each value keystroke
  }, [measureEdit?.key]);

  const commitMeasureEdit = () => {
    const edit = measureEditRef.current;
    if (!edit) return;
    measureEditRef.current = null;
    setMeasureEdit(null);
    const v = parseFloat(edit.value.trim().replace(",", "."));
    if (Number.isFinite(v) && v > 0 && edit.lengthPx > 1e-9) {
      onMmPerPxChangeRef.current(v / edit.lengthPx);
    }
    (scopeRef.current as unknown as ScopeExtras | null)?.__clearMeasure?.();
  };

  const cancelMeasureEdit = () => {
    if (!measureEditRef.current) return;
    measureEditRef.current = null;
    setMeasureEdit(null);
    (scopeRef.current as unknown as ScopeExtras | null)?.__clearMeasure?.();
  };

  const onMeasureKeyDown = (ev: ReactKeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commitMeasureEdit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelMeasureEdit();
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
          cursor: "crosshair",
          background: "#fff",
          outline: "none",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 4,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          width: 168,
        }}
      >
        <Tooltip
          title={
            stampUi === "off"
              ? "First select a closed curve"
              : stampUi === "back"
                ? "Leave stamp editing"
                : stampUi === "edit"
                  ? "Edit stamp features on this cutter"
                  : "Add a stamp that fits inside this cutter"
          }
          placement="right"
        >
          <span>
            <Button
              size="small"
              variant="contained"
              disabled={stampUi === "off"}
              onClick={() =>
                (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__toggleStamp?.()
              }
              startIcon={
                stampUi === "back" ? undefined : (
                  <ApprovalOutlinedIcon sx={{ fontSize: 16 }} />
                )
              }
              sx={{ textTransform: "none", width: "100%" }}
            >
              {stampUi === "back"
                ? "Edit cutter"
                : stampUi === "edit"
                  ? "Edit stamp"
                  : "Add stamp"}
            </Button>
          </span>
        </Tooltip>
        {stampUi === "back" && (
          <Box
            sx={{
              bgcolor: "rgba(255,255,255,0.94)",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              px: 1,
              py: 0.75,
            }}
          >
            <Box sx={{ display: "flex", justifyContent: "space-between" }}>
              <Box component="span" sx={{ fontSize: 11, color: "text.secondary" }}>
                Fit gap
              </Box>
              <Box component="span" sx={{ fontSize: 11 }}>
                {stampGapMm.toFixed(2)} mm
              </Box>
            </Box>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={stampGapMm}
              onChange={(e) => onStampGapChange(Number(e.target.value))}
              style={{ width: "100%" }}
              aria-label="Stamp fit gap"
            />
            <Box component="p" sx={{ m: 0, fontSize: 10, color: "text.secondary", lineHeight: 1.3 }}>
              Inside the wall, plus this clearance
            </Box>
            <FormControlLabel
              sx={{
                mx: 0,
                mt: 0.5,
                width: "100%",
                justifyContent: "space-between",
              }}
              labelPlacement="start"
              control={
                <Switch
                  size="small"
                  checked={stampOutlineEnabled}
                  onChange={(_, checked) =>
                    onStampOutlineEnabledChange(checked)
                  }
                />
              }
              label={
                <Box
                  component="span"
                  sx={{ fontSize: 11, color: "text.secondary" }}
                >
                  Raised outline
                </Box>
              }
            />
          </Box>
        )}
      </Box>
      {featureHud && stampUi === "back" && (
        <Box
          sx={{
            position: "absolute",
            left: 8,
            bottom: 8,
            zIndex: 4,
            width: 180,
            bgcolor: "rgba(255,255,255,0.94)",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            px: 1,
            py: 0.75,
          }}
        >
          {!featureHud.rim && (
            <>
              <Box sx={{ display: "flex", gap: 0.5, mb: 0.5 }}>
                <Button
                  size="small"
                  variant={featureHud.raised ? "contained" : "outlined"}
                  onClick={() =>
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__setFeatureRaised?.(true)
                  }
                  sx={{
                    textTransform: "none",
                    flex: 1,
                    bgcolor: featureHud.raised ? "#7f1d1d" : undefined,
                  }}
                >
                  Raised
                </Button>
                <Button
                  size="small"
                  variant={!featureHud.raised ? "contained" : "outlined"}
                  onClick={() =>
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__setFeatureRaised?.(false)
                  }
                  sx={{
                    textTransform: "none",
                    flex: 1,
                    bgcolor: !featureHud.raised ? "#1e3a8a" : undefined,
                  }}
                >
                  Recessed
                </Button>
              </Box>
              {featureHud.closed && (
                <FormControlLabel
                  sx={{
                    mx: 0,
                    mb: 0.25,
                    width: "100%",
                    justifyContent: "space-between",
                  }}
                  labelPlacement="start"
                  control={
                    <Switch
                      size="small"
                      checked={featureHud.filled}
                      onChange={() =>
                        (
                          scopeRef.current as unknown as ScopeExtras | null
                        )?.__toggleFeatureFill?.()
                      }
                    />
                  }
                  label={
                    <Box
                      component="span"
                      sx={{ fontSize: 11, color: "text.secondary" }}
                    >
                      Fill
                    </Box>
                  }
                />
              )}
            </>
          )}
          {featureHud.rim && (
            <Box
              component="p"
              sx={{ m: 0, mb: 0.5, fontSize: 11, color: "text.secondary" }}
            >
              Raised outline
            </Box>
          )}
          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
            <Box component="span" sx={{ fontSize: 11, color: "text.secondary" }}>
              {featureHud.rim ? "Width" : "Line width"}
            </Box>
            <Box component="span" sx={{ fontSize: 11 }}>
              {featureHud.widthMm.toFixed(2)} mm
            </Box>
          </Box>
          <WheelSlider
            size="small"
            min={0.3}
            max={6}
            step={0.05}
            value={featureHud.widthMm}
            onChange={(_, v) =>
              (scopeRef.current as unknown as ScopeExtras | null)?.__setFeatureWidth?.(
                v as number,
              )
            }
            aria-label={
              featureHud.rim ? "Stamp outline width" : "Stamp line width"
            }
          />
        </Box>
      )}
      {canvasEmpty && !backgroundUrl && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            pointerEvents: "none",
            color: "#9aa0a6",
            fontSize: 15,
            letterSpacing: 0.2,
            userSelect: "none",
          }}
        >
          Drop or paste image, SVG or PDF — or start drawing
          <Button
            size="small"
            variant="outlined"
            onClick={() => setExamplesOpen(true)}
            sx={{
              pointerEvents: "auto",
              textTransform: "none",
              color: "#546e7a",
              borderColor: "#cfd8dc",
              bgcolor: "rgba(255,255,255,0.9)",
              "&:hover": {
                borderColor: "#c45c26",
                color: "#c45c26",
                bgcolor: "#fff",
              },
            }}
          >
            Load example
          </Button>
        </div>
      )}
      <ExamplesDialog
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        onPick={importDroppedOrPickedFile}
      />
      {mode === "measure" && measureReadout && !measureEdit && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 10,
            zIndex: 3,
            pointerEvents: "none",
            fontSize: 13,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: "#1565c0",
            background: "rgba(255,255,255,0.92)",
            border: "1px solid #bbdefb",
            borderRadius: 4,
            padding: "3px 8px",
            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            userSelect: "none",
          }}
        >
          {measureReadout}
        </div>
      )}
      <Tooltip
        title={
          hasClosedCurve
            ? "Download sketch PDF (Ctrl+S saves a browser draft)"
            : hasCurves
              ? "Download sketch PDF (Ctrl+S saves a browser draft)"
              : "Draw a curve to save — autosaves in this browser"
        }
        placement="left"
      >
        <span
          style={{
            position: "absolute",
            right: 10,
            bottom: 10,
            zIndex: 3,
          }}
        >
          <IconButton
            size="small"
            disabled={!hasCurves}
            onClick={() =>
              (scopeRef.current as unknown as ScopeExtras | null)?.__saveSketchPdf?.()
            }
            sx={{
              bgcolor: hasClosedCurve ? "#c45c26" : "background.paper",
              color: hasClosedCurve ? "#fff" : "action.active",
              border: 1,
              borderColor: hasClosedCurve ? "#c45c26" : "divider",
              boxShadow: 1,
              "&:hover": {
                bgcolor: hasClosedCurve ? "#a84a1c" : "grey.100",
              },
              "&.Mui-disabled": {
                bgcolor: "background.paper",
                borderColor: "divider",
              },
            }}
            aria-label="Save sketch as PDF"
          >
            <SaveAltIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {measureEdit && (
        <div
          style={{
            position: "absolute",
            left: measureEdit.left,
            top: measureEdit.top,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "#fff",
            border: "1px solid #90caf9",
            borderRadius: 4,
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            padding: "2px 4px 2px 6px",
          }}
        >
          <input
            ref={measureInputRef}
            value={measureEdit.value}
            inputMode="decimal"
            onChange={(ev) => {
              const raw = ev.target.value.replace(",", ".");
              if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
              setMeasureEdit((m) => {
                if (!m) return m;
                const next = { ...m, value: raw };
                measureEditRef.current = next;
                return next;
              });
            }}
            onBlur={commitMeasureEdit}
            onKeyDown={onMeasureKeyDown}
            style={{
              width: 64,
              border: "none",
              outline: "none",
              fontSize: 13,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              color: "#0d47a1",
              background: "transparent",
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "#546e7a",
              paddingRight: 4,
              userSelect: "none",
            }}
          >
            mm
          </span>
        </div>
      )}
      {traceOpen && (
        <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 4 }}>
          <ImageTracePanel
            hasImage={!!backgroundUrl}
            threshold={traceThreshold}
            smooth={traceSmooth}
            showBackground={showBackground}
            showTraceCurves={showTraceCurves}
            traceMode={traceMode}
            backgroundOpacity={bgOpacity}
            curveCount={traceCurveCount}
            onThresholdChange={setTraceThreshold}
            onSmoothChange={setTraceSmooth}
            onShowBackgroundChange={setShowBackground}
            onShowTraceCurvesChange={setShowTraceCurves}
            onTraceModeChange={setTraceMode}
            onBackgroundOpacityChange={setBgOpacity}
            onLoadImage={(url) => onImportBgRef.current(url)}
            onLoadFile={importDroppedOrPickedFile}
            onRemoveImage={() => {
              onClearBackgroundRef.current();
              (scopeRef.current as unknown as ScopeExtras | null)?.__scheduleDraftSave?.();
            }}
            onHide={() => {
              setTraceOpen(false);
              onImagePanelOpenChangeRef.current(false);
              (scopeRef.current as unknown as ScopeExtras | null)?.__clearImageContours?.();
              setTraceCurveCount(0);
            }}
          />
        </Box>
      )}
      <Menu
        open={!!ctxMenu}
        onClose={closeMenu}
        anchorReference="anchorPosition"
        anchorPosition={ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined}
      >
        {ctxMenu?.kind === "point" && (
          <>
            <MenuItem
              onClick={() =>
                applyPointMenu(
                  ctxMenu.meta.smooth[ctxMenu.index] ? "corner" : "smooth",
                )
              }
            >
              <ListItemText
                primary={
                  ctxMenu.meta.smooth[ctxMenu.index]
                    ? "Change to corner"
                    : "Change to smooth"
                }
              />
            </MenuItem>
            <MenuItem onClick={() => applyPointMenu("clear-handles")}>
              <ListItemText primary="Clear handles" />
            </MenuItem>
            <MenuItem onClick={() => applyPointMenu("delete")}>
              <ListItemText primary="Delete point" />
            </MenuItem>
          </>
        )}
        {ctxMenu?.kind === "stamp" && (
          <>
            <MenuItem
              onClick={() => {
                const raised = ctxMenu.meta.raised === false;
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__setFeatureRaised?.(
                  raised,
                );
              }}
            >
              <ListItemText
                primary={ctxMenu.meta.raised === false ? "Make raised" : "Make recessed"}
              />
            </MenuItem>
            {ctxMenu.meta.path.closed && (
              <MenuItem
                onClick={() => {
                  closeMenu();
                  (scopeRef.current as unknown as ScopeExtras | null)?.__toggleFeatureFill?.();
                }}
              >
                <ListItemText primary={ctxMenu.meta.filled ? "Stroke" : "Fill"} />
              </MenuItem>
            )}
            <Divider />
            <MenuItem
              onClick={() => {
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__mirrorObject?.("h");
              }}
            >
              <ListItemText primary="Flip horizontal" />
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__mirrorObject?.("v");
              }}
            >
              <ListItemText primary="Flip vertical" />
            </MenuItem>
            {ctxMenu.meta.path.closed && (
              <>
                <Divider />
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(0.5);
                  }}
                >
                  <ListItemText primary="Grow 0.5 mm" />
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(-0.5);
                  }}
                >
                  <ListItemText primary="Shrink 0.5 mm" />
                </MenuItem>
              </>
            )}
          </>
        )}
        {ctxMenu?.kind === "object" && (
          <>
            <MenuItem
              onClick={() => {
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__mirrorObject?.("h");
              }}
            >
              <ListItemText primary="Flip horizontal" />
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__mirrorObject?.("v");
              }}
            >
              <ListItemText primary="Flip vertical" />
            </MenuItem>
            {ctxMenu.meta.path.closed && (
              <>
                <Divider />
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(0.5);
                  }}
                >
                  <ListItemText primary="Grow 0.5 mm" />
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(-0.5);
                  }}
                >
                  <ListItemText primary="Shrink 0.5 mm" />
                </MenuItem>
              </>
            )}
          </>
        )}
        {ctxMenu?.kind === "curve" && (
          <>
            <MenuItem onClick={() => applyCurveMenu("add")}>
              <ListItemText primary="Add point" />
            </MenuItem>
            {!ctxMenu.meta.path.closed && (
              <MenuItem onClick={() => applyCurveMenu("close")}>
                <ListItemText primary="Close curve" />
              </MenuItem>
            )}
            {ctxMenu.meta.path.closed && (
              <>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(0.5);
                  }}
                >
                  <ListItemText primary="Grow 0.5 mm" />
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__offsetClosedByMm?.(-0.5);
                  }}
                >
                  <ListItemText primary="Shrink 0.5 mm" />
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => applyCurveMenu("delete-segment")}>
              <ListItemText primary="Delete segment" />
            </MenuItem>
            <Divider />
            <MenuItem onClick={() => applyCurveMenu("delete")}>
              <ListItemText primary="Delete curve" />
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
