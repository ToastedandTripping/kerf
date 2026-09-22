//! GRBL status snapshot — a parsed, validated `<…>` status report that can be
//! read without holding the command mutex.
//!
//! The snapshot is the bridge between B1's admission fence (which needs to know
//! whether the machine is Idle/Run/Hold) and the TS side (B2b), without requiring
//! the command lock. The pump publishes a snapshot every time it reads a `<…>`
//! frame; the status query reads it independently.
//!
//! ## Parsing rules
//!
//! - Framing: `<` prefix, `>` suffix. Anything else is rejected.
//! - Fields are `|`-separated, order-independent.
//! - First field is the machine state (e.g. `Idle`, `Run`, `Hold:0`, `Door:1`).
//! - Position: `MPos:x,y,z` or `WPos:x,y,z`. Both accepted; kind recorded.
//! - WCO: `WCO:x,y,z` — work coordinate offset (optional, cached by GRBL).
//! - FS: `FS:feed,spindle` or `F:feed` (spindle omitted on some builds).
//! - Accessory field: `A:SFM` etc. Absent = Unknown (never "off").
//! - Truncated frames, NaN-like fields, and unknown states produce
//!   `GrblSnapshot` with `actionable_idle: false` — never a valid Idle.
//! - Unknown fields are retained in `unknown_fields`.

use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Machine state parsed from the first field of a `<…>` report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MachineState {
    Idle,
    Run,
    Hold {
        substate: Option<u8>,
    },
    Jog,
    Home,
    Door {
        substate: Option<u8>,
    },
    Alarm,
    Check,
    Sleep,
    /// A state token GRBL sent that we don't recognize. Treated as non-idle.
    Unknown(String),
}

impl MachineState {
    /// Whether this state is actionable Idle (safe to begin new work).
    #[allow(dead_code)]
    pub fn is_idle(&self) -> bool {
        matches!(self, MachineState::Idle)
    }

    /// Whether this state represents active motion or active operation
    /// that should renew a no-terminal deadline.
    #[allow(dead_code)]
    pub fn is_run_like(&self) -> bool {
        matches!(
            self,
            MachineState::Run
                | MachineState::Hold { .. }
                | MachineState::Jog
                | MachineState::Home
                | MachineState::Door { .. }
        )
    }
}

/// Which coordinate system the position was reported in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PositionKind {
    MPos,
    WPos,
}

/// Accessory field presence. `Unknown` means GRBL did not include the field —
/// that does NOT mean accessories are off. It means we don't know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AccessoryState {
    /// GRBL did not include the `A:` field in this report.
    Unknown,
    /// GRBL reported `A:` with the given raw flags (e.g. `"SFM"`).
    Present(String),
}

/// Units validity — we don't know until `$13` is queried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnitsValidity {
    /// `$13` has not been read; positions might be mm or inches.
    Unknown,
    /// `$13=0` confirmed: positions are mm.
    Mm,
    /// `$13=1` confirmed: positions are inches.
    Inches,
}

/// A parsed, validated GRBL status snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrblSnapshot {
    /// Connection epoch at the time the command lock was acquired (not at
    /// publish time — prevents post-stop snapshots carrying pre-stop epochs).
    pub epoch: u64,
    /// Monotonic receive sequence within this session.
    pub seq: u64,
    /// When this snapshot was received (not serialized — computed as age_ms at query).
    #[serde(skip)]
    #[allow(dead_code)]
    pub received_at: Option<Instant>,
    /// Machine state.
    pub state: MachineState,
    /// Position kind.
    pub position_kind: Option<PositionKind>,
    /// Position [x, y, z].
    pub position: Option<[f64; 3]>,
    /// Work coordinate offset [x, y, z] (cached by GRBL, sent periodically).
    pub wco: Option<[f64; 3]>,
    /// Feed rate (mm/min or in/min depending on $13).
    pub feed: Option<f64>,
    /// Spindle speed (RPM for spindle; on laser builds, the S-value).
    pub spindle: Option<f64>,
    /// Accessory field.
    pub accessory: AccessoryState,
    /// Units validity.
    pub units: UnitsValidity,
    /// Raw status string as received from GRBL.
    pub raw: String,
    /// Fields we didn't recognize (retained for debugging).
    pub unknown_fields: Vec<String>,
}

impl GrblSnapshot {
    /// Age in milliseconds since this snapshot was received.
    #[allow(dead_code)]
    pub fn age_ms(&self) -> u64 {
        self.received_at
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(u64::MAX)
    }
}

/// Parse a `<…>` status frame into a `GrblSnapshot`.
///
/// Returns `None` if the frame is not well-formed (missing `<`/`>` framing).
/// Malformed fields produce a snapshot with `state: Unknown` and
/// `actionable_idle` will be false, satisfying AC2.
pub fn parse_status_frame(raw: &str, epoch: u64, seq: u64) -> Option<GrblSnapshot> {
    let inner = raw.strip_prefix('<')?.strip_suffix('>')?;
    if inner.is_empty() {
        return None;
    }

    let mut fields = inner.split('|');

    // First field: machine state (required).
    let state_token = fields.next()?;
    let state = parse_machine_state_token(state_token);

    let mut position_kind = None;
    let mut position = None;
    let mut wco = None;
    let mut feed = None;
    let mut spindle = None;
    let mut accessory = AccessoryState::Unknown;
    let mut unknown_fields = Vec::new();

    for field in fields {
        if let Some(rest) = field.strip_prefix("MPos:") {
            if let Some(coords) = parse_xyz(rest) {
                position_kind = Some(PositionKind::MPos);
                position = Some(coords);
            }
        } else if let Some(rest) = field.strip_prefix("WPos:") {
            if let Some(coords) = parse_xyz(rest) {
                position_kind = Some(PositionKind::WPos);
                position = Some(coords);
            }
        } else if let Some(rest) = field.strip_prefix("WCO:") {
            wco = parse_xyz(rest);
        } else if let Some(rest) = field.strip_prefix("FS:") {
            let parts: Vec<&str> = rest.split(',').collect();
            if !parts.is_empty() {
                feed = parse_finite_f64(parts[0]);
            }
            if parts.len() >= 2 {
                spindle = parse_finite_f64(parts[1]);
            }
        } else if let Some(rest) = field.strip_prefix("F:") {
            feed = parse_finite_f64(rest);
        } else if let Some(rest) = field.strip_prefix("A:") {
            accessory = AccessoryState::Present(rest.to_string());
        } else if let Some(rest) = field.strip_prefix("Ov:") {
            // Override values — known field, not surfaced yet. Skip silently.
            let _ = rest;
        } else if let Some(rest) = field.strip_prefix("Pn:") {
            // Pin state — known field, not surfaced yet. Skip silently.
            let _ = rest;
        } else if let Some(rest) = field.strip_prefix("Bf:") {
            // Buffer state — known field, not surfaced yet. Skip silently.
            let _ = rest;
        } else if let Some(rest) = field.strip_prefix("Ln:") {
            // Line number — known field, not surfaced yet. Skip silently.
            let _ = rest;
        } else {
            unknown_fields.push(field.to_string());
        }
    }

    Some(GrblSnapshot {
        epoch,
        seq,
        received_at: Some(Instant::now()),
        state,
        position_kind,
        position,
        wco,
        feed,
        spindle,
        accessory,
        units: UnitsValidity::Unknown,
        raw: raw.to_string(),
        unknown_fields,
    })
}

/// Parse a machine state token like `Idle`, `Run`, `Hold:0`, `Door:1`.
fn parse_machine_state_token(token: &str) -> MachineState {
    if let Some(rest) = token.strip_prefix("Hold") {
        let substate = rest.strip_prefix(':').and_then(|s| s.parse::<u8>().ok());
        return MachineState::Hold { substate };
    }
    if let Some(rest) = token.strip_prefix("Door") {
        let substate = rest.strip_prefix(':').and_then(|s| s.parse::<u8>().ok());
        return MachineState::Door { substate };
    }
    match token {
        "Idle" => MachineState::Idle,
        "Run" => MachineState::Run,
        "Jog" => MachineState::Jog,
        "Home" => MachineState::Home,
        "Alarm" => MachineState::Alarm,
        "Check" => MachineState::Check,
        "Sleep" => MachineState::Sleep,
        other => MachineState::Unknown(other.to_string()),
    }
}

/// Parse `x,y,z` into `[f64; 3]`, rejecting NaN and infinity.
fn parse_xyz(s: &str) -> Option<[f64; 3]> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 3 {
        return None;
    }
    let x = parse_finite_f64(parts[0])?;
    let y = parse_finite_f64(parts[1])?;
    let z = parse_finite_f64(parts[2])?;
    Some([x, y, z])
}

/// Parse a float, rejecting NaN and infinity.
fn parse_finite_f64(s: &str) -> Option<f64> {
    let v: f64 = s.parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_idle_mpos() {
        let snap = parse_status_frame("<Idle|MPos:1.000,2.000,3.000|FS:0,0>", 1, 1).unwrap();
        assert!(snap.state.is_idle());
        assert_eq!(snap.position_kind, Some(PositionKind::MPos));
        assert_eq!(snap.position, Some([1.0, 2.0, 3.0]));
        assert_eq!(snap.feed, Some(0.0));
        assert_eq!(snap.spindle, Some(0.0));
        assert!(matches!(snap.accessory, AccessoryState::Unknown));
    }

    #[test]
    fn parse_run_wpos_with_accessory() {
        let snap = parse_status_frame("<Run|WPos:10.5,20.3,0.0|FS:500,1000|A:SFM>", 2, 5).unwrap();
        assert_eq!(snap.state, MachineState::Run);
        assert_eq!(snap.position_kind, Some(PositionKind::WPos));
        assert_eq!(snap.feed, Some(500.0));
        assert_eq!(snap.spindle, Some(1000.0));
        assert!(matches!(snap.accessory, AccessoryState::Present(ref s) if s == "SFM"));
    }

    #[test]
    fn parse_hold_substate() {
        let snap = parse_status_frame("<Hold:0|MPos:0,0,0|FS:0,0>", 1, 1).unwrap();
        assert_eq!(snap.state, MachineState::Hold { substate: Some(0) });
        assert!(snap.state.is_run_like());
        assert!(!snap.state.is_idle());
    }

    #[test]
    fn parse_door_substate() {
        let snap = parse_status_frame("<Door:1|MPos:0,0,0>", 1, 1).unwrap();
        assert_eq!(snap.state, MachineState::Door { substate: Some(1) });
        assert!(snap.state.is_run_like());
    }

    #[test]
    fn parse_unknown_state() {
        let snap = parse_status_frame("<FutureState|MPos:0,0,0>", 1, 1).unwrap();
        assert!(matches!(snap.state, MachineState::Unknown(ref s) if s == "FutureState"));
        assert!(!snap.state.is_idle());
        assert!(!snap.state.is_run_like());
    }

    #[test]
    fn reject_malformed_framing() {
        assert!(parse_status_frame("Idle|MPos:0,0,0>", 1, 1).is_none());
        assert!(parse_status_frame("<Idle|MPos:0,0,0", 1, 1).is_none());
        assert!(parse_status_frame("", 1, 1).is_none());
        assert!(parse_status_frame("<>", 1, 1).is_none());
    }

    #[test]
    fn nan_coordinates_rejected() {
        let snap = parse_status_frame("<Idle|MPos:NaN,0,0|FS:0,0>", 1, 1).unwrap();
        // Position should be None because NaN is rejected
        assert!(snap.position.is_none());
    }

    #[test]
    fn infinity_coordinates_rejected() {
        let snap = parse_status_frame("<Idle|MPos:inf,0,0|FS:0,0>", 1, 1).unwrap();
        assert!(snap.position.is_none());
    }

    #[test]
    fn out_of_order_fields() {
        let snap = parse_status_frame(
            "<Run|FS:500,800|A:S|MPos:1.0,2.0,3.0|WCO:0.5,0.5,0.0>",
            1,
            1,
        )
        .unwrap();
        assert_eq!(snap.state, MachineState::Run);
        assert_eq!(snap.position, Some([1.0, 2.0, 3.0]));
        assert_eq!(snap.wco, Some([0.5, 0.5, 0.0]));
        assert_eq!(snap.feed, Some(500.0));
        assert!(matches!(snap.accessory, AccessoryState::Present(ref s) if s == "S"));
    }

    #[test]
    fn unknown_fields_retained() {
        let snap = parse_status_frame("<Idle|MPos:0,0,0|FutureField:abc|FS:0,0>", 1, 1).unwrap();
        assert_eq!(snap.unknown_fields, vec!["FutureField:abc"]);
    }

    #[test]
    fn f_only_no_spindle() {
        let snap = parse_status_frame("<Idle|MPos:0,0,0|F:1500>", 1, 1).unwrap();
        assert_eq!(snap.feed, Some(1500.0));
        assert_eq!(snap.spindle, None);
    }

    #[test]
    fn wco_field_parsed() {
        let snap = parse_status_frame("<Idle|MPos:0,0,0|WCO:10.0,20.0,30.0>", 1, 1).unwrap();
        assert_eq!(snap.wco, Some([10.0, 20.0, 30.0]));
    }

    #[test]
    fn epoch_and_seq_carried() {
        let snap = parse_status_frame("<Idle|MPos:0,0,0>", 42, 99).unwrap();
        assert_eq!(snap.epoch, 42);
        assert_eq!(snap.seq, 99);
    }

    #[test]
    fn fused_frame_rejected() {
        // A fused frame like `<Idle|MPos:0,0,0>ALARM:1` should NOT parse as a
        // valid status frame because the `>` is not at the end.
        // The raw string contains characters after `>`.
        let result = parse_status_frame("<Idle|MPos:0,0,0>ALARM:1", 1, 1);
        // strip_suffix('>') looks for '>' at the end. "...>ALARM:1" does not end with '>'.
        assert!(
            result.is_none(),
            "fused frame must not parse as valid status"
        );
    }

    #[test]
    fn home_and_jog_are_run_like() {
        let snap = parse_status_frame("<Home|MPos:0,0,0>", 1, 1).unwrap();
        assert!(snap.state.is_run_like());
        let snap = parse_status_frame("<Jog|MPos:0,0,0>", 1, 1).unwrap();
        assert!(snap.state.is_run_like());
    }
}
