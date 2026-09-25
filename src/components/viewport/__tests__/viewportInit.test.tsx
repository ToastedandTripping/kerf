/**
 * R2 F1 — the canvas draws on first paint, and a StrictMode double-mount never
 * lets the discarded Pixi app touch the live app's state.
 *
 * pixi.js is replaced by a fake built like the rulers' 2D-context fake: every
 * display object is a Proxy whose unknown property reads return a cached spy
 * (which returns the proxy, so calls chain) and whose writes are stored. The
 * fake therefore does not break the next time Viewport gains a Pixi call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Rust backend not available")),
}));

vi.mock("opentype.js", () => ({
  default: { load: vi.fn().mockRejectedValue(new Error("no fonts in jsdom")) },
}));

interface FakeNodeT {
  children: FakeNodeT[];
  parent: FakeNodeT | null;
  kind: string;
  calls: Map<string, ReturnType<typeof vi.fn>>;
  [k: string]: unknown;
}

const fake = vi.hoisted(() => {
  const nodes: FakeNodeT[] = [];
  const apps: FakeAppT[] = [];

  interface FakeAppT {
    init: ReturnType<typeof vi.fn>;
    resolveInit: () => void;
    screen: { width: number; height: number };
    canvas: HTMLCanvasElement;
    stage: FakeNodeT;
    destroy: ReturnType<typeof vi.fn>;
  }

  return { nodes, apps } as { nodes: FakeNodeT[]; apps: FakeAppT[] };
});

vi.mock("pixi.js", () => {
  function makePoint() {
    const p = { x: 0, y: 0, set: vi.fn() };
    p.set.mockImplementation((x: number, y?: number) => {
      p.x = x;
      p.y = y ?? x;
    });
    return p;
  }

  class FakeNode {
    constructor(kind: string) {
      const target = this as unknown as FakeNodeT;
      target.kind = kind;
      target.children = [];
      target.parent = null;
      target.calls = new Map();
      target.x = 0;
      target.y = 0;
      target.rotation = 0;
      target.alpha = 1;
      target.width = 0;
      target.height = 0;
      target.position = makePoint();
      target.pivot = makePoint();
      target.scale = makePoint();
      (target.scale as { x: number; y: number }).x = 1;
      (target.scale as { x: number; y: number }).y = 1;
      const own: Record<string, (...a: unknown[]) => unknown> = {
        addChild: (...cs: unknown[]) => {
          for (const c of cs as FakeNodeT[]) {
            c.parent = proxy;
            target.children.push(c);
          }
          return cs[0];
        },
        addChildAt: (c: unknown, i: unknown) => {
          (c as FakeNodeT).parent = proxy;
          target.children.splice(i as number, 0, c as FakeNodeT);
          return c;
        },
        removeChild: (c: unknown) => {
          const i = target.children.indexOf(c as FakeNodeT);
          if (i >= 0) target.children.splice(i, 1);
          (c as FakeNodeT).parent = null;
          return c;
        },
        removeChildren: () => {
          const out = target.children.splice(0);
          for (const c of out) c.parent = null;
          return out;
        },
      };
      for (const [k, fn] of Object.entries(own)) target.calls.set(k, vi.fn(fn));
      const proxy: FakeNodeT = new Proxy(target, {
        get(t, prop, recv) {
          if (typeof prop === "symbol" || prop === "then") return Reflect.get(t, prop, recv);
          if (prop in t) return Reflect.get(t, prop, recv);
          let spy = t.calls.get(prop);
          if (!spy) {
            spy = vi.fn(() => proxy);
            t.calls.set(prop, spy);
          }
          return spy;
        },
        set(t, prop, value) {
          return Reflect.set(t, prop, value);
        },
      }) as unknown as FakeNodeT;
      fake.nodes.push(proxy);
      return proxy;
    }
  }

  class Container extends FakeNode {
    constructor() {
      super("Container");
    }
  }
  class Graphics extends Container {
    constructor() {
      super();
      (this as unknown as FakeNodeT).kind = "Graphics";
    }
  }
  class Sprite extends Container {
    constructor() {
      super();
      (this as unknown as FakeNodeT).kind = "Sprite";
    }
  }
  class Text extends Container {
    constructor() {
      super();
      (this as unknown as FakeNodeT).kind = "Text";
    }
  }
  class TextStyle {
    constructor(opts: unknown) {
      Object.assign(this, opts);
    }
  }
  const Texture = { from: vi.fn(() => ({ destroy: vi.fn() })) };

  class Application {
    init: ReturnType<typeof vi.fn>;
    resolveInit!: () => void;
    screen = { width: 800, height: 600 };
    canvas = document.createElement("canvas");
    stage = new Container() as unknown as FakeNodeT;
    destroy = vi.fn();
    constructor() {
      const p = new Promise<void>((res) => {
        this.resolveInit = res;
      });
      this.init = vi.fn(() => p);
      fake.apps.push(this as never);
    }
  }

  return { Application, Container, Graphics, Sprite, Text, TextStyle, Texture };
});

import { render, act, cleanup } from "@testing-library/react";
import { useStore } from "../../../app/store";
import type { DesignObject } from "../../../app/types";
import { PX_PER_MM } from "../../../lib/constants";
import { Viewport } from "../Viewport";

function makeRect(id: string): DesignObject {
  return {
    id,
    type: "rectangle",
    name: `Rect ${id}`,
    transform: { x: 10, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    layerIndex: 0,
    visible: true,
    locked: false,
    fill: null,
    stroke: "#4a90e2",
    strokeWidth: 1,
    opacity: 1,
  };
}

/** Root of a node's parent chain. */
function rootOf(n: FakeNodeT): FakeNodeT {
  let cur = n;
  while (cur.parent) cur = cur.parent;
  return cur;
}

/** Graphics nodes that live in `app`'s stage subtree, in creation order. */
function graphicsOf(app: (typeof fake.apps)[number]): FakeNodeT[] {
  return fake.nodes.filter((n) => n.kind === "Graphics" && rootOf(n) === app.stage);
}

function rectCalls(n: FakeNodeT): unknown[][] {
  return (n.calls.get("rect")?.mock.calls ?? []) as unknown[][];
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  fake.nodes.length = 0;
  fake.apps.length = 0;
  useStore.setState({
    objects: [],
    objectsById: new Map(),
    selectedIds: [],
    selectedSet: new Set(),
    undoStack: [],
    redoStack: [],
    workspaceWidth: 500,
    workspaceHeight: 300,
    gridVisible: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Viewport init (R2 F1)", () => {
  it("draws the bed and grid on first paint with no interaction", async () => {
    render(<Viewport />);
    expect(fake.apps).toHaveLength(1);
    await act(async () => {
      fake.apps[0].resolveInit();
      await flush();
    });
    const gs = graphicsOf(fake.apps[0]);
    const workspace = gs[0];
    const grid = gs[1];
    expect(rectCalls(workspace)).toContainEqual([0, 0, 500 * PX_PER_MM, 300 * PX_PER_MM]);
    expect(grid.calls.get("moveTo")?.mock.calls.length ?? 0).toBeGreaterThan(0);
  });

  it("StrictMode: the discarded app never appends a canvas; the live app draws", async () => {
    const { container } = render(
      <React.StrictMode>
        <Viewport />
      </React.StrictMode>
    );
    expect(fake.apps).toHaveLength(2);
    await act(async () => {
      fake.apps[0].resolveInit();
      await flush();
      fake.apps[1].resolveInit();
      await flush();
    });
    expect(fake.apps[0].canvas.parentNode).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(fake.apps[1].canvas.parentNode).not.toBeNull();
    const workspace = graphicsOf(fake.apps[1])[0];
    expect(rectCalls(workspace)).toContainEqual([0, 0, 500 * PX_PER_MM, 300 * PX_PER_MM]);
  });

  it("StrictMode, out-of-order init: the discarded app's cleanup never clears the live app's state", async () => {
    render(
      <React.StrictMode>
        <Viewport />
      </React.StrictMode>
    );
    expect(fake.apps).toHaveLength(2);
    const [app1, app2] = fake.apps;

    // init#2 resolves first: app#2 goes live.
    await act(async () => {
      app2.resolveInit();
      await flush();
    });
    await act(async () => {
      useStore.getState().addObject(makeRect("r1"));
      await flush();
    });
    const world = app2.stage.children[0];
    const objectsContainer = world.children[2];
    expect(objectsContainer.children).toHaveLength(1);
    const liveGraphics = graphicsOf(app2);

    // Now init#1 resolves, and its chained cleanup runs.
    await act(async () => {
      app1.resolveInit();
      await flush();
    });
    await act(async () => {
      useStore.getState().updateObject("r1", {
        transform: { x: 12, y: 10, width: 20, height: 20, rotation: 0, scaleX: 1, scaleY: 1 },
      });
      await flush();
    });

    expect(app2.destroy).not.toHaveBeenCalled();
    expect(app1.destroy).toHaveBeenCalledTimes(1);
    expect(objectsContainer.children).toHaveLength(1);
    for (const g of liveGraphics) {
      expect(g.calls.get("destroy")?.mock.calls.length ?? 0).toBe(0);
    }
  });
});
