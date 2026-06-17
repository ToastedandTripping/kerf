import { useEffect } from "react";

/**
 * Registers a keydown listener for Escape when `open` is true and calls
 * `onClose`. Extracted from NestingDialog so all modal dialogs share the
 * same pattern.
 */
export function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);
}
