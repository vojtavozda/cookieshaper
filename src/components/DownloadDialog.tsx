import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogContent,
  Divider,
  FormControlLabel,
  IconButton,
  Stack,
  SvgIcon,
  Typography,
  type SvgIconProps,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import FolderZipOutlinedIcon from "@mui/icons-material/FolderZipOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import { LayerArrowUp, PawPrint, Stamp } from "lucide-react";
import { preloadUnionWasm } from "../geometry/unionSolid";
import {
  bumpCoffeeFollowUpShows,
  loadCoffeeFollowUpHidden,
  saveCoffeeFollowUpHidden,
} from "../storage";

const BMC_HREF = "https://www.buymeacoffee.com/vojtavozda";
const BMC_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=vojtavozda&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff";
const GITHUB_ISSUE_HREF =
  "https://github.com/vojtavozda/cookieshaper/issues/new";

function GithubIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.09.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12c0-5.523-4.477-10-10-10z" />
    </SvgIcon>
  );
}

function CoffeeAsk() {
  return (
    <>
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
    </>
  );
}

export type DownloadChoice =
  | "sketch"
  | "cutter"
  | "stamp"
  | "assembly"
  | "holder"
  | "zip";

type Props = {
  open: boolean;
  onClose: () => void;
  canSketch: boolean;
  canCutter: boolean;
  canStamp: boolean;
  /** Return true when a file was actually saved (not cancelled). */
  onChoose: (
    choice: DownloadChoice,
    onProgress?: (done: number, total: number) => void,
  ) => boolean | Promise<boolean>;
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
  const [followUp, setFollowUp] = useState(false);
  const [busyChoice, setBusyChoice] = useState<DownloadChoice | null>(null);
  const [zipProgress, setZipProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const busy = busyChoice != null;

  const requestClose = () => {
    if (downloaded && !loadCoffeeFollowUpHidden()) setFollowUp(true);
    onClose();
  };

  useEffect(() => {
    if (!open) {
      setDownloaded(false);
      setBusyChoice(null);
      setZipProgress(null);
      return;
    }
    // Warm manifold wasm while the user picks a download option.
    preloadUnionWasm();
  }, [open]);

  const run = async (choice: DownloadChoice) => {
    if (busy) return;
    setBusyChoice(choice);
    setZipProgress(null);
    // Let the busy spinner paint before sync-heavy STL/PDF work starts.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    try {
      const saved = await onChoose(
        choice,
        choice === "zip"
          ? (done, total) => {
              setZipProgress(total > 1 ? { done, total } : null);
            }
          : undefined,
      );
      if (saved) setDownloaded(true);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusyChoice(null);
      setZipProgress(null);
    }
  };

  const canZip = canSketch || canCutter || canStamp;

  return (
    <>
    <Dialog
      open={open}
      onClose={requestClose}
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
        onClick={requestClose}
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
            icon={<PawPrint size={22} strokeWidth={2} />}
            label="Cutter (STL)"
            hint="3D cookie cutter mesh"
            disabled={!canCutter || (busy && busyChoice !== "cutter")}
            loading={busyChoice === "cutter"}
            onClick={() => void run("cutter")}
          />
          <ChoiceButton
            icon={<Stamp size={22} strokeWidth={2} />}
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
            icon={<LayerArrowUp size={22} strokeWidth={2} />}
            label="Stamp holder (STL)"
            hint="Handle to glue onto the stamp plate"
            disabled={busy && busyChoice !== "holder"}
            loading={busyChoice === "holder"}
            onClick={() => void run("holder")}
          />
          <ChoiceButton
            icon={<FolderZipOutlinedIcon />}
            label={
              busyChoice === "zip" && zipProgress
                ? `Everything (ZIP) — ${zipProgress.done}/${zipProgress.total}`
                : "Everything (ZIP)"
            }
            hint="Sketch and nested cutter+stamp for each open tab, plus one stamp holder"
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
            <CoffeeAsk />
          </Box>
        )}
      </DialogContent>
    </Dialog>

    <CoffeeFollowUpDialog open={followUp} onClose={() => setFollowUp(false)} />
    </>
  );
}

const COFFEE_FOLLOW_DISMISS_AFTER = 10;

/** Coffee tip + GitHub issue prompt after a successful save / download. */
export function CoffeeFollowUpDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [offerHide, setOfferHide] = useState(false);
  const [hideChecked, setHideChecked] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hideCheckedRef = useRef(hideChecked);
  hideCheckedRef.current = hideChecked;
  const offerHideRef = useRef(offerHide);
  offerHideRef.current = offerHide;

  useEffect(() => {
    if (!open) return;
    if (loadCoffeeFollowUpHidden()) {
      onCloseRef.current();
      return;
    }
    const shows = bumpCoffeeFollowUpShows();
    setOfferHide(shows >= COFFEE_FOLLOW_DISMISS_AFTER);
    setHideChecked(false);
  }, [open]);

  const finish = () => {
    if (offerHideRef.current && hideCheckedRef.current) {
      saveCoffeeFollowUpHidden(true);
    }
    onCloseRef.current();
  };

  return (
    <Dialog
      open={open}
      onClose={finish}
      maxWidth="xs"
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
            px: 0.5,
            py: 0.5,
          },
        },
      }}
    >
      <IconButton
        aria-label="Close"
        onClick={finish}
        size="small"
        sx={{
          position: "absolute",
          top: 6,
          right: 6,
          zIndex: 1,
          color: "text.secondary",
        }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      <DialogContent
        sx={{
          textAlign: "center",
          px: 1.5,
          pt: 3.5,
          pb: 1.75,
          "&:first-of-type": { pt: 3.5 },
        }}
      >
        <CoffeeAsk />
        <Box
          sx={{
            mt: 2,
            pt: 1.75,
            borderTop: 1,
            borderColor: "divider",
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Found a bug? Have an idea for a new feature?
          </Typography>
          <Button
            component="a"
            href={GITHUB_ISSUE_HREF}
            target="_blank"
            rel="noopener noreferrer"
            variant="contained"
            startIcon={<GithubIcon sx={{ fontSize: 18 }} />}
            sx={{
              textTransform: "none",
              bgcolor: "#2b2b2b",
              color: "#fff",
              "&:hover": { bgcolor: "#111" },
            }}
          >
            Open an issue!
          </Button>
          {offerHide && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <FormControlLabel
                sx={{
                  mx: 0,
                  alignItems: "center",
                  textAlign: "left",
                  gap: 0.25,
                }}
                control={
                  <Checkbox
                    size="small"
                    checked={hideChecked}
                    onChange={(_, v) => setHideChecked(v)}
                    sx={{ py: 0, pl: 0.25, pr: 0.5 }}
                  />
                }
                label={
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.disabled",
                      lineHeight: 1.35,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Okay, okay, I will! Just don&apos;t show me this message again!
                  </Typography>
                }
              />
            </>
          )}
        </Box>
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
