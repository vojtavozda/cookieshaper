import { Box, IconButton, Tab, Tabs, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { Library } from "lucide-react";
import type { SketchTab } from "../geometry/sketchDraft";

/** Same hue as the cutter orange (#c45c26). Set to null for paper background. */
export const SKETCH_TAB_BG: string | null = "#a3481e";
export const SKETCH_TAB_FG = "rgba(255,248,243,0.85)";
export const SKETCH_TAB_HOVER_BG = "rgba(0,0,0,0.18)";
const TAB_ACTIVE = "#f0b48a";

type Props = {
  tabs: SketchTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onOpenLibrary: () => void;
  onHide: () => void;
};

export function SketchTabsBar({
  tabs,
  activeId,
  onSelect,
  onCloseTab,
  onNewTab,
  onOpenLibrary,
  onHide,
}: Props) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        minWidth: 0,
        bgcolor: SKETCH_TAB_BG ?? "background.paper",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Tooltip title="Browse library">
        <IconButton
          aria-label="Browse library"
          size="small"
          onClick={onOpenLibrary}
          sx={{
            m: 0,
            p: 0,
            width: 32,
            height: 32,
            borderRadius: 0,
            color: SKETCH_TAB_BG ? SKETCH_TAB_FG : "inherit",
            "&:hover": SKETCH_TAB_BG
              ? { color: "#fff8f3", bgcolor: SKETCH_TAB_HOVER_BG }
              : undefined,
          }}
        >
          <Library size={18} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tabs
        value={tabs.some((t) => t.id === activeId) ? activeId : false}
        onChange={(_, id: string) => {
          if (id === "new-sketch") {
            onNewTab();
            return;
          }
          onSelect(id);
        }}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Sketches"
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 32,
          "& .MuiTab-root": {
            minWidth: 0,
            minHeight: 32,
            px: 1,
            py: 0,
            color: SKETCH_TAB_BG ? SKETCH_TAB_FG : undefined,
            "&:hover": SKETCH_TAB_BG
              ? { bgcolor: SKETCH_TAB_HOVER_BG, opacity: 1 }
              : undefined,
            "&.Mui-selected": {
              color: SKETCH_TAB_BG ? TAB_ACTIVE : undefined,
            },
          },
          "& .MuiTabs-indicator": {
            backgroundColor: SKETCH_TAB_BG ? TAB_ACTIVE : undefined,
          },
          "& .MuiTabs-scrollButtons": {
            color: SKETCH_TAB_BG ? SKETCH_TAB_FG : undefined,
            "&:hover": SKETCH_TAB_BG
              ? { color: "#fff8f3", bgcolor: SKETCH_TAB_HOVER_BG }
              : undefined,
            "&.Mui-disabled": {
              opacity: 0.35,
              color: SKETCH_TAB_BG ? SKETCH_TAB_FG : undefined,
            },
          },
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            value={tab.id}
            title={tab.name}
            sx={{
              textTransform: "none",
              "&.Mui-selected": {
                color: SKETCH_TAB_BG ? TAB_ACTIVE : undefined,
              },
            }}
            label={
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  maxWidth: 200,
                }}
              >
                <Box
                  component="span"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: tab.id === activeId && SKETCH_TAB_BG ? TAB_ACTIVE : "inherit",
                  }}
                >
                  {tab.name}
                </Box>
                <Box
                  component="span"
                  role="button"
                  aria-label={`Close ${tab.name}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  sx={{
                    display: "inline-flex",
                    color: "inherit",
                    borderRadius: "50%",
                    "&:hover": { opacity: 1, bgcolor: "rgba(255,255,255,0.12)" },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </Box>
              </Box>
            }
          />
        ))}
        <Tab
          value="new-sketch"
          aria-label="New sketch"
          title="New sketch"
          label="+"
          sx={{ minWidth: 40, px: 1, fontSize: 20, fontWeight: 500 }}
        />
      </Tabs>
      <Tooltip title="Hide tabs">
        <IconButton
          aria-label="Hide tabs"
          size="small"
          onClick={onHide}
          sx={{
            m: 0,
            p: 0,
            width: 32,
            height: 32,
            borderRadius: 0,
            color: SKETCH_TAB_FG,
            bgcolor: "transparent",
            "&:hover": { color: SKETCH_TAB_FG, bgcolor: SKETCH_TAB_HOVER_BG },
          }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
