# Kerf Hardware Test Card

A quick script for confirming Kerf still behaves correctly on the real
machine after an update. About 10 minutes. Run the steps in order — several
of them depend on the machine being in whatever state the previous step
left it in, so don't skip around.

If anything below doesn't match its "Expected" line, stop testing, write
down exactly which step and what happened, and flag it before doing
anything else on the machine.

## Before you start

- [ ] Machine is powered on and connected via USB
- [ ] A scrap piece of test material is loaded and the bed is otherwise clear
- [ ] You roughly know where your machine's travel limits are (needed for the alarm step)

## v1 — Baseline script

### 1. Connect
- [ ] Open Kerf, pick your machine's port, click **Connect**.
- **Expected:** within a couple of seconds the console at the bottom of the
  screen shows a response line — either the GRBL startup banner or
  "Connected to [port] at [baud] baud". That line appearing means the app
  automatically reset the controller as part of connecting. You don't need
  to do anything else here — just confirm you see it.

### 2. Home
- [ ] Click **Home ($H)**.
- **Expected:** the head drives to the home switches and stops. The status
  bar reads "Idle" once it's done.

### 3. Frame a small design
- [ ] Import or draw a small shape, assign it to a Cut layer, then click
  **Frame**.
- **Expected:** the head traces the shape's outline with the laser OFF —
  you should see motion but no firing. This confirms the design lands
  where you expect on the material before committing to a real cut.

### 4. Small cut
- [ ] Click **Generate**, then **Start** on that same small shape.
- **Expected:** a clean cut all the way through the material along the
  outline. No stutter, no missed sections, and the laser stops firing the
  instant the cut finishes.

### 5. Dense engrave
- [ ] Set up a small filled/engraved area — a filled letter or a small
  photo works well — and click **Start**.
- **Expected:** even, consistent engraving depth across the whole area.
  No patchy spots, no visible hesitation or stutter in the head's motion.

### 6. Pause / resume mid-engrave
- [ ] While the engrave from step 5 is running, click **Pause**, wait a
  few seconds, then click **Resume**.
- **Expected:** the laser turns off immediately on Pause (no dwelling or
  burning while paused), and the job picks back up cleanly on Resume —
  continuing where it left off, no double-burned or skipped lines.

### 7. Stop
- [ ] While a job is running, click **Stop**.
- **Expected:** the laser turns off immediately, the head stops, and the
  job ends. The machine should be safe to touch right away.

### 8. Trigger an alarm
- [ ] Deliberately trigger an alarm state. Easiest way: jog the head past
  its travel limit (works if your machine has limit switches enabled).
  If you know how to send GRBL's alarm-test command from the console,
  that works too.
- **Expected:** the machine enters an ALARM state. Kerf's status bar shows
  the alarm, and buttons that would move the head or start a job refuse
  to run until the alarm is cleared.

### 9. Unlock
- [ ] Click **Unlock ($X)**.
- **Expected:** the alarm clears and the machine returns to Idle.
  Re-home before doing anything else — same as Kerf itself will prompt.

### 10. Disconnect
- [ ] Click **Disconnect**.
- **Expected:** the console shows "Disconnected" and the status bar shows
  not-connected. No hung state — you shouldn't need to unplug/replug the
  USB cable to reconnect next time.

## Per-release additions

_(empty — release-specific test steps get appended here as they come up,
so this card grows over time instead of getting rewritten each release.)_
