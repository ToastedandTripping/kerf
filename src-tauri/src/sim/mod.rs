//! Virtual GRBL 1.1 controller for CI-testable serial streaming.
//!
//! Kerf hardening program, Phase 1 ("GRBL simulator + test spine"),
//! Relay 1A. See `.claude/plans/kerf-hardening-program.md`.
//!
//! Gated `#[cfg(any(test, feature = "sim"))]` from `lib.rs`: excluded from
//! plain `cargo build`/release builds, included whenever running tests, and
//! includable standalone via `--features sim` for Phase 2's demo connectable
//! port (not wired up in this relay).

pub mod grbl;
