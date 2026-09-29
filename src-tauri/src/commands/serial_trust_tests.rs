//! Motion-trust tests (relay `kerf-safety-motion-trust`, batch B1).
//!
//! Driven through the production bodies (`serial_send_inner`,
//! `serial_get_status_inner`, `serial_stream_job_inner`, `serial_stop_inner`,
//! `serial_connect_inner`, `disconnect_inner`) over a one-brain `ScriptedPort`
//! whose writer, reader and realtime handles share one ordered trace.
//!
//! Script separators are pre-released hold points: a `HoldUntilRelease`
//! step ends `bytes_to_read`'s contiguous-data count (so a drain stops there)
//! but costs no timeout tick when read.

use super::*;
use crate::sim::scripted_port::{HandleRole, ScriptStep, ScriptedPort, TraceEvent};

const BANNER: &[u8] = b"Grbl 1.1h ['$' for help]\r\n";

/// Pre-released separator hold ids.
const SEPS: [&str; 12] = [
    "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
];

pub(super) struct Rig {
    pub inner: Arc<SerialInner>,
    pub base: ScriptedPort,
}

pub(super) fn sep(i: usize) -> ScriptStep {
    ScriptStep::HoldUntilRelease { id: SEPS[i] }
}

pub(super) fn data(d: &'static [u8]) -> ScriptStep {
    ScriptStep::Data(d)
}

fn channel_for(base: &ScriptedPort) -> CommandChannel {
    CommandChannel {
        writer: Box::new(base.clone_with_role(HandleRole::Writer)),
        reader: BufReader::new(
            Box::new(base.clone_with_role(HandleRole::Reader)) as Box<dyn SerialPort>
        ),
        pending: Vec::new(),
    }
}

/// Pre-release every separator (several times each, so an id may recur).
pub(super) fn release_seps(base: &ScriptedPort) {
    for id in SEPS {
        for _ in 0..16 {
            base.release_hold(id);
        }
    }
}

/// An installed, idle connection over a scripted port.
pub(super) fn rig(script: Vec<ScriptStep>) -> Rig {
    let base = ScriptedPort::new(script);
    release_seps(&base);
    let inner = Arc::new(SerialInner {
        command: Mutex::new(Some(channel_for(&base))),
        realtime: Mutex::new(Some(
            Box::new(base.clone_with_role(HandleRole::Realtime)) as Box<dyn SerialPort>
        )),
        connected: AtomicBool::new(true),
        pump_in_flight: AtomicBool::new(false),
        job_abort: AtomicBool::new(false),
        session: SerialSession::default(),
    });
    inner.session.epoch.store(1, Ordering::SeqCst);
    inner.session.phase.store(PHASE_IDLE, Ordering::SeqCst);
    Rig { inner, base }
}

pub(super) fn send(r: &Rig, cmd: &str) -> Result<SendOutcome, String> {
    serial_send_inner(&r.inner, cmd, None)
}

pub(super) fn poll(r: &Rig) -> StatusOutcome {
    serial_get_status_inner(&r.inner).expect("status poll")
}

/// The published snapshot as TS sees it (JSON), so the reproduce-first
/// versions of these tests compile against the pre-B1 tree.
pub(super) fn snap_json(r: &Rig) -> serde_json::Value {
    serde_json::to_value(r.inner.session.read_snapshot().expect("a snapshot")).unwrap()
}

pub(super) fn writer_bytes(trace: &[TraceEvent]) -> Vec<u8> {
    trace
        .iter()
        .filter_map(|e| match e {
            TraceEvent::Write {
                role: HandleRole::Writer,
                data,
            } => Some(data.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

// ── N1 (reproduce-first): the drain and status-read sites ──────────────────

/// Home, observe, then a banner reaches the pre-write drain of the next
/// send. The published snapshot must stop saying homed.
#[test]
fn n1_banner_at_the_send_drain_revokes_homed() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n"), // $H
        sep(0),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"), // barrier probe
        data(BANNER), // buffered before the next send: drained
        sep(1),
        data(b"[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\nok\r\n"), // $G
        sep(2),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    send(&r, "$H").unwrap();
    poll(&r);
    assert_eq!(
        snap_json(&r)["homed"],
        serde_json::Value::Bool(true),
        "control: a clean $H grants homed"
    );
    send(&r, "$G").unwrap();
    poll(&r);
    assert_eq!(
        snap_json(&r)["homed"],
        serde_json::Value::Bool(false),
        "a banner drained before a write revokes homed"
    );
}

/// Home, observe (the observation is then current, so the next poll takes
/// the ordinary status read), then a banner arrives inside that read.
#[test]
fn n1_banner_at_the_status_read_revokes_homed() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n"), // $H
        sep(0),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"), // barrier probe
        sep(1),
        data(BANNER),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    send(&r, "$H").unwrap();
    poll(&r);
    assert_eq!(snap_json(&r)["homed"], serde_json::Value::Bool(true));
    poll(&r);
    assert_eq!(
        snap_json(&r)["homed"],
        serde_json::Value::Bool(false),
        "a banner read by the status read revokes homed"
    );
}

// ── N5 (reproduce-first): the observation barrier ──────────────────────────

/// A stale `<Idle|MPos:10…>` is already buffered after a jog's `ok`; the
/// real post-motion `<Idle|MPos:11…>` is the reply to the barrier's `?`.
#[test]
fn n5_barrier_drains_a_stale_idle_and_observes_the_probe_reply() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n<Idle|MPos:10.000,0.000,0.000|FS:0,0>\r\n"),
        sep(0),
        data(b"<Idle|MPos:11.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    send(&r, "$J=G91 X1 F100").unwrap();
    let out = poll(&r);
    let snap = out.snapshot.expect("a snapshot");
    assert_eq!(
        snap.position,
        Some([11.0, 0.0, 0.0]),
        "the stale buffered Idle must not be the observation"
    );
    let j = snap_json(&r);
    assert_eq!(j["observedPos"], serde_json::json!([11.0, 0.0, 0.0]));
    assert_eq!(j["observedSeq"], serde_json::json!(snap.seq));
}

// ── N8 (reproduce-first): the uncontended stale-connection schedule ────────

/// Disconnect and reconnect run to completion; a send made for the OLD
/// connection must not reach the new port. B1 adds only the identity; the
/// refusal (and so this test going green) is B2+B3.
#[test]
#[ignore = "B2+B3: the conn refusal makes this green; B1 adds only conn_id bookkeeping"]
fn n8_uncontended_stale_send_writes_nothing_to_the_new_port() {
    let old = ScriptedPort::new(vec![data(BANNER)]);
    let new = ScriptedPort::new(vec![data(BANNER), data(b"ok\r\n")]);
    let inner = Arc::new(SerialInner::default());
    let o = old.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "old", 115200, &|_| {}, &move |_, _| {
        o.try_clone()
    })
    .unwrap();
    disconnect_inner(&inner).unwrap();
    let n = new.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "new", 115200, &|_| {}, &move |_, _| {
        n.try_clone()
    })
    .unwrap();
    let before = writer_bytes(&new.trace()).len();
    // The "old connection's" send: today nothing names the connection.
    let _ = serial_send_inner(&inner, "$J=G91 X50 F3000", None);
    let after = writer_bytes(&new.trace());
    assert_eq!(
        after.len(),
        before,
        "a send for the old connection wrote to the new port: {:?}",
        String::from_utf8_lossy(&after[before..])
    );
}
