/**
 * refresh-editing-shortcuts fix4: useFocusTrap restore and initial focus.
 * jsdom's offsetParent is always null, which makes the trap treat every child as
 * hidden; stub it so the trap sees children the way a browser does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { useRef } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { useFocusTrap } from "../useFocusTrap";
import { OnboardingOverlay } from "../../../components/panels/OnboardingOverlay";

const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentNode;
    },
  });
});
afterAll(() => {
  if (desc) Object.defineProperty(HTMLElement.prototype, "offsetParent", desc);
});
beforeEach(() => cleanup());

function Dialog({ open, name }: { open: boolean; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open);
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={name}>
      <button>{name} button</button>
    </div>
  );
}

/** B sits before A in the tree, as ImageImportDialog sits before PdfImportDialog in App. */
function Pair({ a, b }: { a: boolean; b: boolean }) {
  return (
    <>
      <button>opener</button>
      <Dialog open={b} name="B" />
      <Dialog open={a} name="A" />
    </>
  );
}

describe("useFocusTrap restore on close", () => {
  it("does not pull focus back to the opener when another dialog opened in the same commit", () => {
    const r = render(<Pair a={false} b={false} />);
    r.getByText("opener").focus();
    r.rerender(<Pair a={true} b={false} />);
    expect(document.activeElement?.textContent).toBe("A button");

    // A closes and B opens in one commit (App's PDF -> image import handoff)
    r.rerender(<Pair a={false} b={true} />);
    expect(document.activeElement?.textContent).toBe("B button");
  });

  it("still restores focus to the opener after a plain close (positive control)", () => {
    const r = render(<Pair a={false} b={false} />);
    const opener = r.getByText("opener");
    opener.focus();
    r.rerender(<Pair a={true} b={false} />);
    expect(document.activeElement?.textContent).toBe("A button");
    r.rerender(<Pair a={false} b={false} />);
    expect(document.activeElement).toBe(opener);
  });
});

describe("onboarding initial focus is not the dismiss-forever Skip button", () => {
  it("focus lands on Next", () => {
    render(<OnboardingOverlay onClose={() => {}} />);
    act(() => {});
    expect(document.activeElement?.textContent).toBe("Next");
  });
});
