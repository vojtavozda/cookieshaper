/**
 * Sketch examples served from `/examples` (Vite `public/examples`).
 * Add a PDF (+ optional PNG preview with the same stem) and list it here.
 */
export type SketchExample = {
  id: string;
  title: string;
  /** Filename under `/examples/`. */
  file: string;
  /** Preview image under `/examples/` (same stem `.png` by convention). */
  preview: string;
};

function titleFromStem(stem: string): string {
  return stem
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Hand-listed so production builds don't need a directory API. */
const EXAMPLE_FILES = ["car.pdf", "race_car.pdf"] as const;

export const SKETCH_EXAMPLES: SketchExample[] = EXAMPLE_FILES.map((file) => {
  const stem = file.replace(/\.pdf$/i, "");
  return {
    id: stem,
    title: titleFromStem(stem),
    file,
    preview: `${stem}.png`,
  };
});

export function examplePdfUrl(ex: SketchExample): string {
  return `/examples/${ex.file}`;
}

export function examplePreviewUrl(ex: SketchExample): string {
  return `/examples/${ex.preview}`;
}
