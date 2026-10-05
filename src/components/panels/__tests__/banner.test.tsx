/**
 * Banner (UI polish P2): the presentational notice A3, A4, A5, A11 and A12
 * consume. Three contracts: each tone draws its own tokens; no ARIA role unless
 * the caller passes one; an action's onClick is the button's own DOM handler, so
 * it is called once per click with the click event and nothing else.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { Banner, type BannerTone } from "../Banner";

afterEach(cleanup);

const TONE_TOKENS: Record<BannerTone, [string, string]> = {
  warning: ["var(--warning-bg)", "var(--warning-border)"],
  danger: ["var(--danger-bg)", "var(--danger-border)"],
  success: ["var(--success-bg)", "var(--success-border)"],
  info: ["var(--accent-bg)", "var(--accent-border)"],
};

function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

describe("Banner tones", () => {
  for (const tone of Object.keys(TONE_TOKENS) as BannerTone[]) {
    it(`${tone} renders its -bg and -border tokens`, () => {
      const { container } = render(<Banner tone={tone} title="T" body="B" />);
      const el = root(container);
      const [bg, border] = TONE_TOKENS[tone];
      expect(el.style.background).toBe(bg);
      expect(el.style.borderTopColor).toBe(border);
      expect(el.style.borderLeftColor).toBe(border);
      expect(el.style.borderWidth).toBe("1px");
      // no other tone's tokens leak in
      for (const other of Object.keys(TONE_TOKENS) as BannerTone[]) {
        if (other === tone) continue;
        expect(el.getAttribute("style")).not.toContain(TONE_TOKENS[other][0]);
      }
      expect(el.getAttribute("style")).toContain(bg);
    });
  }

  it("padding, radius and 11px body follow the spec", () => {
    const el = root(render(<Banner tone="info" body="B" />).container);
    expect(el.style.padding).toBe("8px 10px");
    expect(el.style.borderRadius).toBe("var(--radius-sm)");
    expect(el.style.fontSize).toBe("var(--text-xs)");
  });

  it("leftRule draws a 3px rule in the tone's mark colour", () => {
    const el = root(render(<Banner tone="danger" body="B" leftRule />).container);
    expect(el.style.borderWidth).toBe("1px 1px 1px 3px");
    expect(el.style.borderLeftColor).toBe("var(--danger)");
    cleanup();
    const plain = root(render(<Banner tone="danger" body="B" />).container);
    expect(plain.style.borderWidth).toBe("1px");
    expect(plain.style.borderLeftColor).toBe("var(--danger-border)");
  });

  it("renders title and body text", () => {
    render(<Banner tone="warning" title="Heads up" body="Details here" />);
    expect(screen.getByText("Heads up")).toBeTruthy();
    expect(screen.getByText("Details here")).toBeTruthy();
  });
});

describe("Banner role", () => {
  it("has no role attribute unless one is passed", () => {
    for (const tone of Object.keys(TONE_TOKENS) as BannerTone[]) {
      const { container } = render(<Banner tone={tone} title="T" />);
      expect(container.querySelector("[role]")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      cleanup();
    }
  });

  it("renders the role the caller passes", () => {
    render(<Banner tone="danger" title="T" role="alert" />);
    expect(screen.getByRole("alert")).toBeTruthy();
    cleanup();
    render(<Banner tone="warning" title="T" role="status" />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("Banner actions", () => {
  it("calls each action's onClick once per click, with the click event and nothing else", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <Banner
        tone="warning"
        title="T"
        actions={[
          { label: "One", onClick: first },
          { label: "Two", onClick: second },
        ]}
      />
    );
    const one = screen.getByRole("button", { name: "One" });
    fireEvent.click(one);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    const args = first.mock.calls[0];
    expect(args).toHaveLength(1);
    const ev = args[0] as { type: string; currentTarget: unknown; target: unknown };
    expect(ev.type).toBe("click");
    expect(ev.target).toBe(one);

    fireEvent.click(one);
    expect(first).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]).toHaveLength(1);
  });

  it("renders no buttons when there are no actions", () => {
    render(<Banner tone="success" title="T" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
