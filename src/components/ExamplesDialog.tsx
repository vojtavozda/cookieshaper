import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import {
  SKETCH_EXAMPLES,
  examplePdfUrl,
  examplePreviewUrl,
  type SketchExample,
} from "../examplesCatalog";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with the example PDF, same as a drop/paste. */
  onPick: (file: File) => void;
};

async function fetchExampleFile(ex: SketchExample): Promise<File> {
  const res = await fetch(examplePdfUrl(ex));
  if (!res.ok) throw new Error(`Could not load ${ex.file}`);
  const blob = await res.blob();
  return new File([blob], ex.file, {
    type: blob.type || "application/pdf",
  });
}

export function ExamplesDialog({ open, onClose, onPick }: Props) {
  const pick = async (ex: SketchExample) => {
    try {
      const file = await fetchExampleFile(ex);
      onPick(file);
      onClose();
    } catch {
      window.alert(`Could not load example “${ex.title}”`);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: { sx: { borderRadius: 1.5 } },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pr: 1,
          py: 1.25,
        }}
      >
        <Typography component="span" variant="h6" sx={{ fontSize: 18 }}>
          Load example
        </Typography>
        <IconButton size="small" aria-label="Close" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 0.5, pb: 2.5 }}>
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1.5,
            justifyContent: "flex-start",
          }}
        >
          {SKETCH_EXAMPLES.map((ex) => (
            <Box
              key={ex.id}
              component="button"
              type="button"
              onClick={() => void pick(ex)}
              sx={{
                all: "unset",
                cursor: "pointer",
                width: 148,
                boxSizing: "border-box",
                borderRadius: 1,
                border: 1,
                borderColor: "divider",
                bgcolor: "#fffaf5",
                overflow: "hidden",
                transition: "border-color 120ms, box-shadow 120ms",
                "&:hover": {
                  borderColor: "#c45c26",
                  boxShadow: "0 1px 4px rgba(196,92,38,0.18)",
                },
                "&:focus-visible": {
                  outline: "2px solid #c45c26",
                  outlineOffset: 2,
                },
              }}
            >
              <Box
                component="img"
                src={examplePreviewUrl(ex)}
                alt=""
                sx={{
                  width: "100%",
                  height: 92,
                  objectFit: "contain",
                  display: "block",
                  bgcolor: "#fffaf5",
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  textAlign: "center",
                  px: 0.75,
                  py: 0.75,
                  fontWeight: 600,
                  color: "text.primary",
                  lineHeight: 1.25,
                  userSelect: "none",
                }}
              >
                {ex.title}
              </Typography>
            </Box>
          ))}
        </Box>
        {SKETCH_EXAMPLES.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No examples found in /examples (need matching .pdf + .png).
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
