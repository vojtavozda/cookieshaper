export type Vec2 = { x: number; y: number };

export type CutterParams = {
  /**
   * Overall size in mm: longer side of the outline bounding box.
   * Aspect ratio of the drawing is preserved.
   */
  sizeMm: number;
  /**
   * Flange outer radius from the midline (contour).
   * UI shows overhang past the outer wall: rimWidthMm − wallThickness/2.
   */
  rimWidthMm: number;
  /** Flange / base thickness */
  baseHeightMm: number;
  wallThicknessMm: number;
  /** Rectangular wall height (below knife) */
  wallHeightMm: number;
  /** Concave fillet between flange top and outer wall face */
  filletRadiusMm: number;
  /** Slice height for stacked / Clipper2 bevel (mm) */
  bevelLayerMm: number;
  /** Triangular tip height on top of the wall */
  knifeHeightMm: number;
};

export const DEFAULT_PARAMS: CutterParams = {
  sizeMm: 80,
  rimWidthMm: 4,
  baseHeightMm: 1.2,
  wallThicknessMm: 1,
  wallHeightMm: 12,
  filletRadiusMm: 3,
  bevelLayerMm: 0.2,
  knifeHeightMm: 1,
};

export type SizeReadout = { widthMm: number; heightMm: number };

/** One drawn mark on a stamp (paper-space points). */
export type StampFeatureIn = {
  points: Vec2[];
  closed: boolean;
  filled: boolean;
  raised: boolean;
  widthMm: number;
};

export type StampParams = {
  gapMm: number;
  plateMm: number;
  raiseMm: number;
  recessMm: number;
};

export const DEFAULT_STAMP: StampParams = {
  gapMm: 0.5,
  plateMm: 4,
  raiseMm: 0.8,
  recessMm: 0.5,
};

/** How the 3D cutter solid is built. */
export type BuildMethod = "current" | "stacked" | "clipper2";

export const BUILD_METHODS: { id: BuildMethod; label: string }[] = [
  { id: "current", label: "Current bevel" },
  { id: "stacked", label: "Stacked layers" },
  { id: "clipper2", label: "Clipper2" },
];
