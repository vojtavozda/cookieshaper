/** Default cookie / project title shown on the canvas. */
export const DEFAULT_PROJECT_NAME = "Pernickovadlo";

/**
 * Soft-clean a canvas / PDF title (keeps Unicode; strips controls).
 * Prefer this for UI + PDF metadata; use {@link projectFileBase} for filenames.
 */
export function projectDisplayName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || DEFAULT_PROJECT_NAME).slice(0, 120);
}

/**
 * Sanitize a display name into a safe download basename
 * (spaces → `_`, inverse of {@link projectNameFromFilename}).
 */
export function projectFileBase(name: string): string {
  const cleaned = projectDisplayName(name)
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return (cleaned || DEFAULT_PROJECT_NAME).slice(0, 120);
}

/** Title from a dropped/imported filename (extension stripped, `_` → space). */
export function projectNameFromFilename(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "");
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/_/g, " ")
    .replace(/[<>:"/\\|?*]+/g, "");
  return projectDisplayName(stem);
}

/** First free download basename; `Heart`, `Heart-2`, `Heart-3`, … */
export function uniqueFileBase(name: string, used: Set<string>): string {
  const base = projectFileBase(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  const next = `${base}-${i}`;
  used.add(next);
  return next;
}

/** Filenames derived from the canvas project name. */
export function projectExportNames(name: string) {
  const base = projectFileBase(name);
  return {
    base,
    pdf: `${base}.pdf`,
    cutter: `${base}-cutter.stl`,
    stamp: `${base}-stamp.stl`,
    assembly: `${base}-cutter-stamp.stl`,
    holder: `${base}-holder.stl`,
    zip: `${base}.zip`,
  };
}
