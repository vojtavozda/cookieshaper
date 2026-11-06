import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";

/** Curve with control points — clearer than a generic edit pencil. */
export function EditCurveIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path
        d="M4 16 C8 16, 10 8, 14 8 S20 12, 20 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="4" cy="16" r="2" fill="currentColor" />
      <circle cx="14" cy="8" r="2" fill="currentColor" />
      <circle cx="20" cy="8" r="2" fill="currentColor" />
    </SvgIcon>
  );
}
