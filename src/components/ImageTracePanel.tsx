import { useRef } from "react";
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { WheelSlider } from "./WheelSlider";

type Props = {
  hasImage: boolean;
  threshold: number;
  smooth: number;
  showBackground: boolean;
  /** 0–1 when image is shown. */
  backgroundOpacity: number;
  curveCount: number;
  onThresholdChange: (v: number) => void;
  onSmoothChange: (v: number) => void;
  onShowBackgroundChange: (v: boolean) => void;
  onBackgroundOpacityChange: (v: number) => void;
  onLoadImage: (url: string) => void;
  /** SVG / PDF → curves; raster → background image. */
  onLoadFile?: (file: File) => void;
  onHide: () => void;
};

export function ImageTracePanel({
  hasImage,
  threshold,
  smooth,
  showBackground,
  backgroundOpacity,
  curveCount,
  onThresholdChange,
  onSmoothChange,
  onShowBackgroundChange,
  onBackgroundOpacityChange,
  onLoadImage,
  onLoadFile,
  onHide,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Box
      sx={{
        width: 220,
        bgcolor: "rgba(255,255,255,0.94)",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        boxShadow: 2,
        px: 1.25,
        pt: 0.5,
        pb: 1,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 0.5,
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
          Curves from image
        </Typography>
        <IconButton
          size="small"
          aria-label="Hide image trace"
          onClick={onHide}
          sx={{ p: 0.25 }}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      <Stack spacing={0.75}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<FolderOpenIcon />}
          onClick={() => fileRef.current?.click()}
          sx={{ textTransform: "none" }}
        >
          {hasImage ? "Load file…" : "Browse image…"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg,application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (onLoadFile) onLoadFile(file);
            else onLoadImage(URL.createObjectURL(file));
            e.target.value = "";
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
          SVG/PDF import as editable curves. PNG/JPG use threshold tracing below.
        </Typography>

        <Box sx={{ opacity: hasImage ? 1 : 0.4, pointerEvents: hasImage ? "auto" : "none" }}>
          <Stack direction="row" sx={{ justifyContent: "space-between" }}>
            <Typography variant="caption">Threshold</Typography>
            <Typography variant="caption" color="text.secondary">
              {threshold}
            </Typography>
          </Stack>
          <WheelSlider
            size="small"
            value={threshold}
            min={10}
            max={240}
            step={1}
            disabled={!hasImage}
            onChange={(_, v) => onThresholdChange(v as number)}
          />
        </Box>

        <Box sx={{ opacity: hasImage ? 1 : 0.4, pointerEvents: hasImage ? "auto" : "none" }}>
          <Stack direction="row" sx={{ justifyContent: "space-between" }}>
            <Typography variant="caption">Simplify</Typography>
            <Typography variant="caption" color="text.secondary">
              {smooth.toFixed(2)}
            </Typography>
          </Stack>
          <WheelSlider
            size="small"
            value={smooth}
            min={0}
            max={1}
            step={0.05}
            disabled={!hasImage}
            onChange={(_, v) => onSmoothChange(v as number)}
          />
        </Box>

        <FormControlLabel
          disabled={!hasImage}
          control={
            <Switch
              size="small"
              checked={showBackground}
              onChange={(_, v) => onShowBackgroundChange(v)}
            />
          }
          label={
            <Typography variant="caption">Show image</Typography>
          }
          sx={{ ml: 0, mr: 0, opacity: hasImage ? 1 : 0.4 }}
        />

        <Box
          sx={{
            opacity: hasImage && showBackground ? 1 : 0.4,
            pointerEvents: hasImage && showBackground ? "auto" : "none",
          }}
        >
          <Stack direction="row" sx={{ justifyContent: "space-between" }}>
            <Typography variant="caption">Image opacity</Typography>
            <Typography variant="caption" color="text.secondary">
              {Math.round(backgroundOpacity * 100)}%
            </Typography>
          </Stack>
          <WheelSlider
            size="small"
            value={backgroundOpacity}
            min={0.05}
            max={1}
            step={0.05}
            disabled={!hasImage || !showBackground}
            onChange={(_, v) => onBackgroundOpacityChange(v as number)}
          />
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
          {!hasImage
            ? "Load an image to detect curves"
            : curveCount > 0
              ? `${curveCount} curve${curveCount === 1 ? "" : "s"} — hover & click to import`
              : "No curves found — try adjusting threshold"}
        </Typography>
      </Stack>
    </Box>
  );
}
