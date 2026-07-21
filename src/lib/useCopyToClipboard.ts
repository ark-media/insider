import { useState } from "react";

// Copies text to the clipboard and flips a transient `copied` flag (auto-reset
// after `resetMs`) for "Copied ✓" affordances. `onSuccess` runs only after a
// successful write, for callers that also fire analytics or mark state. Copy
// failures are swallowed — these surfaces show the raw URL alongside as a manual
// fallback.
export function useCopyToClipboard(resetMs = 2200) {
  const [copied, setCopied] = useState(false);

  const copy = async (text: string, onSuccess?: () => void): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onSuccess?.();
      setTimeout(() => setCopied(false), resetMs);
    } catch {
      /* no-op */
    }
  };

  return { copied, copy };
}
