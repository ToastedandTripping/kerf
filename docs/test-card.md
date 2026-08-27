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

### Phase 2 pre-flight — streaming baseline capture

Two extra captures to do **once, on the current build**, while you're already at
the machine for the script above. One records your machine's settings; the other
is an honest "before" of how dense engraving looks today — the baseline we'll
compare the upcoming streaming rework against. Neither needs anything installed;
both use screens Kerf already has.

#### A. Capture machine settings

- [ ] With the machine connected, open **Menu → Machine Settings…** (also in the
      command palette as "Machine Settings"). Kerf runs `$$` and `$I` for you and
      lists every setting with a plain-language label.
- [ ] **Screenshot the whole list** and send it back with this card.
- **The ones that matter most:** `$32` (Laser Mode — we want this **On / `=1`**),
  `$23` (homing direction), `$110`/`$111` (max feed rate X/Y), `$120`/`$121`
  (acceleration). Grabbing the full list is easier than picking them out.
- [ ] Also note the **GRBL version** shown on connect / in that dialog (e.g.
      `1.1h`). Write down exactly what it says — it tells us your controller's serial
      buffer size, which the new streaming code has to size itself to.

#### B. Record a dense-engrave "before"

This is the measurement the whole streaming rework rests on. Right now we only
_assume_ dense detail makes the head starve and stutter — nobody has watched for
it on purpose. Your recording is the first real evidence.

- [ ] Load a **genuinely detailed** engrave — a traced photo, or a densely filled
      shape with lots of fine, short strokes (busier than the step-5 engrave, on
      purpose). Click **Start**.
- [ ] **Film the head with your phone during the busiest passes.** What we're
      looking for:
  - Does it move **smoothly**, or **stutter / hesitate / micro-pause** where the
    detail is densest?
  - Is the burn depth **even**, or patchy in the dense areas?
- [ ] **Write down the verdict in one word: smooth, or stuttering.** If it's
      already smooth, that's a real result — it means the streaming rework may not be
      worth its risk, and we'd rather learn that now than after building it.

Keep the video and the settings screenshot together. That pair is the complete
baseline the streaming design gets built against.
