/**
 * R2 F2 — the rulers repaint when the grid is toggled off and back on.
 *
 * Toggling the grid unmounts and remounts both ruler canvases. The fake 2D
 * context is a Proxy (any method read is a cached spy, any write is stored),
 * so the test does not break the next time Rulers gains a canvas call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

import { render, act, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import { Rulers } from "../Rulers";

const painted = new Set<HTMLCanvasElement>();
let restoreGetContext: (() => void) | null = null;
let restoreResizeObserver: (() => void) | null = null;

function makeFakeContext(): CanvasRenderingContext2D {
  const spies = new Map<string | symbol, ReturnType<typeof vi.fn>>();
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      let s = spies.get(prop);
      if (!s) {
        s = vi.fn();
        spies.set(prop, s);
      }
      return s;
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  painted.clear();
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement, kind: string) => unknown;
  };
  const original = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement) {
    painted.add(this);
    return makeFakeContext();
  };
  restoreGetContext = () => {
    proto.getContext = original;
  };

  const g = globalThis as unknown as { ResizeObserver: unknown };
  const originalRO = g.ResizeObserver;
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  restoreResizeObserver = () => {
    g.ResizeObserver = originalRO;
  };

  useStore.setState({ gridVisible: true, camera: { x: 0, y: 0, zoom: 1 } });
});

afterEach(() => {
  cleanup();
  restoreGetContext?.();
  restoreResizeObserver?.();
});

describe("Rulers remount (R2 F2)", () => {
  it("paints both new canvases after the grid is toggled off and on", () => {
    const { container } = render(<Rulers />);
    const first = Array.from(container.querySelectorAll("canvas"));
    expect(first).toHaveLength(2);
    for (const c of first) expect(painted.has(c)).toBe(true);

    act(() => useStore.setState({ gridVisible: false }));
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    act(() => useStore.setState({ gridVisible: true }));

    const second = Array.from(container.querySelectorAll("canvas"));
    expect(second).toHaveLength(2);
    for (const c of second) {
      expect(first).not.toContain(c);
      expect(painted.has(c)).toBe(true);
    }
  });
});
