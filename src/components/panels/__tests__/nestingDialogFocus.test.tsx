/**
 * refresh-editing-shortcuts fix5 (Jen C2): Auto-Nest opens on the Spacing number
 * field (the range slider paints no focus ring), and the slider stays tabbable.
 * jsdom's offsetParent is stubbed so the trap sees children as a browser does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import { NestingDialog } from "../NestingDialog";

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
beforeEach(() => {
  cleanup();
  useStore.setState({ openDialogs: new Set(), snapToGrid: false });
});

describe("Auto-Nest initial focus", () => {
  it("opens on the Spacing number field; the slider keeps its Tab stop", () => {
    const { container } = render(<NestingDialog open onClose={() => {}} />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    const field = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(slider.tabIndex).toBe(0);
    expect(slider.hasAttribute("tabindex")).toBe(false);
  });
});
