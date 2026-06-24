/**
 * WS4 unit tests for keepAwake.ts
 *
 * Coverage boundary disclosure:
 * These tests mock `@tauri-apps/api/core` and exercise the JS subscription
 * edge-trigger logic (false→true fires acquire, true→false fires release,
 * rejected invoke is swallowed). They do NOT exercise the real OS power
 * assertion path. Confirming the assertion actually appears in `pmset -g
 * assertions` (macOS) is an owner hardware smoke test, out of scope for
 * automated testing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Must mock before importing modules that use it (matches connection.test.ts pattern).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../../app/store";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

// keepAwake.ts has a module-level `installed` guard so a single module import
// can only install once. We import once here and reset store state between tests.
// The idempotency test exercises the guard directly by calling installKeepAwake twice.
import { installKeepAwake } from "../keepAwake";

describe("keepAwake (WS4)", () => {
  beforeEach(() => {
    // Default to resolving so any subscription firing during setup never throws.
    // Tests that need different behaviour call mockInvoke.mockReset() themselves.
    mockInvoke.mockResolvedValue(undefined);
    // Reset jobRunning to false before each test.
    useStore.setState({ jobRunning: false });
    // Flush any subscription calls triggered by the setState above.
    mockInvoke.mockClear();
  });

  it("fires keep_awake_acquire once on false→true transition", async () => {
    mockInvoke.mockResolvedValue(undefined);

    installKeepAwake();

    // Transition false → true
    useStore.setState({ jobRunning: true });

    // Allow microtasks to settle
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("keep_awake_acquire");
  });

  it("fires keep_awake_release once on true→false transition", async () => {
    mockInvoke.mockResolvedValue(undefined);

    // Start with job running so the listener's initial prevJobRunning is true
    useStore.setState({ jobRunning: true });
    installKeepAwake();

    mockInvoke.mockClear();

    // Transition true → false
    useStore.setState({ jobRunning: false });

    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("keep_awake_release");
  });

  it("does not fire on repeated setState with same value (no-op on same state)", async () => {
    mockInvoke.mockResolvedValue(undefined);

    installKeepAwake();

    useStore.setState({ jobRunning: true });
    await Promise.resolve();
    mockInvoke.mockClear();

    // Setting the same value again — no edge, no invoke
    useStore.setState({ jobRunning: true });
    await Promise.resolve();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("swallows a rejected acquire invoke — does not throw", async () => {
    mockInvoke.mockRejectedValue(new Error("D-Bus unavailable"));

    installKeepAwake();

    // Must not throw; error is caught and logged as a warning.
    await expect(
      (async () => {
        useStore.setState({ jobRunning: true });
        // Two ticks: one for subscribe callback, one for the catch handler
        await Promise.resolve();
        await Promise.resolve();
      })()
    ).resolves.toBeUndefined();
  });

  it("swallows a rejected release invoke — does not throw", async () => {
    mockInvoke.mockResolvedValue(undefined);

    useStore.setState({ jobRunning: true });
    installKeepAwake();

    mockInvoke.mockReset();
    mockInvoke.mockRejectedValue(new Error("release failed"));

    await expect(
      (async () => {
        useStore.setState({ jobRunning: false });
        await Promise.resolve();
        await Promise.resolve();
      })()
    ).resolves.toBeUndefined();
  });

  it("fires acquire then release across a full false→true→false cycle", async () => {
    mockInvoke.mockResolvedValue(undefined);

    installKeepAwake();

    useStore.setState({ jobRunning: true });
    await Promise.resolve();
    useStore.setState({ jobRunning: false });
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "keep_awake_acquire");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "keep_awake_release");
  });

  it("installKeepAwake is idempotent — calling twice registers only one listener", async () => {
    mockInvoke.mockResolvedValue(undefined);

    installKeepAwake();
    installKeepAwake(); // second call is a no-op due to `installed` guard

    useStore.setState({ jobRunning: true });
    await Promise.resolve();

    // Exactly one acquire, not two
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("keep_awake_acquire");
  });
});
