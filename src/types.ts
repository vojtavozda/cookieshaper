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
  /**
   * Flat width at the top of the knife (mm). Avoids a razor point that
   * collapses into stacked single-line walls in the slicer. Clamped to wall thickness.
   */
  knifeTipMm: number;
};

export const DEFAULT_PARAMS: CutterParams = {
  sizeMm: 80,
  rimWidthMm: 4,
  baseHeightMm: 3,
  wallThicknessMm: 0.8,
  wallHeightMm: 12,
  filletRadiusMm: 2,
  bevelLayerMm: 0.2,
  knifeHeightMm: 0.8,
  knifeTipMm: 0.3,
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
  /** Raised rim following the stamp plate edge (inward from fit gap). */
  outlineEnabled: boolean;
  /** Inward thickness of that rim (mm). */
  outlineWidthMm: number;
};

export const DEFAULT_STAMP: StampParams = {
  gapMm: 0.5,
  plateMm: 3,
  raiseMm: 2,
  recessMm: 1,
  outlineEnabled: true,
  outlineWidthMm: 0.6,
};

/**
 * Full cutter + stamp presets (like the old reset-to-defaults).
 * Base width in the UI is flange overhang past the outer wall
 * (rimWidthMm − wallThickness/2).
 */
export type ThicknessPresetId = "draft" | "standard" | "sturdy";

export type ThicknessPreset = {
  id: ThicknessPresetId;
  label: string;
  hint: string;
  params: CutterParams;
  stamp: StampParams;
};

function makePreset(opts: {
  baseHeightMm: number;
  /** Flange overhang past outer wall (UI “Base width”). */
  baseWidthMm: number;
  wallThicknessMm: number;
  filletRadiusMm: number;
  knifeHeightMm: number;
  knifeTipMm: number;
  /** Overall cutter height including the knife (UI “Height”). */
  overallHeightMm: number;
}): { params: CutterParams; stamp: StampParams } {
  const {
    baseHeightMm,
    baseWidthMm,
    wallThicknessMm,
    filletRadiusMm,
    knifeHeightMm,
    knifeTipMm,
    overallHeightMm,
  } = opts;
  return {
    params: {
      ...DEFAULT_PARAMS,
      baseHeightMm,
      wallThicknessMm,
      rimWidthMm: baseWidthMm + wallThicknessMm / 2,
      filletRadiusMm,
      knifeHeightMm,
      knifeTipMm,
      // Stored wall is the straight section under the knife.
      wallHeightMm: Math.max(0, overallHeightMm - knifeHeightMm),
    },
    stamp: {
      ...DEFAULT_STAMP,
      plateMm: baseHeightMm,
      recessMm: Math.min(DEFAULT_STAMP.recessMm, baseHeightMm),
    },
  };
}

export const THICKNESS_PRESETS: ThicknessPreset[] = [
  {
    id: "draft",
    label: "Draft",
    hint: "1.8 mm base/plate, 0.8 mm wall, no bevel or knife — quick printer drafts",
    ...makePreset({
      baseHeightMm: 1.8,
      baseWidthMm: 1,
      wallThicknessMm: 0.8,
      filletRadiusMm: 0,
      knifeHeightMm: 0,
      knifeTipMm: 0,
      overallHeightMm: 12,
    }),
  },
  {
    id: "standard",
    label: "Standard",
    hint: "2.4 mm base/plate, 0.8 mm wall, 1 mm bevel, 1 mm knife — everyday use",
    ...makePreset({
      baseHeightMm: 2.4,
      baseWidthMm: 2.6,
      wallThicknessMm: 0.8,
      filletRadiusMm: 1,
      knifeHeightMm: 1,
      knifeTipMm: 0,
      overallHeightMm: 12,
    }),
  },
  {
    id: "sturdy",
    label: "Sturdy",
    hint: "3 mm base/plate, 1.2 mm wall, 2 mm bevel, 1.2 mm knife — extra durability",
    ...makePreset({
      baseHeightMm: 3,
      baseWidthMm: 3.4,
      wallThicknessMm: 1.2,
      filletRadiusMm: 2,
      knifeHeightMm: 1.2,
      knifeTipMm: 0.3,
      overallHeightMm: 12,
    }),
  },
];

function nearlyEq(a: number, b: number) {
  return Math.abs(a - b) < 1e-6;
}

/** True when cutter + stamp match a preset (sizeMm ignored — drawing-driven). */
export function matchesThicknessPreset(
  preset: ThicknessPreset,
  params: CutterParams,
  stamp: StampParams | null,
): boolean {
  const p = preset.params;
  const cutterOk =
    nearlyEq(params.rimWidthMm, p.rimWidthMm) &&
    nearlyEq(params.baseHeightMm, p.baseHeightMm) &&
    nearlyEq(params.wallThicknessMm, p.wallThicknessMm) &&
    nearlyEq(params.wallHeightMm, p.wallHeightMm) &&
    nearlyEq(params.filletRadiusMm, p.filletRadiusMm) &&
    nearlyEq(params.bevelLayerMm, p.bevelLayerMm) &&
    nearlyEq(params.knifeHeightMm, p.knifeHeightMm) &&
    nearlyEq(params.knifeTipMm, p.knifeTipMm);
  if (!cutterOk) return false;
  if (!stamp) return nearlyEq(params.baseHeightMm, preset.stamp.plateMm);
  const s = preset.stamp;
  return (
    nearlyEq(stamp.gapMm, s.gapMm) &&
    nearlyEq(stamp.plateMm, s.plateMm) &&
    nearlyEq(stamp.raiseMm, s.raiseMm) &&
    nearlyEq(stamp.recessMm, s.recessMm) &&
    stamp.outlineEnabled === s.outlineEnabled &&
    nearlyEq(stamp.outlineWidthMm, s.outlineWidthMm)
  );
}

/** Wall-profile overlay on the 3D view. */
export type WallProfileMode = "hidden" | "large";

/** How the 3D cutter solid is built. */
export type BuildMethod = "current" | "stacked" | "clipper2";

export const BUILD_METHODS: { id: BuildMethod; label: string }[] = [
  { id: "current", label: "Current bevel" },
  { id: "stacked", label: "Stacked layers" },
  { id: "clipper2", label: "Clipper2" },
];
