import { useRef } from "react";
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ContentPasteOutlinedIcon from "@mui/icons-material/ContentPasteOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { WheelSlider } from "./WheelSlider";
import type { TraceMode } from "../geometry/imageContours";

type Props = {
  hasImage: boolean;
  threshold: number;
  smooth: number;
  showBackground: boolean;
  /** Blue preview contours available for click-to-import. */
  showTraceCurves: boolean;
  /** Outlines of blobs vs stroke centerlines. */
  traceMode: TraceMode;
  /** 0–1 when image is shown. */
  backgroundOpacity: number;
  curveCount: number;
  onThresholdChange: (v: number) => void;
  onSmoothChange: (v: number) => void;
  onShowBackgroundChange: (v: boolean) => void;
  onShowTraceCurvesChange: (v: boolean) => void;
  onTraceModeChange: (m: TraceMode) => void;
  onBackgroundOpacityChange: (v: number) => void;
  onLoadImage: (url: string) => void;
  /** SVG / PDF → curves; raster → background image. */
  onLoadFile?: (file: File) => void;
  /** Drop the current raster (keeps imported curves). */
  onRemoveImage?: () => void;
  onHide: () => void;
};

export function ImageTracePanel({
  hasImage,
  threshold,
  smooth,
  showBackground,
  showTraceCurves,
  traceMode,
  backgroundOpacity,
  curveCount,
  onThresholdChange,
  onSmoothChange,
  onShowBackgroundChange,
  onShowTraceCurvesChange,
  onTraceModeChange,
  onBackgroundOpacityChange,
  onLoadImage,
  onLoadFile,
  onRemoveImage,
  onHide,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFile = (file: File) => {
    if (onLoadFile) onLoadFile(file);
    else onLoadImage(URL.createObjectURL(file));
  };

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(
          (t) => t.startsWith("image/") || t === "image/svg+xml",
        );
        if (!type) continue;
        const blob = await item.getType(type);
        const ext =
          type === "image/svg+xml" ? "svg" : (type.split("/")[1] ?? "png");
        loadFile(new File([blob], `clipboard.${ext}`, { type }));
        return;
      }
      window.alert("Clipboard has no image");
    } catch {
      window.alert("Could not read an image from the clipboard");
    }
  };

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
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "stretch" }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FolderOpenIcon />}
            onClick={() => fileRef.current?.click()}
            sx={{
              textTransform: "none",
              flex: 1,
              minWidth: 0,
              height: 30,
              py: 0,
            }}
          >
            Browse
          </Button>
          <Tooltip title="Paste image from clipboard">
            <Button
              size="small"
              variant="outlined"
              aria-label="Paste image from clipboard"
              onClick={() => void pasteFromClipboard()}
              sx={{ minWidth: 36, width: 36, height: 30, px: 0, py: 0 }}
            >
              <ContentPasteOutlinedIcon sx={{ fontSize: 18 }} />
            </Button>
          </Tooltip>
          <Tooltip
            title={hasImage ? "Remove background image" : "No image loaded"}
          >
            <Box component="span" sx={{ display: "inline-flex", height: 30 }}>
              <Button
                size="small"
                variant="outlined"
                disabled={!hasImage || !onRemoveImage}
                aria-label="Remove background image"
                onClick={onRemoveImage}
                sx={{
                  minWidth: 36,
                  width: 36,
                  height: 30,
                  px: 0,
                  py: 0,
                  ...(hasImage && onRemoveImage
                    ? {
                        bgcolor: "#c45c26",
                        borderColor: "#c45c26",
                        color: "#fff",
                        "&:hover": {
                          bgcolor: "#a84c1f",
                          borderColor: "#a84c1f",
                          color: "#fff",
                        },
                      }
                    : null),
                }}
              >
                <DeleteOutlineIcon sx={{ fontSize: 18 }} />
              </Button>
            </Box>
          </Tooltip>
        </Stack>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg,application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            loadFile(file);
            e.target.value = "";
          }}
        />
        {/* <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
          SVG/PDF → editable curves. PNG/JPG → threshold tracing. Paste (Ctrl+V) works too.
        </Typography> */}

        <FormControlLabel
          disabled={!hasImage}
          control={
            <Switch
              size="small"
              checked={showBackground}
              onChange={(_, v) => onShowBackgroundChange(v)}
            />
          }
          label={<Typography variant="caption">Show image</Typography>}
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

        <FormControlLabel
          disabled={!hasImage}
          control={
            <Switch
              size="small"
              checked={showTraceCurves}
              onChange={(_, v) => onShowTraceCurvesChange(v)}
            />
          }
          label={<Typography variant="caption">Detect curves</Typography>}
          sx={{ ml: 0, mr: 0, opacity: hasImage ? 1 : 0.4 }}
        />

        <FormControlLabel
          disabled={!hasImage || !showTraceCurves}
          control={
            <Switch
              size="small"
              checked={traceMode === "lines"}
              onChange={(_, v) => onTraceModeChange(v ? "lines" : "outlines")}
            />
          }
          label={
            <Typography variant="caption">
              Centerlines (stroke middle)
            </Typography>
          }
          sx={{
            ml: 0,
            mr: 0,
            opacity: hasImage && showTraceCurves ? 1 : 0.4,
          }}
        />

        <Box
          sx={{
            opacity: hasImage && showTraceCurves ? 1 : 0.4,
            pointerEvents: hasImage && showTraceCurves ? "auto" : "none",
          }}
        >
          <Stack direction="row" sx={{ justifyContent: "space-between" }}>
            <Typography variant="caption">Threshold</Typography>
            <Typography variant="caption" color="text.secondary">
              {threshold}
            </Typography>
          </Stack>
          <WheelSlider
            size="small"
            value={threshold}
            min={0}
            max={255}
            step={1}
            disabled={!hasImage || !showTraceCurves}
            onChange={(_, v) => onThresholdChange(v as number)}
          />
        </Box>

        <Box
          sx={{
            opacity: hasImage && showTraceCurves ? 1 : 0.4,
            pointerEvents: hasImage && showTraceCurves ? "auto" : "none",
          }}
        >
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
            disabled={!hasImage || !showTraceCurves}
            onChange={(_, v) => onSmoothChange(v as number)}
          />
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
          {!hasImage
            ? "Load an image to detect curves"
            : !showTraceCurves
              ? "Curve detection off — image only"
              : curveCount > 0
                ? `${curveCount} ${
                    traceMode === "lines" ? "line" : "curve"
                  }${curveCount === 1 ? "" : "s"} — hover & click to import`
                : traceMode === "lines"
                  ? "No centerlines found — try adjusting threshold"
                  : "No curves found — try adjusting threshold"}
        </Typography>
      </Stack>
    </Box>
  );
}
