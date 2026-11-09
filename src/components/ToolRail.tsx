import { Box, Divider, IconButton, SvgIcon, Tooltip, Typography, type SvgIconProps } from "@mui/material";
import { WheelSlider } from "./WheelSlider";
import GestureIcon from "@mui/icons-material/Gesture";
import ImageIcon from "@mui/icons-material/Image";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import PentagonOutlinedIcon from "@mui/icons-material/PentagonOutlined";
import CircleOutlinedIcon from "@mui/icons-material/CircleOutlined";
import StraightenIcon from "@mui/icons-material/Straighten";
import GridOnIcon from "@mui/icons-material/GridOn";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import { Broom } from "lucide-react";
import { EditCurveIcon } from "./EditCurveIcon";

/** Classic mouse-pointer arrow for object edit mode. */
function SelectArrowIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M5.5 3.2 18.8 14.1l-5.55.55 3.35 7.55-2.6 1.15-3.35-7.55L5.5 19.8V3.2z" />
    </SvgIcon>
  );
}

/** Horseshoe magnet for snap-to-curve. */
function MagnetIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M7 3h3.2v8.2a1.8 1.8 0 0 0 3.6 0V3H17v8.2a5 5 0 0 1-10 0V3zm0 0v2.2H6.2V3H7zm10.8 0v2.2H17V3h.8z" />
    </SvgIcon>
  );
}

/** `edit` = object transform; `curveEdit` = points / handles. */
export type CanvasMode =
  | "draw"
  | "edit"
  | "curveEdit"
  | "polygon"
  | "ellipse"
  | "measure";

type Props = {
  mode: CanvasMode;
  onModeChange: (m: CanvasMode) => void;
  simplifyTolerance: number;
  onSimplifyChange: (v: number) => void;
  /** Smooth slider only when a (simplifiable) curve is selected. */
  showSmooth?: boolean;
  snapGrid: boolean;
  onSnapGridChange: (v: boolean) => void;
  snapCurves: boolean;
  onSnapCurvesChange: (v: boolean) => void;
  imagePanelOpen: boolean;
  onOpenImagePanel: () => void;
  onDeleteCurrent: () => void;
  canDelete: boolean;
  /** Remove every curve, stamp feature, and background image. */
  onClearCanvas: () => void;
  canClearCanvas: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Flush browser sketch draft (same as Ctrl+S). */
  onSaveDraft: () => void;
  canSaveDraft: boolean;
};

function RailSep() {
  return (
    <Divider
      flexItem
      sx={{ width: 52, alignSelf: "center", borderColor: "divider", my: 0.25 }}
    />
  );
}

export function ToolRail({
  mode,
  onModeChange,
  simplifyTolerance,
  onSimplifyChange,
  showSmooth = false,
  snapGrid,
  onSnapGridChange,
  snapCurves,
  onSnapCurvesChange,
  imagePanelOpen,
  onOpenImagePanel,
  onDeleteCurrent,
  canDelete,
  onClearCanvas,
  canClearCanvas,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSaveDraft,
  canSaveDraft,
}: Props) {
  return (
    <Box
      sx={{
        width: 72,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        py: 1.5,
        bgcolor: "background.paper",
        borderRight: 1,
        borderColor: "divider",
      }}
    >
      <Tooltip title="Edit — move / scale / rotate" placement="right">
        <IconButton
          color={mode === "edit" ? "primary" : "default"}
          onClick={() => onModeChange("edit")}
        >
          <SelectArrowIcon />
        </IconButton>
      </Tooltip>

      <Tooltip title="Curve edit — points / handles (right-click menu)" placement="right">
        <IconButton
          color={mode === "curveEdit" ? "primary" : "default"}
          onClick={() => onModeChange("curveEdit")}
        >
          <EditCurveIcon />
        </IconButton>
      </Tooltip>

      <RailSep />

      <Tooltip title="Draw freehand" placement="right">
        <IconButton
          color={mode === "draw" ? "primary" : "default"}
          onClick={() => onModeChange("draw")}
        >
          <GestureIcon />
        </IconButton>
      </Tooltip>

      <Tooltip title="Polygon (click vertices, drag for smooth handles)" placement="right">
        <IconButton
          color={mode === "polygon" ? "primary" : "default"}
          onClick={() => onModeChange("polygon")}
        >
          <PentagonOutlinedIcon />
        </IconButton>
      </Tooltip>

      <Tooltip
        title="Ellipse (drag; Ctrl = circle; Shift = from center)"
        placement="right"
      >
        <IconButton
          color={mode === "ellipse" ? "primary" : "default"}
          onClick={() => onModeChange("ellipse")}
        >
          <CircleOutlinedIcon />
        </IconButton>
      </Tooltip>

      <RailSep />

      <Tooltip title="Background image / trace curves" placement="right">
        <IconButton
          color={imagePanelOpen ? "primary" : "default"}
          onClick={onOpenImagePanel}
        >
          <ImageIcon />
        </IconButton>
      </Tooltip>

      <Tooltip
        title={snapGrid ? "Snap to grid (on)" : "Snap to grid (off)"}
        placement="right"
      >
        <IconButton
          color={snapGrid ? "primary" : "default"}
          onClick={() => onSnapGridChange(!snapGrid)}
        >
          <GridOnIcon />
        </IconButton>
      </Tooltip>

      <Tooltip title="Measure / set size from a length" placement="right">
        <IconButton
          color={mode === "measure" ? "primary" : "default"}
          onClick={() => onModeChange("measure")}
        >
          <StraightenIcon />
        </IconButton>
      </Tooltip>

      <Tooltip
        title={snapCurves ? "Snap to curves (on)" : "Snap to curves (off)"}
        placement="right"
      >
        <IconButton
          color={snapCurves ? "primary" : "default"}
          onClick={() => onSnapCurvesChange(!snapCurves)}
        >
          <MagnetIcon sx={{ transform: "rotate(45deg)" }} />
        </IconButton>
      </Tooltip>

      <Tooltip
        title={canDelete ? "Delete current curve" : "Select a curve to delete"}
        placement="right"
      >
        <span>
          <IconButton disabled={!canDelete} onClick={onDeleteCurrent}>
            <DeleteOutlineIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip
        title={
          canClearCanvas
            ? "Clear canvas — curves, stamps & background"
            : "Canvas is empty"
        }
        placement="right"
      >
        <span>
          <IconButton disabled={!canClearCanvas} onClick={onClearCanvas}>
            <Broom size={24} strokeWidth={1.75} />
          </IconButton>
        </span>
      </Tooltip>

      <RailSep />

      <Tooltip
        title={canUndo ? "Undo (Ctrl+Z)" : "Nothing to undo"}
        placement="right"
      >
        <span>
          <IconButton disabled={!canUndo} onClick={onUndo}>
            <UndoIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip
        title={canRedo ? "Redo (Ctrl+Shift+Z)" : "Nothing to redo"}
        placement="right"
      >
        <span>
          <IconButton disabled={!canRedo} onClick={onRedo}>
            <RedoIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip
        title={
          canSaveDraft
            ? "Save sketch in this browser (Ctrl+S)"
            : "Draw a curve to save"
        }
        placement="right"
      >
        <span>
          <IconButton disabled={!canSaveDraft} onClick={onSaveDraft}>
            <SaveOutlinedIcon />
          </IconButton>
        </span>
      </Tooltip>

      {showSmooth && (
        <Box
          sx={{
            mt: 2,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            minHeight: 160,
            overflow: "visible",
          }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontSize: 10, lineHeight: 1.2 }}
          >
            Smooth
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mb: 0.75, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
          >
            {simplifyTolerance.toFixed(1)}
          </Typography>
          <WheelSlider
            orientation="vertical"
            value={simplifyTolerance}
            min={0}
            max={20}
            step={0.5}
            onChange={(_, v) => onSimplifyChange(v as number)}
            onChangeCommitted={(e) => {
              const el = e.target as HTMLElement | null;
              el?.blur?.();
            }}
            // Value shown above the track — hover chip would cover the canvas
            valueLabelDisplay="off"
            sx={{
              height: 120,
              py: 1,
              "& .MuiSlider-thumb": { width: 14, height: 14 },
            }}
          />
        </Box>
      )}
    </Box>
  );
}
