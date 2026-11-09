import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
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
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { borderRadius: 1.5 } }}
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
      <DialogContent sx={{ pt: 0, pb: 2 }}>
        <TableContainer>
          <Table size="small" aria-label="Example sketches">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 120, borderBottomColor: "divider" }}>
                  Preview
                </TableCell>
                <TableCell sx={{ borderBottomColor: "divider" }}>Name</TableCell>
                <TableCell sx={{ borderBottomColor: "divider" }}>File</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {SKETCH_EXAMPLES.map((ex) => (
                <TableRow
                  key={ex.id}
                  hover
                  onClick={() => void pick(ex)}
                  sx={{
                    cursor: "pointer",
                    "&:last-child td": { borderBottom: 0 },
                  }}
                >
                  <TableCell sx={{ py: 1 }}>
                    <Box
                      component="img"
                      src={examplePreviewUrl(ex)}
                      alt=""
                      sx={{
                        width: 104,
                        height: 65,
                        objectFit: "contain",
                        display: "block",
                        borderRadius: 0.75,
                        border: 1,
                        borderColor: "divider",
                        bgcolor: "#fffaf5",
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {ex.title}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: "ui-monospace, monospace" }}
                    >
                      {ex.file}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
    </Dialog>
  );
}
