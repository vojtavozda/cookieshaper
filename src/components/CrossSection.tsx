import { Box, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { CutterParams } from "../types";

type Props = {
  params: CutterParams;
  onHide: () => void;
};

/**
 * Compact schematic of the cutter wall profile — overlay-friendly.
 */
export function CrossSection({ params, onHide }: Props) {
  const {
    rimWidthMm: rim,
    baseHeightMm: bh,
    wallThicknessMm: wt,
    wallHeightMm: wh,
    filletRadiusMm: fr,
    knifeHeightMm: kh,
  } = params;

  const half = wt / 2;
  const r = Math.min(fr, Math.max(0, rim - half), Math.max(0, wh - bh));

  const svgW = 132;
  const svgH = 128;
  const pad = 1.5;
  const totalH = wh + kh + pad * 2;
  const totalW = rim + half + pad * 2;
  const scale = Math.min((svgW - 20) / totalW, (svgH - 18) / totalH);
  const ox = 8;
  const oy = svgH - 6;

  const X = (x: number) => ox + (x + half + pad) * scale;
  const Y = (z: number) => oy - z * scale;

  const wallOuter = half;
  const wallInner = -half;

  const pts: [number, number][] = [
    [wallInner, 0],
    [rim, 0],
    [rim, bh],
    [wallOuter + r, bh],
  ];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = 1.5 * Math.PI - (i / steps) * (Math.PI / 2);
    pts.push([
      wallOuter + r + r * Math.cos(t),
      bh + r + r * Math.sin(t),
    ]);
  }
  pts.push([wallOuter, wh]);
  pts.push([0, wh + kh]);
  pts.push([wallInner, wh]);
  pts.push([wallInner, 0]);

  const d =
    pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`)
      .join(" ") + " Z";

  return (
    <Box
      sx={{
        width: svgW,
        bgcolor: "rgba(255,255,255,0.92)",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        boxShadow: 2,
        px: 0.5,
        pt: 0.25,
        pb: 0.25,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pointerEvents: "auto",
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
          Wall profile
        </Typography>
        <IconButton
          size="small"
          aria-label="Hide wall profile"
          onClick={onHide}
          sx={{ p: 0.25 }}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
      <svg
        width="100%"
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ pointerEvents: "none", display: "block" }}
      >
        <path d={d} fill="#e8d5b7" stroke="#8a6a45" strokeWidth={1.1} />
        <text x={X(0)} y={Y(wh + kh) - 4} textAnchor="middle" fontSize={8} fill="#666">
          knife
        </text>
        <text x={X(wallOuter + r + 0.5)} y={Y(bh + r * 0.6)} fontSize={8} fill="#666">
          bevel
        </text>
        <text
          x={X((wallInner + rim) / 2)}
          y={Y(bh / 2) + 3}
          textAnchor="middle"
          fontSize={8}
          fill="#666"
        >
          base
        </text>
      </svg>
    </Box>
  );
}
