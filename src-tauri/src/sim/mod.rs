//! Test infrastructure for the serial/GRBL command layer.
//!
//! Gated `#[cfg(any(test, feature = "sim"))]` from `lib.rs`: excluded from
//! plain `cargo build`/release builds, included whenever running tests, and
//! includable standalone via `--features sim`.
//!
//! - `grbl.rs`: Virtual GRBL 1.1 controller (SimPort) with fault injection.
//! - `scripted_port.rs`: Deterministic test double with scripted reads,
//!   ordered I/O trace, hold points, and session-event observer.

pub mod grbl;
pub mod scripted_port;
