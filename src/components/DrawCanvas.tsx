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
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import SaveAltIcon from "@mui/icons-material/SaveAlt";
import {
  ArrowBigDown,
  ArrowBigUp,
  Library,
  Link,
  Microwave,
  PawPrint,
  SquareCheckBig,
  Stamp,
  Unlink,
  X,
} from "lucide-react";
import type { StampOutlineMode, Vec2 } from "../types";
import type { CanvasMode } from "./ToolRail";
import { ExamplesDialog } from "./ExamplesDialog";
import type { SketchExample } from "../examplesCatalog";
import {
  DEFAULT_PROJECT_NAME,
  projectDisplayName,
  projectExportNames,
  projectNameFromFilename,
} from "../projectName";
import { ImageTracePanel, type TraceTab } from "./ImageTracePanel";
import { WheelSlider } from "./WheelSlider";
import {
  applyRaw,
  cloneRaw,
  detectSmoothFlags,
  makeSegmentCorner,
  makeSegmentSmooth,
  meshSampleOpts,
  reverseRaw,
  samplePathPoints,
  simplifyTail,
  styleInsertedSegment,
  type SegSnap,
} from "../geometry/pathEdit";
import {
  findContours,
  findStampBlobs,
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
  STAMP_HOLE_RGB,
  STAMP_PLATE_RGB,
  STAMP_RAISE_RGB,
  STAMP_RECESS_RGB,
  STAMP_RIM_RGB,
  svgTextFromFile,
  type ImportedPath,
} from "../geometry/importVector";
import {
  buildSketchPdf,
  downloadSketchPdf,
  jpegFromImageUrl,
  type SketchPdfBackground,
} from "../geometry/exportSketchPdf";
import { cleanClosedPolyline, ensureCcw } from "../geometry/offset";
import { offsetClosedClipper, stampRimLoopsPx } from "../geometry/stampGeom";
import {
  clearSketchDraft,
  deleteTabDraft,
  ensureSketchTabs,
  loadTabDraft,
  newSketchTabId,
  saveSketchDraft,
  saveSketchTabIndex,
  saveTabDraft,
  type SketchDraftItem,
  type SketchLinkSource,
  type SketchTab,
} from "../geometry/sketchDraft";
import type { StampFeatureIn, StampParams } from "../types";
import { DEFAULT_STAMP } from "../types";
import {
  loadCloseTabConfirmHidden,
  loadImageTracePrefs,
  saveCloseTabConfirmHidden,
  saveImageTracePrefs,
} from "../storage";

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
  /** Cuts raised and recessed marks in this area. */
  hole?: boolean;
  widthMm?: number;
  filled?: boolean;
  /** Special raised rim along the stamp plate edge (not in metasRef). */
  stampRim?: boolean;
  /**
   * This Bézier is the outer edge of the raised stamp rim.
   * A cutter is generated around it and is not edited on its own.
   */
  stampPlate?: boolean;
  /** Set on the generated cutter; points at the stamp-plate path id. */
  derivedFromId?: string;
  /**
   * Locked stamp outline inset from a cutter. Not a source plate.
   * `ownerId` is that cutter.
   */
  plateFromCutter?: boolean;
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
  | {
      kind: "nodes";
      meta: PathMeta;
      indices: number[];
      grabbed: number;
      origin: paper.Point;
      starts: paper.Point[];
      started: boolean;
    }
  | {
      kind: "marquee";
      meta: PathMeta;
      origin: paper.Point;
      rect: paper.Path | null;
    }
  | {
      kind: "select-rect";
      origin: paper.Point;
      rect: paper.Path | null;
      shift: boolean;
      ctrl: boolean;
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
      /** Preserve edit-mode multi-selection after the drag. */
      keepMulti?: PathMeta[];
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
    hole?: boolean;
    widthMm?: number;
    filled?: boolean;
    stampPlate?: boolean;
    derivedFromId?: string;
    plateFromCutter?: boolean;
  }[];
  linkSource?: SketchLinkSource;
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
  /** Rim along the stamp plate edge (raised / none / recessed). */
  stampOutlineMode: StampOutlineMode;
  onStampOutlineModeChange: (mode: StampOutlineMode) => void;
  stampOutlineWidthMm: number;
  onStampOutlineWidthChange: (widthMm: number) => void;
  /** Full stamp params (for draft persistence). */
  stamp: StampParams;
  onStampChange: (next: StampParams) => void;
  /** Features of the cutter curve currently driving the 3D view; null = no stamp. */
  onStampFeatures: (
    features: StampFeatureIn[] | null,
    outlinePx?: Vec2[] | null,
  ) => void;
  /** Short status after Ctrl+S draft flush. */
  onDraftSaved?: (message: string) => void;
  /** 1–5 sampling density of smooth curves in the 3D mesh. */
  meshQuality: number;
  /** Paper units → mm (always defined; from measure calibration or Size). */
  mmPerPx: number;
  onMmPerPxChange: (mmPerPx: number) => void;
  onClosedPathChange: (path: Vec2[] | null) => void;
  /** Every cutter island and stamp plate, including a stamp with no cutter. */
  onMeshParts?: (parts: {
    cutterLoops: Vec2[][];
    outlineLoops: Vec2[][];
    features: StampFeatureIn[] | null;
  }) => void;
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
  /** Increment to flip the whole sketch vertically. */
  mirrorToken: number;
  /** Increment to swap raised ↔ recessed on stamp marks + outline. */
  invertReliefToken: number;
  /** Stamp vs cutter layer for the tool rail. */
  onActiveLayerChange?: (layer: "cutter" | "stamp") => void;
  undoToken: number;
  redoToken: number;
  /** Whether the canvas has drawable curves (for Download dialog). */
  onHasCurvesChange?: (has: boolean) => void;
  /** Increment to trigger sketch PDF download. */
  saveSketchToken?: number;
  /** Live API for sketch export (PDF / ZIP). */
  saveApiRef?: MutableRefObject<CanvasSaveApi | null>;
  /** Fired after the canvas PDF icon actually saves a file (not cancelled). */
  onSketchPdfSaved?: () => void;
  /** Cookie / project title used in download filenames. */
  projectName: string;
  onProjectNameChange: (name: string) => void;
  /** Keep the app-level tab strip in sync. */
  onSketchTabsChange?: (tabs: SketchTab[], activeId: string | null) => void;
};

/** One open tab, ready to drop into the “everything” ZIP. */
export type ZipSketchPart = {
  name: string;
  pdf: Uint8Array | null;
  /** Closed cutter outline. Null when this tab cannot build a solid. */
  pts: Vec2[] | null;
  /** Every closed cutter, sharing one frame. Falls back to `pts`. */
  cutterLoops?: Vec2[][];
  /** Every stamp plate island. Falls back to `outlinePx`. */
  outlineLoops?: Vec2[][];
  /** Null when the cutter has no stamp. Empty array is a blank stamp plate. */
  features: StampFeatureIn[] | null;
  stamp: StampParams;
  outlinePx: Vec2[] | null;
  mmPerPx: number | null;
};

export type CanvasSaveApi = {
  savePdf: () => Promise<"saved" | "cancelled" | void>;
  buildPdfBytes: () => Promise<Uint8Array | null>;
  /** Flush IndexedDB sketch draft (Ctrl+S / floppy). */
  saveDraft: () => Promise<void>;
  /**
   * Non-empty open tabs: live geometry for the active tab, stored drafts
   * for the rest. Does not switch the visible canvas.
   */
  collectZipSketches: () => Promise<ZipSketchPart[]>;
  switchSketchTab: (id: string) => Promise<void>;
  requestCloseTab: (id: string) => Promise<void>;
  openFreshTab: () => Promise<void>;
  openLibrary: () => void;
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
  /** Re-sample curves into the 3D polyline after mesh quality changes. */
  __resampleMesh?: () => void;
  __toggleStamp?: () => void;
  /** Switch the active sketch layer. */
  __setLayer?: (layer: "cutter" | "stamp") => void;
  /** Remove stamp (features + rim) from a cutter, or the stamp currently being edited. */
  __removeStamp?: (meta?: PathMeta) => void;
  __setFeatureWidth?: (widthMm: number) => void;
  __setFeatureRaised?: (raised: boolean) => void;
  __setFeatureHole?: () => void;
  __toggleFeatureFill?: () => void;
  __setFeatureFill?: (filled: boolean) => void;
  __mirrorObject?: (axis: "h" | "v") => void;
  /** Swap raised ↔ recessed on all stamp marks; outline raised↔recessed (none stays). */
  __invertStampRelief?: () => void;
  /** Clipper2 outset/inset by a fixed mm amount (closed curves only). */
  __offsetClosedByMm?: (mm: number) => void;
  /** Keep the selected closed curve as the stamp rim and build a cutter around it. */
  __addCutterAroundOutline?: () => void;
  /** Create a linked stamp outline from the selected closed cutter. */
  __addLinkedStamp?: () => void;
  /** Flip every source curve horizontally (left↔right) about the sketch center. */
  __mirrorAllHorizontal?: () => void;
  /** Drop the generated cutter and turn the stamp-plate curve back into a normal path. */
  __removeCutterAroundOutline?: () => void;
  /** Stop the fit gap from moving the derived outline. Both curves stay. */
  __decouple?: () => void;
  /** Re-sample every island into the 3D preview. */
  __emitMesh?: () => void;
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
  /** Import Area-tab blob outlines as stamp curves (raised or recessed). */
  __stampBlacks?: (raised?: boolean) => void;
  /** Select every editable curve on the active layer. */
  __selectAll?: () => void;
  __clearImageContours?: () => void;
  __importVectorFile?: (
    file: File,
    opts?: { preferredName?: string },
  ) => Promise<void>;
  /** Copy the selected curve (edit / curve edit). */
  __copyCurve?: () => boolean;
  __saveSketchPdf?: () => void | Promise<"saved" | "cancelled" | void>;
  /** Build sketch PDF bytes without downloading (for ZIP). */
  __buildSketchPdfBytes?: () => Promise<Uint8Array | null>;
  __collectZipSketches?: () => Promise<ZipSketchPart[]>;
  __scheduleDraftSave?: () => void;
  __flushDraftSave?: (toast?: boolean) => void;
  /** New blank tab when the current sketch is not empty. */
  __openFreshTab?: () => Promise<void>;
  __switchSketchTab?: (id: string) => Promise<void>;
  __requestCloseTab?: (id: string) => Promise<void>;
  __confirmCloseTab?: (id: string) => Promise<void>;
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
  stampOutlineMode,
  onStampOutlineModeChange,
  stampOutlineWidthMm,
  onStampOutlineWidthChange,
  stamp,
  onStampChange,
  onStampFeatures,
  onDraftSaved,
  meshQuality,
  mmPerPx,
  onMmPerPxChange,
  onClosedPathChange,
  onMeshParts,
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
  mirrorToken,
  invertReliefToken,
  onActiveLayerChange,
  undoToken,
  redoToken,
  onHasCurvesChange,
  saveSketchToken = 0,
  saveApiRef,
  onSketchPdfSaved,
  projectName,
  onProjectNameChange,
  onSketchTabsChange,
}: Props) {
  const onSketchPdfSavedRef = useRef(onSketchPdfSaved);
  onSketchPdfSavedRef.current = onSketchPdfSaved;
  const onSketchTabsChangeRef = useRef(onSketchTabsChange);
  onSketchTabsChangeRef.current = onSketchTabsChange;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const onProjectNameChangeRef = useRef(onProjectNameChange);
  onProjectNameChangeRef.current = onProjectNameChange;
  const [nameEditing, setNameEditing] = useState(false);
  const [pdfSaving, setPdfSaving] = useState(false);
  const [sketchTabs, setSketchTabs] = useState<SketchTab[]>([]);
  const [activeSketchId, setActiveSketchId] = useState<string | null>(null);
  const [closeSketch, setCloseSketch] = useState<SketchTab | null>(null);
  const [closePdfSaved, setClosePdfSaved] = useState(false);
  const [closeDontAsk, setCloseDontAsk] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const activeSketchIdRef = useRef<string | null>(null);
  const sketchTabsRef = useRef<SketchTab[]>([]);
  /** Skip one project-name → tab-label write when the name came from a tab load. */
  const skipNameSyncRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<paper.PaperScope | null>(null);
  const metasRef = useRef<PathMeta[]>([]);
  const endsRef = useRef<OpenEnd[]>([]);
  const gizmosRef = useRef<EditGizmo[]>([]);
  /** Object-edit transform overlays (box, corners, orange points). */
  const xformItemsRef = useRef<paper.Item[]>([]);
  /** Orange hairline + points while continuing a curve in draw/polygon. */
  const continueChromeRef = useRef<paper.Item[]>([]);
  const selectedRef = useRef<PathMeta | null>(null);
  /** Edit-mode multi-selection. Last entry is the primary (gizmo) curve. */
  const selectedManyRef = useRef<PathMeta[]>([]);
  const drawingRef = useRef<paper.Path | null>(null);
  const [canvasEmpty, setCanvasEmpty] = useState(true);
  /** File drag hovering the canvas (image / PDF / SVG import). */
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragDepthRef = useRef(0);
  const [examplesOpen, setExamplesOpen] = useState(false);
  /** Finished curves on the canvas (enables Save). */
  const [hasCurves, setHasCurves] = useState(false);
  /** At least one closed outline — Save gets orange emphasis. */
  const [hasClosedCurve, setHasClosedCurve] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  // Higher = stricter: only darker ink (0 ≈ all, 255 = pure black only).
  const [traceThreshold, setTraceThreshold] = useState(
    () => loadImageTracePrefs().threshold,
  );
  const [traceSmooth, setTraceSmooth] = useState(
    () => loadImageTracePrefs().smooth,
  );
  /** Ignore filled blobs smaller than this many image pixels (Area tab). */
  const [traceMinArea, setTraceMinArea] = useState(
    () => loadImageTracePrefs().minArea,
  );
  const [showBackground, setShowBackground] = useState(true);
  /** Curves = stroke/outline detect; Area = filled-region outlines. */
  const [traceTab, setTraceTab] = useState<TraceTab>("curves");
  /** Outlines of dark regions vs stroke centerlines (Curves tab). */
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
  /** Curve-edit: every point inside the marquee, or the clicked point. */
  const selectedPointsRef = useRef<number[]>([]);
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
  const outlineModeRef = useRef(stampOutlineMode);
  outlineModeRef.current = stampOutlineMode;
  const onOutlineModeChangeRef = useRef(onStampOutlineModeChange);
  onOutlineModeChangeRef.current = onStampOutlineModeChange;
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
  const [activeLayer, setActiveLayer] = useState<"cutter" | "stamp">("cutter");
  const [linkUi, setLinkUi] = useState<"off" | "linked" | "decoupled">("off");
  /** Which side owns the link when `linkUi === "linked"`. */
  const [linkSourceUi, setLinkSourceUi] = useState<"cutter" | "stamp" | null>(
    null,
  );
  const [canAddLinkedCutter, setCanAddLinkedCutter] = useState(false);
  const [canAddLinkedStamp, setCanAddLinkedStamp] = useState(false);
  const [hasStampContent, setHasStampContent] = useState(false);
  const [appDialog, setAppDialog] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string | null;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [featureHud, setFeatureHud] = useState<{
    rim?: boolean;
    widthMm: number;
    raised: boolean;
    hole: boolean;
    filled: boolean;
    closed: boolean;
  } | null>(null);
  const setActiveLayerRef = useRef(setActiveLayer);
  setActiveLayerRef.current = setActiveLayer;
  const onActiveLayerChangeRef = useRef(onActiveLayerChange);
  onActiveLayerChangeRef.current = onActiveLayerChange;
  const lastReportedLayerRef = useRef<"cutter" | "stamp" | null>(null);
  const setLinkUiRef = useRef(setLinkUi);
  setLinkUiRef.current = setLinkUi;
  const setLinkSourceUiRef = useRef(setLinkSourceUi);
  setLinkSourceUiRef.current = setLinkSourceUi;
  const setCanAddLinkedCutterRef = useRef(setCanAddLinkedCutter);
  setCanAddLinkedCutterRef.current = setCanAddLinkedCutter;
  const setCanAddLinkedStampRef = useRef(setCanAddLinkedStamp);
  setCanAddLinkedStampRef.current = setCanAddLinkedStamp;
  const setHasStampContentRef = useRef(setHasStampContent);
  setHasStampContentRef.current = setHasStampContent;
  const setAppDialogRef = useRef(setAppDialog);
  setAppDialogRef.current = setAppDialog;
  const setFeatureHudRef = useRef(setFeatureHud);
  setFeatureHudRef.current = setFeatureHud;
  const setTraceCurveCountRef = useRef(setTraceCurveCount);
  setTraceCurveCountRef.current = setTraceCurveCount;
  const mmPerPxRef = useRef(mmPerPx);
  mmPerPxRef.current = mmPerPx;
  const meshQualityRef = useRef(meshQuality);
  meshQualityRef.current = meshQuality;
  const showBackgroundRef = useRef(showBackground);
  showBackgroundRef.current = showBackground;
  const traceTabRef = useRef(traceTab);
  traceTabRef.current = traceTab;
  const traceModeRef = useRef(traceMode);
  traceModeRef.current = traceMode;
  const traceThresholdRef = useRef(traceThreshold);
  traceThresholdRef.current = traceThreshold;
  const traceSmoothRef = useRef(traceSmooth);
  traceSmoothRef.current = traceSmooth;
  const traceMinAreaRef = useRef(traceMinArea);
  traceMinAreaRef.current = traceMinArea;
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
    stampOutlineMode?: StampOutlineMode | null;
    stampOutlineWidthMm?: number | null;
  } | null>(null);
  /** Draft restore waiting for background raster placement. */
  const pendingDraftRestoreRef = useRef<{
    items: SketchDraftItem[];
    stampOwnerId: string | null;
    linkSource?: SketchLinkSource;
    mmPerPx: number | null;
    quiet?: boolean;
  } | null>(null);
  const finishPendingDraftRestoreRef = useRef<(() => void) | null>(null);
  const finishPendingPdfImportRef = useRef<
    ((raster: paper.Raster | null) => void) | null
  >(null);
  const onMmPerPxChangeRef = useRef(onMmPerPxChange);
  onMmPerPxChangeRef.current = onMmPerPxChange;
  const onClosedRef = useRef(onClosedPathChange);
  onClosedRef.current = onClosedPathChange;
  const onMeshPartsRef = useRef(onMeshParts);
  onMeshPartsRef.current = onMeshParts;
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
      // Previews live with the image — hide both when "Show image" is off.
      if (!showBackgroundRef.current) return 0;
      const img = imageDataRef.current;
      const sz = imageSizeRef.current;
      const raster = bgRef.current;
      if (!img || !sz || !raster || !raster.bounds) return 0;
      const b = raster.bounds;
      const toProject = (c: Contour) =>
        c.map((p) => ({
          x: b.left + (p.x / sz.w) * b.width,
          y: b.top + (p.y / sz.h) * b.height,
        }));

      // Area tab: blue outlines of filled blobs (outers + holes). Apply imports them.
      if (traceTabRef.current === "area") {
        const blobs = findStampBlobs(img, threshold, {
          simplifyAmount: smoothAmt,
          minArea: traceMinAreaRef.current,
        });
        imageProjectContours = [];
        for (const blob of blobs) {
          const rings = [blob.outer, ...blob.holes];
          for (const ring of rings) {
            const pts = toProject(ring);
            if (pts.length < 3) continue;
            const path = new scope.Path({
              segments: pts.map((p) => new scope.Point(p.x, p.y)),
              closed: true,
              strokeColor: new scope.Color("#1e88e5"),
              strokeWidth: screen(1.5),
              fillColor: null,
              opacity: 0.75,
              strokeCap: "round",
              strokeJoin: "round",
            });
            path.data.imageContour = true;
            path.data.contourIndex = imagePreviewPaths.length;
            path.data.traceOpen = false;
            path.data.traceArea = true;
            path.bringToFront();
            imagePreviewPaths.push(path);
            imageProjectContours.push(
              path.segments.map((s) => ({ x: s.point.x, y: s.point.y })),
            );
          }
        }
        return imagePreviewPaths.filter(Boolean).length;
      }

      const lines = traceModeRef.current === "lines";
      const raw = lines
        ? findStrokeCenterlines(img, threshold, { simplifyAmount: smoothAmt })
        : findContours(img, threshold, { simplifyAmount: smoothAmt });
      const prepared = raw.map((c) =>
        lines
          ? prepareOpenContourForEdit(c, smoothAmt)
          : prepareContourForEdit(c, smoothAmt),
      );
      imageProjectContours = [];
      for (let i = 0; i < prepared.length; i++) {
        const pts = toProject(prepared[i]);
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
      if (inStampDraw()) {
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
    /** Stamp marks with no cutter yet. New strokes are features. */
    const stampLayerRef = { current: false };
    /**
     * `null` may still auto-link. `decoupled` must not — the shapes have diverged.
     */
    const linkSourceRef: { current: SketchLinkSource } = { current: null };
    const inStampDraw = () => !!stampOwnerRef.current || stampLayerRef.current;

    const askConfirm = (title: string, message: string, confirmLabel = "OK") =>
      new Promise<boolean>((resolve) => {
        setAppDialogRef.current({
          title,
          message,
          confirmLabel,
          cancelLabel: "Cancel",
          resolve,
        });
      });

    const askAlert = (title: string, message: string) =>
      new Promise<void>((resolve) => {
        setAppDialogRef.current({
          title,
          message,
          confirmLabel: "OK",
          cancelLabel: null,
          resolve: () => resolve(),
        });
      });
    /** Outer fit-gap edge (mask hole; dashed chrome when rim is off). */
    const stampOutlineRef: { current: paper.Path | null } = { current: null };
    /** Filled annulus matching 3D rim (outer − inward width). */
    const stampRimFillRef: { current: paper.Item | null } = {
      current: null,
    };
    const stampRimMetaRef: { current: PathMeta | null } = { current: null };
    /** Gray rim bands shown in cutter-edit mode (not interactive). */
    const stampRimPreviewRef: { current: paper.Item[] } = { current: [] };
    const stampMaskRef: { current: paper.CompoundPath | null } = { current: null };
    let metaSeq = 1;
    const lastWidthMm = { current: 0.6 };

    const ensureId = (m: PathMeta) => {
      if (!m.id) m.id = `p${metaSeq++}`;
      return m.id;
    };

    /** Real cutter outline — not a stamp feature and not a stamp-plate Bézier. */
    const isCutterShape = (m: PathMeta) =>
      m.role !== "feature" && !m.stampPlate && !m.stampRim;

    const derivedFor = (plate: PathMeta): PathMeta | null =>
      metasRef.current.find((m) => m.derivedFromId && m.derivedFromId === plate.id) ??
      null;

    const plateFor = (cutter: PathMeta): PathMeta | null => {
      if (!cutter.derivedFromId) return null;
      return (
        metasRef.current.find(
          (m) => m.stampPlate && m.id === cutter.derivedFromId,
        ) ?? null
      );
    };

    /** Stamp features belonging to this cutter (follow move/scale/rotate). */
    const linkedStampFeatures = (item: PathMeta): PathMeta[] => {
      const cutter = item.stampPlate ? derivedFor(item) : item;
      if (!cutter?.id || !isCutterShape(cutter)) return [];
      return metasRef.current.filter(
        (m) => m.role === "feature" && m.ownerId === cutter.id,
      );
    };

    /**
     * Parts that transform with a cutter (its stamp features).
     * Stamp-plate outlines move alone — linked cutter rebuilds via syncStampChrome.
     */
    const linkedWithCutter = (item: PathMeta): PathMeta[] => {
      if (item.stampPlate) return [];
      return linkedStampFeatures(item);
    };

    const featureColor = (m: PathMeta) =>
      m.hole ? "#263238" : m.raised === false ? "#1e3a8a" : "#7f1d1d";

    /**
     * Keep the photo under drawing and re-assert its visibility. Fill restacks
     * (and path opacity compositing) were able to blank the raster until the
     * user toggled "Show image".
     */
    const pinBackdropAndTrace = () => {
      const bg = bgRef.current;
      if (bg) {
        bg.sendToBack();
        if (showBackgroundRef.current) {
          bg.visible = true;
          bg.opacity = bgOpacityRef.current;
        } else {
          bg.visible = false;
          bg.opacity = 0;
        }
      }
      if (gridGroup) {
        if (bg) gridGroup.insertAbove(bg);
        else gridGroup.sendToBack();
      }
      // Trace previews sit above the photo; gizmos are rebuilt after call sites.
      for (const p of imagePreviewPaths) {
        if (!p) continue;
        if (bg) p.insertAbove(gridGroup ?? bg);
        else p.sendToBack();
      }
    };

    /** Holes sit above the marks they cancel, and under the plate / cutter. */
    const orderFeatureStack = () => {
      const owner = stampOwnerRef.current;
      const mask = stampMaskRef.current;
      const features = metasRef.current.filter(
        (m) =>
          m.role === "feature" &&
          m.path.visible &&
          (!owner || m.ownerId === owner.id),
      );
      const solids = features.filter((m) => !m.hole);
      const holes = features.filter((m) => m.hole);
      if (mask) {
        // Last inserted below the mask ends up topmost among features.
        for (const m of solids) m.path.insertBelow(mask);
        for (const h of holes) h.path.insertBelow(mask);
        pinBackdropAndTrace();
        return;
      }
      // No mask (e.g. Area Apply before a plate): list order, last on top.
      // sendToBack would bury new strokes under earlier filled pads.
      for (const m of solids) m.path.bringToFront();
      for (const h of holes) h.path.bringToFront();
      for (const m of metasRef.current) {
        if (m.role !== "feature" && m.path.visible && !m.stampRim) {
          m.path.bringToFront();
        }
      }
      pinBackdropAndTrace();
    };

    const styleFeature = (m: PathMeta, gray = false) => {
      const raw = m.widthMm ?? lastWidthMm.current;
      const w = Number.isFinite(raw) ? Math.max(0, raw) : 0.6;
      m.widthMm = w;
      // Strict true — never treat undefined/missing as filled.
      const filled = m.filled === true;
      m.path.strokeCap = "round";
      m.path.strokeJoin = "round";
      m.path.dashArray = [];
      m.path.data = { ...(m.path.data || {}), kind: "feature" };
      // Holes use the same fill / width rules as raised & recessed, in charcoal.
      const color = gray ? "#9aa3ab" : featureColor(m);
      // Keep item opacity at 1 and put alpha on the fill color. Path opacity < 1
      // forces an offscreen composite over the whole bounds and can blank the
      // background raster until "Show image" is toggled.
      m.path.opacity = gray ? 0.4 : 1;
      if (filled) {
        const fill = new scope.Color(color);
        fill.alpha = gray ? 1 : 0.9;
        m.path.fillColor = fill;
      } else {
        m.path.fillColor = null;
      }
      if (w <= 1e-9) {
        // Hairline: filled pads have no border; strokes stay a 1px screen line.
        if (filled) {
          m.path.strokeColor = null;
          m.path.strokeWidth = 0;
        } else {
          m.path.strokeColor = new scope.Color(color);
          m.path.strokeWidth = Math.max(1, screen(1));
        }
        orderFeatureStack();
        return;
      }
      const px = mmPerPxRef.current > 1e-6 ? w / mmPerPxRef.current : 1.5;
      m.path.strokeColor = new scope.Color(color);
      m.path.strokeWidth = Math.max(1, px);
      orderFeatureStack();
    };

    const styleStampPlate = (m: PathMeta, grey = false) => {
      m.path.strokeCap = "round";
      m.path.strokeJoin = "round";
      m.path.fillColor = null;
      m.path.opacity = grey ? 0.55 : 1;
      m.path.data = { ...(m.path.data || {}), kind: "stamp-plate" };
      if (m.plateFromCutter) {
        // Linked outline inset from a cutter — dashed, locked.
        m.path.strokeColor = new scope.Color(grey ? "#9aa3ab" : "#7f1d1d");
        m.path.strokeWidth = 1.25;
        m.path.dashArray = [8, 6];
        m.path.locked = true;
      } else {
        // User stamp boundary — black hairline.
        m.path.strokeColor = new scope.Color(grey ? "#9aa3ab" : "#111");
        m.path.strokeWidth = Math.max(1, screen(1));
        m.path.dashArray = [];
        m.path.locked = grey;
      }
    };

    /** Locked cutter derived from a stamp boundary — dashed, not editable. */
    const styleDerivedCutter = (m: PathMeta, grey = false) => {
      m.path.strokeColor = new scope.Color(grey ? "#9aa3ab" : "#c45c26");
      m.path.strokeWidth = 1.25;
      m.path.strokeCap = "round";
      m.path.strokeJoin = "round";
      m.path.fillColor = null;
      m.path.opacity = grey ? 0.55 : 0.9;
      m.path.dashArray = [8, 6];
      m.path.locked = true;
      m.path.data = { ...(m.path.data || {}), kind: "derived-cutter" };
    };

    const cutterStroke = (m: PathMeta, grey: boolean) => {
      if (m.derivedFromId) {
        styleDerivedCutter(m, grey);
        return;
      }
      m.path.strokeColor = new scope.Color(
        grey ? "#9aa3ab" : m.path.closed ? "#c45c26" : "#111",
      );
      m.path.strokeWidth = m.path.closed ? 2.2 : 1.5;
      m.path.fillColor = null;
      m.path.opacity = grey ? 0.55 : 1;
      m.path.dashArray = [];
      m.path.locked = grey || !!m.derivedFromId;
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
        if (outlineModeRef.current !== "none" && stampRimFillRef.current) {
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
        }) as paper.Item;
        highlight.opacity = 0.45;
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

    const metaIsPickable = (m: PathMeta, owner: PathMeta | null) => {
      if (!m.path.visible || m.path.locked) return false;
      if (m.derivedFromId || m.plateFromCutter || m.stampRim) return false;
      if (stampLayerRef.current || owner) {
        // Stamp layer: features + editable stamp boundaries only.
        if (m.role === "feature") {
          if (owner && m.ownerId && m.ownerId !== owner.id) return false;
          return true;
        }
        if (m.stampPlate && !m.plateFromCutter) {
          if (owner && m.ownerId && m.ownerId !== owner.id) return false;
          return true;
        }
        return false;
      }
      // Cutter layer: stamp content is not selectable.
      if (m.role === "feature" || m.stampPlate) return false;
      return true;
    };

    /** Closest editable curve near the pointer (nested curves win over large parents). */
    const pickEditableMeta = (pt: paper.Point): PathMeta | null => {
      const lim = screen(8);
      let best: PathMeta | null = null;
      let bestD = lim;
      const owner = stampOwnerRef.current;
      let fillBest: PathMeta | null = null;
      let fillArea = Infinity;
      for (const m of metasRef.current) {
        if (!metaIsPickable(m, owner)) continue;
        const loc = m.path.getNearestLocation(pt);
        if (loc && loc.distance < bestD) {
          bestD = loc.distance;
          best = m;
        }
        // Filled pads: a click in the interior selects the shape.
        // The smallest containing fill wins when several overlap.
        if (
          m.filled === true &&
          m.path.closed &&
          m.path.contains(pt)
        ) {
          const area = Math.abs(m.path.area);
          if (area < fillArea) {
            fillArea = area;
            fillBest = m;
          }
        }
      }
      if (best) return best;
      if (fillBest) return fillBest;
      // Raised outline is not selectable — width lives in the Fit gap panel.
      return best;
    };

    const resolveStampTarget = (): PathMeta | null => {
      const sel = selectedRef.current;
      if (sel?.stampPlate) {
        const derived = derivedFor(sel);
        if (derived?.path.closed) return derived;
      }
      if (sel && isCutterShape(sel) && sel.path.closed) return sel;
      const closed = metasRef.current.filter(
        (m) => isCutterShape(m) && m.path.closed && m.path.visible,
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

    /** Idle ellipse-mode crosshair (H+V dashed guides through the pointer). */
    let ellipseGuide: paper.Group | null = null;
    const clearEllipseGuide = () => {
      ellipseGuide?.remove();
      ellipseGuide = null;
    };
    const showEllipseGuide = (at: paper.Point) => {
      clearEllipseGuide();
      const b = scope.view.bounds;
      const color = new scope.Color("#1e88e5");
      const sw = screen(1);
      const dash = [screen(6), screen(4)];
      const g = new scope.Group();
      g.locked = true;
      g.addChild(
        new scope.Path.Line({
          from: new scope.Point(b.left, at.y),
          to: new scope.Point(b.right, at.y),
          strokeColor: color,
          strokeWidth: sw,
          dashArray: dash,
          opacity: 0.85,
          strokeCap: "round",
        }),
      );
      g.addChild(
        new scope.Path.Line({
          from: new scope.Point(at.x, b.top),
          to: new scope.Point(at.x, b.bottom),
          strokeColor: color,
          strokeWidth: sw,
          dashArray: dash,
          opacity: 0.85,
          strokeCap: "round",
        }),
      );
      g.bringToFront();
      ellipseGuide = g;
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
      setSelectedPoints([]);
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

    /** Curve-edit centerline drawn over the real stroke. */
    let curveHairline: paper.Path | null = null;

    const clearCurveHairline = () => {
      curveHairline?.remove();
      curveHairline = null;
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
      clearCurveHairline();
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

    /** Union of padded bounds for a multi-selection. */
    const selectionGroupBounds = (list: PathMeta[]) => {
      let u: paper.Rectangle | null = null;
      for (const m of list) {
        const b = selectionPadBounds(m);
        u = u ? u.unite(b) : b.clone();
      }
      return u;
    };

    /** Everything that must translate with a multi-move (curves + linked stamp parts). */
    const gatherMultiMovers = (list: PathMeta[]): PathMeta[] => {
      const seen = new Set<PathMeta>();
      const out: PathMeta[] = [];
      for (const item of list) {
        if (
          !item ||
          seen.has(item) ||
          item.stampRim ||
          item.derivedFromId ||
          !metasRef.current.includes(item)
        ) {
          continue;
        }
        out.push(item);
        seen.add(item);
        for (const linked of linkedWithCutter(item)) {
          if (seen.has(linked)) continue;
          out.push(linked);
          seen.add(linked);
        }
      }
      return out;
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

    const clearContinueChrome = () => {
      for (const it of continueChromeRef.current) it.remove();
      continueChromeRef.current = [];
    };

    /** Orange centerline + vertex dots (selection / continue-from-endpoint). */
    const pushOrangePathChrome = (
      meta: PathMeta,
      into: paper.Item[],
      opts?: { hairline?: boolean; maxDotIndex?: number },
    ) => {
      if (meta.stampRim) return;
      const wantHair =
        opts?.hairline !== false &&
        (meta.role === "feature" || meta.stampPlate || opts?.hairline === true);
      if (wantHair) {
        const hair = meta.path.clone() as paper.Path;
        hair.strokeColor = new scope.Color("#c45c26");
        hair.strokeWidth = Math.max(1, screen(1));
        hair.fillColor = null;
        hair.dashArray = [];
        hair.opacity = 1;
        hair.selected = false;
        hair.locked = true;
        hair.bringToFront();
        into.push(hair);
      }
      const pr = screen(2.6);
      const last =
        opts?.maxDotIndex != null
          ? Math.min(opts.maxDotIndex, meta.path.segments.length - 1)
          : meta.path.segments.length - 1;
      for (let i = 0; i <= last; i++) {
        const seg = meta.path.segments[i];
        if (!seg) continue;
        const dot = new scope.Path.Circle({
          center: seg.point,
          radius: pr,
          fillColor: new scope.Color("#c45c26"),
          strokeColor: null,
        });
        dot.locked = true;
        into.push(dot);
      }
    };

    /**
     * While extending an open curve in draw/polygon, show the same orange
     * hairline + points as object-edit selection.
     */
    const rebuildContinueChrome = () => {
      clearContinueChrome();
      if (modeRef.current !== "draw" && modeRef.current !== "polygon") return;
      let meta: PathMeta | null = null;
      let maxDotIndex: number | undefined;
      let forceHair = false;
      if (continueMetaRef.current && drawingRef.current) {
        meta = continueMetaRef.current;
        // Freehand adds dense samples — keep dots on the already-finished part.
        maxDotIndex = continueAnchorRef.current;
        forceHair = true;
      } else if (polygonRef.current && polyBaseCount > 0) {
        meta =
          metasRef.current.find((m) => m.path === polygonRef.current) ?? null;
        forceHair = true;
      }
      if (!meta) return;
      pushOrangePathChrome(meta, continueChromeRef.current, {
        hairline: forceHair || meta.role === "feature" || !!meta.stampPlate,
        maxDotIndex,
      });
    };

    const rebuildTransformGizmos = () => {
      clearXformGizmos();
      const many = activeSelection();
      const strokeW = screen(1.1);
      if (many.length > 1) {
        for (const m of many) {
          const hi = m.path.clone() as paper.Path;
          hi.strokeColor = new scope.Color("#1e88e5");
          hi.strokeWidth = Math.max(m.path.strokeWidth || 1.5, screen(2));
          hi.fillColor = null;
          hi.selected = false;
          hi.locked = true;
          hi.bringToFront();
          xformItemsRef.current.push(hi);
        }
        const gb = selectionGroupBounds(many);
        if (gb) {
          const box = new scope.Path.Rectangle(gb);
          box.strokeColor = new scope.Color("#1e88e5");
          box.strokeWidth = strokeW;
          box.dashArray = [screen(5), screen(3)];
          box.fillColor = null;
          box.locked = true;
          box.bringToFront();
          xformItemsRef.current.push(box);
        }
        return;
      }
      const meta = selectedRef.current;
      if (!meta) return;
      meta.path.fullySelected = false;
      meta.path.selected = false;
      const b = selectionPadBounds(meta);
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

      // Stamp marks: orange hairline over the real red/blue/black stroke + width.
      // Cutters already stroke orange — dots only.
      pushOrangePathChrome(meta, xformItemsRef.current, {
        hairline: meta.role === "feature" || !!meta.stampPlate,
      });
    };

    const restorePathDisplay = (m: PathMeta) => {
      if (m.stampRim || !metasRef.current.includes(m)) return;
      const stampLayer = stampLayerRef.current || !!stampOwnerRef.current;
      if (m.role === "feature") styleFeature(m, !stampLayer);
      else if (m.stampPlate) styleStampPlate(m, !stampLayer);
      else cutterStroke(m, stampLayer || (!!stampOwnerRef.current && stampOwnerRef.current !== m));
    };

    const clearCurveEditStroke = () => {
      clearCurveHairline();
      const meta = selectedRef.current;
      if (meta) restorePathDisplay(meta);
    };

    const rebuildCurveEditGizmos = () => {
      clearGizmos();
      const meta = selectedRef.current;
      if (!meta || meta.stampRim) return;
      ensureSmoothFlags(meta);
      meta.path.fullySelected = false;
      meta.path.selected = false;
      restorePathDisplay(meta);
      // Teal centerline over the real stroke. Distinct from selection blue,
      // handle grey, open-end red, and the cutter orange.
      const hair = meta.path.clone() as paper.Path;
      hair.strokeColor = new scope.Color("#00897b");
      hair.strokeWidth = Math.max(1, screen(1));
      hair.fillColor = null;
      hair.dashArray = [];
      hair.opacity = 1;
      hair.selected = false;
      hair.locked = true;
      hair.bringToFront();
      curveHairline = hair;
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

    const setSelectedPoints = (indices: number[]) => {
      const meta = selectedRef.current;
      selectedPointsRef.current = indices;
      selectedPointRef.current =
        meta && indices.length
          ? { meta, index: indices[indices.length - 1] }
          : null;
    };

    const paintPointSelection = () => {
      const meta = selectedRef.current;
      if (!meta) return;
      const picked = new Set(selectedPointsRef.current);
      const hover = hoverNodeRef.current;
      for (const g of gizmosRef.current) {
        if (hover && hover.meta === g.meta && hover.index === g.index) continue;
        if (g.meta === meta && picked.has(g.index)) {
          (g.node as paper.Path).fillColor = new scope.Color("#1e88e5");
        }
      }
    };

    const rebuildEditGizmos = () => {
      clearGizmos();
      clearXformGizmos();
      clearCurveHover();
      hoverNodeRef.current = null;
      const mode = modeRef.current;
      if (mode === "edit") {
        clearCurveEditStroke();
        rebuildTransformGizmos();
      } else if (mode === "curveEdit") {
        rebuildCurveEditGizmos();
        paintPointSelection();
        const segSel = selectedSegmentRef.current;
        if (segSel) showCurveHover(segSel.meta, segSel.segIndex);
      } else {
        clearCurveEditStroke();
      }
    };

    const clearDrawMarkers = () => {
      for (const e of endsRef.current) e.marker.remove();
      endsRef.current = [];
      drawStartMarkerRef.current?.remove();
      drawStartMarkerRef.current = null;
      clearMagnet();
      clearContinueChrome();
    };

    const refreshDrawMarkers = () => {
      for (const e of endsRef.current) e.marker.remove();
      endsRef.current = [];
      // Show open endpoints in freehand and polygon so new strokes can continue / join
      if (modeRef.current !== "draw" && modeRef.current !== "polygon") {
        clearContinueChrome();
        return;
      }
      const activePoly = polygonRef.current;
      const activeDraw = drawingRef.current;
      const continuing = !!continueMetaRef.current;
      for (const meta of metasRef.current) {
        if (meta.path.closed || meta.path.segments.length < 1) continue;
        if (inStampDraw()) {
          if (meta.role !== "feature") continue;
          if (
            stampOwnerRef.current &&
            meta.ownerId !== stampOwnerRef.current.id
          ) {
            continue;
          }
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
      rebuildContinueChrome();
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
        hole: m.hole,
        widthMm: m.widthMm,
        filled: m.filled,
        stampPlate: m.stampPlate,
        derivedFromId: m.derivedFromId,
        plateFromCutter: m.plateFromCutter,
      })),
      linkSource: linkSourceRef.current,
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
        hole: m.hole,
        widthMm: m.widthMm,
        filled: m.filled,
        stampPlate: m.stampPlate,
        derivedFromId: m.derivedFromId,
        plateFromCutter: m.plateFromCutter,
      }));

    const captureBackgroundBlob = async (): Promise<{
      blob: Blob | null;
      place: { x: number; y: number; width: number; height: number } | null;
    }> => {
      const raster = bgRef.current;
      if (!raster || raster.width <= 0) {
        return { blob: null, place: null };
      }
      const b = raster.bounds;
      const place = { x: b.x, y: b.y, width: b.width, height: b.height };
      // Prefer the live pixel buffer so mirrors / edits stay in the draft.
      const img = imageDataRef.current;
      if (img && img.width > 0 && img.height > 0) {
        try {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          if (ctx) {
            ctx.putImageData(img, 0, 0);
            const blob = await new Promise<Blob | null>((resolve) =>
              c.toBlob(resolve, "image/png"),
            );
            if (blob) return { blob, place };
          }
        } catch {
          /* fall through to URL fetch */
        }
      }
      const url = backgroundUrlRef.current;
      if (!url) return { blob: null, place };
      try {
        const res = await fetch(url);
        return { blob: await res.blob(), place };
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
      const bg = await captureBackgroundBlob();
      const record = {
        items,
        mmPerPx: mmPerPxRef.current > 0 ? mmPerPxRef.current : null,
        stamp: stampRef.current ?? { ...DEFAULT_STAMP },
        stampOwnerId: stampOwnerRef.current?.id ?? null,
        linkSource: linkSourceRef.current,
        bgPlace: bg.place,
        background: bg.blob,
      };
      const tabId = activeSketchIdRef.current;
      try {
        if (!items.length && !bg.blob) {
          if (tabId) await deleteTabDraft(tabId);
          await clearSketchDraft();
        } else if (tabId) {
          await saveTabDraft(tabId, record);
          // Mirror the open tab so a refresh still finds a draft if the index lags.
          await saveSketchDraft(record);
        } else {
          await saveSketchDraft(record);
        }
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
          hole: item.hole,
          widthMm: item.widthMm,
          filled: item.filled,
          stampPlate: item.stampPlate,
          derivedFromId: item.derivedFromId,
          plateFromCutter: item.plateFromCutter,
        });
      }
      if (snap.linkSource !== undefined) linkSourceRef.current = snap.linkSource;
      const ownerId = stampOwnerRef.current?.id;
      stampOwnerRef.current =
        metasRef.current.find((m) => m.id && m.id === ownerId) ?? null;
      for (const m of metasRef.current) {
        if (m.stampPlate) styleStampPlate(m);
        else if (m.role === "feature") styleFeature(m);
        else cutterStroke(m, false);
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
      linkSource?: SketchLinkSource,
    ) => {
      restoreSnapshot({ items, linkSource: linkSource ?? null });
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
          metasRef.current.find((m) => m.stampPlate && m.path.closed) ??
          metasRef.current.find((m) => isCutterShape(m) && m.path.closed) ??
          metasRef.current[metasRef.current.length - 1] ??
          null;
        if (preferClosed) setSelection(preferClosed, true);
      }
      if (metasRef.current.some((m) => m.path.closed)) notifyClosedCurve();
    };

    /** Dense sample so the generated cutter stays smooth. The plate Bézier is untouched. */
    const PLATE_SAMPLE = { flatness: 0.12, minPerCurve: 32, maxPoints: 900 };

    const cutterOutsetPx = () => {
      const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      return (wallMmRef.current / 2 + Math.max(0, gapMmRef.current)) / mm;
    };

    const samplePlatePts = (path: paper.Path) =>
      ensureCcw(samplePathPoints(path, PLATE_SAMPLE));

    /** Annulus from two loops. Subtract so a later filled import cannot collapse it. */
    const makeAnnulus = (
      outerPts: { x: number; y: number }[],
      innerPts: { x: number; y: number }[],
      color: string,
      opacity: number,
    ): paper.Item | null => {
      if (outerPts.length < 3 || innerPts.length < 3) return null;
      const outer = new scope.Path({
        insert: false,
        closed: true,
        fillColor: null,
        strokeColor: null,
        strokeWidth: 0,
      });
      for (const p of outerPts) outer.add(new scope.Point(p.x, p.y));
      outer.closed = true;
      outer.fillColor = null;
      outer.clockwise = true;
      const hole = new scope.Path({
        insert: false,
        closed: true,
        fillColor: null,
        strokeColor: null,
        strokeWidth: 0,
      });
      for (const p of innerPts) hole.add(new scope.Point(p.x, p.y));
      hole.closed = true;
      hole.fillColor = null;
      hole.clockwise = false;
      let ring: paper.Item = outer;
      const cut = outer.subtract(hole, { insert: false });
      if (cut && !cut.isEmpty()) {
        ring = cut;
        if (outer.parent) outer.remove();
        if (hole.parent) hole.remove();
      } else {
        ring = new scope.CompoundPath({
          children: [outer, hole],
          insert: false,
          fillRule: "evenodd",
        });
      }
      ring.fillColor = new scope.Color(color);
      ring.strokeColor = null;
      ring.strokeWidth = 0;
      ring.opacity = opacity;
      ring.locked = true;
      ring.fillRule = "evenodd";
      return ring;
    };

    const ringContains = (path: paper.Path, pt: paper.Point) => {
      if (!path.closed || path.segments.length < 3) return false;
      let inside = false;
      const segs = path.segments;
      for (let i = 0, j = segs.length - 1; i < segs.length; j = i++) {
        const yi = segs[i].point.y;
        const yj = segs[j].point.y;
        const xi = segs[i].point.x;
        const xj = segs[j].point.x;
        if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };

    const applyLoop = (path: paper.Path, loop: { x: number; y: number }[]) => {
      path.removeSegments();
      for (const p of loop) path.add(new scope.Point(p.x, p.y));
      path.closed = true;
    };

    /**
     * Rebuild locked cutters from stamp-plate Béziers.
     * Outset is wall/2 + fit gap, so later slider changes keep the curve on the rim.
     */
    const rebuildDerivedCutters = () => {
      if (
        linkSourceRef.current === "decoupled" ||
        linkSourceRef.current === "cutter"
      ) {
        return;
      }
      for (const plate of [...metasRef.current]) {
        if (plate.plateFromCutter) continue;
        if (!plate.stampPlate || !plate.path.closed || plate.path.segments.length < 3) {
          continue;
        }
        ensureId(plate);
        const pts = samplePlatePts(plate.path);
        // Round joins — miter (limit 8) threw rare spikes at sharp / near-collinear
        // sample corners; the 3D wall already uses Round for the same reason.
        const rawLoop = offsetClosedClipper(pts, cutterOutsetPx(), 0.05);
        if (!rawLoop || rawLoop.length < 3) continue;
        const loop = cleanClosedPolyline(rawLoop);
        if (loop.length < 3) continue;
        let cutter = derivedFor(plate);
        if (!cutter) {
          const path = new scope.Path({
            closed: true,
            strokeCap: "round",
            strokeJoin: "round",
            fillColor: null,
          });
          applyLoop(path, loop);
          cutter = {
            path,
            raw: cloneRaw(path),
            smooth: path.segments.map(() => false),
            lockIndex: 0,
            noSimplify: true,
            derivedFromId: plate.id,
            id: `cut-${plate.id}`,
          };
          metasRef.current.push(cutter);
        } else {
          applyLoop(cutter.path, loop);
          cutter.raw = cloneRaw(cutter.path);
          cutter.smooth = cutter.path.segments.map(() => false);
          cutter.noSimplify = true;
        }
        ensureId(cutter);
        if (!cutter.stampId) cutter.stampId = `stamp-${cutter.id}`;
        plate.stampId = cutter.stampId;
        plate.ownerId = cutter.id;
        cutterStroke(cutter, !!stampOwnerRef.current && stampOwnerRef.current !== cutter);
        cutter.path.locked = true;
        styleStampPlate(plate);
        if (cutter.id && cutter.stampId) {
          for (const f of metasRef.current) {
            if (f.role !== "feature" || f.stampRim) continue;
            if (f.ownerId && f.ownerId !== cutter.id) continue;
            const mid = f.path.bounds.center;
            if (!ringContains(plate.path, mid) && !ringContains(cutter.path, mid)) continue;
            f.ownerId = cutter.id;
            f.stampId = cutter.stampId;
          }
        }
      }
    };

    /** Locked stamp outline inset from each real cutter. One island per cutter. */
    const rebuildDerivedPlates = () => {
      if (linkSourceRef.current !== "cutter") return;
      const inset = cutterOutsetPx();
      const cutters = metasRef.current.filter(
        (m) =>
          isCutterShape(m) &&
          !m.derivedFromId &&
          m.path.closed &&
          m.path.segments.length >= 3,
      );
      const keep = new Set<PathMeta>();
      for (const cutter of cutters) {
        ensureId(cutter);
        if (!cutter.stampId) cutter.stampId = `stamp-${cutter.id}`;
        const pts = samplePathPoints(cutter.path, PLATE_SAMPLE);
        const rawLoop = offsetClosedClipper(pts, -inset, 0.05);
        if (!rawLoop || rawLoop.length < 3) continue;
        const loop = cleanClosedPolyline(rawLoop);
        if (loop.length < 3) continue;
        let plate =
          metasRef.current.find(
            (m) => m.plateFromCutter && m.ownerId === cutter.id,
          ) ?? null;
        if (!plate) {
          const path = new scope.Path({
            closed: true,
            strokeCap: "round",
            strokeJoin: "round",
            fillColor: null,
          });
          applyLoop(path, loop);
          plate = {
            path,
            raw: cloneRaw(path),
            smooth: path.segments.map(() => false),
            lockIndex: 0,
            noSimplify: true,
            stampPlate: true,
            plateFromCutter: true,
            ownerId: cutter.id,
            stampId: cutter.stampId,
          };
          metasRef.current.push(plate);
        } else {
          applyLoop(plate.path, loop);
          plate.raw = cloneRaw(plate.path);
          plate.smooth = plate.path.segments.map(() => false);
          plate.noSimplify = true;
          plate.stampId = cutter.stampId;
        }
        plate.stampPlate = true;
        plate.plateFromCutter = true;
        plate.ownerId = cutter.id;
        styleStampPlate(plate);
        keep.add(plate);
      }
      for (const m of [...metasRef.current]) {
        if (!m.plateFromCutter || keep.has(m)) continue;
        m.path.remove();
        metasRef.current = metasRef.current.filter((x) => x !== m);
      }
    };

    /**
     * Keep an existing link in sync. Does not create a new link — that is only
     * via “Add linked cutter” / “Add linked stamp”.
     */
    const syncLink = () => {
      if (linkSourceRef.current === "decoupled") return;
      const userPlates = metasRef.current.some(
        (m) =>
          m.stampPlate &&
          !m.plateFromCutter &&
          m.path.closed &&
          m.path.segments.length >= 3,
      );
      const hasDerivedPlate = metasRef.current.some((m) => m.plateFromCutter);
      // Recover direction from geometry after draft load if linkSource was missing.
      if (linkSourceRef.current == null) {
        if (userPlates) linkSourceRef.current = "stamp";
        else if (hasDerivedPlate) linkSourceRef.current = "cutter";
      }
      if (linkSourceRef.current === "stamp") {
        rebuildDerivedCutters();
        return;
      }
      if (linkSourceRef.current === "cutter") {
        rebuildDerivedPlates();
      }
    };

    /** Padded rectangle around stamp marks. Used only while no cutter exists. */
    const virtualPlate = (feats: PathMeta[]): Vec2[] | null => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const f of feats) {
        const b = f.path.bounds;
        if (!b || !Number.isFinite(b.x)) continue;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
      if (!Number.isFinite(minX) || maxX - minX < 1e-6) return null;
      const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      const pad = Math.max(4, 2 / mm);
      return [
        { x: minX - pad, y: minY - pad },
        { x: maxX + pad, y: minY - pad },
        { x: maxX + pad, y: maxY + pad },
        { x: minX - pad, y: maxY + pad },
      ];
    };

    let emitTimer: number | null = null;
    /** Every cutter island, plus the stamp plate (real, derived, or virtual). */
    const closedMeshSnapshot = (): {
      pts: Vec2[] | null;
      cutterLoops: Vec2[][];
      outlineLoops: Vec2[][];
      features: StampFeatureIn[] | null;
      outlinePx: Vec2[] | null;
    } => {
      const empty = {
        pts: null,
        cutterLoops: [] as Vec2[][],
        outlineLoops: [] as Vec2[][],
        features: null,
        outlinePx: null,
      };
      const sampleOutline = (path: paper.Path) => {
        const sampled = samplePathPoints(
          path,
          meshSampleOpts(meshQualityRef.current, "outline"),
        );
        return sampled.length >= 3 ? sampled : null;
      };
      const cutterLoops = metasRef.current
        .filter(
          (m) =>
            isCutterShape(m) &&
            m.path.closed &&
            m.path.segments.length >= 3,
        )
        .map((m) => sampleOutline(m.path))
        .filter((l): l is Vec2[] => !!l);
      const userPlates = metasRef.current.filter(
        (m) =>
          m.stampPlate &&
          !m.plateFromCutter &&
          m.path.closed &&
          m.path.segments.length >= 3,
      );
      const derivedPlates = metasRef.current.filter(
        (m) =>
          m.plateFromCutter && m.path.closed && m.path.segments.length >= 3,
      );
      const plateMetas = userPlates.length ? userPlates : derivedPlates;
      const outlineLoops = plateMetas
        .map((m) => samplePlatePts(m.path))
        .filter((l) => l.length >= 3);
      const featMetas = metasRef.current.filter(
        (m) => m.role === "feature" && !m.stampRim && m.path.segments.length >= 2,
      );
      const stampOn =
        featMetas.length > 0 ||
        plateMetas.length > 0 ||
        stampLayerRef.current ||
        metasRef.current.some((m) => isCutterShape(m) && !!m.stampId);
      if (!cutterLoops.length && !stampOn) return empty;
      if (!cutterLoops.length && featMetas.length && !outlineLoops.length) {
        const pad = virtualPlate(featMetas);
        if (pad) outlineLoops.push(pad);
      }
      const features: StampFeatureIn[] | null = stampOn
        ? featMetas.map((m) => ({
            points: samplePathPoints(
              m.path,
              meshSampleOpts(meshQualityRef.current, "feature"),
            ),
            closed: m.path.closed,
            filled: m.filled === true,
            raised: m.raised !== false,
            hole: !!m.hole,
            widthMm: m.widthMm ?? 0.6,
          }))
        : null;
      return {
        pts: cutterLoops[0] ?? null,
        cutterLoops,
        outlineLoops,
        features,
        outlinePx: outlineLoops[0] ?? null,
      };
    };

    const emitClosedNow = () => {
      syncLink();
      const cutters = metasRef.current.filter((m) => isCutterShape(m));
      setHasClosedCurve(
        cutters.some((m) => m.path.closed) ||
          metasRef.current.some((m) => m.stampPlate && m.path.closed),
      );
      setHasCurves(
        cutters.some((m) => m.path.segments.length >= 2) ||
          metasRef.current.some(
            (m) =>
              (m.stampPlate || m.role === "feature") &&
              m.path.segments.length >= 2,
          ),
      );
      const snap = closedMeshSnapshot();
      onClosedRef.current(snap.pts);
      onStampFeaturesRef.current(snap.features, snap.outlinePx);
      onMeshPartsRef.current?.({
        cutterLoops: snap.cutterLoops,
        outlineLoops: snap.outlineLoops,
        features: snap.features,
      });
      const linked =
        linkSourceRef.current === "cutter" || linkSourceRef.current === "stamp";
      setLinkUiRef.current(
        linked ? "linked" : linkSourceRef.current === "decoupled" ? "decoupled" : "off",
      );
      setLinkSourceUiRef.current(
        linked
          ? (linkSourceRef.current as "cutter" | "stamp")
          : null,
      );
    };

    const clearStampRimPreviews = () => {
      for (const it of stampRimPreviewRef.current) it.remove();
      stampRimPreviewRef.current = [];
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
      clearStampRimPreviews();
    };

    /** Gray locked rim for cutters that already have a stamp (cutter-edit mode). */
    const rebuildStampRimPreviews = () => {
      clearStampRimPreviews();
      if (stampOwnerRef.current || outlineModeRef.current === "none") return;
      const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      for (const host of metasRef.current) {
        if (
          host.role === "feature" ||
          host.stampPlate ||
          host.derivedFromId ||
          !host.stampId ||
          !host.path.closed ||
          !host.path.visible ||
          host.path.segments.length < 3
        ) {
          continue;
        }
        const pts = samplePathPoints(host.path, {
          flatness: 0.4,
          minPerCurve: 12,
          maxPoints: 360,
        });
        const loops = stampRimLoopsPx(
          pts,
          wallMmRef.current,
          gapMmRef.current,
          outlineWidthMmRef.current,
          mm,
        );
        if (!loops) continue;
        const outer = new scope.Path({ insert: false, closed: true });
        for (const p of loops.outer) outer.add(new scope.Point(p.x, p.y));
        outer.closed = true;
        outer.fillColor = null;
        outer.clockwise = true;
        const hole = new scope.Path({
          insert: false,
          closed: true,
          fillColor: null,
          strokeColor: null,
          strokeWidth: 0,
        });
        for (const p of loops.inner) hole.add(new scope.Point(p.x, p.y));
        hole.closed = true;
        hole.fillColor = null;
        hole.clockwise = false;
        const fill = new scope.CompoundPath({
          children: [outer, hole],
          fillColor: new scope.Color("#9aa3ab"),
          strokeColor: null,
          strokeWidth: 0,
          opacity: 0.4,
          locked: true,
          fillRule: "evenodd",
        });
        fill.data = { kind: "stamp-rim-preview" };
        fill.sendToBack();
        stampRimPreviewRef.current.push(fill);
      }
      // Stamp-first: the Bézier itself is the rim's outer edge.
      if (outlineModeRef.current === "none") return;
      const mmPlate = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      for (const plate of metasRef.current) {
        if (!plate.stampPlate || !plate.path.closed || !plate.path.visible) continue;
        if (plate.path.segments.length < 3) continue;
        const wPx = Math.max(0.05, outlineWidthMmRef.current) / mmPlate;
        const innerLoop = offsetClosedClipper(samplePlatePts(plate.path), -wPx, 0.05);
        if (!innerLoop || innerLoop.length < 3) continue;
        const outer = plate.path.clone({ insert: false }) as paper.Path;
        outer.fillColor = null;
        outer.strokeColor = null;
        outer.strokeWidth = 0;
        outer.clockwise = true;
        const hole = new scope.Path({
          insert: false,
          closed: true,
          fillColor: null,
          strokeColor: null,
          strokeWidth: 0,
        });
        for (const p of innerLoop) hole.add(new scope.Point(p.x, p.y));
        hole.closed = true;
        hole.fillColor = null;
        hole.clockwise = false;
        const fill = new scope.CompoundPath({
          children: [outer, hole],
          fillColor: new scope.Color("#9aa3ab"),
          strokeColor: null,
          strokeWidth: 0,
          opacity: 0.4,
          locked: true,
          fillRule: "evenodd",
        });
        fill.data = { kind: "stamp-rim-preview" };
        fill.sendToBack();
        stampRimPreviewRef.current.push(fill);
      }
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
          raised: outlineModeRef.current !== "recessed",
          filled: true,
          widthMm: outlineWidthMmRef.current,
        };
        stampRimMetaRef.current = m;
      } else {
        m.path = path;
        m.widthMm = outlineWidthMmRef.current;
        m.filled = true;
        m.raised = outlineModeRef.current !== "recessed";
      }
      return m;
    };

    const outlineRimColor = () =>
      outlineModeRef.current === "recessed" ? "#1e3a8a" : "#7f1d1d";

    /** Every stamp plate island (user boundary or linked inset from a cutter). */
    const resolveStampPlates = (): PathMeta[] => {
      const user = metasRef.current.filter(
        (m) =>
          m.stampPlate &&
          !m.plateFromCutter &&
          m.path.closed &&
          m.path.segments.length >= 3,
      );
      if (user.length) return user;
      return metasRef.current.filter(
        (m) =>
          m.plateFromCutter &&
          m.path.closed &&
          m.path.segments.length >= 3,
      );
    };

    const rebuildStampOutline = () => {
      const keepRim = !!selectedRef.current?.stampRim;
      try {
        scope.currentStyle.fillColor = null;
      } catch {
        /* ignore */
      }
      stampOutlineRef.current?.remove();
      stampOutlineRef.current = null;
      stampRimFillRef.current?.remove();
      stampRimFillRef.current = null;
      if (!stampLayerRef.current && !stampOwnerRef.current) {
        stampRimMetaRef.current = null;
        if (keepRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
        return;
      }
      const plates = resolveStampPlates();
      const owner = stampOwnerRef.current;
      const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
      // Fallback: one virtual plate from the owning cutter when no plate metas yet.
      const loops: { loop: Vec2[]; plate: PathMeta | null }[] = plates.length
        ? plates.map((plate) => ({
            loop: samplePlatePts(plate.path),
            plate,
          }))
        : owner && owner.path.closed && owner.path.segments.length >= 3
          ? [
              {
                loop:
                  offsetClosedClipper(
                    samplePathPoints(owner.path, {
                      flatness: 0.4,
                      minPerCurve: 12,
                      maxPoints: 360,
                    }),
                    -(
                      (wallMmRef.current / 2 + Math.max(0, gapMmRef.current)) /
                      mm
                    ),
                  ) ?? [],
                plate: null,
              },
            ]
          : [];
      const valid = loops.filter((x) => x.loop.length >= 3);
      if (!valid.length) {
        stampRimMetaRef.current = null;
        if (keepRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
        return;
      }

      const rimGroup = new scope.Group();
      rimGroup.data = { kind: "stamp-rim-group" };
      let primaryOutline: paper.Path | null = null;

      for (const { loop, plate } of valid) {
        const path = plate
          ? (plate.path.clone({ insert: false }) as paper.Path)
          : new scope.Path({ insert: false, closed: true, fillColor: null });
        if (!plate) {
          for (const p of loop) path.add(new scope.Point(p.x, p.y));
        }
        path.closed = true;
        path.fillColor = null;
        path.data = { kind: "stamp-outline" };
        path.locked = true;

        if (outlineModeRef.current !== "none") {
          const rimColor = outlineRimColor();
          const wPx = Math.max(0.05, outlineWidthMmRef.current) / mm;
          const innerLoop = offsetClosedClipper(loop, -wPx);
          if (innerLoop && innerLoop.length >= 3) {
            path.strokeColor = null;
            path.strokeWidth = 0;
            path.visible = true;
            const fill = makeAnnulus(loop, innerLoop, rimColor, 0.92);
            if (fill) {
              fill.data = { kind: "stamp-rim" };
              rimGroup.addChild(fill);
            }
          } else {
            path.strokeColor = new scope.Color(rimColor);
            path.strokeWidth = screen(1.6);
            path.dashArray = [];
            path.visible = true;
          }
        } else if (!plate) {
          path.strokeColor = new scope.Color("#455a64");
          path.strokeWidth = screen(1.4);
          path.dashArray = [screen(6), screen(4)];
          path.visible = true;
        } else {
          path.strokeColor = null;
          path.strokeWidth = 0;
          path.visible = false;
        }

        if (!primaryOutline) {
          primaryOutline = path;
          scope.project.activeLayer.addChild(path);
        }
      }

      if (rimGroup.children.length) {
        stampRimFillRef.current = rimGroup;
      } else {
        rimGroup.remove();
        stampRimFillRef.current = null;
      }

      stampOutlineRef.current = primaryOutline;
      if (primaryOutline) {
        ensureStampRimMeta(primaryOutline);
        // Outline is not selectable — clear a stale rim selection.
        if (keepRim || selectedRef.current?.stampRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
      } else {
        stampRimMetaRef.current = null;
        if (keepRim || selectedRef.current?.stampRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
        }
      }
    };

    const rebuildStampMask = () => {
      stampMaskRef.current?.remove();
      stampMaskRef.current = null;
      if (!stampLayerRef.current && !stampOwnerRef.current) return;
      const plates = resolveStampPlates();
      const holes: paper.Path[] = [];
      for (const plate of plates) {
        const hole = plate.path.clone({ insert: false }) as paper.Path;
        hole.visible = true;
        hole.strokeColor = null;
        hole.strokeWidth = 0;
        hole.fillColor = null;
        hole.dashArray = [];
        hole.closed = true;
        hole.clockwise = false;
        holes.push(hole);
      }
      if (!holes.length && stampOutlineRef.current) {
        const hole = stampOutlineRef.current.clone({ insert: false }) as paper.Path;
        hole.visible = true;
        hole.strokeColor = null;
        hole.strokeWidth = 0;
        hole.fillColor = null;
        hole.dashArray = [];
        hole.closed = true;
        hole.clockwise = false;
        holes.push(hole);
      }
      if (!holes.length) return;
      const b = scope.view.bounds.expand(400);
      const frame = new scope.Path.Rectangle(b);
      frame.clockwise = true;
      const mask = new scope.CompoundPath({
        children: [frame, ...holes],
        fillColor: new scope.Color(0.45, 0.48, 0.5, 0.42),
        strokeColor: null,
        locked: true,
        fillRule: "evenodd",
      });
      mask.data = { kind: "stamp-mask" };
      stampMaskRef.current = mask;
    };

    const refreshStampUi = () => {
      const stampLayer = stampLayerRef.current || !!stampOwnerRef.current;
      const layer: "cutter" | "stamp" = stampLayer ? "stamp" : "cutter";
      setActiveLayerRef.current(layer);
      if (lastReportedLayerRef.current !== layer) {
        lastReportedLayerRef.current = layer;
        onActiveLayerChangeRef.current?.(layer);
      }
      setHasStampContentRef.current(
        metasRef.current.some(
          (m) =>
            m.role === "feature" ||
            m.stampPlate ||
            (!!m.stampId && isCutterShape(m)),
        ),
      );
      const sel = selectedRef.current;
      const closedOk = (m: PathMeta) =>
        m.path.closed &&
        m.path.segments.length >= 3 &&
        !m.derivedFromId &&
        !m.plateFromCutter &&
        !m.stampRim;
      const alreadyLinkedCutter =
        !!sel?.stampPlate && !sel.plateFromCutter && !!derivedFor(sel);
      const stampBoundary =
        stampLayer &&
        !!sel &&
        closedOk(sel) &&
        !alreadyLinkedCutter &&
        (sel.role === "feature" ||
          !!sel.stampPlate ||
          (isCutterShape(sel) && !sel.stampId));
      setCanAddLinkedCutterRef.current(!!stampBoundary);

      const plainClosedCutters = metasRef.current.filter(
        (m) =>
          isCutterShape(m) &&
          closedOk(m) &&
          m.path.visible &&
          !(linkSourceRef.current === "cutter" && !!m.stampId),
      );
      const cutterBoundary =
        !stampLayer &&
        ((sel &&
          isCutterShape(sel) &&
          closedOk(sel) &&
          !(linkSourceRef.current === "cutter" && !!sel.stampId)) ||
          plainClosedCutters.length === 1);
      setCanAddLinkedStampRef.current(!!cutterBoundary);
    };

    const refreshFeatureHud = () => {
      const sel = selectedRef.current;
      if (sel?.stampRim) {
        // Outline width is edited in the Fit gap panel, not via selection.
        setFeatureHudRef.current(null);
      } else if (inStampDraw() && sel && sel.role === "feature") {
        setFeatureHudRef.current({
          widthMm: sel.widthMm ?? 0.6,
          raised: sel.raised !== false,
          hole: !!sel.hole,
          filled: sel.filled === true,
          closed: sel.path.closed,
        });
      } else {
        setFeatureHudRef.current(null);
      }
    };

    const syncStampChrome = () => {
      syncLink();
      const stampLayer = stampLayerRef.current || !!stampOwnerRef.current;
      stampLayerRef.current = stampLayer;
      const owner = stampOwnerRef.current;
      for (const m of metasRef.current) {
        ensureId(m);
        if (m.stampPlate) {
          m.path.visible = true;
          styleStampPlate(m, !stampLayer);
          continue;
        }
        if (m.derivedFromId) {
          m.path.visible = true;
          styleDerivedCutter(m, stampLayer);
          continue;
        }
        if (m.role === "feature") {
          m.path.visible = true;
          if (stampLayer) {
            if (owner && m.ownerId && m.ownerId !== owner.id) {
              m.path.visible = false;
              m.path.locked = true;
            } else {
              styleFeature(m);
              m.path.locked = false;
            }
          } else {
            styleFeature(m, true);
            m.path.locked = true;
          }
          continue;
        }
        // Real cutter curves
        m.path.visible = true;
        if (stampLayer) {
          cutterStroke(m, true);
          m.path.locked = true;
        } else {
          cutterStroke(m, false);
          m.path.locked = false;
        }
      }
      if (stampLayer) {
        clearStampRimPreviews();
        rebuildStampOutline();
        rebuildStampMask();
        const mask = stampMaskRef.current;
        const outline = stampOutlineRef.current;
        const owned = metasRef.current.filter((m) => m.role === "feature");
        if (mask) {
          for (const m of owned) m.path.sendToBack();
          mask.sendToBack();
          for (const m of owned) {
            if (!m.hole) m.path.insertBelow(mask);
          }
          for (const m of owned) {
            if (m.hole) m.path.insertBelow(mask);
          }
        } else {
          // Keep later features (new strokes) above earlier filled Area pads.
          for (const m of owned) {
            if (!m.hole) m.path.bringToFront();
          }
          for (const m of owned) {
            if (m.hole) m.path.bringToFront();
          }
        }
        for (const m of metasRef.current) {
          if (m.derivedFromId) m.path.bringToFront();
        }
        outline?.bringToFront();
        stampRimFillRef.current?.bringToFront();
        for (const m of metasRef.current) {
          if (m.stampPlate && !m.plateFromCutter) m.path.bringToFront();
        }
        pinBackdropAndTrace();
      } else {
        // Drop interactive stamp chrome, keep a gray rim preview + gray features
        stampOutlineRef.current?.remove();
        stampOutlineRef.current = null;
        stampRimFillRef.current?.remove();
        stampRimFillRef.current = null;
        stampRimMetaRef.current = null;
        stampMaskRef.current?.remove();
        stampMaskRef.current = null;
        if (selectedRef.current?.stampRim) {
          selectedRef.current = null;
          onHasSelRef.current(false);
          onSimplifySyncRef.current?.(null);
          clearXformGizmos();
        }
        rebuildStampRimPreviews();
        // Gray features under their cutters
        for (const m of metasRef.current) {
          if (m.role === "feature" && m.path.visible && !m.hole) m.path.sendToBack();
        }
        for (const m of metasRef.current) {
          if (m.role === "feature" && m.path.visible && m.hole) m.path.bringToFront();
        }
        for (const rim of stampRimPreviewRef.current) rim.sendToBack();
        for (const m of metasRef.current) {
          if (m.role !== "feature" && m.path.visible) m.path.bringToFront();
        }
        pinBackdropAndTrace();
      }
      refreshStampUi();
      refreshFeatureHud();
      // Outline path is rebuilt on sync — refresh selection chrome
      rebuildEditGizmos();
    };

    const tagFeature = (meta: PathMeta) => {
      const owner = stampOwnerRef.current;
      if (!owner && !stampLayerRef.current) return;
      ensureId(meta);
      meta.role = "feature";
      if (owner) {
        ensureId(owner);
        if (!owner.stampId) owner.stampId = `stamp-${owner.id}`;
        meta.ownerId = owner.id;
        meta.stampId = owner.stampId;
      } else if (!meta.stampId) {
        meta.stampId = "sketch-stamp";
      }
      if (meta.raised == null) meta.raised = true;
      // Drawn / imported stamp curves stay strokes unless Fill was set explicitly.
      if (meta.filled == null) meta.filled = false;
      if (meta.widthMm == null) meta.widthMm = lastWidthMm.current;
      styleFeature(meta);
    };

    const stampBlacks = (raised = true) => {
      if (!inStampDraw()) {
        stampLayerRef.current = true;
        if (modeRef.current !== "edit") onModeChangeRef.current("edit");
        refreshStampUi();
      }
      const img = imageDataRef.current;
      const sz = imageSizeRef.current;
      const raster = bgRef.current;
      if (!img || !sz || !raster?.bounds) {
        void askAlert("No image", "Load an image first.");
        return;
      }
      const blobs = findStampBlobs(img, traceThresholdRef.current, {
        simplifyAmount: traceSmoothRef.current,
        minArea: traceMinAreaRef.current,
      });
      if (!blobs.length) {
        void askAlert("Nothing found", "No black shapes at this threshold.");
        return;
      }
      const b = raster.bounds;
      const toProject = (pts: Contour) =>
        pts.map((p) => ({
          x: b.left + (p.x / sz.w) * b.width,
          y: b.top + (p.y / sz.h) * b.height,
        }));
      // Snapshot fill/width of everything already on the stamp — Apply must not
      // change those. Only the newly imported rings get filled hairlines.
      const prior = metasRef.current.map((m) => ({
        meta: m,
        filled: m.filled === true,
        widthMm: m.widthMm,
      }));
      const addRing = (pts: { x: number; y: number }[], hole: boolean) => {
        if (pts.length < 3) return;
        const path = new scope.Path({
          segments: pts.map((p) => new scope.Point(p.x, p.y)),
          closed: true,
          strokeCap: "round",
          strokeJoin: "round",
          fillColor: null,
        });
        const meta: PathMeta = {
          path,
          raw: cloneRaw(path),
          smooth: path.segments.map(() => false),
          lockIndex: 0,
          noSimplify: true,
          filled: true,
          hole,
          raised: hole ? true : raised,
          widthMm: 0,
        };
        metasRef.current.push(meta);
        tagFeature(meta);
      };
      pushUndo();
      for (const blob of blobs) {
        addRing(toProject(blob.outer), false);
        for (const hole of blob.holes) addRing(toProject(hole), true);
      }
      for (const p of prior) {
        // Re-assert prior fill/width — Apply must not bleed onto existing marks.
        p.meta.filled = p.filled;
        if (p.widthMm != null) p.meta.widthMm = p.widthMm;
        else if (p.meta.role === "feature" && p.meta.widthMm === 0 && !p.filled) {
          p.meta.widthMm = lastWidthMm.current;
        }
        if (p.meta.role === "feature") styleFeature(p.meta);
        else if (p.meta.stampPlate) styleStampPlate(p.meta);
      }
      // Don't leave Paper's currentStyle stuck on the last filled pad.
      try {
        scope.currentStyle.fillColor = null;
      } catch {
        /* ignore */
      }
      clearImageContours();
      setTraceCurveCountRef.current(0);
      syncStampChrome();
      setSelection(null, true);
      syncEmpty();
      emitClosed(true);
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

    const applySelection = (meta: PathMeta | null, emitImmediate = true) => {
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
        selectedPointsRef.current = [];
      }
      selectedRef.current = meta;
      onHasSelRef.current(!!meta || selectedManyRef.current.length > 0);
      onSimplifySyncRef.current?.(
        meta &&
          selectedManyRef.current.length <= 1 &&
          !meta.noSimplify &&
          !meta.stampRim
          ? (meta.simplifyTol ?? 1)
          : null,
      );
      rebuildEditGizmos();
      rebuildMeasureDots();
      emitClosed(emitImmediate);
      refreshStampUi();
      refreshFeatureHud();
    };

    /** Curves that count as the current edit-mode selection. */
    const activeSelection = (): PathMeta[] => {
      const primary = selectedRef.current;
      if (!primary || primary.stampRim) return primary ? [primary] : [];
      const many = selectedManyRef.current.filter(
        (m) => metasRef.current.includes(m) && !m.stampRim && !m.derivedFromId,
      );
      if (many.length > 1 && many.includes(primary)) return many;
      return [primary];
    };

    const setSelection = (meta: PathMeta | null, emitImmediate = true) => {
      selectedManyRef.current = meta ? [meta] : [];
      applySelection(meta, emitImmediate);
    };

    const setMultiSelection = (
      list: PathMeta[],
      primary: PathMeta | null,
      emitImmediate = true,
    ) => {
      const uniq: PathMeta[] = [];
      for (const m of list) {
        if (m && metasRef.current.includes(m) && !uniq.includes(m)) uniq.push(m);
      }
      selectedManyRef.current = uniq;
      const meta =
        primary && uniq.includes(primary)
          ? primary
          : (uniq[uniq.length - 1] ?? null);
      applySelection(meta, emitImmediate);
    };

    /** Curves a click or edit-mode marquee is allowed to select. */
    const selectableCurves = (): PathMeta[] => {
      const owner = stampOwnerRef.current;
      const out: PathMeta[] = [];
      for (const m of metasRef.current) {
        if (
          !m.path.visible ||
          m.path.locked ||
          m.derivedFromId ||
          m.plateFromCutter ||
          m.stampRim
        ) {
          continue;
        }
        if (m.path.segments.length < 2) continue;
        if (stampLayerRef.current || owner) {
          if (m.role === "feature") {
            if (owner && m.ownerId && m.ownerId !== owner.id) continue;
          } else if (m.stampPlate && !m.plateFromCutter) {
            if (owner && m.ownerId && m.ownerId !== owner.id) continue;
          } else {
            continue;
          }
        } else if (m.role === "feature" || m.stampPlate) {
          continue;
        }
        out.push(m);
      }
      return out;
    };

    const boundsInside = (b: paper.Rectangle, box: paper.Rectangle) =>
      b.left >= box.left - 1e-6 &&
      b.right <= box.right + 1e-6 &&
      b.top >= box.top - 1e-6 &&
      b.bottom <= box.bottom + 1e-6;

    /**
     * Left→right (crossing = false): curve bounds fully inside.
     * Right→left (crossing): curve touches the rectangle.
     */
    const curveInMarquee = (
      meta: PathMeta,
      box: paper.Rectangle,
      crossing: boolean,
    ) => {
      const b = meta.path.bounds;
      if (b.width < 1e-6 && b.height < 1e-6) return box.contains(b.center);
      if (!crossing) return boundsInside(b, box);
      if (boundsInside(b, box)) return true;
      if (!b.intersects(box)) return false;
      if (meta.path.segments.some((s) => box.contains(s.point))) return true;
      const probe = new scope.Path.Rectangle(box);
      const hit = meta.path.getIntersections(probe).length > 0;
      const covered =
        !hit &&
        meta.path.closed &&
        [
          probe.bounds.topLeft,
          probe.bounds.topRight,
          probe.bounds.bottomLeft,
          probe.bounds.bottomRight,
        ].some((p) => meta.path.contains(p));
      probe.remove();
      return hit || covered;
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
      if (meta.stampPlate) styleStampPlate(meta);
      else if (meta.role === "feature") styleFeature(meta);
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
      const many = activeSelection().filter(
        (m) => !m.stampRim && !m.derivedFromId,
      );
      if (!many.length) return;
      // Never delete the locked cutter while editing its stamp
      if (
        stampOwnerRef.current &&
        many.every((m) => m.role !== "feature" && !m.stampPlate)
      ) {
        return;
      }
      const targets = many.filter(
        (m) =>
          !(
            stampOwnerRef.current &&
            m.role !== "feature" &&
            !m.stampPlate
          ),
      );
      if (!targets.length) return;
      pushUndo();
      const drop = new Set<PathMeta>();
      for (const meta of targets) {
        if (stampOwnerRef.current === meta) stampOwnerRef.current = null;
        drop.add(meta);
        // Cutter and stamp stay independent: deleting one side only unlocks
        // the linked partner instead of removing it.
        if (meta.stampPlate) {
          const cutter = derivedFor(meta);
          if (cutter) {
            cutter.derivedFromId = undefined;
            cutter.path.locked = false;
            if (stampOwnerRef.current === cutter) stampOwnerRef.current = null;
          }
          if (linkSourceRef.current === "stamp") {
            linkSourceRef.current = "decoupled";
          }
        }
        if (isCutterShape(meta) && meta.id && !meta.stampPlate) {
          for (const m of metasRef.current) {
            if (m.plateFromCutter && m.ownerId === meta.id) {
              m.plateFromCutter = false;
              m.ownerId = undefined;
            } else if (m.role === "feature" && m.ownerId === meta.id) {
              m.ownerId = undefined;
            }
          }
          meta.stampId = undefined;
          if (linkSourceRef.current === "cutter") {
            linkSourceRef.current = "decoupled";
          }
        }
      }
      for (const m of drop) m.path.remove();
      metasRef.current = metasRef.current.filter((m) => !drop.has(m));
      const stampLayer = stampLayerRef.current || !!stampOwnerRef.current;
      const owner = stampOwnerRef.current;
      const next = stampLayer
        ? (metasRef.current.find(
            (m) =>
              m.path.visible &&
              !m.derivedFromId &&
              !m.plateFromCutter &&
              !m.stampRim &&
              (m.role === "feature" || !!m.stampPlate) &&
              (!owner || !m.ownerId || m.ownerId === owner.id),
          ) ?? null)
        : (metasRef.current.find(
            (m) =>
              isCutterShape(m) &&
              !m.derivedFromId &&
              m.path.visible,
          ) ?? null);
      selectedSegmentRef.current = null;
      selectedPointRef.current = null;
      clearCurveHover();
      refreshDrawMarkers();
      syncStampChrome();
      setSelection(next, true);
      notifyMaybeEmpty();
    };

    /** Drop the live sketch. Undo stacks are left for the caller. */
    const wipeSketch = (opts?: { background?: boolean }) => {
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
      stampLayerRef.current = false;
      linkSourceRef.current = null;
      setLinkUiRef.current("off");
      setLinkSourceUiRef.current(null);
      setActiveLayerRef.current("cutter");
      setHasStampContentRef.current(false);
      setCanAddLinkedCutterRef.current(false);
      setCanAddLinkedStampRef.current(false);
      clearStampChrome();
      for (const m of metasRef.current) m.path.remove();
      metasRef.current = [];
      selectedRef.current = null;
      selectedManyRef.current = [];
      onHasSelRef.current(false);
      onSimplifySyncRef.current?.(null);
      clearGizmos();
      clearXformGizmos();
      rebuildEditGizmos();
      refreshFeatureHud();
      refreshStampUi();
      syncEmpty();
      onClosedRef.current(null);
      onStampFeaturesRef.current(null, null);
      onMeshPartsRef.current?.({
        cutterLoops: [],
        outlineLoops: [],
        features: null,
      });
      if (opts?.background !== false) onClearBackgroundRef.current();
      setTraceOpen(false);
      onImagePanelOpenChangeRef.current(false);
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
      wipeSketch();
      onCurvesEmptyRef.current();
      onProjectNameChangeRef.current(DEFAULT_PROJECT_NAME);
      const tabId = activeSketchIdRef.current;
      if (tabId) void deleteTabDraft(tabId);
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
        if (dragRef.current?.kind === "marquee") dragRef.current.rect?.remove();
        dragRef.current = null;
        selectedSegmentRef.current = null;
        selectedPointRef.current = null;
        selectedPointsRef.current = [];
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
          setSelectedPoints([wasFirst ? 0 : meta.path.segments.length - 1]);
        } else {
          setSelectedPoints([]);
        }
        setSelection(meta, true);
      };

      const multi = selectedPointsRef.current;
      if (multi.length > 1 && selectedRef.current) {
        const meta = selectedRef.current;
        const n = meta.path.segments.length;
        const minKeep = meta.path.closed ? 3 : 2;
        const selected = [...new Set(multi)]
          .filter((i) => i >= 0 && i < n)
          .sort((a, b) => a - b);
        const maxDrop = Math.max(0, n - minKeep);
        if (!selected.length || maxDrop === 0) return;
        const dropping =
          selected.length <= maxDrop
            ? selected
            : selected.slice(selected.length - maxDrop);
        const dropped = new Set(dropping);
        pushUndo();
        for (const index of [...dropping].sort((a, b) => b - a)) {
          meta.path.removeSegment(index);
          meta.smooth.splice(index, 1);
        }
        meta.raw = cloneRaw(meta.path);
        hoverNodeRef.current = null;
        selectedSegmentRef.current = null;
        const kept = selected
          .filter((i) => !dropped.has(i))
          .map((i) => i - dropping.filter((d) => d < i).length);
        setSelectedPoints(kept);
        setSelection(meta, true);
        return;
      }
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
      if (surviving.role === "feature" || inStampDraw()) {
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
      if (inStampDraw()) {
        meta.filled = false;
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
      if (inStampDraw()) {
        meta.filled = false;
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

      // Image-trace previews: hover highlight (Curves tab — click to import)
      if (
        traceTabRef.current === "curves" &&
        imagePreviewPaths.some(Boolean)
      ) {
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

      if (modeRef.current === "ellipse") {
        clearSnapPreview();
        clearCurveHover();
        if (ellipseDrag) {
          clearEllipseGuide();
        } else {
          showEllipseGuide(maybeSnap(e.point));
        }
        canvas.style.cursor = "crosshair";
        return;
      }

      if (modeRef.current === "polygon") {
        clearEllipseGuide();
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
        const many = activeSelection();
        if (many.length > 1) {
          const gb = selectionGroupBounds(many);
          const under = pickEditableMeta(e.point);
          if (
            (gb && gb.contains(e.point)) ||
            (under && many.includes(under))
          ) {
            clearCurveHover();
            canvas.style.cursor = "move";
            return;
          }
          if (under) {
            showPathHover(under);
            canvas.style.cursor = "pointer";
            return;
          }
          clearCurveHover();
          canvas.style.cursor = "default";
          return;
        }
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
          paintPointSelection();
          canvas.style.cursor = "pointer";
          return;
        }
        hoverNodeRef.current = null;
        resetGizmoPaint();
        paintPointSelection();
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

      if (
        traceTabRef.current === "curves" &&
        imagePreviewPaths.some(Boolean)
      ) {
        const ci = hitImageContour(e.point);
        if (ci >= 0) {
          importImageContour(ci);
          return;
        }
      }

      if (modeRef.current === "ellipse") {
        clearEllipseGuide();
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
            refreshDrawMarkers();
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
        if (polyBaseCount > 0) rebuildContinueChrome();
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

        const shift = toolShift(e);
        const ctrl = toolCtrlOrMeta(e);
        const under = pickEditableMeta(e.point);
        const many = activeSelection().filter((m) => !m.stampRim);
        if ((shift || ctrl) && under && !under.stampRim && !under.derivedFromId) {
          const cur = many;
          if (ctrl) {
            if (!cur.includes(under)) return;
            const next = cur.filter((m) => m !== under);
            setMultiSelection(
              next,
              meta && next.includes(meta) ? meta : (next[next.length - 1] ?? null),
              false,
            );
          } else {
            const next = cur.includes(under) ? cur : [...cur, under];
            setMultiSelection(next, under, false);
          }
          return;
        }

        // Multi-selection: drag inside the group box (or on any selected curve) moves all
        if (many.length > 1) {
          const gb = selectionGroupBounds(many);
          const onSelected = !!(under && many.includes(under));
          if (onSelected || (gb && gb.contains(e.point))) {
            const primary =
              meta && many.includes(meta) ? meta : (many[many.length - 1] ?? null);
            if (!primary) return;
            const movers = gatherMultiMovers(many);
            dragRef.current = {
              kind: "xform-move",
              meta: primary,
              last: e.point.clone(),
              started: false,
              linked: movers.filter((m) => m !== primary),
              keepMulti: many,
            };
            return;
          }
          if (under) {
            setSelection(under, false);
            return;
          }
          dragRef.current = {
            kind: "select-rect",
            origin: e.point.clone(),
            rect: null,
            shift,
            ctrl,
          };
          return;
        }

        // Transform handles win over a shape underneath (hover already does this).
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
                linked: linkedWithCutter(meta),
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
                linkedStarts: linkedWithCutter(meta).map((m) => ({
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
                linkedStarts: linkedWithCutter(meta).map((m) => ({
                  meta: m,
                  raw: cloneRaw(m.path),
                })),
                started: false,
              };
            }
            return;
          }
        }

        // Prefer a nested / closer curve when not on a transform handle
        if (under && under !== meta) {
          setSelection(under, false);
          return;
        }

        // Click inside the selection box (but not on a handle) keeps selection
        if (meta && selectionPadBounds(meta).contains(e.point)) return;

        const m = under;
        if (m) {
          setSelection(m, false);
          return;
        }
        // Empty press — drag draws the curve marquee. A tiny drag deselects.
        dragRef.current = {
          kind: "select-rect",
          origin: e.point.clone(),
          rect: null,
          shift,
          ctrl,
        };
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
          if (gh.kind === "node") {
            const already = selectedPointsRef.current.includes(gh.g.index);
            const indices = already
              ? [...selectedPointsRef.current]
              : [gh.g.index];
            if (!already) setSelectedPoints(indices);
            dragRef.current = {
              kind: "nodes",
              meta: gh.g.meta,
              indices,
              grabbed: gh.g.index,
              origin: e.point.clone(),
              starts: indices.map((i) =>
                gh.g.meta.path.segments[i].point.clone(),
              ),
              started: false,
            };
            paintPointSelection();
          } else if (gh.kind === "handle-in")
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
            setSelectedPoints([]);
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
          const other = pickEditableMeta(e.point);
          if (other && other !== meta) {
            setSelectedPoints([]);
            setSelection(other, false);
            return;
          }
          // Empty press — drag draws the point marquee
          selectedSegmentRef.current = null;
          dragRef.current = {
            kind: "marquee",
            meta,
            origin: e.point.clone(),
            rect: null,
          };
          return;
        }
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
        fillColor: null,
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
        if (polyBaseCount > 0) rebuildContinueChrome();
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
          if (continueMetaRef.current) rebuildContinueChrome();
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

      if (drag.kind === "select-rect") {
        if (e.point.getDistance(drag.origin) < screen(3)) return;
        drag.rect?.remove();
        const box = new scope.Rectangle(
          Math.min(drag.origin.x, e.point.x),
          Math.min(drag.origin.y, e.point.y),
          Math.abs(e.point.x - drag.origin.x),
          Math.abs(e.point.y - drag.origin.y),
        );
        const crossing = e.point.x < drag.origin.x;
        const rect = new scope.Path.Rectangle(box);
        rect.strokeColor = new scope.Color(crossing ? "#2e7d32" : "#1e88e5");
        rect.strokeWidth = screen(1);
        rect.dashArray = crossing ? [screen(5), screen(4)] : [];
        rect.fillColor = crossing
          ? new scope.Color(0.18, 0.49, 0.2, 0.12)
          : new scope.Color(0.12, 0.53, 0.9, 0.12);
        rect.locked = true;
        rect.bringToFront();
        drag.rect = rect;
        return;
      }
      if (drag.kind === "marquee") {
        if (e.point.getDistance(drag.origin) < screen(3)) return;
        drag.rect?.remove();
        const box = new scope.Rectangle(
          Math.min(drag.origin.x, e.point.x),
          Math.min(drag.origin.y, e.point.y),
          Math.abs(e.point.x - drag.origin.x),
          Math.abs(e.point.y - drag.origin.y),
        );
        const rect = new scope.Path.Rectangle(box);
        rect.strokeColor = new scope.Color("#1e88e5");
        rect.strokeWidth = screen(1);
        rect.dashArray = [screen(5), screen(4)];
        rect.fillColor = new scope.Color(0.12, 0.53, 0.9, 0.12);
        rect.locked = true;
        rect.bringToFront();
        drag.rect = rect;
        return;
      }
      if (drag.kind === "nodes") {
        if (!drag.started) {
          if (e.point.getDistance(drag.origin) < screen(3)) return;
          pushUndo();
          drag.started = true;
          selectedSegmentRef.current = null;
        }
        const grabbedAt = drag.indices.indexOf(drag.grabbed);
        const grabbedStart = drag.starts[grabbedAt] ?? drag.starts[0];
        const delta = maybeSnap(e.point).subtract(grabbedStart);
        for (let k = 0; k < drag.indices.length; k++) {
          const seg = drag.meta.path.segments[drag.indices[k]];
          const start = drag.starts[k];
          if (seg && start) seg.point = start.add(delta);
        }
        const n = drag.meta.path.segments.length;
        const open = !drag.meta.path.closed;
        const only = drag.indices.length === 1 ? drag.indices[0] : -1;
        rebuildEditGizmos();
        if (open && (only === 0 || only === n - 1)) {
          const which = only === 0 ? "first" : "last";
          const hit = findOpenEndNear(e.point, {
            meta: drag.meta,
            which,
          });
          const blue = new Set<number>();
          if (hit) {
            blue.add(only);
            if (hit.meta === drag.meta) {
              blue.add(which === "first" ? n - 1 : 0);
            }
            showMagnet(hit.point);
          } else clearMagnet();
          applyEndpointColors(blue.size ? blue : null);
          paintPointSelection();
        }
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
        if (inStampDraw()) {
          meta.filled = false;
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
            if (
              drag.kind === "xform-move" &&
              drag.keepMulti &&
              drag.keepMulti.length > 1
            ) {
              const still = drag.keepMulti.filter((m) =>
                metasRef.current.includes(m),
              );
              setMultiSelection(still, drag.meta, true);
            } else {
              setSelection(drag.meta, true);
            }
          }
          clearCurveHover();
          return;
        }
        if (drag.kind === "select-rect") {
          drag.rect?.remove();
          const box = new scope.Rectangle(
            Math.min(drag.origin.x, e.point.x),
            Math.min(drag.origin.y, e.point.y),
            Math.abs(e.point.x - drag.origin.x),
            Math.abs(e.point.y - drag.origin.y),
          );
          const tiny = box.width < screen(4) && box.height < screen(4);
          if (tiny) {
            if (!drag.shift && !drag.ctrl) setSelection(null, false);
            return;
          }
          // Left → right: only curves fully inside. Right → left: anything touched.
          const crossing = e.point.x < drag.origin.x;
          const hits = selectableCurves().filter((m) =>
            curveInMarquee(m, box, crossing),
          );
          const cur = activeSelection().filter((m) => !m.stampRim);
          if (drag.ctrl) {
            const drop = new Set(hits);
            const next = cur.filter((m) => !drop.has(m));
            setMultiSelection(next, next[next.length - 1] ?? null, false);
          } else if (drag.shift) {
            const next = [...cur];
            for (const h of hits) if (!next.includes(h)) next.push(h);
            setMultiSelection(next, next[next.length - 1] ?? null, false);
          } else {
            setMultiSelection(hits, hits[hits.length - 1] ?? null, false);
          }
          return;
        }
        if (drag.kind === "marquee") {
          drag.rect?.remove();
          const box = new scope.Rectangle(
            Math.min(drag.origin.x, e.point.x),
            Math.min(drag.origin.y, e.point.y),
            Math.abs(e.point.x - drag.origin.x),
            Math.abs(e.point.y - drag.origin.y),
          );
          const tiny = box.width < screen(4) && box.height < screen(4);
          if (tiny) {
            setSelectedPoints([]);
            selectedSegmentRef.current = null;
            clearCurveHover();
            const other = pickEditableMeta(e.point);
            if (other && other !== drag.meta) setSelection(other, false);
            else setSelection(drag.meta, false);
            return;
          }
          const indices: number[] = [];
          drag.meta.path.segments.forEach((seg, i) => {
            if (box.contains(seg.point)) indices.push(i);
          });
          selectedSegmentRef.current = null;
          setSelectedPoints(indices);
          setSelection(drag.meta, false);
          return;
        }
        if (drag.kind === "nodes") {
          selectedSegmentRef.current = null;
          const meta = drag.meta;
          if (!drag.started) {
            setSelection(meta, false);
            clearMagnet();
            return;
          }
          const n = meta.path.segments.length;
          const only = drag.indices.length === 1 ? drag.indices[0] : -1;
          if (!meta.path.closed && (only === 0 || only === n - 1)) {
            const which = only === 0 ? "first" : "last";
            const hit = findOpenEndNear(e.point, { meta, which });
            if (hit) {
              meta.path.segments[only].point = hit.point.clone();
              setSelectedPoints([]);
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
        const plate = metasRef.current.find(
          (m) =>
            m.stampPlate &&
            m.ownerId === stampOwnerRef.current?.id &&
            (m.path.getNearestLocation(pt)?.distance ?? Infinity) <= screen(8),
        );
        const meta = metasRef.current.find(
          (m) =>
            m.role === "feature" &&
            m.ownerId === stampOwnerRef.current?.id &&
            (m.path.getNearestLocation(pt)?.distance ?? Infinity) <= screen(8),
        );
        if (plate && (!meta || (plate.path.getNearestLocation(pt)?.distance ?? Infinity) <=
          (meta.path.getNearestLocation(pt)?.distance ?? Infinity))) {
          setSelection(plate, false);
          setCtxMenu({ kind: "object", x: ev.clientX, y: ev.clientY, meta: plate });
        } else if (meta) {
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
      // Tool letters (Figma / Illustrator-style). Skip with modifiers.
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat) {
        const letter = ev.key.length === 1 ? ev.key.toLowerCase() : "";
        const toolMode =
          letter === "v"
            ? ("edit" as const)
            : letter === "a"
              ? ("curveEdit" as const)
              : letter === "b"
                ? ("draw" as const)
                : letter === "p"
                  ? ("polygon" as const)
                  : letter === "o"
                    ? ("ellipse" as const)
                    : letter === "m"
                      ? ("measure" as const)
                      : null;
        if (toolMode) {
          onModeChangeRef.current(toolMode);
          ev.preventDefault();
          return;
        }
        if (letter === "i") {
          setTraceOpen(true);
          onImagePanelOpenChangeRef.current(true);
          ev.preventDefault();
          return;
        }
        if (letter === "f") {
          extras.__toggleFeatureFill?.();
          ev.preventDefault();
          return;
        }
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
        (ev.key === "a" || ev.key === "A") &&
        (ev.ctrlKey || ev.metaKey) &&
        !ev.shiftKey &&
        !ev.altKey
      ) {
        extras.__selectAll?.();
        ev.preventDefault();
      }
      if (
        (ev.key === "c" || ev.key === "C") &&
        (ev.ctrlKey || ev.metaKey) &&
        !ev.shiftKey &&
        !ev.altKey &&
        (modeRef.current === "edit" || modeRef.current === "curveEdit")
      ) {
        if (extras.__copyCurve?.()) ev.preventDefault();
      }
      if (
        (ev.key === "Delete" || ev.key === "Backspace") &&
        (modeRef.current === "edit" || modeRef.current === "curveEdit")
      ) {
        extras.__deleteHoverPoint?.();
        ev.preventDefault();
      }
      // Nudge selection: 0.5 mm, Shift = 2 mm, Ctrl/Cmd = 0.05 mm
      if (
        (ev.key === "ArrowLeft" ||
          ev.key === "ArrowRight" ||
          ev.key === "ArrowUp" ||
          ev.key === "ArrowDown") &&
        (modeRef.current === "edit" || modeRef.current === "curveEdit") &&
        !dragRef.current
      ) {
        const meta = selectedRef.current;
        if (
          meta &&
          !meta.stampRim &&
          !meta.derivedFromId &&
          meta.path.segments.length >= 1
        ) {
          const stepMm =
            ev.ctrlKey || ev.metaKey ? 0.05 : ev.shiftKey ? 2 : 0.5;
          const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
          const dx =
            ((ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0) *
              stepMm) /
            mm;
          const dy =
            ((ev.key === "ArrowUp" ? -1 : ev.key === "ArrowDown" ? 1 : 0) *
              stepMm) /
            mm;
          const delta = new scope.Point(dx, dy);

          let pointIndices =
            modeRef.current === "curveEdit"
              ? [...selectedPointsRef.current]
              : [];
          if (
            modeRef.current === "curveEdit" &&
            !pointIndices.length &&
            selectedPointRef.current?.meta === meta
          ) {
            pointIndices = [selectedPointRef.current.index];
          }

          if (!ev.repeat) pushUndo();
          if (pointIndices.length) {
            for (const index of pointIndices) {
              const seg = meta.path.segments[index];
              if (seg) seg.point = seg.point.add(delta);
            }
            meta.raw = cloneRaw(meta.path);
          } else {
            const movers =
              modeRef.current === "edit" && activeSelection().length > 1
                ? activeSelection()
                : [meta];
            const seen = new Set<PathMeta>();
            for (const item of movers) {
              if (seen.has(item)) continue;
              item.path.translate(delta);
              item.raw = cloneRaw(item.path);
              seen.add(item);
              for (const linked of linkedWithCutter(item)) {
                if (seen.has(linked)) continue;
                linked.path.translate(delta);
                linked.raw = cloneRaw(linked.path);
                seen.add(linked);
              }
            }
            syncStampChrome();
            if (movers.length > 1) {
              setMultiSelection(movers, meta, true);
              ev.preventDefault();
              return;
            }
          }
          syncStampChrome();
          setSelection(meta, true);
          ev.preventDefault();
        }
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
      if (
        dragRef.current?.kind === "marquee" ||
        dragRef.current?.kind === "select-rect"
      ) {
        dragRef.current.rect?.remove();
      }
      dragRef.current = null;
      continueMetaRef.current = null;
      polyHandleDragRef.current = null;
      if (polygonRef.current && modeRef.current !== "polygon") {
        polygonRef.current.remove();
        polygonRef.current = null;
      }
      if (modeRef.current !== "polygon") clearPolyPreview();
      if (modeRef.current !== "ellipse") {
        clearEllipseDrag();
        clearEllipseGuide();
      }
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
      refreshStampUi();
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

    extras.__resampleMesh = () => {
      emitClosedNow();
    };

    extras.__emitMesh = () => {
      emitClosedNow();
    };

    extras.__setLayer = (layer: "cutter" | "stamp") => {
      if (layer === "stamp") {
        stampLayerRef.current = true;
        if (modeRef.current !== "edit" && modeRef.current !== "curveEdit") {
          onModeChangeRef.current("edit");
        }
        // Prefer an owning cutter when the link runs cutter → plate.
        if (linkSourceRef.current === "cutter") {
          const host =
            metasRef.current.find(
              (m) =>
                isCutterShape(m) &&
                !m.derivedFromId &&
                m.path.closed &&
                !!m.stampId,
            ) ?? null;
          stampOwnerRef.current = host;
        } else {
          stampOwnerRef.current = null;
        }
        const prefer =
          selectedRef.current &&
          (selectedRef.current.role === "feature" ||
            !!selectedRef.current.stampPlate)
            ? selectedRef.current
            : (metasRef.current.find(
                (m) =>
                  m.stampPlate &&
                  !m.plateFromCutter &&
                  m.path.closed &&
                  m.path.visible,
              ) ??
              metasRef.current.find(
                (m) => m.role === "feature" && m.path.visible,
              ) ??
              metasRef.current.find(
                (m) =>
                  m.plateFromCutter && m.path.closed && m.path.visible,
              ) ??
              null);
        // Selection first so sync/restorePathDisplay cannot un-gray the wrong layer.
        setSelection(prefer, false);
        syncStampChrome();
        refreshStampUi();
        emitClosed(true);
      } else {
        stampLayerRef.current = false;
        stampOwnerRef.current = null;
        const prefer =
          selectedRef.current &&
          isCutterShape(selectedRef.current) &&
          !selectedRef.current.derivedFromId
            ? selectedRef.current
            : (metasRef.current.find(
                (m) =>
                  isCutterShape(m) &&
                  !m.derivedFromId &&
                  m.path.closed &&
                  m.path.visible,
              ) ??
              metasRef.current.find(
                (m) =>
                  isCutterShape(m) &&
                  !!m.derivedFromId &&
                  m.path.closed &&
                  m.path.visible,
              ) ??
              null);
        setSelection(prefer, false);
        syncStampChrome();
        refreshStampUi();
        emitClosed(true);
      }
    };

    /** @deprecated Prefer __setLayer("stamp"). Kept for older call sites. */
    extras.__toggleStamp = () => {
      extras.__setLayer?.(stampLayerRef.current ? "cutter" : "stamp");
    };

    extras.__removeStamp = (meta?: PathMeta) => {
      if (!stampOwnerRef.current && stampLayerRef.current) {
        const drop = metasRef.current.filter(
          (m) => m.role === "feature" || m.plateFromCutter,
        );
        pushUndo();
        for (const m of drop) m.path.remove();
        metasRef.current = metasRef.current.filter((m) => !drop.includes(m));
        stampLayerRef.current = false;
        if (linkSourceRef.current === "cutter") linkSourceRef.current = null;
        syncStampChrome();
        setSelection(null, true);
        return;
      }
      const owner =
        meta && meta.role !== "feature"
          ? meta
          : stampOwnerRef.current ??
            (selectedRef.current?.role !== "feature"
              ? selectedRef.current
              : null);
      // stampPlate is never the stamp owner; derived cutters (Add cutter) can be.
      if (!owner || !owner.stampId || owner.stampPlate) return;
      ensureId(owner);
      pushUndo();
      const ownerId = owner.id!;
      const drop = metasRef.current.filter(
        (m) =>
          (m.role === "feature" &&
            !m.stampRim &&
            (!m.ownerId || m.ownerId === ownerId)) ||
          (m.plateFromCutter && m.ownerId === ownerId),
      );
      for (const m of drop) m.path.remove();
      metasRef.current = metasRef.current.filter((m) => !drop.includes(m));
      owner.stampId = undefined;
      if (
        linkSourceRef.current === "cutter" &&
        !metasRef.current.some((m) => m.stampId || m.plateFromCutter || m.stampPlate)
      ) {
        linkSourceRef.current = null;
      }
      if (stampOwnerRef.current === owner) stampOwnerRef.current = null;
      if (selectedRef.current && drop.includes(selectedRef.current)) {
        selectedRef.current = null;
      }
      selectedSegmentRef.current = null;
      selectedPointRef.current = null;
      clearCurveHover();
      syncStampChrome();
      // Prefer the editable plate when the stamp lived on a derived cutter.
      setSelection(plateFor(owner) ?? owner, true);
      notifyMaybeEmpty();
    };

    extras.__setFeatureWidth = (widthMm: number) => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature") return;
      // Rim outline keeps a real width; feature strokes may be hairline (0).
      const w = m.stampRim
        ? Math.max(0.3, widthMm)
        : widthMm <= 0
          ? 0
          : Math.max(0.3, widthMm);
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
      if (w > 0) lastWidthMm.current = w;
      styleFeature(m);
      refreshFeatureHud();
      rebuildEditGizmos();
      emitClosed(true);
    };

    extras.__setFeatureRaised = (raised: boolean) => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim) return;
      m.hole = false;
      m.raised = raised;
      styleFeature(m);
      syncStampChrome();
      refreshFeatureHud();
      emitClosed(true);
    };

    extras.__setFeatureHole = () => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim) return;
      m.hole = true;
      if (m.path.closed) m.filled = true;
      styleFeature(m);
      syncStampChrome();
      refreshFeatureHud();
      emitClosed(true);
    };

    extras.__toggleFeatureFill = () => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim || !m.path.closed) return;
      extras.__setFeatureFill?.(!m.filled);
    };

    extras.__setFeatureFill = (filled: boolean) => {
      const m = selectedRef.current;
      if (!m || m.role !== "feature" || m.stampRim || !m.path.closed) return;
      if (!!m.filled === !!filled) return;
      pushUndo();
      m.filled = !!filled;
      styleFeature(m);
      // Keep the edited curve above older filled pads so the change is visible.
      if (!m.hole) m.path.bringToFront();
      for (const h of metasRef.current) {
        if (h.role === "feature" && h.hole && h.path.visible) h.path.bringToFront();
      }
      stampMaskRef.current?.bringToFront();
      stampOutlineRef.current?.bringToFront();
      stampRimFillRef.current?.bringToFront();
      for (const p of metasRef.current) {
        if (p.stampPlate && !p.plateFromCutter) p.path.bringToFront();
      }
      // Restack photo + trace previews — bringToFront above buried the image.
      pinBackdropAndTrace();
      rebuildEditGizmos();
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
        for (const f of linkedWithCutter(meta)) {
          f.path.scale(sx, sy, center);
          f.raw = cloneRaw(f.path);
          f.smooth = detectSmoothFlags(f.path);
        }
      }
      syncStampChrome();
      setSelection(meta, true);
    };

    const flipImageDataHorizontal = (src: ImageData): ImageData => {
      const { width, height, data } = src;
      const out = new ImageData(width, height);
      const row = width * 4;
      for (let y = 0; y < height; y++) {
        const rowOff = y * row;
        for (let x = 0; x < width; x++) {
          const si = rowOff + x * 4;
          const di = rowOff + (width - 1 - x) * 4;
          out.data[di] = data[si];
          out.data[di + 1] = data[si + 1];
          out.data[di + 2] = data[si + 2];
          out.data[di + 3] = data[si + 3];
        }
      }
      return out;
    };

    /** Swap raised ↔ recessed on stamp marks; outline raised↔recessed (none stays). */
    extras.__invertStampRelief = () => {
      if (!inStampDraw()) return;
      const features = metasRef.current.filter(
        (m) => m.role === "feature" && !m.stampRim && !m.hole && m.path.visible,
      );
      const mode = outlineModeRef.current;
      const flipOutline = mode === "raised" || mode === "recessed";
      if (!features.length && !flipOutline) return;
      pushUndo();
      for (const m of features) {
        m.raised = m.raised === false;
        styleFeature(m);
      }
      if (flipOutline) {
        const next = mode === "raised" ? "recessed" : "raised";
        outlineModeRef.current = next;
        onOutlineModeChangeRef.current(next);
      }
      syncStampChrome();
      refreshFeatureHud();
      const sel = selectedRef.current;
      if (sel && metasRef.current.includes(sel) && !sel.stampRim) {
        setSelection(sel, true);
      } else {
        emitClosed(true);
      }
    };

    /** Flip the whole sketch horizontally / left↔right. Derived outlines rebuild. */
    extras.__mirrorAllHorizontal = () => {
      const targets = metasRef.current.filter(
        (m) =>
          !m.derivedFromId &&
          !m.plateFromCutter &&
          !m.stampRim &&
          m.path.segments.length >= 2,
      );
      const raster = bgRef.current;
      const hasBg = !!(raster && raster.width > 0);
      if (!targets.length && !hasBg) return;
      pushUndo();
      let bounds: paper.Rectangle | null = null;
      for (const m of targets) {
        const b = m.path.bounds;
        bounds = bounds ? bounds.unite(b) : b.clone();
      }
      if (hasBg && raster) {
        const b = raster.bounds;
        bounds = bounds ? bounds.unite(b) : b.clone();
      }
      if (!bounds) return;
      const center = bounds.center.clone();
      for (const m of targets) {
        m.path.scale(-1, 1, center);
        m.raw = cloneRaw(m.path);
        m.smooth = detectSmoothFlags(m.path);
      }
      if (hasBg && raster) {
        raster.scale(-1, 1, center);
        if (imageDataRef.current) {
          imageDataRef.current = flipImageDataHorizontal(imageDataRef.current);
          if (showBackgroundRef.current) {
            const n = rebuildImageContours(
              traceThresholdRef.current,
              traceSmoothRef.current,
            );
            setTraceCurveCountRef.current(n);
          }
        }
      }
      syncStampChrome();
      const sel = selectedRef.current;
      if (sel && metasRef.current.includes(sel) && !sel.stampRim) {
        setSelection(sel, true);
      } else {
        emitClosed(true);
      }
    };

    /** Grow (positive mm) or shrink (negative) via Clipper2 — not a scale. */
    extras.__offsetClosedByMm = (mm: number) => {
      const meta = selectedRef.current;
      if (
        !meta ||
        meta.stampRim ||
        meta.stampPlate ||
        meta.derivedFromId ||
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

    /** Keep this closed curve as the stamp boundary and build a cutter around it. */
    extras.__addCutterAroundOutline = async () => {
      if (!stampLayerRef.current && !stampOwnerRef.current) {
        extras.__setLayer?.("stamp");
      }
      const sel = selectedRef.current;
      let meta: PathMeta | null = null;
      if (
        sel &&
        sel.path.closed &&
        sel.path.segments.length >= 3 &&
        !sel.derivedFromId &&
        !sel.plateFromCutter &&
        !sel.stampRim &&
        (sel.role === "feature" ||
          !!sel.stampPlate ||
          (isCutterShape(sel) && !sel.stampId))
      ) {
        meta = sel;
      }
      if (!meta) return;
      const loop = offsetClosedClipper(
        samplePlatePts(meta.path),
        cutterOutsetPx(),
        0.05,
      );
      if (!loop || loop.length < 3) return;
      const realCutters = metasRef.current.filter(
        (m) =>
          isCutterShape(m) &&
          !m.derivedFromId &&
          m !== meta &&
          m.path.closed,
      );
      const derivedPlates = metasRef.current.filter((m) => m.plateFromCutter);
      const replacing =
        (linkSourceRef.current === "decoupled" ||
          linkSourceRef.current === "cutter") &&
        (realCutters.length > 0 || derivedPlates.length > 0);
      if (replacing) {
        const ok = await askConfirm(
          "Replace linked cutter?",
          "Replace the current cutter with one linked to this stamp boundary? The old cutter will be removed.",
          "Replace",
        );
        if (!ok) return;
      }
      pushUndo();
      if (replacing) {
        for (const c of realCutters) c.path.remove();
        for (const p of derivedPlates) p.path.remove();
        metasRef.current = metasRef.current.filter(
          (m) => !realCutters.includes(m) && !derivedPlates.includes(m),
        );
      }
      meta.role = undefined;
      meta.plateFromCutter = false;
      meta.derivedFromId = undefined;
      meta.stampPlate = true;
      meta.path.locked = false;
      ensureId(meta);
      linkSourceRef.current = "stamp";
      styleStampPlate(meta);
      syncStampChrome();
      // Stay on stamp so the outline stays editable after linking.
      extras.__setLayer?.("stamp");
      setSelection(meta, true);
      emitClosed(true);
    };

    /** Create linked stamp outline(s) from closed cutter curve(s). */
    extras.__addLinkedStamp = async () => {
      if (stampLayerRef.current || stampOwnerRef.current) {
        extras.__setLayer?.("cutter");
      }
      const sel = selectedRef.current;
      let targets: PathMeta[] = [];
      if (
        sel &&
        isCutterShape(sel) &&
        sel.path.closed &&
        sel.path.segments.length >= 3 &&
        !sel.derivedFromId &&
        !sel.stampPlate
      ) {
        targets = [sel];
      } else {
        const plain = metasRef.current.filter(
          (m) =>
            isCutterShape(m) &&
            !m.derivedFromId &&
            m.path.closed &&
            m.path.segments.length >= 3 &&
            m.path.visible,
        );
        if (plain.length === 1) targets = plain;
      }
      if (!targets.length) return;

      const userPlates = metasRef.current.filter(
        (m) => m.stampPlate && !m.plateFromCutter && m.path.closed,
      );
      const derivedPlates = metasRef.current.filter((m) => m.plateFromCutter);
      const replacing =
        (linkSourceRef.current === "decoupled" ||
          linkSourceRef.current === "stamp") &&
        (userPlates.length > 0 || derivedPlates.length > 0);
      if (replacing) {
        const ok = await askConfirm(
          "Replace linked stamp?",
          "Replace the current stamp outline with one linked to this cutter? The old stamp outline will be removed.",
          "Replace",
        );
        if (!ok) return;
      }
      pushUndo();
      if (replacing) {
        for (const p of [...userPlates, ...derivedPlates]) p.path.remove();
        metasRef.current = metasRef.current.filter(
          (m) => !userPlates.includes(m) && !derivedPlates.includes(m),
        );
        for (const m of metasRef.current) {
          if (m.derivedFromId) {
            m.derivedFromId = undefined;
            m.path.locked = false;
          }
        }
      }
      for (const c of targets) {
        ensureId(c);
        if (!c.stampId) c.stampId = `stamp-${c.id}`;
      }
      linkSourceRef.current = "cutter";
      syncStampChrome();
      // Show the new linked stamp layer.
      extras.__setLayer?.("stamp");
      emitClosed(true);
    };

    extras.__decouple = () => {
      if (
        linkSourceRef.current !== "cutter" &&
        linkSourceRef.current !== "stamp"
      ) {
        return;
      }
      pushUndo();
      for (const m of metasRef.current) {
        if (m.plateFromCutter) {
          m.plateFromCutter = false;
          styleStampPlate(m);
        }
        if (m.derivedFromId) {
          m.derivedFromId = undefined;
          m.path.locked = false;
          cutterStroke(m, false);
        }
      }
      linkSourceRef.current = "decoupled";
      syncStampChrome();
      emitClosed(true);
    };

    extras.__removeCutterAroundOutline = () => {
      const sel = selectedRef.current;
      const plate = sel?.stampPlate
        ? sel
        : sel?.derivedFromId
          ? plateFor(sel)
          : null;
      if (!plate) return;
      pushUndo();
      const cutter = derivedFor(plate);
      if (cutter) {
        if (stampOwnerRef.current === cutter) stampOwnerRef.current = null;
        cutter.path.remove();
        metasRef.current = metasRef.current.filter((m) => m !== cutter);
      }
      // Keep the stamp boundary and its marks; only the linked cutter goes away.
      plate.ownerId = undefined;
      if (linkSourceRef.current === "stamp") linkSourceRef.current = "decoupled";
      styleStampPlate(plate);
      syncStampChrome();
      setSelection(plate, true);
      emitClosed(true);
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

    extras.__stampBlacks = (raised = true) => stampBlacks(raised);

    extras.__selectAll = () => {
      if (modeRef.current !== "edit" && modeRef.current !== "curveEdit") {
        onModeChangeRef.current("edit");
      }
      const list = selectableCurves();
      if (!list.length) {
        setSelection(null, true);
        return;
      }
      setMultiSelection(list, list[list.length - 1] ?? null, true);
    };

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
        if (src?.stampPlate) {
          meta.stampPlate = true;
          styleStampPlate(meta);
        } else if (cls.role === "feature") {
          meta.role = "feature";
          meta.raised = cls.raised;
          meta.hole = !!cls.hole;
          meta.filled = !!src?.filled || !!cls.hole;
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
      const cutters = metas.filter((m) => isCutterShape(m) && m.path.closed);
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
        metas.find((m) => m.stampPlate && m.path.closed) ??
        metas.find((m) => isCutterShape(m) && m.path.closed) ??
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
      if (pending.stampOutlineMode != null) {
        onOutlineModeChangeRef.current(pending.stampOutlineMode);
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
      applyDraftItems(pending.items, pending.stampOwnerId, pending.linkSource);
      draftRestoringRef.current = false;
      if (!pending.quiet) {
        onDraftSavedRef.current?.("Restored sketch from this browser");
      }
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
        // Rim annulus is rebuilt from /StampOutline — skip as a feature path
        // so old PDFs (no rim) and new ones (with rim) both import cleanly.
        if (
          ip.stampRim ||
          classifyStampColor(ip.strokeRgb).stampRim
        ) {
          continue;
        }
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
      const ptsToSegs = (pts: { x: number; y: number }[]): ImportedPath["segments"] =>
        pts.map((p) => ({
          point: { x: p.x, y: p.y },
          handleIn: { x: 0, y: 0 },
          handleOut: { x: 0, y: 0 },
        }));
      const paths: ImportedPath[] = [];
      for (const m of metasRef.current) {
        if (m.path.segments.length < 2) continue;
        if (m.derivedFromId) continue;
        if (m.stampPlate) {
          paths.push({
            closed: m.path.closed,
            segments: toSegs(m),
            role: "cutter",
            stampPlate: true,
            strokeRgb: STAMP_PLATE_RGB,
          });
          continue;
        }
        if (m.role === "feature") {
          const raised = m.raised !== false;
          paths.push({
            closed: m.path.closed,
            segments: toSegs(m),
            role: "feature",
            raised,
            hole: !!m.hole,
            filled: !!m.filled,
            widthMm: m.widthMm ?? 0.6,
            strokeRgb: m.hole
              ? STAMP_HOLE_RGB
              : raised
                ? STAMP_RAISE_RGB
                : STAMP_RECESS_RGB,
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
      // Plate-edge rim (annulus) so PDF matches the canvas / 3D stamp
      if (outlineModeRef.current !== "none") {
        const rimRaised = outlineModeRef.current === "raised";
        const rimRgb = rimRaised ? STAMP_RIM_RGB : STAMP_RECESS_RGB;
        const mm = mmPerPxRef.current > 1e-9 ? mmPerPxRef.current : 1;
        for (const m of metasRef.current) {
          if (
            m.role === "feature" ||
            m.stampPlate ||
            !m.stampId ||
            !m.path.closed ||
            m.path.segments.length < 3
          ) {
            continue;
          }
          if (m.derivedFromId) {
            const plate = plateFor(m);
            if (!plate) continue;
            const outer = samplePlatePts(plate.path);
            const wPx = Math.max(0.05, outlineWidthMmRef.current) / mm;
            const inner = offsetClosedClipper(outer, -wPx, 0.05);
            if (!inner || inner.length < 3) continue;
            paths.push({
              closed: true,
              segments: ptsToSegs(outer),
              holes: [ptsToSegs(inner)],
              role: "feature",
              raised: rimRaised,
              filled: true,
              stampRim: true,
              widthMm: outlineWidthMmRef.current,
              strokeRgb: rimRgb,
              strokePt: 0.05,
            });
            continue;
          }
          const loops = stampRimLoopsPx(
            samplePathPoints(m.path, {
              flatness: 0.4,
              minPerCurve: 12,
              maxPoints: 360,
            }),
            wallMmRef.current,
            gapMmRef.current,
            outlineWidthMmRef.current,
            mm,
          );
          if (!loops) continue;
          paths.push({
            closed: true,
            segments: ptsToSegs(loops.outer),
            holes: [ptsToSegs(loops.inner)],
            role: "feature",
            raised: rimRaised,
            filled: true,
            stampRim: true,
            widthMm: outlineWidthMmRef.current,
            strokeRgb: rimRgb,
            strokePt: 0.05,
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
        stampOutlineMode: outlineModeRef.current,
        stampOutlineWidthMm: outlineWidthMmRef.current,
        projectName: projectNameRef.current,
      });
    };

    const pdfBytesFor = (
      paths: ImportedPath[],
      mm: number | null,
      stamp: StampParams,
      name: string,
      background: SketchPdfBackground | null,
    ): Uint8Array | null => {
      if (!paths.length) return null;
      try {
        return buildSketchPdf(paths, {
          mmPerPx: mm,
          background,
          stampGapMm: stamp.gapMm,
          stampOutlineMode: stamp.outlineMode,
          stampOutlineWidthMm: stamp.outlineWidthMm,
          projectName: name,
        });
      } catch {
        return null;
      }
    };

    /** Sample a stored tab without putting its paths on the visible canvas. */
    const withDraftMetas = <T,>(
      items: SketchDraftItem[],
      stampOwnerId: string | null,
      stamp: StampParams,
      mm: number | null,
      linkSource: SketchLinkSource,
      fn: () => T,
    ): T => {
      const metas: PathMeta[] = [];
      for (const item of items) {
        if (!item.raw || item.raw.length < 2) continue;
        const path = new scope.Path({ insert: false });
        path.closed = item.closed;
        applyRaw(path, item.raw, scope);
        metas.push({
          path,
          raw: item.raw,
          smooth: item.smooth?.length
            ? item.smooth
            : path.segments.map(() => false),
          lockIndex: item.lockIndex ?? 0,
          simplifyTol: item.simplifyTol,
          noSimplify: item.noSimplify,
          id: item.id,
          role: item.role,
          stampId: item.stampId,
          ownerId: item.ownerId,
          raised: item.raised,
          hole: item.hole,
          widthMm: item.widthMm,
          filled: item.filled,
          stampPlate: item.stampPlate,
          derivedFromId: item.derivedFromId,
          plateFromCutter: item.plateFromCutter,
        });
      }
      const prev = {
        metas: metasRef.current,
        stamp: stampRef.current,
        mm: mmPerPxRef.current,
        gap: gapMmRef.current,
        outline: outlineModeRef.current,
        outlineW: outlineWidthMmRef.current,
        sel: selectedRef.current,
        owner: stampOwnerRef.current,
        link: linkSourceRef.current,
        layer: stampLayerRef.current,
      };
      metasRef.current = metas;
      selectedRef.current = null;
      linkSourceRef.current = linkSource ?? null;
      stampLayerRef.current = false;
      const owner = stampOwnerId
        ? (metas.find((m) => m.id === stampOwnerId) ?? null)
        : null;
      stampOwnerRef.current = owner && owner.path.closed ? owner : null;
      stampRef.current = stamp;
      if (mm != null && mm > 0) mmPerPxRef.current = mm;
      gapMmRef.current = stamp.gapMm;
      outlineModeRef.current = stamp.outlineMode;
      outlineWidthMmRef.current = stamp.outlineWidthMm;
      try {
        return fn();
      } finally {
        for (const m of metas) m.path.remove();
        metasRef.current = prev.metas;
        stampRef.current = prev.stamp;
        mmPerPxRef.current = prev.mm;
        gapMmRef.current = prev.gap;
        outlineModeRef.current = prev.outline;
        outlineWidthMmRef.current = prev.outlineW;
        selectedRef.current = prev.sel;
        stampOwnerRef.current = prev.owner;
        linkSourceRef.current = prev.link;
        stampLayerRef.current = prev.layer;
      }
    };

    extras.__collectZipSketches = async () => {
      await flushDraftSave();
      const out: ZipSketchPart[] = [];
      const activeId = activeSketchIdRef.current;
      for (const tab of sketchTabsRef.current) {
        if (tab.id === activeId) {
          syncLink();
          const mesh = closedMeshSnapshot();
          const payload = await buildSketchPdfPayload();
          const stamp = { ...(stampRef.current ?? DEFAULT_STAMP) };
          const mm = mmPerPxRef.current > 0 ? mmPerPxRef.current : null;
          const pdf = payload
            ? pdfBytesFor(
                payload.paths,
                mm,
                stamp,
                projectNameRef.current,
                payload.background,
              )
            : null;
          if (!pdf && !mesh.pts && !mesh.outlinePx) continue;
          out.push({
            name: projectNameRef.current,
            pdf,
            pts: mesh.pts,
            cutterLoops: mesh.cutterLoops,
            outlineLoops: mesh.outlineLoops,
            features: mesh.features,
            stamp,
            outlinePx: mesh.outlinePx,
            mmPerPx: mm,
          });
          continue;
        }
        const draft = await loadTabDraft(tab.id);
        if (!draft || !draft.meta.items.some((it) => it.raw.length >= 2)) {
          continue;
        }
        const captured = withDraftMetas(
          draft.meta.items,
          draft.meta.stampOwnerId,
          draft.meta.stamp,
          draft.meta.mmPerPx,
          draft.meta.linkSource ?? null,
          () => {
            syncLink();
            return {
              paths: collectSketchPaths(),
              mesh: closedMeshSnapshot(),
              mm: mmPerPxRef.current > 0 ? mmPerPxRef.current : null,
            };
          },
        );
        let background: SketchPdfBackground | null = null;
        const place = draft.meta.bgPlace;
        if (
          draft.background &&
          place &&
          place.width > 0 &&
          place.height > 0
        ) {
          const url = URL.createObjectURL(draft.background);
          try {
            const enc = await jpegFromImageUrl(url);
            background = {
              jpeg: enc.jpeg,
              widthPx: enc.width,
              heightPx: enc.height,
              left: place.x,
              top: place.y,
              width: place.width,
              height: place.height,
            };
          } catch {
            background = null;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        const pdf = pdfBytesFor(
          captured.paths,
          captured.mm,
          draft.meta.stamp,
          tab.name,
          background,
        );
        if (!pdf && !captured.mesh.pts && !captured.mesh.outlinePx) continue;
        out.push({
          name: tab.name,
          pdf,
          pts: captured.mesh.pts,
          cutterLoops: captured.mesh.cutterLoops,
          outlineLoops: captured.mesh.outlineLoops,
          features: captured.mesh.features,
          stamp: draft.meta.stamp,
          outlinePx: captured.mesh.outlinePx,
          mmPerPx: captured.mm,
        });
      }
      return out;
    };

    extras.__saveSketchPdf = async () => {
      const payload = await buildSketchPdfPayload();
      if (!payload) {
        void askAlert(
          "Nothing to save",
          "Draw or import a curve first.",
        );
        return;
      }
      void flushDraftSave();
      const names = projectExportNames(projectNameRef.current);
      return downloadSketchPdf(payload.paths, names.pdf, {
        mmPerPx: mmPerPxRef.current,
        background: payload.background,
        stampGapMm: gapMmRef.current,
        stampOutlineMode: outlineModeRef.current,
        stampOutlineWidthMm: outlineWidthMmRef.current,
        projectName: projectNameRef.current,
      });
    };

    type CurveClip = {
      raw: SegSnap[];
      smooth: boolean[];
      closed: boolean;
      noSimplify?: boolean;
      simplifyTol?: number;
      role?: "feature";
      raised?: boolean;
      hole?: boolean;
      widthMm?: number;
      filled?: boolean;
    };
    const curveClip: { current: CurveClip | null } = { current: null };
    const curveClips: { current: CurveClip[] } = { current: [] };
    /** Repeated paste steps the copy so it doesn't sit on the original. */
    let pasteStep = 0;
    /** True until our clipboard write finishes, so a fast Ctrl+V still pastes the curve. */
    let ownCopyPending = false;
    /** One paste uses the in-app copy when writing the clipboard failed. */
    let forceInternalPaste = false;

    const curveToSvg = (paths: paper.Path[]) => {
      const body = paths
        .map((path) => {
          const d = path.pathData.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          return `<path d="${d}"/>`;
        })
        .join("");
      return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" data-cookieshaper="copy">${body}</svg>`;
    };

    const clipOf = (meta: PathMeta): CurveClip => ({
      raw: cloneRaw(meta.path),
      smooth: [...meta.smooth],
      closed: meta.path.closed,
      noSimplify: meta.noSimplify,
      simplifyTol: meta.simplifyTol,
      role: meta.role === "feature" ? "feature" : undefined,
      raised: meta.raised,
      hole: meta.hole,
      widthMm: meta.widthMm,
      filled: meta.filled,
    });

    const extractSvg = (raw: string) => {
      const start = raw.search(/<svg[\s>/]/i);
      if (start < 0) return null;
      const end = raw.toLowerCase().lastIndexOf("</svg>");
      if (end < start) return null;
      return raw.slice(start, end + "</svg>".length);
    };

    const clipboardSvg = (dt: DataTransfer) => {
      const types = Array.from(dt.types);
      const order = [
        "image/svg+xml",
        "image/x-inkscape-svg",
        "text/plain",
        "text/html",
        ...types,
      ];
      const seen = new Set<string>();
      for (const t of order) {
        if (seen.has(t)) continue;
        seen.add(t);
        let data = "";
        try {
          data = dt.getData(t);
        } catch {
          continue;
        }
        const svg = data ? extractSvg(data) : null;
        if (svg) return svg;
      }
      return null;
    };

    const adoptPastedPath = (
      path: paper.Path,
      feature: Pick<CurveClip, "role" | "raised" | "hole" | "widthMm" | "filled"> | null,
    ) => {
      path.strokeCap = "round";
      path.strokeJoin = "round";
      path.strokeScaling = true;
      path.fillColor = null;
      path.opacity = 1;
      const meta: PathMeta = {
        path,
        raw: cloneRaw(path),
        smooth: feature?.role === "feature" ? [] : detectSmoothFlags(path),
        lockIndex: 0,
      };
      if (feature?.role === "feature") {
        meta.smooth = detectSmoothFlags(path);
        meta.raised = feature.raised;
        meta.hole = feature.hole;
        meta.filled = feature.filled;
        meta.widthMm = feature.widthMm;
      }
      metasRef.current.push(meta);
      if (inStampDraw()) tagFeature(meta);
      else if (path.closed) {
        path.strokeColor = new scope.Color("#c45c26");
        path.strokeWidth = 2.2;
      } else {
        path.strokeColor = new scope.Color("#111");
        path.strokeWidth = 1.5;
      }
      return meta;
    };

    const placePathsInView = (paths: paper.Path[]) => {
      const b = pathGroupBounds(paths);
      if (!b) return;
      const view = scope.view.bounds;
      let center = b.center.clone();
      if (b.width > view.width * 0.8 || b.height > view.height * 0.8) {
        const s = Math.min((view.width * 0.7) / b.width, (view.height * 0.7) / b.height);
        if (s > 0 && s < 1) {
          for (const p of paths) p.scale(s, center);
          center = pathGroupBounds(paths)?.center.clone() ?? center;
        }
      }
      const delta = scope.view.center.subtract(center);
      if (delta.length > 0.5) {
        for (const p of paths) p.translate(delta);
      }
    };

    extras.__copyCurve = () => {
      const list = activeSelection().filter(
        (meta) =>
          metasRef.current.includes(meta) &&
          !meta.stampRim &&
          !meta.derivedFromId &&
          meta.path.segments.length >= 2,
      );
      if (!list.length) return false;
      const clips = list.map(clipOf);
      curveClips.current = clips;
      curveClip.current = clips[0] ?? null;
      pasteStep = 0;
      ownCopyPending = true;
      forceInternalPaste = false;
      const svg = curveToSvg(list.map((m) => m.path));
      const write = navigator.clipboard?.writeText?.(svg);
      if (write) {
        void write.then(
          () => {
            ownCopyPending = false;
          },
          () => {
            ownCopyPending = false;
            forceInternalPaste = true;
          },
        );
      } else {
        ownCopyPending = false;
        forceInternalPaste = true;
      }
      return true;
    };

    const pasteClips = (clips: CurveClip[]) => {
      if (!clips.length) return;
      pasteStep += 1;
      const step = new scope.Point(screen(16) * pasteStep, screen(16) * pasteStep);
      pushUndo();
      const made: PathMeta[] = [];
      for (const clip of clips) {
        const path = new scope.Path({
          strokeCap: "round",
          strokeJoin: "round",
          fillColor: null,
        });
        applyRaw(path, clip.raw, scope);
        path.closed = clip.closed;
        path.translate(step);
        const meta = adoptPastedPath(path, clip.role === "feature" ? clip : null);
        meta.smooth = clip.smooth.length ? [...clip.smooth] : detectSmoothFlags(path);
        meta.noSimplify = clip.noSimplify;
        meta.simplifyTol = clip.simplifyTol;
        meta.raw = cloneRaw(path);
        made.push(meta);
      }
      syncStampChrome();
      setMultiSelection(made, made[made.length - 1] ?? null, true);
      syncEmpty();
      if (made.some((m) => m.path.closed)) notifyClosedCurve();
    };

    const pasteSvgMarkup = (svg: string) => {
      const imported = scope.project.importSVG(svg, {
        expandShapes: true,
        applyMatrix: true,
        insert: true,
      }) as paper.Item | null;
      if (!imported) return false;
      const found: paper.Path[] = [];
      collectSvgPaths(imported, found);
      const clean: paper.Path[] = [];
      for (const src of found) {
        if (src.segments.length < 2) continue;
        const world = src.globalMatrix.clone();
        const p = makeSketchPath(
          src.segments.map((seg) => seg.clone()),
          !!src.closed,
        );
        p.transform(world);
        clean.push(p);
      }
      imported.remove();
      if (!clean.length) return false;
      placePathsInView(clean);
      pushUndo();
      const made: PathMeta[] = [];
      for (const p of clean) made.push(adoptPastedPath(p, null));
      syncStampChrome();
      if (made.length) setMultiSelection(made, made[made.length - 1], true);
      syncEmpty();
      if (clean.some((p) => p.closed)) notifyClosedCurve();
      return true;
    };

    const onPaste = (ev: ClipboardEvent) => {
      if (isTypingTarget(ev.target)) return;
      if (modeRef.current !== "edit" && modeRef.current !== "curveEdit") return;
      const svg = ev.clipboardData ? clipboardSvg(ev.clipboardData) : null;
      const foreign = !!svg && !/data-cookieshaper=["']copy["']/.test(svg);
      if (
        (ownCopyPending || forceInternalPaste) &&
        (curveClips.current.length || curveClip.current)
      ) {
        forceInternalPaste = false;
        ev.preventDefault();
        pasteClips(
          curveClips.current.length
            ? curveClips.current
            : curveClip.current
              ? [curveClip.current]
              : [],
        );
        return;
      }
      if (foreign && svg && pasteSvgMarkup(svg)) {
        ev.preventDefault();
        return;
      }
      if (curveClips.current.length || curveClip.current) {
        ev.preventDefault();
        pasteClips(
          curveClips.current.length
            ? curveClips.current
            : curveClip.current
              ? [curveClip.current]
              : [],
        );
      }
    };

    extras.__importVectorFile = async (
      file: File,
      opts?: { preferredName?: string },
    ) => {
      // New tab first — never rename the previous tab from the incoming file.
      if (canvasHasContent()) await openFreshTab();
      const preferred = opts?.preferredName?.trim() || null;
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
          onProjectNameChangeRef.current(
            preferred || projectNameFromFilename(file.name),
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
            stampOutlineMode,
            stampOutlineWidthMm,
            projectName: pdfTitle,
          } = await pathsFromPdfFile(file);
          onProjectNameChangeRef.current(
            preferred || pdfTitle || projectNameFromFilename(file.name),
          );
          const { paths, kept } = pathsFromImported(imported);
          if (!paths.length) throw new Error("No vector paths found in PDF");
          if (stampGapMm != null) onStampGapChangeRef.current(stampGapMm);
          if (stampOutlineMode != null) {
            onOutlineModeChangeRef.current(stampOutlineMode);
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
              stampOutlineMode,
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
        void askAlert(
          "Import failed",
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
    window.addEventListener("paste", onPaste);
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

    const historyByTab = new Map<string, { undo: Snapshot[]; redo: Snapshot[] }>();
    let tabBusy = false;

    const canvasHasContent = () =>
      metasRef.current.some((m) => m.path.segments.length >= 1) ||
      !!drawingRef.current ||
      !!(polygonRef.current && polygonRef.current.segments.length > 0) ||
      !!bgRef.current ||
      !!backgroundUrlRef.current;

    const rememberHistory = () => {
      const id = activeSketchIdRef.current;
      if (!id) return;
      historyByTab.set(id, {
        undo: undoRef.current,
        redo: redoRef.current,
      });
    };

    const adoptHistory = (id: string) => {
      let h = historyByTab.get(id);
      if (!h) {
        h = { undo: [], redo: [] };
        historyByTab.set(id, h);
      }
      undoRef.current = h.undo;
      redoRef.current = h.redo;
      notifyHistory();
    };

    const publishTabs = (tabs: SketchTab[], activeId: string) => {
      activeSketchIdRef.current = activeId;
      sketchTabsRef.current = tabs;
      setSketchTabs(tabs);
      setActiveSketchId(activeId);
      onSketchTabsChangeRef.current?.(tabs, activeId);
    };

    const loadTabIntoCanvas = async (id: string, quiet: boolean) => {
      draftRestoringRef.current = true;
      const draft = await loadTabDraft(id);
      if (scopeRef.current !== scope) return;
      if (!draft) {
        draftRestoringRef.current = false;
        return;
      }
      onStampChangeRef.current(draft.meta.stamp);
      if (draft.meta.mmPerPx != null) onMmPerPxChangeRef.current(draft.meta.mmPerPx);
      if (draft.background) {
        const blobUrl = URL.createObjectURL(draft.background);
        if (draft.meta.bgPlace) bgPlaceRef.current = { ...draft.meta.bgPlace };
        pendingDraftRestoreRef.current = {
          items: draft.meta.items,
          stampOwnerId: draft.meta.stampOwnerId,
          linkSource: draft.meta.linkSource ?? null,
          mmPerPx: draft.meta.mmPerPx,
          quiet,
        };
        onImportBgRef.current(blobUrl);
      } else {
        if (backgroundUrlRef.current || bgRef.current) onClearBackgroundRef.current();
        applyDraftItems(
          draft.meta.items,
          draft.meta.stampOwnerId,
          draft.meta.linkSource ?? null,
        );
        draftRestoringRef.current = false;
        if (!quiet) onDraftSavedRef.current?.("Restored sketch from this browser");
      }
    };

    const openFreshTab = async () => {
      if (tabBusy || !activeSketchIdRef.current) return;
      tabBusy = true;
      try {
        rememberHistory();
        await flushDraftSave();
        const id = newSketchTabId();
        // Keep the previous tab's stored title — do not pull from projectName
        // (import may already have staged a new title in React state).
        const tabs = [
          ...sketchTabsRef.current,
          { id, name: DEFAULT_PROJECT_NAME },
        ];
        await saveSketchTabIndex({ activeId: id, tabs });
        publishTabs(tabs, id);
        adoptHistory(id);
        wipeSketch();
        skipNameSyncRef.current = true;
        onProjectNameChangeRef.current(DEFAULT_PROJECT_NAME);
      } finally {
        tabBusy = false;
      }
    };

    const switchSketchTab = async (id: string) => {
      if (tabBusy || !activeSketchIdRef.current || !id || id === activeSketchIdRef.current) return;
      const target = sketchTabsRef.current.find((t) => t.id === id);
      if (!target) return;
      tabBusy = true;
      try {
        rememberHistory();
        await flushDraftSave();
        const tabs = sketchTabsRef.current.map((t) =>
          t.id === activeSketchIdRef.current
            ? { ...t, name: projectNameRef.current }
            : t,
        );
        await saveSketchTabIndex({ activeId: id, tabs });
        publishTabs(tabs, id);
        adoptHistory(id);
        wipeSketch({ background: false });
        skipNameSyncRef.current = true;
        onProjectNameChangeRef.current(target.name);
        await loadTabIntoCanvas(id, true);
      } finally {
        tabBusy = false;
      }
    };

    const closeTabNow = async (id: string) => {
      const tabs = sketchTabsRef.current;
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      historyByTab.delete(id);
      await deleteTabDraft(id);
      if (tabs.length === 1) {
        const blank = { undo: [] as Snapshot[], redo: [] as Snapshot[] };
        historyByTab.set(id, blank);
        undoRef.current = blank.undo;
        redoRef.current = blank.redo;
        notifyHistory();
        wipeSketch();
        skipNameSyncRef.current = true;
        onProjectNameChangeRef.current(DEFAULT_PROJECT_NAME);
        publishTabs([{ id, name: DEFAULT_PROJECT_NAME }], id);
        await saveSketchTabIndex({
          activeId: id,
          tabs: [{ id, name: DEFAULT_PROJECT_NAME }],
        });
        await clearSketchDraft();
        return;
      }
      const nextTabs = tabs.filter((t) => t.id !== id);
      const next =
        id === activeSketchIdRef.current
          ? (nextTabs[Math.min(idx, nextTabs.length - 1)] ?? nextTabs[0])
          : nextTabs.find((t) => t.id === activeSketchIdRef.current) ?? nextTabs[0];
      await saveSketchTabIndex({ activeId: next.id, tabs: nextTabs });
      if (id !== activeSketchIdRef.current) {
        publishTabs(nextTabs, activeSketchIdRef.current ?? next.id);
        return;
      }
      publishTabs(nextTabs, next.id);
      adoptHistory(next.id);
      wipeSketch({ background: false });
      skipNameSyncRef.current = true;
      onProjectNameChangeRef.current(next.name);
      await loadTabIntoCanvas(next.id, true);
    };

    extras.__openFreshTab = openFreshTab;
    extras.__switchSketchTab = switchSketchTab;
    extras.__confirmCloseTab = async (id: string) => {
      if (tabBusy) return;
      tabBusy = true;
      try {
        await closeTabNow(id);
      } finally {
        tabBusy = false;
      }
    };
    extras.__requestCloseTab = async (id: string) => {
      if (!activeSketchIdRef.current) return;
      const live = id === activeSketchIdRef.current;
      const empty = live ? !canvasHasContent() : !(await loadTabDraft(id));
      if (empty) {
        if (sketchTabsRef.current.length === 1) return;
        await extras.__confirmCloseTab?.(id);
        return;
      }
      if (loadCloseTabConfirmHidden()) {
        await extras.__confirmCloseTab?.(id);
        return;
      }
      const tab = sketchTabsRef.current.find((t) => t.id === id);
      setClosePdfSaved(false);
      setCloseDontAsk(false);
      setCloseSketch(tab ?? { id, name: projectNameRef.current });
    };

    // Restore the open tab (legacy single draft becomes the first tab).
    draftRestoringRef.current = true;
    void (async () => {
      try {
        const index = await ensureSketchTabs(projectNameRef.current);
        if (scopeRef.current !== scope) {
          draftRestoringRef.current = false;
          return;
        }
        publishTabs(index.tabs, index.activeId);
        adoptHistory(index.activeId);
        const active = index.tabs.find((t) => t.id === index.activeId);
        if (active && active.name !== projectNameRef.current) {
          skipNameSyncRef.current = true;
          onProjectNameChangeRef.current(active.name);
        }
        await loadTabIntoCanvas(index.activeId, false);
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
      window.removeEventListener("paste", onPaste);
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
    sketchTabsRef.current = sketchTabs;
    activeSketchIdRef.current = activeSketchId;
    if (skipNameSyncRef.current) {
      skipNameSyncRef.current = false;
      return;
    }
    if (!activeSketchId || sketchTabs.length === 0) return;
    const cur = sketchTabs.find((t) => t.id === activeSketchId);
    if (!cur || cur.name === projectName) return;
    const next = sketchTabs.map((t) =>
      t.id === activeSketchId ? { ...t, name: projectName } : t,
    );
    sketchTabsRef.current = next;
    setSketchTabs(next);
    onSketchTabsChangeRef.current?.(next, activeSketchId);
    void saveSketchTabIndex({ activeId: activeSketchId, tabs: next });
  }, [projectName, activeSketchId, sketchTabs]);

  // Canvas clicks don't move focus — blur the name field so outside click = Enter.
  useEffect(() => {
    if (!nameEditing) return;
    const onPointerDown = (ev: PointerEvent) => {
      const el = nameInputRef.current;
      if (!el) return;
      if (ev.target instanceof Node && el.contains(ev.target)) return;
      el.blur();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [nameEditing]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__setSnapGrid?.();
  }, [snapGrid]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__syncStamp?.();
  }, [
    stampGapMm,
    wallThicknessMm,
    mmPerPx,
    stampOutlineMode,
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
    if (mirrorToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__mirrorAllHorizontal?.();
  }, [mirrorToken]);

  useEffect(() => {
    if (invertReliefToken === 0) return;
    (scopeRef.current as unknown as ScopeExtras | null)?.__invertStampRelief?.();
  }, [invertReliefToken]);

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
      collectZipSketches: async () =>
        (await (
          scopeRef.current as unknown as ScopeExtras | null
        )?.__collectZipSketches?.()) ?? [],
      saveDraft: async () => {
        (scopeRef.current as unknown as ScopeExtras | null)?.__flushDraftSave?.(
          true,
        );
      },
      switchSketchTab: async (id: string) => {
        await (
          scopeRef.current as unknown as ScopeExtras | null
        )?.__switchSketchTab?.(id);
      },
      requestCloseTab: async (id: string) => {
        await (
          scopeRef.current as unknown as ScopeExtras | null
        )?.__requestCloseTab?.(id);
      },
      openFreshTab: async () => {
        await (
          scopeRef.current as unknown as ScopeExtras | null
        )?.__openFreshTab?.();
      },
      openLibrary: () => setExamplesOpen(true),
    };
    return () => {
      saveApiRef.current = null;
    };
  }, [saveApiRef]);

  useEffect(() => {
    if (!saveSketchToken) return;
    void (async () => {
      const result = await (
        scopeRef.current as unknown as ScopeExtras | null
      )?.__saveSketchPdf?.();
      if (result === "saved") onSketchPdfSavedRef.current?.();
    })();
  }, [saveSketchToken]);

  useEffect(() => {
    saveImageTracePrefs({
      threshold: traceThreshold,
      smooth: traceSmooth,
      minArea: traceMinArea,
    });
  }, [traceThreshold, traceSmooth, traceMinArea]);

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
    if (!showBackground) {
      scope.__clearImageContours?.();
      setTraceCurveCount(0);
      return;
    }
    const id = window.setTimeout(() => {
      const n = scope.__rebuildImageContours?.(traceThreshold, traceSmooth);
      if (typeof n === "number") setTraceCurveCount(n);
    }, 60);
    return () => window.clearTimeout(id);
  }, [
    traceThreshold,
    traceSmooth,
    traceMinArea,
    traceOpen,
    showBackground,
    traceTab,
    traceMode,
  ]);

  useEffect(() => {
    (scopeRef.current as unknown as ScopeExtras | null)?.__resampleMesh?.();
  }, [meshQuality]);

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
    if (meta.stampPlate || meta.plateFromCutter) {
      (scope as unknown as ScopeExtras).__syncStamp?.();
    } else if (meta.path.closed) {
      (scope as unknown as ScopeExtras).__emitMesh?.();
    }
  };

  const emitClosedFromMetas = () => {
    const closed =
      (selectedRef.current?.path.closed ? selectedRef.current : null) ??
      metasRef.current.find((m) => m.path.closed) ??
      null;
    if (!closed) {
      (scopeRef.current as unknown as ScopeExtras | null)?.__emitMesh?.();
      return;
    }
    if (closed.stampPlate || closed.derivedFromId || closed.plateFromCutter) {
      (scopeRef.current as unknown as ScopeExtras | null)?.__syncStamp?.();
      return;
    }
    (scopeRef.current as unknown as ScopeExtras | null)?.__emitMesh?.();
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
      if (meta.stampPlate) {
        undoRef.current.pop();
        closeMenu();
        selectedRef.current = meta;
        (scope as unknown as ScopeExtras).__deleteCurrent?.();
        return;
      }
      meta.path.remove();
      metasRef.current = metasRef.current.filter((m) => m !== meta);
      const next = metasRef.current[0] ?? null;
      selectedRef.current = next;
      notifySelectionUi(next);
      closeMenu();
      (scope as unknown as ScopeExtras).__setMode?.();
      if (!next) {
        (scope as unknown as ScopeExtras).__emitMesh?.();
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
      if (meta.stampPlate || meta.plateFromCutter) {
        (scope as unknown as ScopeExtras).__syncStamp?.();
      } else {
        (scope as unknown as ScopeExtras).__emitMesh?.();
      }
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
    if (meta.stampPlate || meta.plateFromCutter) {
      (scope as unknown as ScopeExtras).__syncStamp?.();
    } else if (meta.path.closed) {
      (scope as unknown as ScopeExtras).__emitMesh?.();
    }
  };

  const isFileDrag = (ev: DragEvent) =>
    [...ev.dataTransfer.types].includes("Files");

  const clearFileDragOver = () => {
    fileDragDepthRef.current = 0;
    setFileDragOver(false);
  };

  const onDragEnter = (ev: DragEvent) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragOver(true);
  };

  const onDragOver = (ev: DragEvent) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    if (!fileDragOver) setFileDragOver(true);
  };

  const onDragLeave = (ev: DragEvent) => {
    if (!isFileDrag(ev)) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragOver(false);
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
    clearFileDragOver();
    const file = pickImportableFile(ev.dataTransfer.files);
    if (file) importDroppedOrPickedFile(file);
  };

  // Escape / drop outside the canvas must clear the oven overlay.
  useEffect(() => {
    const clear = () => clearFileDragOver();
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

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

  const saveOpenSketchPdf = async () => {
    if (pdfSaving) return;
    setPdfSaving(true);
    try {
      const result = await (
        scopeRef.current as unknown as ScopeExtras | null
      )?.__saveSketchPdf?.();
      if (result === "saved") onSketchPdfSavedRef.current?.();
    } finally {
      setPdfSaving(false);
    }
  };

  const saveClosingSketchPdf = async () => {
    const id = closeSketch?.id;
    if (!id || pdfSaving || closePdfSaved) return;
    const scope = scopeRef.current as unknown as ScopeExtras | null;
    if (id !== activeSketchId) await scope?.__switchSketchTab?.(id);
    setPdfSaving(true);
    try {
      const result = await scope?.__saveSketchPdf?.();
      if (result === "saved") {
        setClosePdfSaved(true);
        onSketchPdfSavedRef.current?.();
      }
    } finally {
      setPdfSaving(false);
    }
  };

  return (
    <>
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
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
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "stretch" }}>
          <Tooltip
            title="Edit cutter"
            placement="bottom"
            disableInteractive
            slotProps={{
              tooltip: { sx: { pointerEvents: "none", userSelect: "none" } },
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <Button
                size="small"
                variant={activeLayer === "cutter" ? "contained" : "outlined"}
                onClick={() =>
                  (
                    scopeRef.current as unknown as ScopeExtras | null
                  )?.__setLayer?.("cutter")
                }
                startIcon={<PawPrint size={16} strokeWidth={2} />}
                sx={{ textTransform: "none", width: "100%" }}
              >
                Cutter
              </Button>
            </span>
          </Tooltip>
          <Tooltip
            title={hasStampContent ? "Edit stamp" : "Add a stamp"}
            placement="bottom"
            disableInteractive
            slotProps={{
              tooltip: { sx: { pointerEvents: "none", userSelect: "none" } },
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <Button
                size="small"
                variant={activeLayer === "stamp" ? "contained" : "outlined"}
                onClick={() =>
                  (
                    scopeRef.current as unknown as ScopeExtras | null
                  )?.__setLayer?.("stamp")
                }
                startIcon={<Stamp size={16} strokeWidth={2} />}
                sx={{ textTransform: "none", width: "100%" }}
              >
                Stamp
              </Button>
            </span>
          </Tooltip>
        </Box>
        {activeLayer === "cutter" && canAddLinkedStamp && (
          <Tooltip
            title="Build a linked stamp outline inside this cutter. The cutter stays editable; the stamp outline follows wall thickness and fit gap."
            placement="right"
            disableInteractive
            slotProps={{
              tooltip: { sx: { pointerEvents: "none", userSelect: "none" } },
            }}
          >
            <Button
              size="small"
              variant="outlined"
              onClick={() =>
                void (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__addLinkedStamp?.()
              }
              startIcon={<Link size={16} strokeWidth={2} />}
              sx={{ textTransform: "none", width: "100%" }}
            >
              Add linked stamp
            </Button>
          </Tooltip>
        )}
        {activeLayer === "stamp" && canAddLinkedCutter && (
          <Tooltip
            title="Keep this curve as the stamp boundary and build a linked cutter around it. The boundary stays editable; the cutter follows wall thickness and fit gap."
            placement="right"
            disableInteractive
            slotProps={{
              tooltip: { sx: { pointerEvents: "none", userSelect: "none" } },
            }}
          >
            <Button
              size="small"
              variant="outlined"
              onClick={() =>
                void (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__addCutterAroundOutline?.()
              }
              startIcon={<Link size={16} strokeWidth={2} />}
              sx={{ textTransform: "none", width: "100%" }}
            >
              Add linked cutter
            </Button>
          </Tooltip>
        )}
        {linkUi === "linked" &&
          ((linkSourceUi === "cutter" && activeLayer === "stamp") ||
            (linkSourceUi === "stamp" && activeLayer === "cutter")) && (
          <Tooltip
            title="Stop the fit gap from moving the derived outline. Both curves stay, and they will not link again."
            placement="right"
            disableInteractive
            slotProps={{
              tooltip: { sx: { pointerEvents: "none", userSelect: "none" } },
            }}
          >
            <Button
              size="small"
              variant="outlined"
              onClick={() =>
                (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__decouple?.()
              }
              startIcon={<Unlink size={16} strokeWidth={2} />}
              sx={{ textTransform: "none", width: "100%" }}
            >
              Decouple
            </Button>
          </Tooltip>
        )}
        {(linkUi === "linked" || linkUi === "decoupled") && (
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
            <WheelSlider
              size="small"
              min={0}
              max={3}
              step={0.05}
              value={stampGapMm}
              disabled={linkUi === "decoupled"}
              onChange={(_, v) => onStampGapChange(v as number)}
              aria-label="Stamp fit gap"
            />
            <Box component="p" sx={{ m: 0, fontSize: 10, color: "text.secondary", lineHeight: 1.3 }}>
              {linkUi === "decoupled"
                ? "Decoupled — gap no longer moves the outlines"
                : "Inside the wall, plus this clearance"}
            </Box>
            {activeLayer === "stamp" && (
              <>
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    mt: 0.75,
                    mb: 0.35,
                  }}
                >
                  <Box
                    component="span"
                    sx={{ fontSize: 11, color: "text.secondary" }}
                  >
                    Outline
                  </Box>
                </Box>
                <ToggleButtonGroup
                  size="small"
                  color="primary"
                  exclusive
                  fullWidth
                  value={stampOutlineMode}
                  onChange={(_, next: StampOutlineMode | null) => {
                    if (next != null) onStampOutlineModeChange(next);
                  }}
                  aria-label="Stamp outline"
                  sx={{
                    "& .MuiToggleButton-root": {
                      py: 0.35,
                      px: 0.5,
                      minWidth: 0,
                    },
                  }}
                >
                  <ToggleButton value="raised" aria-label="Raised outline">
                    <ArrowBigUp size={16} strokeWidth={1.75} />
                  </ToggleButton>
                  <ToggleButton value="none" aria-label="No outline">
                    <X size={16} strokeWidth={1.75} />
                  </ToggleButton>
                  <ToggleButton value="recessed" aria-label="Recessed outline">
                    <ArrowBigDown size={16} strokeWidth={1.75} />
                  </ToggleButton>
                </ToggleButtonGroup>
                {stampOutlineMode !== "none" && (
                  <Box sx={{ mt: 0.5 }}>
                    <Box
                      sx={{ display: "flex", justifyContent: "space-between" }}
                    >
                      <Box
                        component="span"
                        sx={{ fontSize: 11, color: "text.secondary" }}
                      >
                        Outline width
                      </Box>
                      <Box component="span" sx={{ fontSize: 11 }}>
                        {stampOutlineWidthMm.toFixed(2)} mm
                      </Box>
                    </Box>
                    <WheelSlider
                      size="small"
                      min={0.3}
                      max={6}
                      step={0.05}
                      value={stampOutlineWidthMm}
                      onChange={(_, v) =>
                        onStampOutlineWidthChange(v as number)
                      }
                      aria-label="Stamp outline width"
                    />
                  </Box>
                )}
              </>
            )}
          </Box>
        )}
      </Box>
      {featureHud && activeLayer === "stamp" && !featureHud.rim && (
        <Box
          sx={{
            position: "absolute",
            left: 8,
            bottom: 8,
            zIndex: 4,
            width: 220,
            bgcolor: "rgba(255,255,255,0.94)",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            px: 1,
            py: 0.75,
          }}
        >
          <Box sx={{ display: "flex", gap: 0.5, mb: 0.5 }}>
            <Button
              size="small"
              variant={
                featureHud.raised && !featureHud.hole ? "contained" : "outlined"
              }
              onClick={() =>
                (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__setFeatureRaised?.(true)
              }
              sx={{
                textTransform: "none",
                flex: 1,
                minWidth: 0,
                px: 0.5,
                fontSize: 12,
                bgcolor:
                  featureHud.raised && !featureHud.hole ? "#7f1d1d" : undefined,
              }}
            >
              Raised
            </Button>
            <Button
              size="small"
              variant={
                !featureHud.raised && !featureHud.hole ? "contained" : "outlined"
              }
              onClick={() =>
                (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__setFeatureRaised?.(false)
              }
              sx={{
                textTransform: "none",
                flex: 1,
                minWidth: 0,
                px: 0.5,
                fontSize: 12,
                bgcolor:
                  !featureHud.raised && !featureHud.hole ? "#1e3a8a" : undefined,
              }}
            >
              Recessed
            </Button>
            <Button
              size="small"
              variant={featureHud.hole ? "contained" : "outlined"}
              onClick={() =>
                (
                  scopeRef.current as unknown as ScopeExtras | null
                )?.__setFeatureHole?.()
              }
              sx={{
                textTransform: "none",
                flex: 1,
                minWidth: 0,
                px: 0.5,
                fontSize: 12,
                bgcolor: featureHud.hole ? "#263238" : undefined,
                color: featureHud.hole ? "#fff" : undefined,
              }}
            >
              Hole
            </Button>
          </Box>
          {featureHud.closed && (
            <Tooltip title="Toggle fill (F)" placement="right">
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
                    onChange={(_, checked) =>
                      (
                        scopeRef.current as unknown as ScopeExtras | null
                      )?.__setFeatureFill?.(checked)
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
            </Tooltip>
          )}
          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
            <Box component="span" sx={{ fontSize: 11, color: "text.secondary" }}>
              Line width
            </Box>
            <Box component="span" sx={{ fontSize: 11 }}>
              {featureHud.widthMm <= 0
                ? "hairline"
                : `${featureHud.widthMm.toFixed(2)} mm`}
            </Box>
          </Box>
          <WheelSlider
            size="small"
            min={0}
            max={6}
            step={0.05}
            value={featureHud.widthMm}
            onChange={(_, v) => {
              const prev = featureHud.widthMm;
              let next = v as number;
              // Discrete jump: 0 (hairline) ↔ 0.3 mm, then 0.05 steps.
              if (prev <= 0 && next > 0) next = 0.3;
              else if (prev >= 0.3 && next < 0.3) next = 0;
              else if (next > 0 && next < 0.3) next = 0.3;
              (
                scopeRef.current as unknown as ScopeExtras | null
              )?.__setFeatureWidth?.(next);
            }}
            aria-label="Stamp line width"
          />
        </Box>
      )}
      {/* Project name — top center, same Y as Edit stamp / Add stamp. */}
      {!fileDragOver && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 8,
            transform: "translateX(-50%)",
            zIndex: 3,
            pointerEvents: "none",
            width: "min(52%, 420px)",
            height: 30.75,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <input
            ref={nameInputRef}
            value={projectName}
            aria-label="Cookie name"
            spellCheck={false}
            onChange={(ev) => onProjectNameChange(ev.target.value)}
            onFocus={() => setNameEditing(true)}
            onBlur={() => {
              setNameEditing(false);
              const next = projectDisplayName(projectName);
              if (next !== projectName) onProjectNameChange(next);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                (ev.target as HTMLInputElement).blur();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                (ev.target as HTMLInputElement).blur();
              }
              ev.stopPropagation();
            }}
            onPointerDown={(ev) => ev.stopPropagation()}
            style={{
              pointerEvents: "auto",
              width: "100%",
              height: "100%",
              border: "none",
              outline: nameEditing ? "1px dashed #b0b7be" : "none",
              outlineOffset: 4,
              background: "transparent",
              textAlign: "center",
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: 0.2,
              color: "#b0b7be",
              caretColor: "#78909c",
              padding: "0 8px",
              borderRadius: 4,
              cursor: nameEditing ? "text" : "pointer",
            }}
          />
        </div>
      )}
      {(fileDragOver || (canvasEmpty && !backgroundUrl)) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: fileDragOver ? 16 : 12,
            pointerEvents: "none",
            color: "#9aa0a6",
            fontSize: fileDragOver ? 22 : 15,
            fontWeight: fileDragOver ? 700 : undefined,
            letterSpacing: 0.2,
            userSelect: "none",
            background: fileDragOver ? "rgba(255,255,255,0.72)" : undefined,
            zIndex: fileDragOver ? 6 : undefined,
          }}
        >
          {fileDragOver ? (
            <>
              Drop your cookie into oven!
              <Microwave size={48} strokeWidth={2.25} aria-hidden />
            </>
          ) : (
            "Drop or paste image, SVG or PDF — or start drawing"
          )}
          {!fileDragOver && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setExamplesOpen(true)}
              startIcon={<Library size={16} strokeWidth={2} />}
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
              Browse library
            </Button>
          )}
        </div>
      )}
      <ExamplesDialog
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        onPick={(file: File, ex: SketchExample) => {
          void (
            scopeRef.current as unknown as ScopeExtras | null
          )?.__importVectorFile?.(file, { preferredName: ex.title });
        }}
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
          pdfSaving
            ? "Preparing PDF…"
            : hasClosedCurve
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
            disabled={!hasCurves || pdfSaving}
            onClick={() => {
              void saveOpenSketchPdf();
            }}
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
                bgcolor: hasClosedCurve && pdfSaving ? "#c45c26" : "background.paper",
                color: hasClosedCurve && pdfSaving ? "#fff" : undefined,
                borderColor: hasClosedCurve && pdfSaving ? "#c45c26" : "divider",
                opacity: pdfSaving ? 1 : undefined,
              },
            }}
            aria-label={pdfSaving ? "Preparing PDF" : "Save sketch as PDF"}
          >
            {pdfSaving ? (
              <CircularProgress size={18} thickness={5} color="inherit" />
            ) : (
              <SaveAltIcon fontSize="small" />
            )}
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
            minArea={traceMinArea}
            showBackground={showBackground}
            traceTab={traceTab}
            traceMode={traceMode}
            backgroundOpacity={bgOpacity}
            curveCount={traceCurveCount}
            onThresholdChange={setTraceThreshold}
            onSmoothChange={setTraceSmooth}
            onMinAreaChange={setTraceMinArea}
            onShowBackgroundChange={setShowBackground}
            onTraceTabChange={setTraceTab}
            onTraceModeChange={setTraceMode}
            onBackgroundOpacityChange={setBgOpacity}
            onLoadImage={(url) => onImportBgRef.current(url)}
            onLoadFile={importDroppedOrPickedFile}
            onApplyAreas={(raised) => {
              (
                scopeRef.current as unknown as ScopeExtras | null
              )?.__stampBlacks?.(raised);
            }}
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
                const raised = ctxMenu.meta.hole || ctxMenu.meta.raised === false;
                closeMenu();
                (scopeRef.current as unknown as ScopeExtras | null)?.__setFeatureRaised?.(
                  raised,
                );
              }}
            >
              <ListItemText
                primary={
                  ctxMenu.meta.hole || ctxMenu.meta.raised === false
                    ? "Make raised"
                    : "Make recessed"
                }
              />
            </MenuItem>
            {!ctxMenu.meta.hole && (
              <MenuItem
                onClick={() => {
                  closeMenu();
                  (scopeRef.current as unknown as ScopeExtras | null)?.__setFeatureHole?.();
                }}
              >
                <ListItemText primary="Make hole" />
              </MenuItem>
            )}
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
            {activeLayer === "stamp" &&
              ctxMenu.meta.path.closed &&
              !ctxMenu.meta.derivedFromId &&
              !ctxMenu.meta.plateFromCutter &&
              !ctxMenu.meta.stampRim && (
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    void (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__addCutterAroundOutline?.();
                  }}
                >
                  <ListItemText primary="Add linked cutter" />
                </MenuItem>
              )}
            {activeLayer === "cutter" &&
              ctxMenu.meta.path.closed &&
              !ctxMenu.meta.derivedFromId &&
              !ctxMenu.meta.stampPlate &&
              !ctxMenu.meta.stampRim &&
              ctxMenu.meta.role !== "feature" &&
              !(linkUi === "linked" && linkSourceUi === "cutter" && !!ctxMenu.meta.stampId) && (
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    void (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__addLinkedStamp?.();
                  }}
                >
                  <ListItemText primary="Add linked stamp" />
                </MenuItem>
              )}
            {ctxMenu.meta.stampPlate && (
              <MenuItem
                onClick={() => {
                  closeMenu();
                  (
                    scopeRef.current as unknown as ScopeExtras | null
                  )?.__removeCutterAroundOutline?.();
                }}
              >
                <ListItemText primary="Remove cutter" />
              </MenuItem>
            )}
            {ctxMenu.meta.path.closed && !ctxMenu.meta.stampPlate && (
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
                {!!ctxMenu.meta.stampId && !ctxMenu.meta.derivedFromId && (
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      (
                        scopeRef.current as unknown as ScopeExtras | null
                      )?.__removeStamp?.(ctxMenu.meta);
                    }}
                  >
                    <ListItemText primary="Remove stamp" />
                  </MenuItem>
                )}
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
            {activeLayer === "stamp" &&
              ctxMenu.meta.path.closed &&
              !ctxMenu.meta.derivedFromId &&
              !ctxMenu.meta.plateFromCutter &&
              !ctxMenu.meta.stampRim && (
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    void (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__addCutterAroundOutline?.();
                  }}
                >
                  <ListItemText primary="Add linked cutter" />
                </MenuItem>
              )}
            {activeLayer === "cutter" &&
              ctxMenu.meta.path.closed &&
              !ctxMenu.meta.derivedFromId &&
              !ctxMenu.meta.stampPlate &&
              !ctxMenu.meta.stampRim &&
              ctxMenu.meta.role !== "feature" &&
              !(linkUi === "linked" && linkSourceUi === "cutter" && !!ctxMenu.meta.stampId) && (
                <MenuItem
                  onClick={() => {
                    closeMenu();
                    void (
                      scopeRef.current as unknown as ScopeExtras | null
                    )?.__addLinkedStamp?.();
                  }}
                >
                  <ListItemText primary="Add linked stamp" />
                </MenuItem>
              )}
            {ctxMenu.meta.stampPlate && (
              <MenuItem
                onClick={() => {
                  closeMenu();
                  (
                    scopeRef.current as unknown as ScopeExtras | null
                  )?.__removeCutterAroundOutline?.();
                }}
              >
                <ListItemText primary="Remove cutter" />
              </MenuItem>
            )}
            {ctxMenu.meta.path.closed && !ctxMenu.meta.stampPlate && (
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
                {!!ctxMenu.meta.stampId && !ctxMenu.meta.derivedFromId && (
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      (
                        scopeRef.current as unknown as ScopeExtras | null
                      )?.__removeStamp?.(ctxMenu.meta);
                    }}
                  >
                    <ListItemText primary="Remove stamp" />
                  </MenuItem>
                )}
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
    <Dialog
      open={!!closeSketch}
      onClose={() => {
        setCloseSketch(null);
        setClosePdfSaved(false);
        setCloseDontAsk(false);
      }}
      maxWidth="xs"
      fullWidth
    >
      <DialogContent sx={{ pt: 2.5, pb: 1 }}>
        <Box sx={{ fontSize: 16, fontWeight: 600 }}>
          Delete “{closeSketch?.name}”?
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ fontSize: 13, color: "text.secondary", lineHeight: 1.45 }}>
          Save the sketch as PDF if you want to edit it later.
        </Box>
      </DialogContent>
      <DialogActions
        sx={{
          px: 2,
          pb: 1.5,
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Button
          variant={closePdfSaved ? "outlined" : "contained"}
          disabled={pdfSaving}
          onClick={() => {
            void saveClosingSketchPdf();
          }}
          startIcon={
            pdfSaving ? (
              <CircularProgress size={18} thickness={5} color="inherit" />
            ) : closePdfSaved ? (
              <SquareCheckBig size={18} strokeWidth={2} />
            ) : (
              <SaveAltIcon fontSize="small" />
            )
          }
          sx={{ textTransform: "none", height: 36.5 }}
        >
          {pdfSaving
            ? "Preparing PDF…"
            : closePdfSaved
              ? "Sketch PDF saved"
              : "Save sketch PDF"}
        </Button>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          <Button
            onClick={() => {
              setCloseSketch(null);
              setClosePdfSaved(false);
              setCloseDontAsk(false);
            }}
            sx={{ textTransform: "none", height: 36.5 }}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const id = closeSketch?.id;
              if (closeDontAsk) saveCloseTabConfirmHidden(true);
              setCloseSketch(null);
              setClosePdfSaved(false);
              setCloseDontAsk(false);
              if (!id) return;
              void (
                scopeRef.current as unknown as ScopeExtras | null
              )?.__confirmCloseTab?.(id);
            }}
            sx={{ textTransform: "none", height: 36.5 }}
          >
            Delete
          </Button>
        </Box>
      </DialogActions>
      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderTop: 1,
          borderColor: "divider",
          bgcolor: "action.hover",
        }}
      >
        <FormControlLabel
          sx={{ mx: 0, alignItems: "center" }}
          control={
            <Checkbox
              size="small"
              checked={closeDontAsk}
              onChange={(_, v) => setCloseDontAsk(v)}
            />
          }
          label={
            <Box
              component="span"
              sx={{ fontSize: 12, color: "text.disabled", lineHeight: 1.35 }}
            >
              Do not show this message again
            </Box>
          }
        />
      </Box>
    </Dialog>
    <Dialog
      open={!!appDialog}
      onClose={() => {
        const d = appDialog;
        setAppDialog(null);
        d?.resolve(false);
      }}
      maxWidth="xs"
      fullWidth
    >
      <DialogContent sx={{ pt: 2.5, pb: 1 }}>
        <Box sx={{ fontSize: 16, fontWeight: 600 }}>{appDialog?.title}</Box>
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ fontSize: 13, color: "text.secondary", lineHeight: 1.45 }}>
          {appDialog?.message}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 1.5, gap: 1 }}>
        {appDialog?.cancelLabel != null && (
          <Button
            onClick={() => {
              const d = appDialog;
              setAppDialog(null);
              d?.resolve(false);
            }}
            sx={{ textTransform: "none", height: 36.5 }}
          >
            {appDialog.cancelLabel}
          </Button>
        )}
        <Button
          variant="contained"
          onClick={() => {
            const d = appDialog;
            setAppDialog(null);
            d?.resolve(true);
          }}
          sx={{ textTransform: "none", height: 36.5 }}
        >
          {appDialog?.confirmLabel ?? "OK"}
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
}
