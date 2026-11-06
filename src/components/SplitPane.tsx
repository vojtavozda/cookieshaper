import { useCallback, useRef, useState } from "react";
import { Box } from "@mui/material";

type Props = {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Initial left pane fraction 0–1 */
  initialLeftFrac?: number;
};

/** Horizontal split with a draggable divider. */
export function SplitPane({ left, right, initialLeftFrac = 0.45 }: Props) {
  const [frac, setFrac] = useState(initialLeftFrac);
  const dragging = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const next = (e.clientX - rect.left) / rect.width;
    setFrac(Math.min(0.75, Math.max(0.25, next)));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  return (
    <Box
      ref={rootRef}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", position: "relative" }}
    >
      <Box sx={{ width: `${frac * 100}%`, minWidth: 0, minHeight: 0, display: "flex" }}>
        {left}
      </Box>
      <Box
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = true;
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
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>{right}</Box>
    </Box>
  );
}
