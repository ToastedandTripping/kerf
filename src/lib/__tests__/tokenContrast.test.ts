/**
 * UI polish A1 (principle 1): the contrast floor, read from the real tokens.
 *
 * Parses `:root` in src/index.css, composites alpha tokens over the panel
 * (the way they are painted), and asserts every pair the plan's principle-1
 * table lists. WCAG 2.x relative luminance, the same formula as the critics'
 * contrast.py.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const css = readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");
const rootBlock = (() => {
  const m = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error(":root block not found in src/index.css");
  return m[1].replace(/\/\*[\s\S]*?\*\//g, "");
})();

const tokens: Record<string, string> = {};
for (const m of rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();

type RGBA = { r: number; g: number; b: number; a: number };

function parseColor(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const p = rgba[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error(`unparseable colour: ${v}`);
}

function tok(name: string): RGBA {
  const v = tokens[name];
  if (v === undefined) throw new Error(`token ${name} missing from :root`);
  return parseColor(v);
}

/** Paint `fg` (with its own alpha) over an opaque `bg`. */
function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (c: RGBA) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(a: RGBA, b: RGBA): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const panel = () => tok("--bg-panel");
const input = () => tok("--bg-input");
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Every allowed text surface, composited over the panel where it is a tint. */
function surfaces(): Record<string, RGBA> {
  return {
    "--bg-app": tok("--bg-app"),
    "--bg-panel": panel(),
    "--bg-input": input(),
    "--bg-hover": tok("--bg-hover"),
    "--bg-elevated": tok("--bg-elevated"),
    "--bg-selected": over(tok("--bg-selected"), panel()),
    "--accent-bg": over(tok("--accent-bg"), panel()),
    "--warning-bg": over(tok("--warning-bg"), panel()),
    "--danger-bg": over(tok("--danger-bg"), panel()),
    "--success-bg": over(tok("--success-bg"), panel()),
    "expanded layer body": over({ r: 0, g: 0, b: 0, a: 0.15 }, panel()),
  };
}

describe("token contrast (principle 1)", () => {
  it("parses a non-trivial :root", () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(30);
    expect(tokens["--bg-panel"]).toBe("#222222");
  });

  for (const text of ["--text-primary", "--text-secondary", "--text-muted", "--accent-text"]) {
    it(`${text} is at least 4.5:1 on every allowed text surface`, () => {
      const fg = tok(text);
      for (const [name, bg] of Object.entries(surfaces())) {
        const r = ratio(fg, bg);
        expect(r, `${text} on ${name} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("--text-muted is never darker than the #a0a0a0 floor", () => {
    expect(lum(tok("--text-muted"))).toBeGreaterThanOrEqual(lum(parseColor("#a0a0a0")));
  });

  it("state text tokens clear 4.5:1 on panel and on their own tints", () => {
    const pairs: [string, RGBA, RGBA][] = [
      ["--warning on panel", tok("--warning"), panel()],
      ["--warning on --warning-bg", tok("--warning"), over(tok("--warning-bg"), panel())],
      ["--success on panel", tok("--success"), panel()],
      ["--danger-text on panel", tok("--danger-text"), panel()],
      ["--danger-text on input", tok("--danger-text"), input()],
      ["--danger-text on --danger-bg", tok("--danger-text"), over(tok("--danger-bg"), panel())],
      ["white on --accent-strong", WHITE, tok("--accent-strong")],
      ["white on --danger-strong", WHITE, tok("--danger-strong")],
      ["OFF badge (--text-secondary on --bg-input)", tok("--text-secondary"), input()],
    ];
    for (const [name, fg, bg] of pairs) {
      const r = ratio(fg, bg);
      expect(r, `${name} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--danger-text fails on --bg-hover, which is why red text never sits there", () => {
    expect(ratio(tok("--danger-text"), tok("--bg-hover"))).toBeLessThan(4.5);
  });

  it("badge text is at least 4.5:1 on its opaque fill", () => {
    for (const b of ["fill", "line", "offset", "fill-line"]) {
      const bg = tok(`--badge-${b}-bg`);
      expect(bg.a, `--badge-${b}-bg must be opaque`).toBe(1);
      const r = ratio(tok(`--badge-${b}-text`), bg);
      expect(r, `badge ${b} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--border-control and --focus-ring are at least 3:1 against panel and input fill", () => {
    const bc = tok("--border-control");
    const checks: [string, number][] = [
      ["--border-control vs panel", ratio(over(bc, panel()), panel())],
      ["--border-control vs input", ratio(over(bc, input()), input())],
      ["--focus-ring vs panel", ratio(over(tok("--focus-ring"), panel()), panel())],
      ["--focus-ring vs input", ratio(over(tok("--focus-ring"), input()), input())],
    ];
    for (const [name, r] of checks) {
      expect(r, `${name} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the artwork well is D2 (a): black is at least 4.5:1 on --bg-preview", () => {
    expect(tokens["--bg-preview"]).toBe("#f4f1ea");
    expect(tokens["--preview-border"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(ratio(BLACK, tok("--bg-preview"))).toBeGreaterThanOrEqual(4.5);
  });

  it("defines the principle-1 tokens", () => {
    for (const t of [
      "--text-disabled",
      "--accent",
      "--accent-border",
      "--danger",
      "--danger-border",
      "--warning-border",
      "--success-border",
      "--bg-plot",
    ]) {
      expect(tokens[t], t).toBeDefined();
    }
  });

  it("declares color-scheme: dark at :root, and the scrollbar corner is transparent", () => {
    expect(rootBlock).toMatch(/^\s*color-scheme:\s*dark;/);
    expect(css).toMatch(/::-webkit-scrollbar-corner\s*\{\s*background:\s*transparent;/);
  });

  it("the drawn checkbox: unchecked edge, checked fill and mark all clear 3:1", () => {
    const edge = tok("--check-border");
    const fill = tok("--check-fill");
    const checks: [string, number][] = [
      ["--check-border vs panel", ratio(over(edge, input()), panel())],
      ["--check-border vs input fill", ratio(over(edge, input()), input())],
      ["--check-fill vs panel", ratio(fill, panel())],
      ["--check-fill vs unchecked face", ratio(fill, input())],
      ["--check-mark on --check-fill", ratio(tok("--check-mark"), fill)],
    ];
    for (const [name, r] of checks) {
      expect(r, `${name} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the drawn checkbox is wired to its tokens in every state", () => {
    const rule = (sel: string) => {
      const esc = sel.replace(/[[\]"():]/g, (c) => "\\" + c);
      const m = css.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
      expect(m, `rule ${sel}`).not.toBeNull();
      return m![1];
    };
    const base = rule('input[type="radio"]');
    expect(base).toMatch(/appearance:\s*none;/);
    expect(base).toMatch(/width:\s*16px;/);
    expect(base).toMatch(/height:\s*16px;/);
    expect(base).toMatch(/border:\s*1px solid var\(--check-border\);/);
    expect(base).toMatch(/background-color:\s*var\(--bg-input\);/);
    const mark = tokens["--check-mark"].replace("#", "%23").toLowerCase();
    for (const st of [":checked", ":indeterminate"]) {
      const body = rule('input[type="checkbox"]' + st);
      expect(body).toMatch(/background-color:\s*var\(--check-fill\);/);
      expect(body).toContain(`stroke='${mark}'`);
    }
    expect(rule('input[type="checkbox"]:checked')).toContain("M1.5 5.2l2.3 2.3 4.7-4.9");
    expect(rule('input[type="checkbox"]:indeterminate')).toContain("M2 5h6");
    expect(rule('input[type="radio"]:checked')).toMatch(/background-color:\s*var\(--check-mark\);/);
    expect(rule('input[type="radio"]:disabled')).toMatch(/opacity:\s*0\.4;/);
    expect(rule('input[type="radio"]:focus-visible')).toMatch(/outline-offset:\s*2px;/);
  });

  it("deletes the dead tokens", () => {
    const names = Object.keys(tokens);
    expect(names).toContain("--border");
    expect(names).not.toContain("--border-focus");
    expect(names).toContain("--shadow-modal");
    expect(names).not.toContain("--shadow-tooltip");
    for (let i = 0; i <= 7; i++) expect(names).not.toContain(`--layer-${i}`);
  });

  it("carries the one type scale", () => {
    expect([
      tokens["--text-2xs"],
      tokens["--text-xs"],
      tokens["--text-sm"],
      tokens["--text-md"],
      tokens["--text-lg"],
      tokens["--text-xl"],
    ]).toEqual(["10px", "11px", "12px", "13px", "14px", "18px"]);
  });

  it("mono stack names the bundled IBM Plex Mono, which has an @font-face", () => {
    expect(tokens["--font-mono"]).toBe('ui-monospace, "SF Mono", "IBM Plex Mono", monospace');
    expect(css).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*"IBM Plex Mono";[^}]*url\("\/fonts\/IBMPlexMono-Regular\.ttf"\)/
    );
  });

  it("focus ring uses --focus-ring at 2px with offset 2px, inputs -1px", () => {
    expect(css).toMatch(
      /\*:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/
    );
    expect(css).toMatch(/textarea:focus-visible\s*\{\s*outline-offset:\s*-1px;/);
  });
});
