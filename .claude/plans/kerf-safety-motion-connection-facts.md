# Native transport facts for the combined jog-safety and connection-lifetime job (S3c+S3d)

Read-only map, taken 2026-09-29 at `a6b5d65` by an Explore agent and saved by the orchestrator. It is the input to the combined plan that Lee chose on 2026-09-29 ("Hold for full fix"). Every item cites the tree. Re-verify each one before the plan relies on it.

## Where controller lines go

- **Classifier:** `LineClass {Ok, Error, Alarm, Banner, Status, Msg, Other}` in `serial_pump.rs:88-103`. `classify_line` is at `:105-121`. It tests, in order: `== "ok"`, `error:`, `ALARM`, `Grbl `, `<`, and `[MSG:`.
- **`run_pump`** (used by `serial_send_inner`, `serial.rs:532`):
  - Every line goes into `responses`. It stops at the first Ok, Error, Alarm or Banner (`:228-251`).
  - Status lines are published through `on_status` (`:221-225`).
  - **On `Err`, every line it collected is dropped** (`serial_pump.rs:186, 206, 255, 271, 291`).
- **`drain_classified`** (`:310-339`): Alarm and Msg go to `surfaced` (the TS `drained`). **Banner, Ok, Error, Status and Other go to `dropped`**, which only reaches `eprintln` (`serial.rs:509-511`).
- **`read_status_bounded`** (`:356-404`): the first Status is kept, Alarm and Msg go to `surfaced` (the TS `events`), and **Banner, ok and error:N are dropped** (`:379-386`). A Banner sets `banner_observed` only when a stop is in flight (`serial.rs:658-668`). On `Err`, what was surfaced is lost (`:372, 401`).
- **`run_buffered_pump`:** a Banner becomes `Aborted` with no text (`:676-677`), and an Alarm becomes `Alarm{text}`.
- **Connect drain** (`drain_startup_banner`, `serial.rs:256-280`): up to 5 raw lines, stopping at the first line that `contains("Grbl")`. It runs twice. **The second result is discarded if the first was non-empty** (`:332-336`).
- **The stop's banner read** (`serial.rs:1077-1091`): it `try_lock`s the command channel and reads into a throwaway `read_buf`, bypassing `pending`. **Every non-banner line, including a reset's `ALARM:3`, is discarded with no log.**
- **TS:**
  - A Banner inside `send()` responses is logged as plain "received" (`connection.ts:632-636`).
  - An ALARM in `responses` is only logged. It clears neither `jobRunning` nor state, unlike `drained` and `events`.

## Connection lifetime

- **There is no native connection id.** `session.epoch` (`serial_session.rs:157`) is bumped on connect (`serial.rs:358`), disconnect (`:460`) and confirmed stop (`:1101`). It is never returned to TS by `serial_connect` (which returns a String) or by `serial_send`. Only job lines are checked against it.
- **Write sites with no guard:**
  - the connect `0x18` (`:326`);
  - a non-job send (`:523`);
  - `send_byte` (`:602`, realtime lock only);
  - the stop `0x18` (`:1028`, `:1035`);
  - the `?` probe (`:187`).

  Job sends go through `admit_and_write`, and the buffered pump through `JobPermit`.
- **Locks:**
  - Connect takes `command` then `realtime` only to install the handles (`:341-352`).
  - Disconnect locks `command` → None, then `realtime` → None (`:443-452`), in sequence, not nested.
  - `std::sync::Mutex` is not FIFO. **A non-job `serial_send` waiting on `command` across a disconnect and reconnect can write to the new controller**, with no check.

## Snapshots and ordering

- **`GrblSnapshot`** (`grbl_status.rs:97-129`) carries epoch, seq, state, positionKind (`"MPos"`/`"WPos"`), position, wco, feed, spindle, accessory, units, raw and unknownFields.
- **`epoch`** is the value captured when the command lock was taken.
- **`seq`** is global and never resets; it has gaps where parses failed (`serial_session.rs:315`).
- **`units` is always `Unknown`** (`grbl_status.rs:219`).
- **A `report` result can carry an older snapshot**, because on a parse failure or rejection it returns `read_snapshot()` (`serial.rs:672-675`). A busy result returns the last-known snapshot.
- **There is no write counter** linking a status sample to earlier writes. Within one `serial_send`, a `<…>` after `ok` is known to be post-ack.
- **Across calls, TS relies on the command lock plus its own `jogTick`.**

## Settings

- **`settingsGeneration`** (`connection.ts:94`) is bumped only by settings writes. **Disconnect clears laser mode (`:573`) but does not bump it**, so a late `$$` can set laser mode true again.
- **Readback paths:**
  - a console `$$` applies only the `$32` readback;
  - `readbackGrblSettings` applies either the `$32` readback or the full parse (`:958-975`);
  - there is no native settings command.
