import { Box, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { CutterParams, StampParams } from "../types";

type Props = {
  params: CutterParams;
  /** Null when the cutter has no stamp. */
  stamp: StampParams | null;
  onHide: () => void;
};

function fmt(n: number) {
  const s = (Math.round(n * 100) / 100).toFixed(2);
  return s.replace(/0$/, "").replace(/\.0$/, "");
}

function arrowHead(x: number, y: number, ang: number) {
  const len = 3.2;
  const spread = 1.15;
  const bx = x - Math.cos(ang) * len;
  const by = y - Math.sin(ang) * len;
  const px = Math.cos(ang + Math.PI / 2) * spread;
  const py = Math.sin(ang + Math.PI / 2) * spread;
  return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(bx + px).toFixed(1)} ${(by + py).toFixed(1)} L ${(bx - px).toFixed(1)} ${(by - py).toFixed(1)} Z`;
}

function DimLine({
  x1,
  y1,
  x2,
  y2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  // Short spans get arrows outside the extension, pointing inward.
  const outside = len < 12;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#333" strokeWidth={0.45} />
      <path d={arrowHead(x2, y2, outside ? ang + Math.PI : ang)} fill="#333" />
      <path d={arrowHead(x1, y1, outside ? ang : ang + Math.PI)} fill="#333" />
    </g>
  );
}

function profilePoints(params: CutterParams) {
  const half = params.wallThicknessMm / 2;
  const tipHalf = Math.min(half, Math.max(0, params.knifeTipMm / 2));
  const overhang = Math.max(0, params.rimWidthMm - half);
  const bh = params.baseHeightMm;
  const wh = params.wallHeightMm;
  const kh = params.knifeHeightMm;
  const rim = params.rimWidthMm;
  // No flange height → no fillet. No overhang → no protruding foot.
  const r =
    bh > 1e-6 && overhang > 1e-6
      ? Math.min(params.filletRadiusMm, overhang, Math.max(0, wh - bh))
      : 0;
  const pts: [number, number][] = [[-half, 0]];
  if (overhang > 1e-6 && bh > 1e-6) {
    pts.push([rim, 0], [rim, bh], [half + r, bh]);
    if (r > 1e-6) {
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const t = 1.5 * Math.PI - (i / steps) * (Math.PI / 2);
        pts.push([half + r + r * Math.cos(t), bh + r + r * Math.sin(t)]);
      }
    }
  } else {
    // No flange: rectangular wall. Missing this corner made the outline a triangle.
    pts.push([half, 0]);
  }
  pts.push([half, wh]);
  if (kh > 1e-6) {
    pts.push([tipHalf, wh + kh], [-tipHalf, wh + kh]);
  }
  pts.push([-half, wh]);
  pts.push([-half, 0]);
  return { pts, half, r, overhang, wh, kh, bh, rim, tipHalf };
}

function LargeProfile({
  params,
  stamp,
}: {
  params: CutterParams;
  stamp: StampParams | null;
}) {
  const { pts, half, r, overhang, wh, kh, bh, rim } = profilePoints(params);
  const overall = wh + kh;
  const showStamp = stamp != null;
  const plate = stamp?.plateMm ?? 0;
  const raise = stamp?.raiseMm ?? 0;
  const gap = Math.max(0, stamp?.gapMm ?? 0);
  const recess = stamp ? Math.min(stamp.recessMm, plate) : 0;
  // Flange exists only when both overhang and height are positive (matches 3D).
  const showFlange = bh > 1e-6 && overhang > 1e-6;
  const showBevel = showFlange && r > 0.05;
  const recessThrough = showStamp && recess >= plate - 1e-6;

  // Shared mm→px scale for cutter and stamp so plate/base tops can line up.
  const S = 108 / Math.max(overall, plate + raise, 4);
  const stampWmm = 6.2;
  const stampW = showStamp ? stampWmm * S : 0;

  // Room above the profile so Stamp/Cutter stay above the wall-thickness label.
  const topPad = 46;
  const bottomPad = showStamp ? 36 : 28;
  const profileH = overall * S;
  const svgH = topPad + profileH + bottomPad;

  // Extra left room so the rotated Height label is not clipped; less empty right.
  const heightCol = 22;
  const plateLabelCol = showStamp ? 16 : 0;
  const leftPad = 14 + heightCol + plateLabelCol;
  const stampX = showStamp ? leftPad : 0;
  const gapPx = showStamp ? Math.max(gap, 0.15) * S : 0;
  // Wall origin: outer/inner centered on wall; leave room for gap when stamp is shown.
  const ox = showStamp
    ? stampX + stampW + gapPx + half * S
    : leftPad + half * S + 20;
  const rightDim = ox + Math.max(rim, half) * S + 10;
  const svgW = rightDim + 58;

  const baseY = topPad + profileH;
  const X = (xmm: number) => ox + xmm * S;
  const Y = (zmm: number) => baseY - zmm * S;

  const d =
    pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`)
      .join(" ") + " Z";

  const stampBottom = baseY;
  const stampTop = stampBottom - plate * S;
  const raiseTop = stampTop - raise * S;
  const raiseX0 = stampX + 0.35 * S;
  const raiseX1 = stampX + 2.5 * S;
  const recessX0 = stampX + 3.5 * S;
  const recessX1 = stampX + 5.7 * S;
  const recessW = recessX1 - recessX0;
  const recessDimX = recessX0 + recessW * 0.8;
  const recessTop = stampTop;
  const recessBot = stampTop + recess * S;
  const stampRight = stampX + stampW;
  const wallInnerX = X(-half);
  const wallOuterX = X(half);

  const label = {
    fontSize: 7,
    fill: "#222",
    fontFamily: "system-ui, sans-serif",
  };
  const caption = {
    fontSize: 9,
    fontWeight: 600,
    fill: "#444",
    fontFamily: "system-ui, sans-serif",
  };

  const ext = { stroke: "#9a9a9a", strokeWidth: 0.4 };

  const bevelCx = half + r;
  const bevelCz = bh + r;
  const bevelMid = 1.25 * Math.PI;
  const bevelLabelX = rightDim + 5;
  const bevelLabelY = Y(bevelCz) - 10;
  const bevelPad = 6;
  const bx0 = X(bevelCx);
  const by0 = Y(bevelCz);
  const leaderAng = Math.atan2(by0 - (bevelLabelY + 4), bx0 - bevelLabelX);
  const leaderStartX = bevelLabelX + Math.cos(leaderAng) * bevelPad;
  const leaderStartY = bevelLabelY + 4 + Math.sin(leaderAng) * bevelPad;
  const leaderEndX = bx0 - Math.cos(leaderAng) * bevelPad;
  const leaderEndY = by0 - Math.sin(leaderAng) * bevelPad;

  const heightDimX = 16;
  const heightLabelX = 8;
  const topsAligned = showStamp && Math.abs(plate - bh) < 1e-6 && showFlange;

  return (
    <svg
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      preserveAspectRatio="xMinYMin meet"
      style={{ pointerEvents: "none", display: "block", height: "auto" }}
    >
      {showStamp && (
        <>
          {/* Fixed near the top; the profile itself sits lower so these clear the wall-thickness label. */}
          <text {...caption} x={stampX + stampW / 2 - 14} y={12} textAnchor="middle">
            Stamp
          </text>
          <text
            {...caption}
            x={(wallInnerX + wallOuterX) / 2 + 14}
            y={12}
            textAnchor="middle"
          >
            Cutter
          </text>

          {/* Plate with recess cut out of the top (and bottom if through). */}
          {recessThrough ? (
            <>
              <path
                d={`M ${stampX} ${stampBottom} L ${recessX0} ${stampBottom} L ${recessX0} ${stampTop} L ${stampX} ${stampTop} Z`}
                fill="#efe4d2"
                stroke="#8a6a45"
                strokeWidth={1.1}
              />
              <path
                d={`M ${recessX1} ${stampBottom} L ${stampRight} ${stampBottom} L ${stampRight} ${stampTop} L ${recessX1} ${stampTop} Z`}
                fill="#efe4d2"
                stroke="#8a6a45"
                strokeWidth={1.1}
              />
              {/* Open recess sides — no top/bottom closing edges */}
              <line
                x1={recessX0}
                y1={stampTop}
                x2={recessX0}
                y2={stampBottom}
                stroke="#1e3a8a"
                strokeWidth={1}
              />
              <line
                x1={recessX1}
                y1={stampTop}
                x2={recessX1}
                y2={stampBottom}
                stroke="#1e3a8a"
                strokeWidth={1}
              />
            </>
          ) : recess > 1e-6 ? (
            <>
              <path
                d={[
                  `M ${stampX} ${stampBottom}`,
                  `L ${stampRight} ${stampBottom}`,
                  `L ${stampRight} ${stampTop}`,
                  `L ${recessX1} ${stampTop}`,
                  `L ${recessX1} ${recessBot}`,
                  `L ${recessX0} ${recessBot}`,
                  `L ${recessX0} ${stampTop}`,
                  `L ${stampX} ${stampTop}`,
                  "Z",
                ].join(" ")}
                fill="#efe4d2"
                stroke="#8a6a45"
                strokeWidth={1.1}
              />
              {/* Recess pocket: sides + bottom only (open top). */}
              <path
                d={`M ${recessX0} ${stampTop} L ${recessX0} ${recessBot} L ${recessX1} ${recessBot} L ${recessX1} ${stampTop}`}
                fill="none"
                stroke="#1e3a8a"
                strokeWidth={1}
              />
            </>
          ) : (
            <rect
              x={stampX}
              y={stampTop}
              width={stampW}
              height={plate * S}
              fill="#efe4d2"
              stroke="#8a6a45"
              strokeWidth={1.1}
            />
          )}

          {raise > 1e-6 && (
            <rect
              x={raiseX0}
              y={raiseTop}
              width={raiseX1 - raiseX0}
              height={raise * S}
              fill="#c45c26"
              stroke="#8a3b16"
              strokeWidth={1}
            />
          )}

          <line x1={stampX - 10} y1={stampBottom} x2={stampX} y2={stampBottom} {...ext} />
          <line x1={stampX - 10} y1={stampTop} x2={stampX} y2={stampTop} {...ext} />
          <DimLine x1={stampX - 10} y1={stampBottom} x2={stampX - 10} y2={stampTop} />
          <text
            {...label}
            textAnchor="start"
            dominantBaseline="middle"
            transform={`translate(${stampX - 20} ${stampBottom - 2}) rotate(-90)`}
          >
            {`Plate = ${fmt(plate)} mm`}
          </text>

          {raise > 1e-6 && (
            <>
              <line x1={raiseX0} y1={raiseTop} x2={raiseX0 - 5} y2={raiseTop} {...ext} />
              <line x1={raiseX0} y1={stampTop} x2={raiseX0 - 5} y2={stampTop} {...ext} />
              <DimLine x1={raiseX0 - 5} y1={stampTop} x2={raiseX0 - 5} y2={raiseTop} />
            </>
          )}
          <text {...label} x={raiseX0} y={Math.min(raiseTop, stampTop) - 11}>
            <tspan x={raiseX0} dy="0">
              Raise
            </tspan>
            <tspan x={raiseX0} dy="8">
              {`${fmt(raise)} mm`}
            </tspan>
          </text>

          {recess > 1e-6 && (
            <DimLine x1={recessDimX} y1={recessTop} x2={recessDimX} y2={recessBot} />
          )}
          <text
            {...label}
            x={recessX0}
            y={
              recess > 1e-6
                ? recessTop - 16
                : Math.min(raiseTop, stampTop) - 11
            }
          >
            <tspan x={recessX0} dy="0">
              Recess
            </tspan>
            <tspan x={recessX0} dy="8">
              {`${fmt(recess)} mm`}
            </tspan>
          </text>

        </>
      )}

      {/* Cutter cross-section */}
      <path d={d} fill="#e8d5b7" stroke="#8a6a45" strokeWidth={1.2} />

      {/* Drawn above the cutter so it isn’t covered by the fill; ends at the bevel’s outer corner. */}
      {topsAligned && (
        <line
          x1={stampRight}
          y1={stampTop}
          x2={X(half + r)}
          y2={Y(bh)}
          stroke="#9a9a9a"
          strokeWidth={0.7}
          strokeDasharray="3 2"
        />
      )}

      {/* Overall height */}
      <line x1={X(-half)} y1={Y(0)} x2={heightDimX + 4} y2={Y(0)} {...ext} />
      <line x1={X(-half)} y1={Y(overall)} x2={heightDimX + 4} y2={Y(overall)} {...ext} />
      <DimLine x1={heightDimX} y1={Y(0)} x2={heightDimX} y2={Y(overall)} />
      <text
        {...label}
        textAnchor="middle"
        transform={`translate(${heightLabelX} ${Y(overall / 2)}) rotate(-90)`}
      >
        {`Height = ${fmt(overall)} mm`}
      </text>

      {/* Wall thickness, above the knife */}
      <line x1={X(-half)} y1={Y(overall)} x2={X(-half)} y2={Y(overall) - 10} {...ext} />
      <line x1={X(half)} y1={Y(overall)} x2={X(half)} y2={Y(overall) - 10} {...ext} />
      <DimLine x1={X(-half)} y1={Y(overall) - 13} x2={X(half)} y2={Y(overall) - 13} />
      <text {...label} x={X(0)} y={Y(overall) - 18} textAnchor="middle">
        {`Wall thickness = ${fmt(params.wallThicknessMm)} mm`}
      </text>

      {/* Base width = UI overhang; only when a real flange exists (matches 3D). */}
      {showFlange && (
        <>
          <line x1={X(half)} y1={Y(0)} x2={X(half)} y2={Y(0) + 10} {...ext} />
          <line x1={X(rim)} y1={Y(0)} x2={X(rim)} y2={Y(0) + 10} {...ext} />
          <DimLine x1={X(half)} y1={Y(0) + 13} x2={X(rim)} y2={Y(0) + 13} />
          <text
            {...label}
            x={showStamp ? X(half) : X(half + overhang / 2)}
            y={Y(0) + 25}
            textAnchor={showStamp ? "start" : "middle"}
          >
            {`Base width = ${fmt(overhang)} mm`}
          </text>
        </>
      )}

      {/* Gap between stamp outer and cutter inner wall */}
      {showStamp && (
        <>
          <line
            x1={stampRight}
            y1={stampBottom}
            x2={stampRight}
            y2={stampBottom + 10}
            {...ext}
          />
          <line
            x1={wallInnerX}
            y1={Y(0)}
            x2={wallInnerX}
            y2={Y(0) + 10}
            {...ext}
          />
          <DimLine
            x1={stampRight}
            y1={stampBottom + 13}
            x2={wallInnerX}
            y2={Y(0) + 13}
          />
          <text
            {...label}
            x={stampRight}
            y={stampBottom + 25}
            textAnchor="end"
          >
            {`Gap = ${fmt(gap)} mm`}
          </text>
        </>
      )}

      {/* Knife edge height — extension lines meet the outer wall face */}
      {kh > 1e-6 && (
        <>
          <line x1={wallOuterX} y1={Y(wh)} x2={rightDim} y2={Y(wh)} {...ext} />
          <line x1={wallOuterX} y1={Y(overall)} x2={rightDim} y2={Y(overall)} {...ext} />
          <DimLine x1={rightDim} y1={Y(wh)} x2={rightDim} y2={Y(overall)} />
          <text {...label} x={rightDim + 5} y={Y(wh + kh / 2)}>
            <tspan x={rightDim + 5} dy="0">
              Knife
            </tspan>
            <tspan x={rightDim + 5} dy="8">
              {`${fmt(kh)} mm`}
            </tspan>
          </text>
        </>
      )}

      {showFlange && (
        <>
          <line x1={X(rim)} y1={Y(0)} x2={rightDim} y2={Y(0)} {...ext} />
          <line x1={X(rim)} y1={Y(bh)} x2={rightDim} y2={Y(bh)} {...ext} />
          <DimLine x1={rightDim} y1={Y(0)} x2={rightDim} y2={Y(bh)} />
          <text {...label} x={rightDim + 5} y={Y(Math.min(bh * 0.45, bh - 0.2))}>
            <tspan x={rightDim + 5} dy="0">
              Base height
            </tspan>
            <tspan x={rightDim + 5} dy="8">
              {`${fmt(bh)} mm`}
            </tspan>
          </text>
        </>
      )}

      {showBevel && (
        <>
          <path
            d={`M ${X(half + r).toFixed(1)} ${Y(bh).toFixed(1)} A ${r * S} ${r * S} 0 0 1 ${X(half).toFixed(1)} ${Y(bh + r).toFixed(1)}`}
            fill="none"
            stroke="#333"
            strokeWidth={0.8}
          />
          <circle cx={bx0} cy={by0} r={1.2} fill="#333" />
          <line
            x1={bx0}
            y1={by0}
            x2={X(bevelCx + r * Math.cos(bevelMid))}
            y2={Y(bevelCz + r * Math.sin(bevelMid))}
            stroke="#333"
            strokeWidth={0.55}
            strokeDasharray="2.5 1.5"
          />
          <line
            x1={leaderStartX}
            y1={leaderStartY}
            x2={leaderEndX}
            y2={leaderEndY}
            stroke="#333"
            strokeWidth={0.45}
          />
          <path d={arrowHead(leaderEndX, leaderEndY, leaderAng)} fill="#333" />
          <text {...label} x={bevelLabelX} y={bevelLabelY}>
            <tspan x={bevelLabelX} dy="0">
              Bevel radius
            </tspan>
            <tspan x={bevelLabelX} dy="8">
              {`${fmt(r)} mm`}
            </tspan>
          </text>
        </>
      )}
    </svg>
  );
}

export function CrossSection({ params, stamp, onHide }: Props) {
  return (
    <Box
      sx={{
        width: "100%",
        maxHeight: "100%",
        overflow: "hidden",
        bgcolor: "rgba(255,255,255,0.94)",
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
          gap: 0.5,
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
      <LargeProfile params={params} stamp={stamp} />
    </Box>
  );
}
