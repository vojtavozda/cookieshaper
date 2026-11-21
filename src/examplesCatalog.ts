/**
 * Sketch examples from `public/examples`.
 * Build-time glob pairs each `*.pdf` with a same-stem `*.png` (case-sensitive).
 */

export type SketchExample = {
  id: string;
  title: string;
  /** Filename under `/examples/`. */
  file: string;
  /** Preview image under `/examples/`. */
  preview: string;
};

/** Caption: underscores → spaces, original case kept. */
export function titleFromStem(stem: string): string {
  return stem.replace(/_/g, " ");
}

function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function stemBeforeExt(name: string, ext: string): string | null {
  if (name.length <= ext.length) return null;
  if (name.slice(-ext.length).toLowerCase() !== ext.toLowerCase()) return null;
  return name.slice(0, -ext.length);
}

// Eager keys only — files stay in `public/` and are fetched as `/examples/…`.
const pdfGlob = import.meta.glob("../public/examples/*.pdf");
const pngGlob = import.meta.glob("../public/examples/*.png");

const pdfByStem = new Map<string, string>();
for (const path of Object.keys(pdfGlob)) {
  const file = fileName(path);
  const stem = stemBeforeExt(file, ".pdf");
  if (stem) pdfByStem.set(stem, file);
}

const pngByStem = new Map<string, string>();
for (const path of Object.keys(pngGlob)) {
  const file = fileName(path);
  const stem = stemBeforeExt(file, ".png");
  if (stem) pngByStem.set(stem, file);
}

export const SKETCH_EXAMPLES: SketchExample[] = [...pdfByStem.entries()]
  .filter(([stem]) => pngByStem.has(stem))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([stem, file]) => ({
    id: stem,
    title: titleFromStem(stem),
    file,
    preview: pngByStem.get(stem)!,
  }));

export function examplePdfUrl(ex: SketchExample): string {
  return `/examples/${ex.file}`;
}

export function examplePreviewUrl(ex: SketchExample): string {
  return `/examples/${ex.preview}`;
}
