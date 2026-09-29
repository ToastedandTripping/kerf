import { useEffect, useRef, type RefObject } from "react";

/** Shared with the central Tab fallback in shortcuts.ts. */
export const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Traps keyboard focus within `ref` when `open` is true.
 *
 * On open:  focuses `initialFocus` if given, else the first focusable element inside `ref`
 *           (pass initialFocus when the first element is destructive).
 * On Tab:   wraps to the first element when at the last.
 * On Shift+Tab: wraps to the last element when at the first.
 * On close: restores focus to the element that triggered the dialog, but only
 *           if focus is on body or still inside the closing dialog. Another dialog
 *           that opened in the same commit keeps its focus.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  initialFocus?: RefObject<HTMLElement | null>
): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      // Restore focus on close
      if (previousFocusRef.current) {
        const active = document.activeElement;
        const focusLeftWithDialog =
          !active || active === document.body || !!dialogElRef.current?.contains(active);
        if (focusLeftWithDialog) previousFocusRef.current.focus();
        previousFocusRef.current = null;
      }
      dialogElRef.current = null;
      return;
    }

    // Store the element that had focus before the dialog opened
    previousFocusRef.current = document.activeElement as HTMLElement;

    const el = ref.current;
    if (!el) return;
    dialogElRef.current = el;

    // Move initial focus to first focusable element
    const getFocusable = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)).filter(
        (node) => !node.closest("[disabled]") && node.offsetParent !== null
      );

    const focusable = getFocusable();
    if (initialFocus?.current && el.contains(initialFocus.current)) {
      initialFocus.current.focus();
    } else if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      el.setAttribute("tabindex", "-1");
      el.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const nodes = getFocusable();
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    el.addEventListener("keydown", handleKeyDown);
    return () => {
      el.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, ref, initialFocus]);
}
