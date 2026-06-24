//! OS sleep-inhibitor commands — WS4: keep-awake during laser jobs.
//!
//! Holds a system sleep-inhibitor (via the `keepawake` crate) for the full
//! duration of a running job so a sleeping computer cannot halt a multi-hour cut.
//!
//! ## Design
//! The `KeepAwakeState` managed type wraps a `Mutex<Option<keepawake::KeepAwake>>`.
//! The guard is an RAII type: releasing `Some(_)` drops it, clearing the OS assertion.
//! Both commands are idempotent: acquire no-ops if a guard is already held; release
//! no-ops if none is held. Acquire failure returns `Err(String)` that the JS caller
//! can swallow — NEVER panics, so a power-assertion failure cannot break a job.
//!
//! ## Laser safety
//! This module acquires/releases an OS power assertion only. It emits zero G-code,
//! zero motion commands, and zero laser commands. No serial interaction whatsoever.
//!
//! ## Coverage note
//! The single `useStore.subscribe` listener in `src/lib/machine/keepAwake.ts` drives
//! both commands. It observes `jobRunning`, which is set to `true` by BOTH the main
//! job loop (`MachinePanel.tsx`) AND the material-test grid (`MaterialTestDialog.tsx`),
//! so the inhibitor covers both job types without separate wiring.

use std::sync::Mutex;
use tauri::State;

/// Managed state wrapping the optional keep-awake guard.
/// `Default` constructs with no guard held (no OS assertion).
pub struct KeepAwakeState(pub Mutex<Option<keepawake::KeepAwake>>);

impl Default for KeepAwakeState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Acquire an OS sleep-inhibitor for the duration of a running job.
///
/// If a guard is already held this is a no-op (idempotent). Returns `Err` if
/// the OS refuses the assertion; the JS caller swallows this and logs a warning
/// so a headless-Linux D-Bus miss never terminates the job.
#[tauri::command]
pub fn keep_awake_acquire(state: State<'_, KeepAwakeState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|e| format!("keep-awake lock poisoned: {}", e))?;

    if guard.is_some() {
        // Already holding an assertion — no-op.
        return Ok(());
    }

    let awake = keepawake::Builder::default()
        .display(false)
        .idle(true)
        .sleep(true)
        .reason("Laser job in progress")
        .app_name("Kerf")
        .app_reverse_domain("io.github.kerf")
        .create()
        .map_err(|e| format!("keep-awake acquire failed: {}", e))?;

    *guard = Some(awake);
    Ok(())
}

/// Release the OS sleep-inhibitor after a job completes (or is stopped).
///
/// If no guard is held this is a no-op (idempotent). Dropping the `KeepAwake`
/// guard releases the OS power assertion immediately.
#[tauri::command]
pub fn keep_awake_release(state: State<'_, KeepAwakeState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|e| format!("keep-awake lock poisoned: {}", e))?;

    // Drop the guard — releases the OS assertion on Drop.
    *guard = None;
    Ok(())
}
