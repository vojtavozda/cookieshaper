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
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  BUILD_METHODS,
  THICKNESS_PRESETS,
  matchesThicknessPreset,
  type BuildMethod,
  type CutterParams,
  type SizeReadout,
  type StampParams,
  type ThicknessPresetId,
} from "../types";
import { WheelSlider } from "./WheelSlider";

/* Buy-me-a-coffee panel UI hidden for now — restore from git history when needed. */

/** Kept for debugging alternate builders; users always get Clipper2. */
const SHOW_BUILD_METHOD_UI = false;

type Props = {
  params: CutterParams;
  sizeReadout: SizeReadout | null;
  liveUpdate: boolean;
  /** Pending sketch/param changes not yet applied to the 3D view. */
  needsApply: boolean;
  enabled: boolean;
  wallProfileVisible: boolean;
  method: BuildMethod;
  onMethodChange: (m: BuildMethod) => void;
  onChange: (next: CutterParams) => void;
  onLiveUpdateChange: (v: boolean) => void;
  onThicknessPreset: (id: ThicknessPresetId) => void;
  /** Opens the save dialog (always available; options inside are gated). */
  onDownload: () => void;
  onApply: () => void;
  onShowWallProfile: () => void;
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
          {value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)} {unit}
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
  liveUpdate,
  needsApply,
  enabled,
  wallProfileVisible,
  method,
  onMethodChange,
  onChange,
  onLiveUpdateChange,
  onThicknessPreset,
  onDownload,
  onApply,
  onShowWallProfile,
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
  const hasFlange = flangeOverhang > 1e-6;

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
        <Typography variant="h6">Perníčkovadlo</Typography>
        <Typography variant="caption" color="text.secondary">
          {enabled
            ? "Tune the cutter profile"
            : "Draw a closed outline to enable 3D"}
        </Typography>
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
              <Typography variant="body2">Scale</Typography>
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
          disabled={!enabled || !hasFlange}
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
          label="Wall height"
          value={params.wallHeightMm}
          min={4}
          max={30}
          step={0.5}
          disabled={!enabled}
          hint="Straight wall height below the knife edge"
          onChange={(v) => set("wallHeightMm", v)}
        />
        <ParamSlider
          label="Bevel / fillet radius"
          value={params.filletRadiusMm}
          min={0}
          max={5}
          step={0.1}
          disabled={!enabled || !hasFlange || params.baseHeightMm <= 0}
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
          hint="Tapered cutting tip on top of the wall"
          onChange={(v) => set("knifeHeightMm", v)}
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
              min={0.1}
              max={4}
              step={0.05}
              hint="How far raised stamp features protrude from the plate"
              onChange={(v) => onStampChange({ ...stamp, raiseMm: v })}
            />
            <ParamSlider
              label="Recess depth"
              value={Math.min(stamp.recessMm, stamp.plateMm)}
              min={0.1}
              max={stamp.plateMm}
              step={0.05}
              hint="How deep recessed stamp features cut into the plate"
              onChange={(v) => onStampChange({ ...stamp, recessMm: v })}
            />
            <Divider />
          </>
        )}

        <Stack
          direction="row"
          spacing={0.5}
          sx={{ alignItems: "center", opacity: enabled ? 1 : 0.45 }}
        >
          <Switch
            size="small"
            checked={liveUpdate}
            disabled={!enabled}
            onChange={(_, v) => onLiveUpdateChange(v)}
          />
          <Typography variant="body2" sx={{ flex: 1 }}>
            Live 3D update
          </Typography>
          {!liveUpdate && (
            <Tooltip
              title={
                needsApply ? "Apply to 3D view" : "3D view is up to date"
              }
            >
              <span>
                <IconButton
                  size="small"
                  color={needsApply && enabled ? "primary" : "default"}
                  disabled={!enabled || !needsApply}
                  onClick={onApply}
                  aria-label="Apply to 3D view"
                  sx={{
                    "&.Mui-disabled": { opacity: 0.35 },
                  }}
                >
                  <RefreshIcon
                    sx={{
                      fontSize: 22,
                      stroke: "currentColor",
                      strokeWidth: 1.15,
                    }}
                  />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>

        <Stack spacing={1}>
          {!wallProfileVisible && (
            <Button variant="outlined" disabled={!enabled} onClick={onShowWallProfile}>
              Show wall profile
            </Button>
          )}
          <Typography variant="caption" color="text.secondary">
            Presets
          </Typography>
          <Stack direction="row" spacing={1}>
            {THICKNESS_PRESETS.map((p) => (
              <Tooltip key={p.id} title={p.hint}>
                <Button
                  fullWidth
                  size="small"
                  variant={activePreset === p.id ? "contained" : "outlined"}
                  onClick={() => onThicknessPreset(p.id)}
                  sx={{ textTransform: "none" }}
                >
                  {p.label}
                </Button>
              </Tooltip>
            ))}
          </Stack>
        </Stack>
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
