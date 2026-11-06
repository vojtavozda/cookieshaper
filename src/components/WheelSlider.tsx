import { Box, Slider, type SliderProps } from "@mui/material";
import { useEffect, useRef } from "react";

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * MUI Slider that nudges by one `step` on mouse-wheel while the pointer is over it.
 */
export function WheelSlider({
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onChange,
  sx,
  orientation,
  ...rest
}: SliderProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const optsRef = useRef({ min, max, step, disabled });
  valueRef.current = value;
  onChangeRef.current = onChange;
  optsRef.current = { min, max, step, disabled };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { min: minV, max: maxV, step: stepV, disabled: dis } = optsRef.current;
      const cur = valueRef.current;
      const change = onChangeRef.current;
      if (dis || cur == null || Array.isArray(cur) || !change) return;
      if (e.deltaY === 0 && e.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const dir = delta < 0 ? 1 : -1;
      const stepN = typeof stepV === "number" && stepV > 0 ? stepV : 1;
      const minN = typeof minV === "number" ? minV : 0;
      const maxN = typeof maxV === "number" ? maxV : 100;
      const rounded = Math.round((cur + dir * stepN) / stepN) * stepN;
      const next = Number(
        Math.min(maxN, Math.max(minN, rounded)).toFixed(decimalsOf(stepN)),
      );
      if (next === cur) return;
      change(e as unknown as Event, next, 0);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const sxObj = sx && typeof sx === "object" && !Array.isArray(sx) ? sx : null;
  const verticalH =
    orientation === "vertical" && sxObj && "height" in sxObj
      ? (sxObj as { height?: number | string }).height
      : orientation === "vertical"
        ? 120
        : undefined;

  return (
    <Box
      ref={wrapRef}
      sx={{
        display: "block",
        width: orientation === "vertical" ? "auto" : "100%",
        height: verticalH ?? "auto",
        touchAction: "none",
      }}
    >
      <Slider
        {...rest}
        orientation={orientation}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={onChange}
        sx={sx}
      />
    </Box>
  );
}
