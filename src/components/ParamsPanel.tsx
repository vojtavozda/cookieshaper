import { useLayoutEffect, useState } from "react";
import {
  Box,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
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
import { BUILD_METHODS, type BuildMethod, type CutterParams, type SizeReadout, type StampParams } from "../types";
import {
  loadBmcStyle,
  saveBmcStyle,
  type BmcStyle,
} from "../storage";
import { WheelSlider } from "./WheelSlider";

const BMC_HREF = "https://www.buymeacoffee.com/vojtavozda";
const BMC_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=vojtavozda&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff";
const BMC_SHOW_CLASS = "bmc-show-widget";

function setBmcWidgetVisible(on: boolean) {
  document.body.classList.toggle(BMC_SHOW_CLASS, on);
}

function BuyMeACoffeeButton() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", width: "100%" }}>
      <Box
        component="a"
        href={BMC_HREF}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Buy me a coffee"
        sx={{
          display: "inline-flex",
          lineHeight: 0,
          mx: "auto",
          "& img": {
            display: "block",
            height: 40,
            width: "auto",
            maxWidth: "100%",
          },
        }}
      >
        <img src={BMC_IMG} alt="Buy me a coffee" />
      </Box>
    </Box>
  );
}

function BuyMeACoffeeSection() {
  const [style, setStyle] = useState<BmcStyle>(() => {
    const initial = loadBmcStyle();
    setBmcWidgetVisible(initial === "widget");
    return initial;
  });

  useLayoutEffect(() => {
    setBmcWidgetVisible(style === "widget");
  }, [style]);

  const setNext = (next: BmcStyle) => {
    setStyle(next);
    saveBmcStyle(next);
  };

  return (
    <Stack spacing={1}>
      {style === "button" ? <BuyMeACoffeeButton /> : null}
      <FormControlLabel
        sx={{
          mx: 0,
          justifyContent: "center",
          gap: 0.5,
          "& .MuiFormControlLabel-label": { fontSize: 12, color: "text.secondary" },
        }}
        control={
          <Switch
            size="small"
            checked={style === "widget"}
            onChange={(_, on) => setNext(on ? "widget" : "button")}
            inputProps={{ "aria-label": "Floating Buy me a coffee widget" }}
          />
        }
        label="Floating coffee widget"
      />
    </Stack>
  );
}

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
  onResetDefaults: () => void;
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
  return (
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
      {hint && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: -0.5, lineHeight: 1.3 }}
        >
          {hint}
        </Typography>
      )}
    </Box>
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
  onResetDefaults,
  onDownload,
  onApply,
  onShowWallProfile,
  stamp,
  onStampChange,
}: Props) {
  const set = <K extends keyof CutterParams>(key: K, value: CutterParams[K]) =>
    onChange({ ...params, [key]: value });

  const wallHalf = params.wallThicknessMm / 2;
  /** Overhang past the outer wall face (UI); 0 = flush with wall. */
  const flangeOverhang = Math.max(0, params.rimWidthMm - wallHalf);
  const hasFlange = flangeOverhang > 1e-6;

  const setFlangeOverhang = (overhang: number) => {
    set("rimWidthMm", Math.max(0, overhang) + wallHalf);
  };

  const setWallThickness = (wt: number) => {
    // Keep the same outer overhang when wall thickness changes
    onChange({
      ...params,
      wallThicknessMm: wt,
      rimWidthMm: flangeOverhang + wt / 2,
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

        <ParamSlider
          label="Base width"
          value={flangeOverhang}
          min={0}
          max={12}
          step={0.1}
          disabled={!enabled}
          onChange={setFlangeOverhang}
        />
        <ParamSlider
          label="Base height"
          value={params.baseHeightMm}
          min={0}
          max={4}
          step={0.1}
          disabled={!enabled || !hasFlange}
          onChange={(v) => set("baseHeightMm", v)}
        />
        <ParamSlider
          label="Wall thickness"
          value={params.wallThicknessMm}
          min={0.4}
          max={3}
          step={0.1}
          disabled={!enabled}
          onChange={setWallThickness}
        />
        <ParamSlider
          label="Wall height"
          value={params.wallHeightMm}
          min={4}
          max={30}
          step={0.5}
          disabled={!enabled}
          onChange={(v) => set("wallHeightMm", v)}
        />
        <ParamSlider
          label="Bevel / fillet radius"
          value={params.filletRadiusMm}
          min={0}
          max={5}
          step={0.1}
          disabled={!enabled || !hasFlange || params.baseHeightMm <= 0}
          onChange={(v) => set("filletRadiusMm", v)}
        />
        <ParamSlider
          label="Knife edge height"
          value={params.knifeHeightMm}
          min={0}
          max={6}
          step={0.1}
          disabled={!enabled}
          onChange={(v) => set("knifeHeightMm", v)}
        />
        <ParamSlider
          label="Layer thickness"
          value={params.bevelLayerMm}
          min={0.1}
          max={0.5}
          step={0.05}
          disabled={!enabled}
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
              onChange={(v) => onStampChange({ ...stamp, raiseMm: v })}
            />
            <ParamSlider
              label="Recess depth"
              value={Math.min(stamp.recessMm, stamp.plateMm)}
              min={0.1}
              max={stamp.plateMm}
              step={0.05}
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
          <Button variant="outlined" onClick={onResetDefaults}>
            Reset to defaults
          </Button>
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
        {/* <BuyMeACoffeeSection /> */}
      </Box>
    </Box>
  );
}
