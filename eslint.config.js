import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Ignore generated/compiled output
  {
    ignores: [
      "dist/**",
      "src-tauri/target/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "vite.config.ts",
      "tailwind.config.ts",
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended (NOT type-checked — no parserOptions.project needed)
  ...tseslint.configs.recommended,

  // React hooks rules
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // rules-of-hooks catches real bugs; exhaustive-deps fixes are behavior-changing
      // in this codebase (84 hook sites) — kept as warn, not error, per Phase 2 plan
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn",

      // react-hooks v7 new rules: set-state-in-effect and refs access during render.
      // These flag real patterns throughout the codebase (dialogs, loading states, previews).
      // Fixing them is behavior-changing and out of scope for Phase 2 (cleanup only).
      // Surface as warnings so they are visible without blocking lint gate.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",

      // ~10 third-party boundary sites (pdf.js oplist, Tauri path narrowing);
      // downgraded to warn so lint gates on errors only
      "@typescript-eslint/no-explicit-any": "warn",

      // tsc strict + noUnusedLocals/Params already enforces these; keep as off to avoid
      // false positives on intentionally-unused function overloads
      "@typescript-eslint/no-unused-vars": "off",

      // js.recommended rules that surface pre-existing patterns not safe to fix without
      // behavior analysis — downgraded to warn for Phase 2.
      // no-useless-assignment: reassignment patterns in geometry/SVG parsers need
      //   per-site analysis before changing (e.g. reset-in-loop vs genuinely dead write).
      "no-useless-assignment": "warn",
      // no-empty: intentional empty catch blocks (try/catch for optional Tauri API, etc.)
      "no-empty": "warn",
      // prefer-const: pre-existing let declarations throughout; safe to fix but not
      //   behavior-preserving in the strictest sense — defer to Phase 3.
      "prefer-const": "warn",
    },
  }
);
