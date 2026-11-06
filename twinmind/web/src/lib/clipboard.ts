/**
 * Copy buttons (ours and the AI Elements ones) use navigator.clipboard.writeText. Browsers only
 * offer it in secure contexts, so with Home Assistant opened over plain http:// it is missing and
 * the buttons silently did nothing; some app WebViews also reject it. Fill in a writeText that
 * falls back to the old execCommand("copy"), so every copy button works without touching the
 * upstream components.
 */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-screen but selectable; 16px avoids iOS zooming in.
  Object.assign(area.style, { position: "fixed", top: "0", left: "-9999px", opacity: "0", fontSize: "16px" });
  document.body.appendChild(area);
  const previous = document.activeElement as HTMLElement | null;
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus?.({ preventScroll: true });
  return ok;
}

export function installClipboardFallback(): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  const native = window.isSecureContext && clipboard?.writeText ? clipboard.writeText.bind(clipboard) : null;
  // Runs synchronously up to the first await, so the fallback still counts as part of the click.
  const writeText = async (text: string): Promise<void> => {
    if (native) {
      try {
        return await native(text);
      } catch {
        // e.g. a WebView without clipboard permission: try the old way.
      }
    }
    if (!legacyCopy(text)) throw new Error("Copying is not supported here");
  };
  if (clipboard) {
    try {
      Object.defineProperty(clipboard, "writeText", { value: writeText, configurable: true });
      return;
    } catch {
      // fall through and replace the whole object
    }
  }
  Object.defineProperty(navigator, "clipboard", { value: { ...(clipboard ?? {}), writeText }, configurable: true });
}
