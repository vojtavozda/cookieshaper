import { useEffect, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import ContentCutOutlinedIcon from "@mui/icons-material/ContentCutOutlined";
import ApprovalOutlinedIcon from "@mui/icons-material/ApprovalOutlined";
import FolderZipOutlinedIcon from "@mui/icons-material/FolderZipOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import { preloadUnionWasm } from "../geometry/unionSolid";

const BMC_HREF = "https://www.buymeacoffee.com/vojtavozda";
const BMC_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=vojtavozda&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff";

export type DownloadChoice = "sketch" | "cutter" | "stamp" | "assembly" | "zip";

type Props = {
  open: boolean;
  onClose: () => void;
  canSketch: boolean;
  canCutter: boolean;
  canStamp: boolean;
  /** Return true when a file was actually saved (not cancelled). */
  onChoose: (choice: DownloadChoice) => boolean | Promise<boolean>;
};

export function DownloadDialog({
  open,
  onClose,
  canSketch,
  canCutter,
  canStamp,
  onChoose,
}: Props) {
  const [downloaded, setDownloaded] = useState(false);
  const [busyChoice, setBusyChoice] = useState<DownloadChoice | null>(null);
  const busy = busyChoice != null;

  useEffect(() => {
    if (!open) {
      setDownloaded(false);
      setBusyChoice(null);
      return;
    }
    // Warm manifold wasm while the user picks a download option.
    preloadUnionWasm();
  }, [open]);

  const run = async (choice: DownloadChoice) => {
    if (busy) return;
    setBusyChoice(choice);
    // Let the busy spinner paint before sync-heavy STL/PDF work starts.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    try {
      const saved = await onChoose(choice);
      if (saved) setDownloaded(true);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusyChoice(null);
    }
  };

  const canZip = canSketch || canCutter || canStamp;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{
        backdrop: {
          sx: {
            bgcolor: "rgba(20, 22, 28, 0.55)",
            backdropFilter: "blur(6px)",
          },
        },
        paper: {
          sx: {
            position: "relative",
            borderRadius: 2,
            px: { xs: 1, sm: 2 },
            py: 1,
          },
        },
      }}
    >
      <IconButton
        aria-label="Close"
        onClick={onClose}
        size="small"
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 1,
          color: "text.secondary",
        }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      <DialogContent>
        <Typography
          variant="h5"
          sx={{ textAlign: "center", fontWeight: 700, mb: 0.5 }}
        >
          What would you like to save?
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ textAlign: "center", mb: 2.5 }}
        >
          Pick a format — you can come back for more anytime.
        </Typography>

        <Stack spacing={1.25}>
          <ChoiceButton
            icon={<PictureAsPdfOutlinedIcon />}
            label="Sketch (PDF)"
            hint="Save your work — re-upload later to keep editing"
            disabled={!canSketch || (busy && busyChoice !== "sketch")}
            loading={busyChoice === "sketch"}
            onClick={() => void run("sketch")}
          />
          <ChoiceButton
            icon={<ContentCutOutlinedIcon />}
            label="Cutter (STL)"
            hint="3D cookie cutter mesh"
            disabled={!canCutter || (busy && busyChoice !== "cutter")}
            loading={busyChoice === "cutter"}
            onClick={() => void run("cutter")}
          />
          <ChoiceButton
            icon={<ApprovalOutlinedIcon />}
            label="Stamp (STL)"
            hint="Stamp plate with raised / recessed marks"
            disabled={!canStamp || (busy && busyChoice !== "stamp")}
            loading={busyChoice === "stamp"}
            onClick={() => void run("stamp")}
          />
          <ChoiceButton
            icon={<LayersOutlinedIcon />}
            label="Cutter + stamp (STL)"
            hint="One solid cutter and one solid stamp, still nested — Split to parts in PrusaSlicer"
            disabled={!canCutter || !canStamp || (busy && busyChoice !== "assembly")}
            loading={busyChoice === "assembly"}
            onClick={() => void run("assembly")}
          />
          <ChoiceButton
            icon={<FolderZipOutlinedIcon />}
            label="Everything (ZIP)"
            hint="Sketch, separate STLs, and the nested cutter+stamp STL"
            disabled={!canZip || (busy && busyChoice !== "zip")}
            loading={busyChoice === "zip"}
            primary
            onClick={() => void run("zip")}
          />
        </Stack>

        {downloaded && (
          <Box
            sx={{
              mt: 3,
              pt: 2.5,
              borderTop: 1,
              borderColor: "divider",
              textAlign: "center",
            }}
          >
            <Typography sx={{ fontWeight: 600, mb: 1.25 }}>
              Do you like the results? Buy me a coffee!
            </Typography>
            <Box sx={{ display: "flex", justifyContent: "center" }}>
              <Box
                component="a"
                href={BMC_HREF}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Buy me a coffee"
                sx={{
                  display: "inline-flex",
                  lineHeight: 0,
                  "& img": {
                    display: "block",
                    height: 48,
                    width: "auto",
                    maxWidth: "100%",
                  },
                }}
              >
                <img src={BMC_IMG} alt="Buy me a coffee" />
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChoiceButton({
  icon,
  label,
  hint,
  disabled,
  loading,
  primary,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  disabled?: boolean;
  loading?: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      fullWidth
      variant={primary ? "contained" : "outlined"}
      disabled={disabled}
      onClick={onClick}
      startIcon={
        loading ? (
          <CircularProgress
            size={18}
            thickness={5}
            color={primary ? "inherit" : "primary"}
          />
        ) : (
          icon
        )
      }
      sx={{
        textTransform: "none",
        justifyContent: "flex-start",
        py: 1.25,
        px: 2,
        borderRadius: 1.5,
        textAlign: "left",
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
        }}
      >
        <Typography component="span" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
          {label}
        </Typography>
        <Typography
          component="span"
          variant="caption"
          sx={{
            opacity: primary ? 0.9 : 0.7,
            color: primary ? "inherit" : "text.secondary",
            lineHeight: 1.3,
          }}
        >
          {hint}
        </Typography>
      </Box>
    </Button>
  );
}
