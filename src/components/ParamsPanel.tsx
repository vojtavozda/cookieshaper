import {
  Box,
  Button,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import UndoIcon from "@mui/icons-material/Undo";
import { PictureInPicture2, X } from "lucide-react";
import {
  BUILD_METHODS,
  THICKNESS_PRESETS,
  matchesThicknessPreset,
  type BuildMethod,
  type CutterParams,
  type SizeReadout,
  type StampParams,
  type ThicknessPresetId,
  type WallProfileMode,
} from "../types";
import { WheelSlider } from "./WheelSlider";

/* Buy-me-a-coffee panel UI hidden for now — restore from git history when needed. */

/** Kept for debugging alternate builders; users always get Clipper2. */
const SHOW_BUILD_METHOD_UI = false;

type Props = {
  params: CutterParams;
  sizeReadout: SizeReadout | null;
  enabled: boolean;
  wallProfileMode: WallProfileMode;
  method: BuildMethod;
  onMethodChange: (m: BuildMethod) => void;
  onChange: (next: CutterParams) => void;
  onThicknessPreset: (id: ThicknessPresetId) => void;
  /** One-step undo of the last preset click. */
  canRevertPreset: boolean;
  onRevertPreset: () => void;
  /** Opens the save dialog (always available; options inside are gated). */
  onDownload: () => void;
  onShowWallProfile: () => void;
  onHideWallProfile: () => void;
  /** Present when the current cutter curve has a stamp. */
  stamp: StampParams | null;
  onStampChange: (next: StampParams) => void;
};

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  unit = "mm",
  hint,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const control = (
    <Box sx={{ opacity: disabled ? 0.45 : 1 }}>
      <Stack
        direction="row"
        sx={{ justifyContent: "space-between", alignItems: "baseline" }}
      >
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}
          {unit ? ` ${unit}` : ""}
        </Typography>
      </Stack>
      <WheelSlider
        size="small"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(_, v) => onChange(v as number)}
        sx={{
          // Keep thumb/focus ring inside the panel (no horizontal scroll)
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          px: 0.5,
          mx: 0,
        }}
      />
    </Box>
  );

  if (!hint) return control;
  return (
    <Tooltip title={hint} enterDelay={400} placement="left">
      <Box>{control}</Box>
    </Tooltip>
  );
}

export function ParamsPanel({
  params,
  sizeReadout,
  enabled,
  wallProfileMode,
  method,
  onMethodChange,
  onChange,
  onThicknessPreset,
  canRevertPreset,
  onRevertPreset,
  onDownload,
  onShowWallProfile,
  onHideWallProfile,
  stamp,
  onStampChange,
}: Props) {
  const set = <K extends keyof CutterParams>(key: K, value: CutterParams[K]) =>
    onChange({ ...params, [key]: value });

  const activePreset = THICKNESS_PRESETS.find((p) =>
    matchesThicknessPreset(p, params, stamp),
  )?.id;

  const wallHalf = params.wallThicknessMm / 2;
  /** Overhang past the outer wall face (UI); 0 = flush with wall. */
  const flangeOverhang = Math.max(0, params.rimWidthMm - wallHalf);
  /** Matches 3D: a flange needs both overhang and height. */
  const hasFlange = flangeOverhang > 1e-6 && params.baseHeightMm > 1e-6;
  const hasOverhang = flangeOverhang > 1e-6;

  const setFlangeOverhang = (overhang: number) => {
    set("rimWidthMm", Math.max(0, overhang) + wallHalf);
  };

  const setWallThickness = (wt: number) => {
    // Keep the same outer overhang when wall thickness changes;
    // clamp knife tip so it never exceeds wall thickness.
    onChange({
      ...params,
      wallThicknessMm: wt,
      rimWidthMm: flangeOverhang + wt / 2,
      knifeTipMm: Math.min(params.knifeTipMm, wt),
    });
  };

  /** Overall cutter height, knife included. The stored wall is the part below the knife. */
  const overallHeight = params.wallHeightMm + params.knifeHeightMm;
  const setOverallHeight = (h: number) => {
    const knife = Math.min(params.knifeHeightMm, Math.max(0, h - 0.4));
    onChange({
      ...params,
      knifeHeightMm: knife,
      wallHeightMm: Math.max(0, h - knife),
    });
  };
  const setKnifeHeight = (kh: number) => {
    const knife = Math.max(0, Math.min(kh, overallHeight - 0.4));
    onChange({
      ...params,
      knifeHeightMm: knife,
      wallHeightMm: overallHeight - knife,
    });
  };

  const sizeLabel = sizeReadout
    ? `${sizeReadout.widthMm.toFixed(1)} × ${sizeReadout.heightMm.toFixed(1)} mm`
    : "— × — mm";

  return (
    <Box
      sx={{
        width: 280,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderLeft: 1,
        borderColor: "divider",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 2, py: 1.5, flexShrink: 0 }}>
        {/* <Typography variant="h6">Perníčkovadlo</Typography> */}
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, alignItems: "center" }}>
          {THICKNESS_PRESETS.map((p) => (
            <Tooltip key={p.id} title={p.hint}>
              <Button
                fullWidth
                size="small"
                variant={activePreset === p.id ? "contained" : "outlined"}
                onClick={() => onThicknessPreset(p.id)}
                sx={{ textTransform: "none", minWidth: 0, px: 0.5 }}
              >
                {p.label}
              </Button>
            </Tooltip>
          ))}
          <Tooltip title="Revert last preset">
            <span>
              <IconButton
                size="small"
                color={canRevertPreset ? "primary" : "default"}
                aria-label="Revert last preset"
                disabled={!canRevertPreset}
                onClick={onRevertPreset}
                sx={{ "&.Mui-disabled": { opacity: 0.3 } }}
              >
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {wallProfileMode === "hidden" ? (
          <Button
            fullWidth
            size="small"
            variant="outlined"
            disabled={!enabled}
            onClick={onShowWallProfile}
            startIcon={<PictureInPicture2 size={16} strokeWidth={2} />}
            sx={{ mt: 1, textTransform: "none" }}
          >
            Show wall profile
          </Button>
        ) : (
          <Button
            fullWidth
            size="small"
            variant="contained"
            disabled={!enabled}
            onClick={onHideWallProfile}
            startIcon={<X size={16} strokeWidth={2} />}
            sx={{ mt: 1, textTransform: "none" }}
          >
            Hide wall profile
          </Button>
        )}
      </Box>
      <Divider />

      <Stack
        spacing={1.5}
        sx={{
          p: 2,
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* Method selector hidden for users — Clipper2 stays the default via App/storage.
            Set SHOW_BUILD_METHOD_UI to true to restore the dropdown for debugging. */}
        {SHOW_BUILD_METHOD_UI && (
          <FormControl size="small" fullWidth>
            <InputLabel id="build-method-label">Method</InputLabel>
            <Select
              labelId="build-method-label"
              label="Method"
              value={method}
              onChange={(e) => onMethodChange(e.target.value as BuildMethod)}
            >
              {BUILD_METHODS.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        <ParamSlider
          label="3D mesh quality"
          value={params.meshQuality}
          min={1}
          max={5}
          step={1}
          unit=""
          hint="Smooth curves become short straight segments in the 3D model. Higher keeps more of each curve (smoother, heavier mesh). 3 is the default."
          onChange={(v) => set("meshQuality", v)}
        />

        <Divider />

        <Tooltip
          title="Longer side of the outline bounding box (aspect ratio kept)"
          enterDelay={400}
          placement="left"
        >
          <Box sx={{ opacity: enabled ? 1 : 0.45 }}>
            <Stack
              direction="row"
              sx={{ justifyContent: "space-between", alignItems: "baseline" }}
            >
              <Typography variant="body2">Size</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                {sizeLabel}
              </Typography>
            </Stack>
            <WheelSlider
              size="small"
              value={params.sizeMm}
              min={10}
              max={300}
              step={1}
              disabled={!enabled}
              onChange={(_, v) => set("sizeMm", v as number)}
              sx={{ display: "block", width: "100%", boxSizing: "border-box", px: 0.5 }}
            />
          </Box>
        </Tooltip>

        <ParamSlider
          label="Height"
          value={overallHeight}
          min={4}
          max={36}
          step={0.5}
          disabled={!enabled}
          hint="Overall cutter height, including the knife edge"
          onChange={setOverallHeight}
        />
        <ParamSlider
          label="Base width"
          value={flangeOverhang}
          min={0}
          max={12}
          step={0.1}
          disabled={!enabled}
          hint="Flange overhang past the outer wall face (0 = flush)"
          onChange={setFlangeOverhang}
        />
        <ParamSlider
          label="Base height"
          value={params.baseHeightMm}
          min={0}
          max={4}
          step={0.1}
          disabled={!enabled || !hasOverhang}
          hint="Thickness of the bottom flange / foot"
          onChange={(v) => set("baseHeightMm", v)}
        />
        <ParamSlider
          label="Wall thickness"
          value={params.wallThicknessMm}
          min={0.4}
          max={3}
          step={0.1}
          disabled={!enabled}
          hint="Cutting wall width; thinner cuts cleaner, thicker is sturdier"
          onChange={setWallThickness}
        />
        <ParamSlider
          label="Bevel / fillet radius"
          value={params.filletRadiusMm}
          min={0}
          max={5}
          step={0.1}
          disabled={!enabled || !hasFlange}
          hint="Rounded transition from flange top into the outer wall"
          onChange={(v) => set("filletRadiusMm", v)}
        />
        <ParamSlider
          label="Knife edge height"
          value={params.knifeHeightMm}
          min={0}
          max={6}
          step={0.1}
          disabled={!enabled}
          hint="Tapered cutting tip. Overall height stays the same"
          onChange={setKnifeHeight}
        />
        <ParamSlider
          label="Knife tip width"
          value={Math.min(params.knifeTipMm, params.wallThicknessMm)}
          min={0}
          max={params.wallThicknessMm}
          step={0.05}
          disabled={!enabled || params.knifeHeightMm <= 0}
          hint="Flat top of the cutting edge (avoids stacked hairlines)"
          onChange={(v) => set("knifeTipMm", v)}
        />
        <ParamSlider
          label="Layer thickness"
          value={params.bevelLayerMm}
          min={0.1}
          max={0.5}
          step={0.05}
          disabled={!enabled}
          hint="Slice height used to build bevels and the knife (match print layer)"
          onChange={(v) => set("bevelLayerMm", v)}
        />

        <Divider />

        {stamp && (
          <>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Stamp
            </Typography>
            <ParamSlider
              label="Plate thickness"
              value={stamp.plateMm}
              min={0.8}
              max={12}
              step={0.1}
              hint="Overall stamp plate thickness"
              onChange={(v) =>
                onStampChange({
                  ...stamp,
                  plateMm: v,
                  recessMm: Math.min(stamp.recessMm, v),
                })
              }
            />
            <ParamSlider
              label="Raise height"
              value={stamp.raiseMm}
              min={0}
              max={4}
              step={0.05}
              hint="How far raised stamp features protrude from the plate (0 = flat)"
              onChange={(v) => onStampChange({ ...stamp, raiseMm: v })}
            />
            <ParamSlider
              label="Recess depth"
              value={Math.min(stamp.recessMm, stamp.plateMm)}
              min={0}
              max={stamp.plateMm}
              step={0.05}
              hint="How deep recessed stamp features cut into the plate (0 = none)"
              onChange={(v) => onStampChange({ ...stamp, recessMm: v })}
            />
          </>
        )}

      </Stack>

      <Box sx={{ px: 2, pb: 2, pt: 1, flexShrink: 0 }}>
        <Divider sx={{ mb: 1.5 }} />
        <Button
          fullWidth
          variant="contained"
          startIcon={<DownloadIcon />}
          onClick={onDownload}
          sx={{ textTransform: "none" }}
        >
          Download
        </Button>
      </Box>
    </Box>
  );
}
