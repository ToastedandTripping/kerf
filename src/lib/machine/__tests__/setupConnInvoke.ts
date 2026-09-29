/**
 * T-C3 (motion trust B2+B3): one interception for the whole suite. After
 * every test, if `@tauri-apps/api/core`'s `invoke` is a mock in that test
 * file, each recorded call to a command that names the connection must carry
 * a numeric `conn`. A call without one fails the test that made it.
 */
import { afterEach, vi } from "vitest";

export const CONN_COMMANDS = new Set(["serial_send", "serial_send_byte", "serial_get_status"]);

/** The offending calls (empty when every conn-carrying call names `conn`). */
export function callsMissingConn(calls: unknown[][]): string[] {
  const bad: string[] = [];
  for (const [cmd, args] of calls) {
    if (typeof cmd !== "string" || !CONN_COMMANDS.has(cmd)) continue;
    const conn = (args as { conn?: unknown } | undefined)?.conn;
    if (typeof conn !== "number") bad.push(`${cmd} ${JSON.stringify(args ?? null)}`);
  }
  return bad;
}

afterEach(async () => {
  const core = await import("@tauri-apps/api/core");
  const inv = core.invoke as unknown;
  if (!vi.isMockFunction(inv)) return;
  const bad = callsMissingConn(inv.mock.calls as unknown[][]);
  if (bad.length > 0) {
    throw new Error(`T-C3: serial invoke without conn:\n${bad.join("\n")}`);
  }
});
