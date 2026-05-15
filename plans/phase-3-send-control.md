# Phase 3: Send & Control

Connect to the laser and run jobs reliably. Three sub-phases, each building on the last.

---

## 3a. Connection Polish

### 3a.1 Expose VID/PID in port listing

The `serialport` crate already provides `UsbPortInfo` with `vid` and `pid` fields, but the current `PortInfo` struct only passes `name` and `port_type` (a display string). We need the raw identifiers on the frontend to filter.

**Files changed:**

- [ ] `src-tauri/src/commands/serial.rs` -- Extend `PortInfo` struct

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}
```

Update `list_serial_ports` to populate the new fields:

```rust
serialport::SerialPortType::UsbPort(info) => PortInfo {
    name: p.port_name.clone(),
    port_type: format!("USB: {} {}",
        info.manufacturer.as_deref().unwrap_or("Unknown"),
        info.product.as_deref().unwrap_or("")),
    vid: Some(info.vid),
    pid: Some(info.pid),
    manufacturer: info.manufacturer.clone(),
    product: info.product.clone(),
},
```

Non-USB ports get `vid: None, pid: None, manufacturer: None, product: None`.

- [ ] `src/lib/machine/connection.ts` -- Update `PortInfo` interface to match

```typescript
interface PortInfo {
  name: string;
  portType: string;
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
}
```

**Dependencies:** None. Pure data addition.

---

### 3a.2 Auto-detect known laser controllers

Add a known-device table and a filtering/sorting function that puts recognized laser controllers at the top of the port list. Common GRBL-based laser controllers:

| Device | VID | PID | Notes |
|--------|------|------|-------|
| CH340 (most Chinese laser boards) | `0x1A86` | `0x7523` | |
| CH341 | `0x1A86` | `0x5523` | |
| FTDI FT232R | `0x0403` | `0x6001` | Ortur, some Atomstack |
| FTDI FT232H | `0x0403` | `0x6014` | |
| CP2102 (SiLabs) | `0x10C6` | `0xEA60` | Sculpfun, some xTool |
| Arduino Uno/Mega (ATmega16U2) | `0x2341` | `0x0043`/`0x0042` | DIY GRBL shields |
| Espressif (ESP32-S2/S3 native) | `0x303A` | varies | ESP32-based boards |
| STM32 DFU/VCP | `0x0483` | `0x5740` | STM32-based controllers |

Also match by port name pattern on Linux: `/dev/ttyUSB*`, `/dev/ttyACM*`.

**Files changed:**

- [ ] `src/lib/machine/knownDevices.ts` -- **New file**

```typescript
export interface KnownDevice {
  vid: number;
  pid: number;
  label: string;
}

export const KNOWN_LASER_DEVICES: KnownDevice[] = [
  { vid: 0x1A86, pid: 0x7523, label: "CH340 (GRBL)" },
  { vid: 0x1A86, pid: 0x5523, label: "CH341 (GRBL)" },
  { vid: 0x0403, pid: 0x6001, label: "FTDI FT232R" },
  { vid: 0x0403, pid: 0x6014, label: "FTDI FT232H" },
  { vid: 0x10C6, pid: 0xEA60, label: "CP2102 (SiLabs)" },
  { vid: 0x2341, pid: 0x0043, label: "Arduino Uno" },
  { vid: 0x2341, pid: 0x0042, label: "Arduino Mega" },
  { vid: 0x0483, pid: 0x5740, label: "STM32 VCP" },
];

export function isKnownLaser(vid: number | null, pid: number | null): KnownDevice | null {
  if (vid === null || pid === null) return null;
  return KNOWN_LASER_DEVICES.find(d => d.vid === vid && d.pid === pid) || null;
}

export function sortPortsByRelevance(ports: PortInfo[]): PortInfo[] {
  return [...ports].sort((a, b) => {
    const aKnown = isKnownLaser(a.vid, a.pid) ? 1 : 0;
    const bKnown = isKnownLaser(b.vid, b.pid) ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    // USB ports above non-USB
    const aUsb = a.portType.startsWith("USB") ? 1 : 0;
    const bUsb = b.portType.startsWith("USB") ? 1 : 0;
    return bUsb - aUsb;
  });
}
```

- [ ] `src/components/panels/MachinePanel.tsx` -- Use `sortPortsByRelevance` in `refreshPorts`. Append `(GRBL)` or device label to option text for recognized VID/PIDs. Auto-select the first recognized port if `selectedPort` is empty.

**Dependencies:** 3a.1

---

### 3a.3 Remember last-used port + auto-reconnect

No persistence plugin is currently installed. Use `localStorage` via the Tauri webview (available by default) rather than adding `tauri-plugin-store` as a dependency. The key `kerf:lastPort` stores the port name. On app launch, if that port appears in the scanned list, auto-connect.

**Files changed:**

- [ ] `src/lib/machine/connection.ts` -- Add two helpers:

```typescript
const LAST_PORT_KEY = "kerf:lastPort";

export function saveLastPort(portName: string): void {
  localStorage.setItem(LAST_PORT_KEY, portName);
}

export function getLastPort(): string | null {
  return localStorage.getItem(LAST_PORT_KEY);
}
```

Update `connect()` to call `saveLastPort(portName)` after successful connection.

- [ ] `src/components/panels/MachinePanel.tsx` -- On mount (`useEffect`), after `refreshPorts`:
  1. Read `getLastPort()`.
  2. If the port exists in the scanned list, `setSelectedPort(...)` and attempt `machineConnection.connect(...)`.
  3. If connection fails (port occupied, device unplugged), silently fall back to manual selection -- no error toast.
  4. Gate auto-connect behind a `useRef(hasAutoConnected)` flag so it only fires once per app session.

**Dependencies:** 3a.1, 3a.2

---

### 3a.4 Connection status always visible in StatusBar

The StatusBar already shows `machineState` with a colored dot and label. Extend it to show the port name when connected.

**Files changed:**

- [ ] `src/app/store.ts` -- Add field:

```typescript
connectedPortName: string | null;
setConnectedPortName: (name: string | null) => void;
```

Initialize as `null`. Set in `machineConnection.connect()`, clear in `disconnect()`.

- [ ] `src/lib/machine/connection.ts` -- `connect()` calls `store.setConnectedPortName(portName)`, `disconnect()` calls `store.setConnectedPortName(null)`.

- [ ] `src/components/bottom/StatusBar.tsx` -- Read `connectedPortName` from store. When connected, display `portName @ 115200` next to the state indicator. When disconnected, show "No machine" in muted text.

**Dependencies:** None (can be done in parallel with 3a.1-3a.3).

---

### 3a.5 Graceful recovery from USB disconnect mid-job

Currently, a serial write failure during job execution returns `"error:disconnected"` which breaks the for-loop and runs `M5` + `softReset` -- but the port is already gone, so those calls silently fail. The user sees "Job stopped due to error" but the machine state may linger as "run" until they manually disconnect.

Two layers of detection needed:

**Layer 1: Write-error detection (already exists, needs cleanup)**

- [ ] `src/components/panels/MachinePanel.tsx` -- In `handleStartJob`, after the error-detection block that already calls `setMachineConnected(false)`, also:
  1. Call `machineConnection.disconnect()` (cleans up poll interval, zustand subscription).
  2. Show a distinct message: `"USB connection lost. Job aborted at line ${i+1}/${lines.length}."`.
  3. Store `lastJobInterruptLine` in a new store field so the user can see where it stopped.

- [ ] `src/app/store.ts` -- Add:

```typescript
lastJobInterruptLine: number | null;
setLastJobInterruptLine: (line: number | null) => void;
```

**Layer 2: Poll-error detection (catches disconnect between commands)**

- [ ] `src/lib/machine/connection.ts` -- In `pollStatus()`, if the catch fires:
  1. Increment a `consecutivePollErrors` counter (module-level variable).
  2. If `consecutivePollErrors >= 3`, treat as disconnect:
     - Call `disconnect()`.
     - Log `"Machine disconnected (serial timeout)"` as warning.
     - If `jobRunning` is true, set `jobRunning = false` in the store.
  3. Reset counter to 0 on any successful poll.

**Layer 3: Tauri-side port health check (optional, skip if Layer 2 is sufficient)**

If needed later, add a `serial_check_health` Tauri command that attempts a zero-byte write to detect broken pipe without sending data to GRBL. This is deferred -- Layers 1+2 should catch all real-world disconnect scenarios within 750ms (3 poll cycles).

**Dependencies:** 3a.4 (for `connectedPortName` cleanup).

---

## 3b. Job Preview

### 3b.1 Estimated cut time display before sending

This already works. `GcodeResult.estimatedTimeSecs` is computed by the Rust backend and displayed in the MachinePanel stats grid after generation. The JS fallback also estimates time. No changes needed for basic display.

However, the Rust time estimate should be improved:

- [ ] `src-tauri/src/engine/gcode_gen.rs` -- At the end of `generate_gcode()`, compute `estimated_time_secs` more accurately:
  1. Use actual feed rates from each move (currently some rapid moves use hardcoded `3000.0`).
  2. Account for GRBL acceleration limits. Add a constant `GRBL_ACCELERATION = 500.0` (mm/s^2, typical $120/$121 value). For short moves, the machine never reaches full speed -- use the trapezoidal velocity profile formula: `t = 2 * sqrt(d / a)` when `d < v^2 / (2*a)`, else `t = d/v + v/(2*a)`.
  3. Add per-pass overhead: 0.5s per M5/M3 cycle for GRBL buffering.

- [ ] `src/components/panels/MachinePanel.tsx` -- Already displays `formatTime(gcodeResult.estimatedTimeSecs)`. No change needed.

**Dependencies:** None.

---

### 3b.2 Bounding box preview on workspace

Show the job's bounding box as a dashed rectangle on the Pixi.js viewport when gcode has been generated, so the user can verify placement before sending.

**Files changed:**

- [ ] `src/app/store.ts` -- Add:

```typescript
jobBoundsVisible: boolean;
setJobBoundsVisible: (v: boolean) => void;
```

Default `true` (auto-show when gcode is generated).

- [ ] `src/components/viewport/Viewport.tsx` -- In the render loop (the `useEffect` that draws objects):
  1. Read `gcodeResult` and `jobBoundsVisible` from store.
  2. If both are truthy, compute the bounding box from `gcodeResult.moves` (min/max of all move x/y coordinates).
  3. Draw a dashed rectangle on `selectionOverlayRef` (or a new `jobBoundsRef` Graphics object) in workspace coordinates:
     - Stroke: `0x4A90E2` (accent blue), 1px, dash pattern `[6, 4]`.
     - Corner labels showing dimensions: `"W x H mm"`.
  4. Coordinate transform: moves use GRBL coordinates (Y=0 at bottom), viewport uses Y=0 at top. Apply the same `workspaceHeight - y` flip used in `JobPreview.tsx`.

- [ ] `src/components/panels/MachinePanel.tsx` -- Add a small toggle icon next to "Generate G-code" button to show/hide bounds overlay. Call `setJobBoundsVisible()`.

**Dependencies:** G-code generation must populate `gcodeResult.moves` (already does).

---

### 3b.3 Frame button enhancement

The Frame button already exists and works -- it sends four `G0` rapid moves tracing the bounding box. Enhancements:

- [ ] `src/components/panels/MachinePanel.tsx` -- Update the Frame `onClick`:
  1. Add an option to fire a very low power laser dot while framing (1% power, M4 mode) so the user can see the boundary on the material. Gate behind a "Visible frame" checkbox or hold-Shift-to-fire-while-framing.
  2. Close the rectangle (already does -- sends 5 G0 commands including return to start).
  3. After framing completes, return the head to its pre-frame position. Store `machinePosition` before framing, `G0` back afterward.

```typescript
async function handleFrame(withLaser: boolean = false) {
  const store = useStore.getState();
  const bounds = getDesignBounds(store.objects);
  if (!bounds) { addConsoleLine("No objects to frame", "error"); return; }

  const { workspaceHeight, grblSValueMax } = store;
  const returnPos = { ...store.machinePosition };
  const y0 = workspaceHeight - bounds.maxY;
  const y1 = workspaceHeight - bounds.minY;

  if (withLaser) {
    const sVal = Math.round(0.01 * grblSValueMax); // 1% power
    await machineConnection.send(`M4 S${sVal}`);
  }

  await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y0.toFixed(3)}`);
  await machineConnection.send(`G0 X${bounds.maxX.toFixed(3)} Y${y0.toFixed(3)}`);
  await machineConnection.send(`G0 X${bounds.maxX.toFixed(3)} Y${y1.toFixed(3)}`);
  await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y1.toFixed(3)}`);
  await machineConnection.send(`G0 X${bounds.minX.toFixed(3)} Y${y0.toFixed(3)}`);

  if (withLaser) {
    await machineConnection.send("M5");
  }

  // Return to pre-frame position
  await machineConnection.send(`G0 X${returnPos.x.toFixed(3)} Y${returnPos.y.toFixed(3)}`);
}
```

- [ ] Replace the current inline `onClick` handler with `handleFrame(false)`. Add Shift-click detection: `onClick={(e) => handleFrame(e.shiftKey)}`. Update the button tooltip to mention Shift for visible frame.

**Dependencies:** 3a.4 (uses `machinePosition` from store -- already exists).

---

### 3b.4 Cut order visualization (animate path sequence)

The `JobPreview` component already does this fully:
- Canvas overlay with all moves drawn
- Color-coded by type (rapid=blue, cut=red, engrave=gold)
- Animated playback with play/pause, scrubber, speed controls (0.25x to 10x)
- Laser head dot with glow effect
- Move-by-move stats overlay
- Elapsed/remaining time display

No further work needed. Mark as complete.

- [x] Cut order visualization -- already implemented in `src/components/bottom/JobPreview.tsx`.

---

## 3c. Job Execution

### 3c.1 Progress bar with estimated time remaining

The progress bar exists but only shows percentage (line count based). Add a time remaining estimate.

**Files changed:**

- [ ] `src/app/store.ts` -- Add fields:

```typescript
jobStartTime: number | null;       // Date.now() when job started
jobElapsedSecs: number;            // updated during job
jobEstimatedTotalSecs: number;     // from gcodeResult.estimatedTimeSecs
setJobStartTime: (t: number | null) => void;
setJobElapsedSecs: (s: number) => void;
setJobEstimatedTotalSecs: (s: number) => void;
```

- [ ] `src/components/panels/MachinePanel.tsx` -- In `handleStartJob`:
  1. Set `jobStartTime = Date.now()` and `jobEstimatedTotalSecs = gcodeResult.estimatedTimeSecs`.
  2. Inside the for-loop, every 10 lines, update `jobElapsedSecs = (Date.now() - jobStartTime) / 1000`.
  3. Compute `estimatedRemaining` using linear interpolation: `(elapsed / progress) * (1 - progress)`. This is more accurate than the pre-computed estimate because it accounts for real serial latency.

- [ ] `src/components/panels/MachinePanel.tsx` -- Replace the current 4px-tall progress bar with a richer display:

```tsx
{jobRunning && (
  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
    {/* Progress bar */}
    <div style={{ background: "var(--bg-input)", borderRadius: "var(--radius-sm)", height: "6px", overflow: "hidden" }}>
      <div style={{
        height: "100%",
        width: `${jobProgress * 100}%`,
        background: machineState === "hold" ? "var(--accent-warm)" : "var(--accent)",
        transition: "width 0.3s",
      }} />
    </div>
    {/* Stats line */}
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
      <span>{(jobProgress * 100).toFixed(1)}%</span>
      <span>{machineState === "hold" ? "PAUSED" : `~${formatTime(estimatedRemaining)} remaining`}</span>
    </div>
  </div>
)}
```

The bar turns amber when paused (hold state).

**Dependencies:** None.

---

### 3c.2 Pause/Resume (GRBL hold `!` and resume `~`)

Already implemented. The connection module has `feedHold()` (sends `0x21`) and `cycleResume()` (sends `0x7e`). The MachinePanel has a PAUSE/RESUME button that toggles based on `machineState === "hold"`. The job loop waits in a 100ms polling loop while `machineState === "hold"`.

Improvements needed:

- [ ] `src/components/panels/MachinePanel.tsx` -- In the pause-wait loop, also check for `jobRunning === false` to break out if the user hits STOP while paused:

```typescript
while (useStore.getState().machineState === "hold") {
  if (!useStore.getState().jobRunning) break; // Exit if stopped while paused
  await new Promise((r) => setTimeout(r, 100));
}
```

- [ ] `src/lib/machine/connection.ts` -- In `feedHold()`, un-suspend status polling temporarily so we can detect state transitions:

```typescript
async feedHold(): Promise<void> {
  await this.sendByte(0x21); // '!'
  // Resume polling briefly to confirm hold state
  jobPollingSuspended = false;
  setTimeout(() => {
    jobPollingSuspended = useStore.getState().jobRunning;
  }, 2000); // Re-suspend after 2s if still running
}
```

- [ ] `src/lib/machine/connection.ts` -- In `cycleResume()`, re-suspend polling:

```typescript
async cycleResume(): Promise<void> {
  await this.sendByte(0x7e); // '~'
  // Re-suspend polling for job
  jobPollingSuspended = useStore.getState().jobRunning;
}
```

**Dependencies:** None.

---

### 3c.3 Emergency stop UX verification

The emergency stop flow is already implemented (`feedHold -> 100ms delay -> M5 -> softReset`). Verify and harden the UX:

- [ ] `src/components/panels/MachinePanel.tsx` -- The STOP button should be visually prominent and always enabled when the machine is connected (already is). Add a confirmation for non-job stops (prevents accidental mid-jog resets):

```typescript
async function handleStop() {
  if (!jobRunning) {
    // If no job is running, this is a manual e-stop. Still do it, but no job cleanup needed.
    await machineConnection.emergencyStop();
    return;
  }
  setJobRunning(false); // Signal the job loop to exit
  await machineConnection.emergencyStop();
}
```

- [ ] Keyboard shortcut: Verify that `Escape` triggers emergency stop during a job. Check `src/lib/shortcuts.ts` (or wherever keybindings are registered). If not bound:

```typescript
// In the keyboard handler
if (e.key === "Escape" && useStore.getState().jobRunning) {
  e.preventDefault();
  useStore.getState().setJobRunning(false);
  machineConnection.emergencyStop();
}
```

- [ ] `src/components/panels/MachinePanel.tsx` -- After emergency stop completes, add a visual indicator:
  1. Flash the STOP button background red briefly (CSS animation).
  2. Console shows: `"EMERGENCY STOP at line X/Y (Z% complete)"` with the line count from `jobProgress`.

- [ ] `src/lib/machine/connection.ts` -- In `emergencyStop()`, if the first `sendByte(0x21)` throws (port gone), skip remaining steps gracefully. The current `try/catch` blocks already handle this, but add a final state cleanup:

```typescript
async emergencyStop(): Promise<void> {
  const store = useStore.getState();
  store.addConsoleLine("Emergency stop initiated", "warning");

  try { await this.sendByte(0x21); } catch { /* continue */ }
  await new Promise((r) => setTimeout(r, 100));
  try { await this.send("M5"); } catch { /* continue */ }
  try {
    await this.sendByte(0x18);
    await this.pollStatus();
  } catch { /* continue */ }

  // Ensure clean state regardless of serial outcome
  store.setJobRunning(false);
  store.setJobProgress(0);
  store.addConsoleLine("Emergency stop complete", "warning");
}
```

**Dependencies:** None (but verify keyboard shortcut file exists first).

---

### 3c.4 Job complete notification

Notify the user when a job finishes, especially useful for long cuts when the user may have switched windows.

**Option A: Web Notification API (no Tauri plugin needed)**

The Tauri webview supports the standard `Notification` API. No need for `tauri-plugin-notification`.

**Files changed:**

- [ ] `src/lib/machine/notifications.ts` -- **New file**

```typescript
let permissionGranted = false;

export async function requestNotificationPermission(): Promise<void> {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return;
  }
  if (Notification.permission !== "denied") {
    const result = await Notification.requestPermission();
    permissionGranted = result === "granted";
  }
}

export function notifyJobComplete(durationSecs: number): void {
  if (!permissionGranted) return;
  const time = durationSecs < 60
    ? `${Math.ceil(durationSecs)}s`
    : `${Math.floor(durationSecs / 60)}m ${Math.ceil(durationSecs % 60)}s`;

  new Notification("Kerf -- Job Complete", {
    body: `Cut finished in ${time}.`,
    icon: "/icon.png",
    silent: false,
  });
}

export function notifyJobFailed(line: number, totalLines: number): void {
  if (!permissionGranted) return;
  new Notification("Kerf -- Job Failed", {
    body: `Error at line ${line}/${totalLines}. Check console.`,
    icon: "/icon.png",
    silent: false,
  });
}
```

- [ ] `src/components/panels/MachinePanel.tsx` -- Import and use:
  1. Call `requestNotificationPermission()` in the component's top-level `useEffect` (once on mount).
  2. In `handleStartJob`, after the for-loop completes successfully: `notifyJobComplete(elapsed)`.
  3. On error: `notifyJobFailed(i + 1, lines.length)`.

- [ ] `src/components/panels/MachinePanel.tsx` -- Visual feedback on completion:
  1. Add a `jobCompleted` state that shows a green "Job Complete" banner for 5 seconds after success.
  2. Play a short beep using `AudioContext` (no external audio file needed):

```typescript
function playCompletionBeep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880; // A5
  gain.gain.value = 0.1;
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  // Second beep
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.frequency.value = 1320; // E6
  gain2.gain.value = 0.1;
  osc2.start(ctx.currentTime + 0.2);
  osc2.stop(ctx.currentTime + 0.35);
}
```

**Dependencies:** None.

---

## Implementation Order

The items have few cross-dependencies and can be partially parallelized. Recommended order:

```
Week 1: 3a.1 + 3a.4 + 3c.1 (in parallel -- no dependencies)
         3a.2 (after 3a.1)
         3a.3 (after 3a.2)

Week 2: 3a.5 + 3b.1 + 3c.2 (in parallel)
         3b.2 (independent)
         3b.3 (after 3b.2 -- shares bounding box logic)

Week 3: 3c.3 + 3c.4 (in parallel)
         Integration testing with real hardware
```

## Files Summary

### New files (3)
| File | Purpose |
|------|---------|
| `src/lib/machine/knownDevices.ts` | VID/PID table, port sorting |
| `src/lib/machine/notifications.ts` | Job completion/failure notifications |
| `plans/phase-3-send-control.md` | This plan |

### Modified files (7)
| File | Changes |
|------|---------|
| `src-tauri/src/commands/serial.rs` | Extend `PortInfo` with vid/pid/manufacturer/product |
| `src-tauri/src/engine/gcode_gen.rs` | Improve time estimate with trapezoidal acceleration model |
| `src/lib/machine/connection.ts` | Last-port persistence, poll-error disconnect detection, pause/resume polling fix, port name in store |
| `src/app/store.ts` | Add `connectedPortName`, `lastJobInterruptLine`, `jobStartTime`, `jobElapsedSecs`, `jobEstimatedTotalSecs`, `jobBoundsVisible` |
| `src/components/panels/MachinePanel.tsx` | Auto-connect, enhanced frame, progress with ETA, disconnect recovery, notifications, completion beep |
| `src/components/bottom/StatusBar.tsx` | Show connected port name |
| `src/components/viewport/Viewport.tsx` | Draw job bounding box overlay |

### No changes needed
| File | Reason |
|------|--------|
| `src/components/bottom/JobPreview.tsx` | Cut order visualization already complete |
| `src/components/bottom/Console.tsx` | No changes required |
| `src-tauri/src/lib.rs` | No new Tauri commands needed |
| `src-tauri/Cargo.toml` | No new crate dependencies |
