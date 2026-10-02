import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    // Motion trust B2+B3 (T-C3): every mocked serial_send / serial_send_byte /
    // serial_get_status invoke in the whole suite must carry `conn`.
    setupFiles: ["src/lib/machine/__tests__/setupConnInvoke.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
