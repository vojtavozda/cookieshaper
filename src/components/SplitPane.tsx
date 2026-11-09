import { useCallback, useRef, useState } from "react";
import { Box, IconButton } from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";

const MIN_LEFT = 0.25;
/** Smallest the 3D pane stays while still visible (left = canvas). */
const MAX_LEFT = 0.75;
/** Drag past this (toward the right edge) and the 3D pane snaps shut. */
const COLLAPSE_AT = 0.92;

type Props = {
  left: React.ReactNode;
  right: React.ReactNode;
  initialLeftFrac?: number;
  initialCollapsed?: boolean;
  onLayoutChange?: (layout: { leftFrac: number; collapsed: boolean }) => void;
};

/** Horizontal split with a draggable divider. Dragging past the 3D minimum hides it. */
export function SplitPane({
  left,
  right,
  initialLeftFrac = 0.45,
  initialCollapsed = false,
  onLayoutChange,
}: Props) {
  const [frac, setFrac] = useState(initialLeftFrac);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [animate, setAnimate] = useState(false);
  const fracRef = useRef(frac);
  const collapsedRef = useRef(collapsed);
  const openFracRef = useRef(initialLeftFrac);
  fracRef.current = frac;
  collapsedRef.current = collapsed;
  const dragging = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onLayoutChange);
  onChangeRef.current = onLayoutChange;

  const publish = () => {
    onChangeRef.current?.({
      leftFrac: openFracRef.current,
      collapsed: collapsedRef.current,
    });
  };

  const apply = (nextFrac: number, nextCollapsed: boolean, snap: boolean) => {
    if (snap) setAnimate(true);
    if (!nextCollapsed) openFracRef.current = nextFrac;
    fracRef.current = nextFrac;
    collapsedRef.current = nextCollapsed;
    setFrac(nextFrac);
    setCollapsed(nextCollapsed);
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const next = (e.clientX - rect.left) / rect.width;
    if (next >= COLLAPSE_AT) {
      apply(openFracRef.current, true, !collapsedRef.current);
      return;
    }
    const clamped = Math.min(MAX_LEFT, Math.max(MIN_LEFT, next));
    apply(clamped, false, collapsedRef.current);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    setAnimate(false);
    publish();
  }, [onPointerMove]);

  const reopen = () => {
    apply(openFracRef.current, false, true);
    window.setTimeout(() => setAnimate(false), 180);
    publish();
  };

  return (
    <Box
      ref={rootRef}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", position: "relative" }}
    >
      <Box
        sx={{
          width: collapsed ? "100%" : `${frac * 100}%`,
          transition: animate ? "width 160ms ease" : "none",
          minWidth: 0,
          minHeight: 0,
          display: "flex",
        }}
      >
        {left}
      </Box>
      {!collapsed && (
        <Box
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = true;
            setAnimate(false);
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
          }}
          sx={{
            width: 6,
            flexShrink: 0,
            cursor: "col-resize",
            bgcolor: "divider",
            "&:hover": { bgcolor: "primary.light" },
            zIndex: 2,
          }}
        />
      )}
      <Box
        sx={{
          flex: collapsed ? "0 0 0px" : 1,
          width: collapsed ? 0 : undefined,
          overflow: "hidden",
          minWidth: 0,
          minHeight: 0,
          display: collapsed ? "none" : "flex",
        }}
      >
        {right}
      </Box>
      {collapsed && (
        <IconButton
          aria-label="Show 3D view"
          onClick={reopen}
          size="small"
          sx={{
            position: "absolute",
            right: 0,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 3,
            width: 22,
            height: 44,
            borderRadius: "8px 0 0 8px",
            bgcolor: "background.paper",
            border: 1,
            borderRight: 0,
            borderColor: "divider",
            boxShadow: 1,
            "&:hover": { bgcolor: "grey.100" },
          }}
        >
          <ChevronLeftIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
