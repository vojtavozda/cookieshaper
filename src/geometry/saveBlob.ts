/** Result of a user-facing save attempt. */
export type SaveResult = "saved" | "cancelled";

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
};

function acceptForFilename(filename: string): {
  description: string;
  accept: Record<string, string[]>;
} {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return { description: "PDF", accept: { "application/pdf": [".pdf"] } };
  }
  if (lower.endsWith(".stl")) {
    return {
      description: "STL",
      accept: { "model/stl": [".stl"], "application/sla": [".stl"] },
    };
  }
  if (lower.endsWith(".zip")) {
    return { description: "ZIP", accept: { "application/zip": [".zip"] } };
  }
  return { description: "File", accept: { "application/octet-stream": ["*"] } };
}

/** Anchor download — used when the File System Access API is unavailable. */
function triggerAnchorDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Best-effort wait until a native “Save as” dialog (if any) is dismissed.
 * Anchor downloads don't expose that event; blur→focus is the usual signal.
 */
function waitForPossibleSaveDialog(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(autoTimer);
      window.clearTimeout(safetyTimer);
      resolve();
    };
    const onFocus = () => finish();
    // No picker (browser auto-saves to Downloads): don't block the UI long.
    const autoTimer = window.setTimeout(finish, 700);
    const safetyTimer = window.setTimeout(finish, 180_000);
    window.addEventListener("focus", onFocus);
    // If the page lost focus (picker open), wait for focus instead of the short timer.
    window.setTimeout(() => {
      if (!document.hasFocus()) window.clearTimeout(autoTimer);
    }, 120);
  });
}

/**
 * Save a blob with the system file picker when available, so callers can
 * await until the user finishes (or cancels) the native dialog.
 */
export async function saveBlob(
  blob: Blob,
  filename: string,
): Promise<SaveResult> {
  const w = window as SaveFilePickerWindow;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [acceptForFilename(filename)],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return "cancelled";
      }
      // Permission / unsupported edge cases → fall through to anchor download.
    }
  }

  triggerAnchorDownload(blob, filename);
  await waitForPossibleSaveDialog();
  return "saved";
}
