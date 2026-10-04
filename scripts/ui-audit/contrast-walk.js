/* global document, getComputedStyle, innerHeight, innerWidth, NodeFilter */
/*
 * contrast-walk.js --in-page WCAG 2.x contrast walker (UI polish A1).
 *
 * Dependency-free. Evaluate it in the page with any driver (CDP
 * Runtime.evaluate, puppeteer page.evaluate, the DevTools MCP). The file is a
 * single function expression, so `(<file text>)(options)` returns the result:
 *
 *   const src = fs.readFileSync("scripts/ui-audit/contrast-walk.js", "utf8");
 *   const result = await page.evaluate(`(${src})({ failingOnly: true })`);
 *
 * Options: { root: CSS selector (default body), failingOnly: boolean (default true) }
 * Returns { checked, failing, nodes: [{ text, selector, ratio, need, size, weight,
 *           opacity, color, background, disabled, x, y }] }.
 *
 * For every visible text node it composites the element's colour over its
 * effective background (translucent ancestors blended down to the first opaque
 * one, falling back to --bg-app #1a1a1a), applies the product of ancestor
 * opacities, and compares against the WCAG threshold (3:1 for large text, 24px or
 * 18.66px at 700+; 4.5:1 otherwise). `disabled` marks text inside a disabled
 * control, which WCAG 1.4.3 exempts; the walker reports it and lets the reader
 * decide. Ported from the access critic's audit.mjs.
 */
// The file is evaluated as an expression by the driver, so a bare function expression is the API.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(function contrastWalk(options) {
  var opts = options || {};
  var failingOnly = opts.failingOnly !== false;
  var parse = function (s) {
    var m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  var lin = function (c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  var lum = function (c) {
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  };
  var blend = function (fg, bg, a) {
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    };
  };
  var contrast = function (a, b) {
    var la = lum(a);
    var lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  var effBg = function (el) {
    var stack = [];
    for (var e = el; e; e = e.parentElement) {
      var c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 1) break;
      }
    }
    var bg = { r: 26, g: 26, b: 26, a: 1 };
    for (var i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg, stack[i].a);
    return bg;
  };
  var effOpacity = function (el) {
    var o = 1;
    for (var e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  var selectorOf = function (el) {
    var parts = [];
    for (var e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      var s = e.tagName.toLowerCase();
      if (e.id) {
        parts.unshift(s + "#" + e.id);
        break;
      }
      var aria = e.getAttribute("aria-label");
      var testid = e.getAttribute("data-testid");
      if (aria) s += '[aria-label="' + aria + '"]';
      else if (testid) s += '[data-testid="' + testid + '"]';
      var parent = e.parentElement;
      if (parent) {
        var tag = e.tagName;
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === tag;
        });
        if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  var hex = function (c) {
    return (
      "#" +
      [c.r, c.g, c.b]
        .map(function (v) {
          return Math.round(v).toString(16).padStart(2, "0");
        })
        .join("")
    );
  };
  var root = opts.root ? document.querySelector(opts.root) : document.body;
  if (!root) throw new Error("contrast-walk: root not found: " + opts.root);
  var nodes = [];
  var checked = 0;
  var failing = 0;
  var seen = new Set();
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    var t = walker.currentNode;
    var txt = t.textContent.trim();
    if (!txt) continue;
    var el = t.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    var fg = parse(cs.color);
    if (!fg) continue;
    var bg = effBg(el);
    var op = effOpacity(el);
    var f = blend(blend(fg, bg, fg.a), bg, op);
    var ratio = contrast(f, bg);
    var size = parseFloat(cs.fontSize);
    var weight = parseInt(cs.fontWeight, 10);
    var large = size >= 24 || (size >= 18.66 && weight >= 700);
    var need = large ? 3 : 4.5;
    checked++;
    var fails = ratio < need;
    if (fails) failing++;
    if (failingOnly && !fails) continue;
    nodes.push({
      text: txt.slice(0, 40),
      selector: selectorOf(el),
      ratio: Math.round(ratio * 100) / 100,
      need: need,
      size: size,
      weight: weight,
      opacity: Math.round(op * 100) / 100,
      color: hex(f),
      background: hex(bg),
      disabled: !!el.closest(":disabled, [aria-disabled='true']"),
      x: Math.round(r.x),
      y: Math.round(r.y),
    });
  }
  return { checked: checked, failing: failing, nodes: nodes };
});
