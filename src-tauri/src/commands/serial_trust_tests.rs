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

/// A console relative motion (class `Motion`). B1's tests used a `$J=` jog
/// as their motion carrier; from B2+B3 a jog is admitted only from a clean
/// home, mm units and a matching basis, so these tests move by console.
const MOVE: &str = "G91 G0 X1";

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
    serial_send_inner(&r.inner, cmd, None, cur(&r.inner), None)
}

pub(super) fn poll(r: &Rig) -> StatusOutcome {
    serial_get_status_inner(&r.inner, cur(&r.inner)).expect("status poll")
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
        data(BANNER),                                      // buffered before the next send: drained
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
    send(&r, MOVE).unwrap();
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
fn n8_uncontended_stale_send_writes_nothing_to_the_new_port() {
    let old = ScriptedPort::new(vec![data(BANNER)]);
    let new = ScriptedPort::new(vec![data(BANNER), data(b"ok\r\n")]);
    let inner = Arc::new(SerialInner::default());
    let o = old.clone_with_role(HandleRole::Writer);
    let old_conn = serial_connect_inner(&inner, "old", 115200, &|_| {}, &move |_, _| o.try_clone())
        .unwrap()
        .conn_id;
    disconnect_inner(&inner).unwrap();
    let n = new.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "new", 115200, &|_| {}, &move |_, _| n.try_clone()).unwrap();
    let before = writer_bytes(&new.trace()).len();
    // The old connection's send names the old connection (B2+B3).
    let res = serial_send_inner(&inner, "G91 G0 X50", None, old_conn, None);
    assert!(
        res.as_ref()
            .is_err_and(|e| e.starts_with("refused: stale-connection:")),
        "{res:?}"
    );
    let after = writer_bytes(&new.trace());
    assert_eq!(
        after.len(),
        before,
        "a send for the old connection wrote to the new port: {:?}",
        String::from_utf8_lossy(&after[before..])
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// B1 suite
// ═══════════════════════════════════════════════════════════════════════════

use super::serial_session::{
    classify_outbound, lock_rank, normalize_grbl_line, Outbound, TrustView,
};
use std::thread;

const IDLE0: &[u8] = b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n";

fn tv(r: &Rig) -> TrustView {
    r.inner.session.trust_view()
}

fn epoch(r: &Rig) -> u64 {
    tv(r).trust_epoch
}

fn nap(_: Duration) {
    thread::sleep(Duration::from_millis(1));
}

/// A rig whose script starts with `$H` → `ok` and one barrier observation
/// (`IDLE0`), followed by `rest`. Returns homed and observed.
fn homed_rig(rest: Vec<ScriptStep>) -> Rig {
    let mut script = vec![sep(0), data(b"ok\r\n"), sep(0), data(IDLE0)];
    script.extend(rest);
    let r = rig(script);
    send(&r, "$H").unwrap();
    poll(&r);
    let v = tv(&r);
    assert!(v.homed, "precondition: homed after a clean $H: {v:?}");
    assert!(v.observed_seq.is_some(), "precondition: observed: {v:?}");
    r
}

// ── N1: every read site ────────────────────────────────────────────────────

#[test]
fn n1_run_pump_banner_terminal_revokes() {
    let r = homed_rig(vec![sep(1), data(BANNER)]);
    let e = epoch(&r);
    send(&r, "$G").unwrap();
    assert_eq!(epoch(&r), e + 1, "run_pump: the banner is noted once");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_run_pump_alarm_line_revokes() {
    let r = homed_rig(vec![sep(1), data(b"ALARM:1\r\n")]);
    let e = epoch(&r);
    send(&r, "$G").unwrap();
    assert_eq!(epoch(&r), e + 1, "run_pump: ALARM:1 is noted");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_run_pump_alarm_status_frame_revokes() {
    let r = homed_rig(vec![
        sep(1),
        data(b"<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\nok\r\n"),
    ]);
    let e = epoch(&r);
    send(&r, "$G").unwrap();
    assert_eq!(epoch(&r), e + 1, "run_pump: <Alarm…> is noted");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_run_pump_idle_status_frame_does_not_revoke() {
    let r = homed_rig(vec![
        sep(1),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\nok\r\n"),
    ]);
    let e = epoch(&r);
    send(&r, "$G").unwrap();
    assert_eq!(epoch(&r), e, "an Idle frame and ok are not invalidating");
    assert!(tv(&r).homed);
}

#[test]
fn n1_drain_alarm_revokes() {
    let r = homed_rig(vec![data(b"ALARM:1\r\n"), sep(1), data(b"ok\r\n")]);
    let e = epoch(&r);
    send(&r, "$G").unwrap();
    assert_eq!(epoch(&r), e + 1, "the pre-write drain notes ALARM:1");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_status_read_alarm_line_and_alarm_frame_revoke() {
    let r = homed_rig(vec![sep(1), data(b"ALARM:1\r\n"), data(IDLE0)]);
    let e = epoch(&r);
    poll(&r);
    assert_eq!(epoch(&r), e + 1, "status read notes ALARM:1");
    assert!(!tv(&r).homed);

    let r = homed_rig(vec![
        sep(1),
        data(b"<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    let e = epoch(&r);
    poll(&r);
    assert_eq!(epoch(&r), e + 1, "status read notes <Alarm…>");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_status_read_banner_advances_epoch_once() {
    let r = homed_rig(vec![sep(1), data(BANNER), data(IDLE0)]);
    let e = epoch(&r);
    poll(&r);
    assert_eq!(epoch(&r), e + 1);
}

#[test]
fn n1_buffered_pump_banner_revokes() {
    let r = homed_rig(vec![sep(1), data(BANNER)]);
    let job = serial_job_begin_inner(&r.inner).unwrap();
    let e = epoch(&r);
    let out = serial_stream_job_inner(&r.inner, "G1 X1 F100", job, true, &|_| Ok(())).unwrap();
    assert_eq!(out, "aborted");
    // +1 the noted banner, +1 the job ending without completing.
    assert_eq!(epoch(&r), e + 2, "buffered pump: the banner is noted");
    assert!(!tv(&r).homed);
}

#[test]
fn n1_connect_drain_notes_the_banner() {
    let port = ScriptedPort::new(vec![data(BANNER)]);
    let inner = Arc::new(SerialInner::default());
    let p = port.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "p", 115200, &|_| {}, &move |_, _| p.try_clone()).unwrap();
    let v = inner.session.trust_view();
    // +1 the noted banner, +1 the connect install.
    assert_eq!(
        v.trust_epoch, 2,
        "connect drain: the banner is noted: {v:?}"
    );
    assert_eq!(v.conn_id, 1);
    assert!(!v.homed);

    // The drain function itself hands every line to the hook.
    let port = ScriptedPort::new(vec![data(b"\r\n"), data(b"ALARM:1\r\n"), data(BANNER)]);
    let mut ch = channel_for(&port);
    let mut seen = Vec::new();
    let banner = drain_startup_banner_noted(&mut ch, &mut |l: &str, c: LineClass| {
        seen.push((l.to_string(), c))
    });
    assert!(banner.contains("Grbl"));
    assert_eq!(
        seen,
        vec![
            ("ALARM:1".to_string(), LineClass::Alarm),
            ("Grbl 1.1h ['$' for help]".to_string(), LineClass::Banner),
        ]
    );
}

#[test]
fn n1_stop_read_notes_alarm_and_banner() {
    let r = homed_rig(vec![data(b"ALARM:3\r\n"), data(BANNER)]);
    let e = epoch(&r);
    let res = serial_stop_inner(&r.inner, &nap);
    assert!(matches!(res, StopResult::Confirmed { .. }), "{res:?}");
    // +1 close_admission, +1 the noted ALARM:3, +1 the noted banner.
    assert_eq!(epoch(&r), e + 3, "the stop read notes every line it takes");
    assert!(!tv(&r).homed);
}

// ── N2: reachable error paths ──────────────────────────────────────────────

#[test]
fn n2_run_pump_alarm_frame_then_io_error_advances_epoch() {
    let r = homed_rig(vec![
        sep(1),
        data(b"<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\n"),
        ScriptStep::Error("boom".to_string()),
    ]);
    let e = epoch(&r);
    assert!(send(&r, "$G").is_err());
    assert_eq!(epoch(&r), e + 1, "the Status line was noted before the Err");
    assert!(!tv(&r).homed);
}

#[test]
fn n2_status_read_alarm_then_error_advances_epoch() {
    let r = homed_rig(vec![
        sep(1),
        data(b"ALARM:2\r\n"),
        ScriptStep::Error("boom".to_string()),
    ]);
    let e = epoch(&r);
    assert!(serial_get_status_inner(&r.inner, cur(&r.inner)).is_err());
    assert_eq!(epoch(&r), e + 1, "ALARM:2 was noted before the Err");
    assert!(!tv(&r).homed);
}

// ── N3: the grant ──────────────────────────────────────────────────────────

#[test]
fn n3_plain_home_ok_grants() {
    let r = rig(vec![sep(0), data(b"ok\r\n")]);
    assert!(!tv(&r).homed);
    send(&r, "$H").unwrap();
    assert!(tv(&r).homed);
}

#[test]
fn n3_home_axis_does_not_grant_and_revokes() {
    let r = homed_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$HX").unwrap();
    assert!(!tv(&r).homed, "$HX never grants, and revokes");
}

#[test]
fn n3_home_with_alarm_frame_during_pump_does_not_grant() {
    let r = rig(vec![
        sep(0),
        data(b"<Alarm|MPos:0.000,0.000,0.000|FS:0,0>\r\nok\r\n"),
    ]);
    send(&r, "$H").unwrap();
    assert!(!tv(&r).homed, "an invalidating line during the $H call");
}

#[test]
fn n3_home_with_alarm_line_does_not_grant() {
    let r = rig(vec![sep(0), data(b"ALARM:9\r\n")]);
    send(&r, "$H").unwrap();
    assert!(!tv(&r).homed);
}

#[test]
fn n3_banner_drained_before_the_home_write_still_grants() {
    // Prior history is revoked by the drain; the new home re-earns trust.
    let r = rig(vec![data(BANNER), sep(0), data(b"ok\r\n")]);
    send(&r, "$H").unwrap();
    assert!(tv(&r).homed);
}

#[test]
fn n3_home_error_does_not_grant() {
    let r = rig(vec![sep(0), data(b"error:9\r\n")]);
    send(&r, "$H").unwrap();
    assert!(!tv(&r).homed);
}

// ── N5: the barrier, split-frame case ──────────────────────────────────────

#[test]
fn n5_split_stale_frame_is_completed_noted_and_discarded() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n<Idle|MPos:10.000,0"),
        sep(1),
        data(b".000,0.000|FS:0,0>\r\n"),
        sep(2),
        data(b"<Idle|MPos:11.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    send(&r, MOVE).unwrap();
    let out = poll(&r);
    let snap = out.snapshot.unwrap();
    assert_eq!(snap.position, Some([11.0, 0.0, 0.0]));
    let v = tv(&r);
    assert_eq!(v.observed_pos, Some([11.0, 0.0, 0.0]));
    assert_eq!(v.observed_seq, Some(snap.seq));
    // The completed stale frame was published (as an ordinary snapshot)
    // before the probe: its seq precedes the observation's.
    assert_eq!(snap.seq, 2, "stale frame seq 1, observation seq 2");
    // And the probe `?` was written only after the stale tail was read.
    let trace = r.base.trace();
    let probe = trace
        .iter()
        .position(
            |e| matches!(e, TraceEvent::Write { role: HandleRole::Writer, data } if data == b"?"),
        )
        .expect("probe written");
    let tail_read = trace
        .iter()
        .position(|e| matches!(e, TraceEvent::HoldReleased { id } if id == "s1"))
        .expect("tail read");
    assert!(
        tail_read < probe,
        "the partial line completes before the probe: {trace:?}"
    );
}

#[test]
fn n5_still_partial_line_writes_no_probe_and_observes_nothing() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n<Idle|MPos:10.000,0"),
        ScriptStep::Timeout,
    ]);
    send(&r, MOVE).unwrap();
    let out = poll(&r);
    assert_eq!(out.kind, StatusKind::NoResponse);
    assert!(tv(&r).observed_seq.is_none());
    assert!(
        !writer_bytes(&r.base.trace()).ends_with(b"?"),
        "no probe behind an unfinished line"
    );
}

#[test]
fn n5_barrier_waits_the_quiesce_after_motion() {
    let r = rig(vec![sep(0), data(b"ok\r\n"), sep(1), data(IDLE0)]);
    send(&r, MOVE).unwrap();
    let t = std::time::Instant::now();
    poll(&r);
    assert!(
        t.elapsed() >= Duration::from_millis(OBSERVE_QUIESCE_MS - 5),
        "the barrier must quiesce after a motion: {:?}",
        t.elapsed()
    );
    assert!(tv(&r).observed_seq.is_some());
}

#[test]
fn n5_barrier_reruns_until_idle() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n"),
        sep(1),
        data(b"<Jog|MPos:0.500,0.000,0.000|FS:100,0>\r\n"),
        sep(2),
        data(b"<Idle|MPos:1.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    send(&r, MOVE).unwrap();
    poll(&r);
    assert!(
        tv(&r).observed_seq.is_none(),
        "a Jog observation is not current"
    );
    assert!(
        r.inner.session.observation_stale(),
        "and so the barrier re-runs"
    );
    poll(&r);
    assert_eq!(tv(&r).observed_pos, Some([1.0, 0.0, 0.0]));
}

#[test]
fn n5_current_observation_is_carried_by_later_snapshots() {
    let r = homed_rig(vec![
        sep(1),
        data(b"<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"),
    ]);
    let first = tv(&r).observed_seq.unwrap();
    let out = poll(&r); // ordinary read: observation current
    let snap = out.snapshot.unwrap();
    assert!(snap.seq > first);
    assert_eq!(
        snap.observed_seq,
        Some(first),
        "same basis on a later frame"
    );
    assert_eq!(snap.observed_pos, Some([0.0, 0.0, 0.0]));
    assert!(snap.homed);
    assert_eq!(snap.conn_id, 0, "rig has no connect install");
}

// ── N6: the ledger ─────────────────────────────────────────────────────────

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    while !f() {
        assert!(
            std::time::Instant::now() < deadline,
            "never observed: {what}"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn n6_concurrent_motion_sends_are_all_counted() {
    let r = homed_rig(vec![
        sep(1),
        ScriptStep::HoldUntilRelease { id: "jogA" },
        data(b"ok\r\n"),
        sep(2),
        data(b"ok\r\n"),
        sep(3),
        data(IDLE0),
    ]);
    let pending = |r: &Rig| r.inner.session.trust().motion_pending;
    let a = {
        let inner = r.inner.clone();
        thread::spawn(move || serial_send_inner(&inner, MOVE, None, cur(&inner), None))
    };
    wait_for("A in its pump", || {
        r.base
            .trace()
            .iter()
            .any(|e| matches!(e, TraceEvent::HoldReached { id } if id == "jogA"))
    });
    assert_eq!(pending(&r), 1);
    let b = {
        let inner = r.inner.clone();
        thread::spawn(move || serial_send_inner(&inner, "G0 X1", None, cur(&inner), None))
    };
    wait_for("B counted while queued on command", || pending(&r) == 2);
    assert!(tv(&r).motion_pending);
    r.base.release_hold("jogA");
    a.join().unwrap().unwrap();
    b.join().unwrap().unwrap();
    assert_eq!(pending(&r), 0, "RAII decrement on return");
    assert!(!tv(&r).motion_pending);
    assert!(tv(&r).observed_seq.is_none(), "not observed after motion");
    poll(&r);
    assert!(tv(&r).observed_seq.is_some(), "observed after the barrier");
}

#[test]
fn n6_motion_guard_decrements_on_error_returns() {
    let r = rig(vec![sep(0), ScriptStep::Error("boom".to_string())]);
    assert!(send(&r, MOVE).is_err());
    assert_eq!(r.inner.session.trust().motion_pending, 0);
    // Non-motion sends are not counted.
    let r = rig(vec![
        sep(0),
        ScriptStep::HoldUntilRelease { id: "q" },
        data(b"ok\r\n"),
    ]);
    let inner = r.inner.clone();
    let h = thread::spawn(move || serial_send_inner(&inner, "$G", None, cur(&inner), None));
    wait_for("in pump", || {
        r.base
            .trace()
            .iter()
            .any(|e| matches!(e, TraceEvent::HoldReached { id } if id == "q"))
    });
    assert_eq!(
        r.inner.session.trust().motion_pending,
        0,
        "$G is not motion"
    );
    r.base.release_hold("q");
    h.join().unwrap().unwrap();
}

#[test]
fn n6_job_admission_clears_the_observation() {
    let r = homed_rig(vec![
        sep(1),
        data(b"ok\r\n"),
        sep(2),
        data(b"ok\r\n"),
        sep(3),
        data(IDLE0),
    ]);
    let w0 = r.inner.session.trust().motion_writes;
    let job = serial_job_begin_inner(&r.inner).unwrap();
    assert!(
        tv(&r).observed_seq.is_none(),
        "admitting a job clears the observation, before any line"
    );
    serial_send_inner(&r.inner, "G1 X1 F100", Some(job), cur(&r.inner), None).unwrap();
    serial_send_inner(&r.inner, "M5", Some(job), cur(&r.inner), None).unwrap();
    serial_job_end_inner(&r.inner, job).unwrap();
    assert!(tv(&r).observed_seq.is_none());
    assert_eq!(
        r.inner.session.trust().motion_writes,
        w0 + 2,
        "job lines are motion"
    );
    poll(&r);
    assert!(tv(&r).observed_seq.is_some(), "a new barrier observes");
}

#[test]
fn n6_job_line_write_clears_the_observation() {
    // Isolated from admission: re-observe after begin, then one line.
    let r = homed_rig(vec![sep(1), data(IDLE0), sep(2), data(b"ok\r\n")]);
    let job = serial_job_begin_inner(&r.inner).unwrap();
    poll(&r);
    assert!(tv(&r).observed_seq.is_some());
    serial_send_inner(&r.inner, "M5", Some(job), cur(&r.inner), None).unwrap();
    assert!(
        tv(&r).observed_seq.is_none(),
        "a job line is a motion write"
    );
}

#[test]
fn n6_buffered_job_lines_are_motion_writes() {
    let r = homed_rig(vec![sep(1), data(b"ok\r\nok\r\n")]);
    let w0 = r.inner.session.trust().motion_writes;
    let job = serial_job_begin_inner(&r.inner).unwrap();
    let out = serial_stream_job_inner(&r.inner, "G1 X1 F100\nM5", job, true, &|_| Ok(())).unwrap();
    assert_eq!(out, "complete");
    assert_eq!(r.inner.session.trust().motion_writes, w0 + 2);
    assert!(tv(&r).observed_seq.is_none());
    assert!(tv(&r).homed, "a completed job keeps the home");
}

// ── N7: literal Idle ───────────────────────────────────────────────────────

#[test]
fn n7_only_literal_idle_with_mpos_is_an_observation() {
    let cases: [(&'static [u8], bool); 7] = [
        (b"<Idle|MPos:1.000,2.000,0.000|FS:0,0>\r\n", true),
        (b"<Check|MPos:1.000,2.000,0.000|FS:0,0>\r\n", false),
        (b"<Sleep|MPos:1.000,2.000,0.000|FS:0,0>\r\n", false),
        (b"<Hold:0|MPos:1.000,2.000,0.000|FS:0,0>\r\n", false),
        (b"<Idle|WPos:1.000,2.000,0.000|FS:0,0>\r\n", false),
        (b"<Idle|FS:0,0>\r\n", false),
        (b"<Idle|MPos:1.000,nan,0.000|FS:0,0>\r\n", false),
    ];
    for (frame, want) in cases {
        let r = rig(vec![sep(0), data(frame)]);
        poll(&r);
        let o = r
            .inner
            .session
            .trust()
            .observed
            .expect("an observation was taken");
        assert_eq!(o.idle_mpos, want, "{}", String::from_utf8_lossy(frame));
        assert_eq!(o.mpos.is_some(), want);
        assert_eq!(tv(&r).observed_seq.is_some(), want);
    }
}

// ── N8 (B1 scope): connection identity bookkeeping ─────────────────────────

#[test]
fn n8_connect_and_disconnect_manage_the_connection_identity() {
    let a = ScriptedPort::new(vec![data(BANNER)]);
    let inner = Arc::new(SerialInner::default());
    let p = a.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "a", 115200, &|_| {}, &move |_, _| p.try_clone()).unwrap();
    let v1 = inner.session.trust_view();
    assert_eq!(v1.conn_id, 1);
    // Trust some state, then tear down.
    {
        let mut t = inner.session.trust();
        t.homed_at = Some(t.trust_epoch);
        t.units_mm = Some(1);
    }
    disconnect_inner(&inner).unwrap();
    let v2 = inner.session.trust_view();
    assert_eq!(v2.conn_id, 0);
    assert!(v2.trust_epoch > v1.trust_epoch);
    assert!(!v2.homed && !v2.units_mm);
    assert!(inner.session.trust().units_mm.is_none());

    let b = ScriptedPort::new(vec![data(BANNER)]);
    let p = b.clone_with_role(HandleRole::Writer);
    serial_connect_inner(&inner, "b", 115200, &|_| {}, &move |_, _| p.try_clone()).unwrap();
    let v3 = inner.session.trust_view();
    assert_eq!(v3.conn_id, 2, "a new identity per connection");
    assert!(v3.trust_epoch > v2.trust_epoch);
    assert!(!v3.homed && !v3.units_mm && v3.observed_seq.is_none());
}

// ── N10: units ─────────────────────────────────────────────────────────────

const SETTINGS_MM: &[u8] = b"$0=10\r\n$13=0\r\n$32=1\r\nok\r\n";

#[test]
fn n10_settings_read_with_13_zero_sets_mm() {
    let r = rig(vec![sep(0), data(SETTINGS_MM)]);
    r.inner.session.trust().conn_id = 7;
    send(&r, "$$").unwrap();
    assert!(tv(&r).units_mm);
    assert_eq!(r.inner.session.trust().units_mm, Some(7));
}

#[test]
fn n10_no_units_without_a_connection() {
    let r = rig(vec![sep(0), data(SETTINGS_MM)]);
    send(&r, "$$").unwrap();
    assert!(!tv(&r).units_mm, "conn_id 0: no units");
}

fn mm_rig(rest: Vec<ScriptStep>) -> Rig {
    let mut script = vec![
        sep(0),
        data(b"ok\r\n"),
        sep(0),
        data(IDLE0),
        sep(0),
        data(SETTINGS_MM),
    ];
    script.extend(rest);
    let r = rig(script);
    r.inner.session.trust().conn_id = 1;
    send(&r, "$H").unwrap();
    poll(&r);
    send(&r, "$$").unwrap();
    let v = tv(&r);
    assert!(v.units_mm && v.homed, "precondition: {v:?}");
    r
}

#[test]
fn n10_report_units_write_clears_units_and_revokes_homed() {
    let r = mm_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$13=1").unwrap();
    assert!(!tv(&r).units_mm);
    assert!(!tv(&r).homed, "$13 is frame-affecting");
}

#[test]
fn n10_frame_key_write_clears_units_and_revokes_homed() {
    let r = mm_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$100=80").unwrap();
    assert!(!tv(&r).units_mm);
    assert!(!tv(&r).homed);
}

#[test]
fn n10_other_key_write_clears_units_only() {
    let r = mm_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$32=1").unwrap();
    assert!(!tv(&r).units_mm);
    assert!(tv(&r).homed, "$32 is not frame-affecting");
}

#[test]
fn n10_startup_line_write_clears_units() {
    let r = mm_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$N0=G21").unwrap();
    assert!(!tv(&r).units_mm);
}

#[test]
fn n10_settings_read_without_13_clears() {
    let r = mm_rig(vec![sep(1), data(b"$0=10\r\n$32=1\r\nok\r\n")]);
    send(&r, "$$").unwrap();
    assert!(!tv(&r).units_mm);
}

#[test]
fn n10_settings_read_with_13_one_clears() {
    let r = mm_rig(vec![sep(1), data(b"$13=0\r\n$13=1\r\nok\r\n")]);
    send(&r, "$$").unwrap();
    assert!(!tv(&r).units_mm);
}

#[test]
fn n10_settings_read_error_clears() {
    let r = mm_rig(vec![sep(1), ScriptStep::Error("boom".to_string())]);
    assert!(send(&r, "$$").is_err());
    assert!(!tv(&r).units_mm);
}

#[test]
fn n10_reset_settings_clears_units_and_revokes_homed() {
    let r = mm_rig(vec![sep(1), data(b"ok\r\n")]);
    send(&r, "$RST=$").unwrap();
    assert!(!tv(&r).units_mm);
    assert!(!tv(&r).homed);
}

#[test]
fn n10_banner_revokes_homed_but_keeps_units() {
    let r = mm_rig(vec![sep(1), data(BANNER)]);
    send(&r, "$G").unwrap();
    assert!(!tv(&r).homed);
    assert!(
        tv(&r).units_mm,
        "units live with the connection plus writes"
    );
}

#[test]
fn n10_units_serialise_as_mm_on_the_snapshot() {
    let r = mm_rig(vec![sep(1), data(IDLE0)]);
    poll(&r);
    let snap = r.inner.session.read_snapshot().unwrap();
    assert!(snap.units_mm);
    assert_eq!(snap.units, super::super::grbl_status::UnitsValidity::Mm);
    let j = snap_json(&r);
    assert_eq!(j["unitsMm"], serde_json::Value::Bool(true));
    assert_eq!(j["units"], serde_json::json!("Mm"));
    for key in [
        "connId",
        "trustEpoch",
        "homed",
        "unitsMm",
        "motionPending",
        "observedSeq",
        "observedPos",
    ] {
        assert!(j.get(key).is_some(), "snapshot JSON carries {key}: {j}");
    }
}

// ── N11: motion I/O error ──────────────────────────────────────────────────

#[test]
fn n11_motion_send_error_after_write_revokes_homed() {
    let r = homed_rig(vec![sep(1), ScriptStep::Error("io".to_string())]);
    let e = epoch(&r);
    assert!(send(&r, MOVE).is_err());
    assert_eq!(epoch(&r), e + 1, "position unknown after a failed motion");
    assert!(!tv(&r).homed);
}

#[test]
fn n11_non_motion_send_error_keeps_homed() {
    let r = homed_rig(vec![sep(1), ScriptStep::Error("io".to_string())]);
    assert!(send(&r, "$G").is_err());
    assert!(tv(&r).homed);
}

// ── Raw reset / jog cancel, and STOP ───────────────────────────────────────

#[test]
fn raw_reset_and_jog_cancel_revoke_homed_other_realtime_bytes_do_not() {
    for (b, revokes) in [
        (0x18u8, true),
        (0x85, true),
        (b'!', false),
        (b'~', false),
        (b'?', false),
    ] {
        let r = homed_rig(vec![]);
        send_byte_inner(&r.inner, cur(&r.inner), b).unwrap();
        assert_eq!(!tv(&r).homed, revokes, "byte 0x{b:02x}");
        assert!(r.base.trace().iter().any(
            |e| matches!(e, TraceEvent::Write { role: HandleRole::Realtime, data } if data == &[b])
        ));
    }
}

#[test]
fn realtime_reset_completes_while_command_lock_held_and_waits_only_on_submit() {
    let r = homed_rig(vec![]);
    let cmd = r.inner.command.lock().unwrap();
    // Hold `submit` as a job-line write would.
    let submit = r.inner.session.submit.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let inner = r.inner.clone();
    thread::spawn(move || {
        let _ = tx.send(send_byte_inner(&inner, cur(&inner), 0x18));
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "0x18 waits behind the one submit holder"
    );
    drop(submit);
    let res = rx
        .recv_timeout(Duration::from_millis(500))
        .expect("0x18 must complete while command is held once submit is free");
    assert!(res.is_ok());
    drop(cmd);
    assert!(!tv(&r).homed);
}

#[test]
fn stop_close_admission_revokes_homed() {
    let r = homed_rig(vec![data(BANNER)]);
    let e = epoch(&r);
    serial_stop_inner(&r.inner, &nap);
    // +1 close_admission, +1 the banner the stop read noted.
    assert_eq!(epoch(&r), e + 2);
}

// ── Grammar (classify-only in B1) ──────────────────────────────────────────

#[test]
fn grammar_normalises_like_grbl() {
    assert_eq!(normalize_grbl_line("  $j=g91 x1 f100 "), "$J=G91X1F100");
    assert_eq!(normalize_grbl_line("(a)$J=G91 X50"), "$J=G91X50");
    assert_eq!(normalize_grbl_line("G1 X1 ; X50"), "G1X1");
    assert_eq!(normalize_grbl_line("G1 (unclosed X5"), "G1");
    assert_eq!(normalize_grbl_line("/G1 X1"), "G1X1");
}

#[test]
fn grammar_classifies_jog_home_settings_reset() {
    let c = |s: &str| classify_outbound(s).unwrap();
    for s in [
        "$J=G91 X1",
        "  $j=g91 x1 f100 ",
        "$ J=G91 X1",
        "$J =G91X1",
        "(a)$J=G91 X50",
    ] {
        assert_eq!(c(s), Outbound::Jog, "{s:?}");
    }
    assert_eq!(c("$H"), Outbound::Home);
    assert_eq!(c("$h"), Outbound::Home);
    assert_eq!(c("$HX"), Outbound::HomeAxis);
    assert_eq!(c("$$"), Outbound::SettingsRead);
    assert_eq!(c("$RST=$"), Outbound::Reset);
    assert_eq!(c("$RST=*"), Outbound::Reset);
    assert_eq!(
        c("$13=1"),
        Outbound::SettingsWrite {
            key: 13,
            startup: false
        }
    );
    assert_eq!(
        c("$100 = 80"),
        Outbound::SettingsWrite {
            key: 100,
            startup: false
        }
    );
    assert_eq!(
        c("$N0=G21"),
        Outbound::SettingsWrite {
            key: 0,
            startup: true
        }
    );
    for s in ["$X", "$G", "$#", "$I", "$C", "$N", "$SLP", "$32"] {
        assert_eq!(c(s), Outbound::Other, "{s:?}");
    }
}

#[test]
fn grammar_motion_rule_matches_s3c_sets() {
    let c = |s: &str| classify_outbound(s).unwrap();
    for s in [
        "G0 X10",
        "g1y5 f100",
        "X5",
        "x-.5",
        "G28",
        "G30",
        "G38.2 Z-5",
        "G1 X1 (c)",
        "G0028",
        "Y+1",
    ] {
        assert_eq!(c(s), Outbound::Motion, "{s:?} is motion");
    }
    for s in [
        "M3 S0", "M5", "G4 P0.5", "G21", "G90", "G92.1", "G1 F100", "; X10", "(X10) M5", "G280", "",
    ] {
        assert_eq!(c(s), Outbound::Other, "{s:?} is not motion");
    }
}

#[test]
fn grammar_flags_malformed_payloads() {
    for s in [
        "$J=G91 X1\n$J=G91 X50",
        "$J=G91 X1\r",
        "G0 X1\u{18}",
        "$J=G91 X1?",
        "G0 X1!",
        "G0 X1~",
        "G0 X1\t",
        "G0 X1 \u{e9}",
        "G0 X1\u{7f}",
    ] {
        let e = classify_outbound(s).unwrap_err();
        assert!(e.starts_with("refused: malformed:"), "{s:?}: {e}");
    }
}

#[test]
fn n9_a_malformed_payload_is_refused_with_nothing_written_or_counted() {
    let r = homed_rig(vec![sep(1), data(b"ok\r\n")]);
    let before = writer_bytes(&r.base.trace()).len();
    let v0 = tv(&r);
    let e = send(&r, "G0 X1?").unwrap_err();
    assert!(e.starts_with("refused: malformed:"), "{e}");
    assert_eq!(writer_bytes(&r.base.trace()).len(), before, "zero bytes");
    assert_eq!(tv(&r), v0, "trust untouched: nothing was written");
    assert_eq!(r.inner.session.trust().motion_pending, 0);
}

// ── N12: source scan ───────────────────────────────────────────────────────

/// Every controller read site under `src/commands` (production code only):
/// `read_until(` and `pending.drain(`. The list is exact; a new read site
/// turns this red until it is added here WITH its `on_line` hook.
#[test]
fn n12_every_read_site_is_pinned_and_hooked() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let needles = [concat!("read_", "until("), concat!("pending.", "drain(")];
    let mut found: Vec<(String, String)> = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".rs") || name.contains("_tests") {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        // Production code only: cut at the first test module.
        let prod = src.split("#[cfg(test)]\nmod ").next().unwrap();
        // Comments do not count as a hook (or as a site).
        let prod: String = prod
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        // Split into functions; a site belongs to the function it sits in,
        // and that WHOLE function must hand its lines to the hook.
        let mut chunks: Vec<(String, String)> = vec![("<none>".to_string(), String::new())];
        for line in prod.lines() {
            let t = line.trim_start();
            if let Some(rest) = t
                .strip_prefix("pub fn ")
                .or_else(|| t.strip_prefix("pub(crate) fn "))
                .or_else(|| t.strip_prefix("fn "))
            {
                let f = rest.split(['(', '<']).next().unwrap().to_string();
                chunks.push((f, String::new()));
            }
            let last = chunks.last_mut().unwrap();
            last.1.push_str(line);
            last.1.push('\n');
        }
        for (f, text) in chunks {
            let sites = text
                .lines()
                .filter(|l| needles.iter().any(|n| l.contains(n)))
                .count();
            if sites == 0 {
                continue;
            }
            assert!(
                text.contains("on_line(") || text.contains("trust_note_line("),
                "{name}::{f} reads controller lines without the on_line hook"
            );
            for _ in 0..sites {
                found.push((name.clone(), f.clone()));
            }
        }
    }
    found.sort();
    let mut want: Vec<(String, String)> = [
        ("serial.rs", "drain_startup_banner_noted"),
        ("serial.rs", "serial_stop_inner"),
        ("serial_pump.rs", "complete_partial_line_noted"),
        ("serial_pump.rs", "drain_classified_noted"),
        ("serial_pump.rs", "read_status_bounded_noted"),
        ("serial_pump.rs", "run_buffered_pump_noted"),
        ("serial_pump.rs", "run_pump_noted"),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    want.sort();
    assert_eq!(found, want, "the pinned read-site list");
}

// ── N13: lock order ────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "lock-order inversion")]
fn n13_tracker_panics_on_an_inversion() {
    let _t = lock_rank::hold(lock_rank::TRUST, "trust");
    let _s = lock_rank::hold(lock_rank::SUBMIT, "submit");
}

#[test]
fn n13_tracker_accepts_the_documented_order() {
    let _c = lock_rank::hold(lock_rank::COMMAND, "command");
    let _s = lock_rank::hold(lock_rank::SUBMIT, "submit");
    let _t = lock_rank::hold(lock_rank::TRUST, "trust");
    let _a = lock_rank::hold(lock_rank::ADMITTED_JOB, "admitted_job");
    let _n = lock_rank::hold(lock_rank::SNAPSHOT, "snapshot");
    drop((_n, _a, _t, _s, _c));
    let _r = lock_rank::hold(lock_rank::REALTIME, "realtime");
    let _t = lock_rank::hold(lock_rank::TRUST, "trust");
}

#[test]
fn n13_tracked_paths_hold_nothing_afterwards() {
    // Every tracked path releases its ranks: after a full homed cycle, a
    // stop, a job and a reconnect, this thread holds no rank.
    let r = homed_rig(vec![sep(1), data(b"ok\r\n"), data(BANNER)]);
    let job = serial_job_begin_inner(&r.inner).unwrap();
    serial_send_inner(&r.inner, "M5", Some(job), cur(&r.inner), None).unwrap();
    serial_job_end_inner(&r.inner, job).unwrap();
    serial_stop_inner(&r.inner, &nap);
    send_byte_inner(&r.inner, cur(&r.inner), 0x18).unwrap();
    disconnect_inner(&r.inner).unwrap();
    assert!(lock_rank::held().is_empty(), "{:?}", lock_rank::held());
}

// ── Fix pass (Razor W1 + NOTEs) ────────────────────────────────────────────

/// A STOP lands while the observation barrier holds `command` (quiescing
/// after a jog). The stop's own read cannot run, so the barrier must flag
/// the confirming banner it consumes at `script`'s window.
fn stop_during_barrier(script: Vec<ScriptStep>) {
    let r = rig(script);
    send(&r, MOVE).unwrap();
    let poller = {
        let inner = r.inner.clone();
        thread::spawn(move || serial_get_status_inner(&inner, cur(&inner)))
    };
    wait_for("barrier holds command", || {
        r.inner.command.try_lock().is_err()
    });
    let res = serial_stop_inner(&r.inner, &nap);
    poller.join().unwrap().unwrap();
    assert!(
        matches!(res, StopResult::Confirmed { .. }),
        "the barrier consumed the banner; the stop must still confirm: {res:?}"
    );
}

#[test]
fn w1_stop_confirms_when_the_barrier_drain_takes_the_banner() {
    stop_during_barrier(vec![
        sep(0),
        data(b"ok\r\n"),
        data(BANNER),
        sep(1),
        data(IDLE0),
    ]);
}

#[test]
fn w1_stop_confirms_when_the_barrier_partial_completion_takes_the_banner() {
    stop_during_barrier(vec![
        sep(0),
        data(b"ok\r\n"),
        data(b"Grbl 1.1h ['$' fo"),
        sep(1),
        data(b"r help]\r\n"),
        sep(2),
        data(IDLE0),
    ]);
}

#[test]
fn w1_stop_confirms_when_the_barrier_probe_takes_the_banner() {
    stop_during_barrier(vec![
        sep(0),
        data(b"ok\r\n"),
        sep(1),
        data(BANNER),
        data(IDLE0),
    ]);
}

#[test]
fn fix_n2_send_byte_bumps_before_the_reset_is_written() {
    let r = homed_rig(vec![]);
    let e = epoch(&r);
    let rt = r.inner.realtime.lock().unwrap(); // the write cannot happen yet
    let h = {
        let inner = r.inner.clone();
        thread::spawn(move || send_byte_inner(&inner, cur(&inner), 0x18))
    };
    wait_for("epoch bumped while the write is blocked", || {
        r.inner.session.trust().trust_epoch == e + 1
    });
    drop(rt);
    h.join().unwrap().unwrap();
}

#[test]
fn fix_n3_job_begin_takes_submit() {
    let r = homed_rig(vec![]);
    let submit = r.inner.session.submit.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let inner = r.inner.clone();
    thread::spawn(move || {
        let _ = tx.send(serial_job_begin_inner(&inner));
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "job admission must wait on submit"
    );
    drop(submit);
    rx.recv_timeout(Duration::from_millis(500))
        .unwrap()
        .unwrap();
}

#[test]
fn fix_partial_invalidating_line_completed_by_the_barrier_is_noted() {
    let r = homed_rig(vec![
        sep(1),
        data(b"ok\r\nALAR"),
        sep(2),
        data(b"M:1\r\n"),
        sep(3),
        data(IDLE0),
    ]);
    send(&r, MOVE).unwrap();
    assert!(tv(&r).homed, "a jog alone keeps the home");
    poll(&r);
    assert!(!tv(&r).homed, "the completed ALARM:1 was noted");
}

// ═══════════════════════════════════════════════════════════════════════════
// B2+B3 suite: connection identity and jog admission
// ═══════════════════════════════════════════════════════════════════════════

use super::serial_session::{TestHook, PHASE_STOPPING};

const JOG: &str = "$J=G21 G91 X1.000 F100";

/// The current observation's seq (the basis TS would send).
fn basis(r: &Rig) -> Option<u64> {
    tv(r).observed_seq
}

fn jog(r: &Rig, basis: Option<u64>) -> Result<SendOutcome, String> {
    serial_send_inner(&r.inner, JOG, None, cur(&r.inner), basis)
}

fn jog_bytes_written(r: &Rig) -> usize {
    let w = writer_bytes(&r.base.trace());
    w.windows(3).filter(|x| x == b"$J=").count()
}

fn refused_with(res: &Result<SendOutcome, String>, code: &str) -> bool {
    res.as_ref()
        .is_err_and(|e| e.starts_with(&format!("refused: {code}:")))
}

fn set_hook(r: &Rig, h: impl Fn(&str) + Send + Sync + 'static) {
    let h: TestHook = Arc::new(h);
    *r.inner.session.test_hook.lock().unwrap() = Some(h);
}

/// mm_rig (homed, observed, `$13=0`, conn 1) plus the jog's `ok`.
fn ready(rest: Vec<ScriptStep>) -> Rig {
    let mut s = vec![sep(1), data(b"ok\r\n")];
    s.extend(rest);
    let r = mm_rig(s);
    assert!(basis(&r).is_some(), "precondition: observed");
    r
}

// ── Admission: the control and every condition ─────────────────────────────

#[test]
fn b23_ready_jog_is_admitted_written_and_counted() {
    let r = ready(vec![]);
    let w0 = r.inner.session.trust().motion_writes;
    jog(&r, basis(&r)).expect("admitted");
    assert_eq!(jog_bytes_written(&r), 1);
    assert!(writer_bytes(&r.base.trace()).ends_with(b"$J=G21 G91 X1.000 F100\n"));
    assert_eq!(r.inner.session.trust().motion_writes, w0 + 1);
    assert!(basis(&r).is_none(), "a jog write clears the observation");
    assert!(tv(&r).homed, "a jog keeps the home");
}

#[test]
fn b23_not_homed_is_refused_with_nothing_written() {
    let r = ready(vec![]);
    r.inner.session.trust_bump();
    // Re-observe so only the home is missing.
    r.base.push_script(vec![sep(2), data(IDLE0)]);
    release_seps(&r.base);
    poll(&r);
    assert!(basis(&r).is_some());
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "not-homed"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 0);
}

#[test]
fn b23_units_not_mm_is_refused() {
    let r = ready(vec![]);
    r.inner.session.trust().units_mm = None;
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "units"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 0);
}

#[test]
fn b23_units_from_an_earlier_connection_are_refused() {
    let r = ready(vec![]);
    r.inner.session.trust().units_mm = Some(99);
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "units"), "{res:?}");
}

#[test]
fn b23_another_counted_motion_send_refuses_motion_pending() {
    let r = ready(vec![]);
    // A second motion send, counted before its `command` wait (as a queued
    // send is), is in flight.
    let queued = r.inner.session.motion_enter();
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "motion-pending"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 0);
    drop(queued);
    jog(&r, basis(&r)).expect("admitted once the other send returned");
}

#[test]
fn b23_after_motion_before_the_barrier_refuses_not_observed_then_admits() {
    let r = ready(vec![sep(2), data(IDLE0), sep(3), data(b"ok\r\n")]);
    let b = basis(&r);
    jog(&r, b).expect("first jog");
    let res = jog(&r, b);
    assert!(refused_with(&res, "not-observed"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 1);
    poll(&r); // the barrier observes
    assert!(basis(&r).is_some());
    let res = jog(&r, b);
    assert!(
        refused_with(&res, "stale-basis"),
        "the old basis is refused: {res:?}"
    );
    jog(&r, basis(&r)).expect("the barrier's basis is admitted");
    assert_eq!(jog_bytes_written(&r), 2);
}

#[test]
fn b23_non_idle_observation_is_not_observed() {
    let r = ready(vec![]);
    r.inner.session.trust().observed.as_mut().unwrap().idle_mpos = false;
    let res = jog(&r, basis(&r).or(Some(1)));
    assert!(refused_with(&res, "not-observed"), "{res:?}");
}

#[test]
fn b23_missing_or_wrong_basis_is_refused_stale_basis() {
    let r = ready(vec![]);
    let b = basis(&r).unwrap();
    for bad in [None, Some(b + 1), Some(b.wrapping_sub(1))] {
        let res = jog(&r, bad);
        assert!(refused_with(&res, "stale-basis"), "{bad:?}: {res:?}");
    }
    assert_eq!(jog_bytes_written(&r), 0);
}

#[test]
fn b23_admitted_job_refuses_job_active() {
    let r = ready(vec![sep(2), data(IDLE0)]);
    let _job = serial_job_begin_inner(&r.inner).unwrap();
    poll(&r); // re-observe, so only the job stands in the way
    assert!(basis(&r).is_some());
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "job-active"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 0);
}

#[test]
fn b23_stopping_phase_refuses_stopping() {
    let r = ready(vec![]);
    r.inner
        .session
        .phase
        .store(PHASE_STOPPING, Ordering::SeqCst);
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "stopping"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 0);
}

#[test]
fn b23_a_refused_jog_leaves_the_ledger_balanced() {
    let r = ready(vec![]);
    let _ = jog(&r, None);
    let t = r.inner.session.trust();
    assert_eq!(t.motion_pending, 0);
}

// ── N1 (Razor B1): a job admission during the barrier ──────────────────────

/// Job begin runs between the barrier's basis capture and its record (the
/// barrier holds `command`; job begin does not take it). The observation
/// must stay cleared.
#[test]
fn b23_n1_job_admitted_during_the_barrier_is_not_overwritten() {
    let r = ready(vec![sep(2), data(IDLE0)]);
    // Make the observation stale without an epoch or write change.
    r.inner.session.trust().observed = None;
    let fired = Arc::new(AtomicBool::new(false));
    {
        let inner = r.inner.clone();
        let fired = fired.clone();
        set_hook(&r, move |p| {
            if p == "barrier_after_basis" && !fired.swap(true, Ordering::SeqCst) {
                serial_job_begin_inner(&inner).expect("job begin");
            }
        });
    }
    poll(&r);
    assert!(fired.load(Ordering::SeqCst), "the interleaving ran");
    assert!(
        r.inner.session.trust().observed.is_none(),
        "a barrier that straddled a job admission recorded an observation"
    );
    assert!(basis(&r).is_none());
    // Control: the next barrier (after the admission) does observe.
    r.base.push_script(vec![sep(3), data(IDLE0)]);
    release_seps(&r.base);
    poll(&r);
    assert!(basis(&r).is_some(), "control: a later barrier observes");
}

// ── N4: STOP / raw reset / job begin against a jog inside `submit` ─────────

/// Runs a ready jog whose `jog_before_write` point starts `other` on a
/// second thread, waits (bounded) until `entered()` says it reached its
/// `submit` wait, checks it is parked (`parked()`), then lets the write go.
fn jog_against(
    r: &Rig,
    other: impl Fn(Arc<SerialInner>) + Send + Sync + 'static,
    entered_point: &'static str,
    parked: impl Fn(&SerialInner, &ScriptedPort) -> Result<(), String> + Send + Sync + 'static,
) -> thread::JoinHandle<()> {
    let fired = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let handle: Arc<Mutex<Option<thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let other = Arc::new(other);
    {
        let inner = r.inner.clone();
        let base = r.base.clone_with_role(HandleRole::Reader);
        let fired = fired.clone();
        let entered = entered.clone();
        let handle = handle.clone();
        set_hook(r, move |p| {
            if p == entered_point {
                entered.store(true, Ordering::SeqCst);
            }
            if p == "jog_before_write" && !fired.swap(true, Ordering::SeqCst) {
                let i2 = inner.clone();
                let o = other.clone();
                *handle.lock().unwrap() = Some(thread::spawn(move || o(i2)));
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while !entered.load(Ordering::SeqCst) {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the other side never reached its submit wait"
                    );
                    thread::sleep(Duration::from_millis(1));
                }
                // It must be parked on `submit`, not past it.
                thread::sleep(Duration::from_millis(50));
                if let Err(e) = parked(&inner, &base) {
                    panic!("{e}");
                }
            }
        });
    }
    jog(r, basis(r)).expect("the jog was admitted before the other side");
    let h = handle.lock().unwrap().take().expect("the other side ran");
    h
}

fn realtime_resets(base: &ScriptedPort) -> usize {
    base.trace()
        .iter()
        .filter(|e| matches!(e, TraceEvent::Write { role: HandleRole::Realtime, data } if data == &[0x18]))
        .count()
}

fn jog_then_reset_order(base: &ScriptedPort) {
    let t = base.trace();
    let j = t
        .iter()
        .position(|e| matches!(e, TraceEvent::Write { role: HandleRole::Writer, data } if data.starts_with(b"$J=")))
        .expect("jog written");
    let x = t
        .iter()
        .position(|e| matches!(e, TraceEvent::Write { role: HandleRole::Realtime, data } if data == &[0x18]))
        .expect("0x18 written");
    assert!(j < x, "the jog's bytes must precede the 0x18: {t:?}");
}

#[test]
fn b23_n4_stop_waits_for_the_admitted_jog_write_then_resets() {
    let r = ready(vec![data(BANNER)]);
    let h = jog_against(
        &r,
        |i| {
            serial_stop_inner(&i, &nap);
        },
        "stop_entered",
        |inner, base| {
            if realtime_resets(base) != 0 {
                return Err("STOP's 0x18 was written while the jog held submit".into());
            }
            if inner.session.phase.load(Ordering::SeqCst) == PHASE_STOPPING {
                return Err("STOP closed admission while the jog held submit".into());
            }
            Ok(())
        },
    );
    h.join().unwrap();
    jog_then_reset_order(&r.base);
    assert_eq!(realtime_resets(&r.base), 1, "one stop, one reset");
    let res = jog(&r, basis(&r));
    assert!(
        refused_with(&res, "stopping") || refused_with(&res, "not-homed"),
        "{res:?}"
    );
    assert_eq!(jog_bytes_written(&r), 1);
}

#[test]
fn b23_n4_raw_reset_waits_for_the_admitted_jog_write() {
    let r = ready(vec![]);
    let e0 = Arc::new(std::sync::atomic::AtomicU64::new(0));
    e0.store(epoch(&r), Ordering::SeqCst);
    let e0c = e0.clone();
    let h = jog_against(
        &r,
        |i| {
            let c = cur(&i);
            send_byte_inner(&i, c, 0x18).unwrap();
        },
        "send_byte_before_submit",
        move |inner, base| {
            if realtime_resets(base) != 0 {
                return Err("the raw 0x18 was written while the jog held submit".into());
            }
            if inner.session.trust().trust_epoch != e0c.load(Ordering::SeqCst) {
                return Err("the raw reset bumped trust while the jog held submit".into());
            }
            Ok(())
        },
    );
    h.join().unwrap();
    jog_then_reset_order(&r.base);
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "not-homed"), "{res:?}");
}

#[test]
fn b23_n4_job_begin_waits_for_the_admitted_jog_write() {
    let r = ready(vec![]);
    let h = jog_against(
        &r,
        |i| {
            serial_job_begin_inner(&i).unwrap();
        },
        "job_begin_before_submit",
        |inner, _| {
            if inner.session.phase.load(Ordering::SeqCst) != PHASE_IDLE {
                return Err("job admitted while the jog held submit".into());
            }
            Ok(())
        },
    );
    h.join().unwrap();
    assert_eq!(r.inner.session.phase.load(Ordering::SeqCst), PHASE_ACTIVE);
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "job-active"), "{res:?}");
    assert_eq!(jog_bytes_written(&r), 1);
}

// ── N8: stale connection ───────────────────────────────────────────────────

struct Two {
    inner: Arc<SerialInner>,
    old_conn: u64,
    new: ScriptedPort,
}

fn connect_to(inner: &SerialInner, port: &ScriptedPort, name: &str) -> u64 {
    let p = port.clone_with_role(HandleRole::Writer);
    serial_connect_inner(inner, name, 115200, &|_| {}, &move |_, _| p.try_clone())
        .unwrap()
        .conn_id
}

/// Connected to "old"; `new` is the port a reconnect will open.
fn two() -> Two {
    let old = ScriptedPort::new(vec![data(BANNER)]);
    let new = ScriptedPort::new(vec![data(BANNER), data(b"ok\r\n"), data(IDLE0)]);
    let inner = Arc::new(SerialInner::default());
    let old_conn = connect_to(&inner, &old, "old");
    Two {
        inner,
        old_conn,
        new,
    }
}

fn reconnect(t: &Two) {
    disconnect_inner(&t.inner).unwrap();
    let c = connect_to(&t.inner, &t.new, "new");
    assert_ne!(c, t.old_conn);
}

/// Every write on `p` (the connect path clones all three handles from one
/// port, so roles do not separate them here).
fn port_writes(p: &ScriptedPort) -> Vec<Vec<u8>> {
    p.trace()
        .iter()
        .filter_map(|e| match e {
            TraceEvent::Write { data, .. } => Some(data.clone()),
            _ => None,
        })
        .collect()
}

/// The new port saw only its own connect's soft reset.
fn only_connect_writes(p: &ScriptedPort) -> bool {
    port_writes(p) == vec![vec![0x18u8]]
}

fn in_flight_reconnect(t: &Two, point: &'static str) {
    let inner = t.inner.clone();
    let new = t.new.clone_with_role(HandleRole::Writer);
    let old_conn = t.old_conn;
    let fired = Arc::new(AtomicBool::new(false));
    let h: TestHook = Arc::new(move |p: &str| {
        if p == point && !fired.swap(true, Ordering::SeqCst) {
            disconnect_inner(&inner).unwrap();
            let n = new.clone_with_role(HandleRole::Writer);
            let c =
                serial_connect_inner(&inner, "new", 115200, &|_| {}, &move |_, _| n.try_clone())
                    .unwrap()
                    .conn_id;
            assert_ne!(c, old_conn);
        }
    });
    *t.inner.session.test_hook.lock().unwrap() = Some(h);
}

#[test]
fn b23_n8_uncontended_stale_send_byte_and_status() {
    let t = two();
    reconnect(&t);
    assert!(only_connect_writes(&t.new), "{:?}", port_writes(&t.new));
    let e = send_byte_inner(&t.inner, t.old_conn, b'!').unwrap_err();
    assert!(e.starts_with("refused: stale-connection:"), "{e}");
    let e = serial_get_status_inner(&t.inner, t.old_conn).unwrap_err();
    assert!(e.starts_with("refused: stale-connection:"), "{e}");
    assert!(
        only_connect_writes(&t.new),
        "a stale feed hold or status probe reached the new port: {:?}",
        port_writes(&t.new)
    );
    // The exception: a reset is never refused.
    send_byte_inner(&t.inner, t.old_conn, 0x18).unwrap();
    assert_eq!(port_writes(&t.new), vec![vec![0x18u8], vec![0x18u8]]);
    // Control: the current connection is accepted.
    let c = cur(&t.inner);
    send_byte_inner(&t.inner, c, b'!').unwrap();
}

#[test]
fn b23_n8_in_flight_send_parked_before_command_is_refused_after_reconnect() {
    let t = two();
    in_flight_reconnect(&t, "send_before_command");
    let res = serial_send_inner(&t.inner, "G91 G0 X50", None, t.old_conn, None);
    assert!(
        res.as_ref()
            .is_err_and(|e| e.starts_with("refused: stale-connection:")),
        "{res:?}"
    );
    assert!(
        only_connect_writes(&t.new),
        "the new port got some of its bytes: {:?}",
        port_writes(&t.new)
    );
    assert_eq!(
        t.inner.session.trust().motion_pending,
        0,
        "the RAII guard decremented"
    );
}

#[test]
fn b23_n8_in_flight_send_byte_parked_before_realtime_is_refused_after_reconnect() {
    let t = two();
    in_flight_reconnect(&t, "send_byte_before_realtime");
    let e = send_byte_inner(&t.inner, t.old_conn, 0x21).unwrap_err();
    assert!(e.starts_with("refused: stale-connection:"), "{e}");
    assert!(
        only_connect_writes(&t.new),
        "the new port got the feed hold: {:?}",
        port_writes(&t.new)
    );
    // 0x18 under the same schedule is written.
    let t = two();
    in_flight_reconnect(&t, "send_byte_before_realtime");
    send_byte_inner(&t.inner, t.old_conn, 0x18).unwrap();
    assert_eq!(port_writes(&t.new), vec![vec![0x18u8], vec![0x18u8]]);
}

#[test]
fn b23_n8_in_flight_status_poll_is_refused_after_reconnect() {
    let t = two();
    in_flight_reconnect(&t, "status_before_command");
    let e = serial_get_status_inner(&t.inner, t.old_conn).unwrap_err();
    assert!(e.starts_with("refused: stale-connection:"), "{e}");
    assert!(only_connect_writes(&t.new), "{:?}", port_writes(&t.new));
}

#[test]
fn b23_n8_outcomes_carry_the_connection() {
    let r = rig(vec![
        sep(0),
        data(b"ok\r\n"),
        sep(1),
        data(IDLE0),
        sep(2),
        data(IDLE0),
    ]);
    r.inner.session.trust().conn_id = 7;
    assert_eq!(send(&r, "$G").unwrap().conn_id, 7);
    assert_eq!(poll(&r).conn_id, 7, "barrier poll");
    assert_eq!(poll(&r).conn_id, 7, "ordinary poll");
    let busy = r.inner.command.lock().unwrap();
    let o = serial_get_status_inner(&r.inner, 7).unwrap();
    drop(busy);
    assert_eq!((o.kind, o.conn_id), (StatusKind::Busy, 7));
}

// ── N9: grammar refusals through the send ─────────────────────────────────

#[test]
fn b23_n9_malformed_payloads_are_refused_with_zero_bytes() {
    let r = ready(vec![]);
    let before = writer_bytes(&r.base.trace()).len();
    for bad in [
        "$J=G91 X1\n$J=G91 X50",
        "$J=G91 X1\r",
        "G0 X1\u{18}",
        "$J=G91 X1?",
        "G0 X1 \u{e9}",
        "$J=G91 X1\n",
        "G0\tX1",
    ] {
        let res = serial_send_inner(&r.inner, bad, None, cur(&r.inner), basis(&r));
        assert!(refused_with(&res, "malformed"), "{bad:?}: {res:?}");
    }
    assert_eq!(writer_bytes(&r.base.trace()).len(), before, "zero bytes");
    assert!(tv(&r).homed, "a refusal changes no trust");
    // A newline or CR is named as a line delimiter (two commands to GRBL),
    // not merely a control byte.
    for bad in ["$J=G91 X1\n$J=G91 X50", "$J=G91 X1\r"] {
        let e = classify_outbound(bad).unwrap_err();
        assert!(e.contains("line delimiter"), "{bad:?}: {e}");
    }
}

#[test]
fn b23_n9_normalised_jog_spellings_are_gated_as_jogs() {
    for spelling in [
        "  $j=g91 x1 f100 ",
        "$ J=G91 X1",
        "$J =G91X1",
        "(a)$J=G91 X50",
    ] {
        let r = ready(vec![]);
        let res = serial_send_inner(&r.inner, spelling, None, cur(&r.inner), None);
        assert!(
            refused_with(&res, "stale-basis"),
            "{spelling:?} must be gated as a jog: {res:?}"
        );
    }
}

// ── N10 / N11: units and motion errors refuse the next jog ────────────────

#[test]
fn b23_n10_units_write_then_frame_write_refuse() {
    let r = ready(vec![sep(2), data(b"ok\r\n")]);
    // `$13=1` is a settings write: units cleared (and a frame key, so the
    // home goes too).
    send(&r, "$13=1").unwrap();
    let res = jog(&r, basis(&r));
    assert!(res.is_err(), "{res:?}");
    assert!(!tv(&r).units_mm && !tv(&r).homed);
    let r = ready(vec![sep(2), data(b"ok\r\n")]);
    send(&r, "$10=1").unwrap(); // not a frame key: units only
    assert!(tv(&r).homed);
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "units"), "{res:?}");
}

#[test]
fn b23_n11_motion_error_after_write_refuses_the_next_jog_not_homed() {
    let r = ready(vec![sep(2), ScriptStep::Error("gone".to_string())]);
    // Consume the ready rig's jog `ok` with a console motion first.
    send(&r, MOVE).unwrap();
    assert!(send(&r, MOVE).is_err());
    let res = jog(&r, basis(&r));
    assert!(refused_with(&res, "not-homed"), "{res:?}");
}

// ── N4 (card note): the probe-timeout restore ─────────────────────────────

#[test]
fn b23_barrier_probe_timeout_is_set_then_restored() {
    let r = homed_rig(vec![]);
    let log = r.base.timeout_log();
    let probe = Duration::from_millis(OBSERVE_PROBE_MS);
    assert!(
        log.iter()
            .any(|(role, t)| *role == HandleRole::Reader && *t == probe),
        "the barrier's probe read ran at OBSERVE_PROBE_MS: {log:?}"
    );
    assert_eq!(
        r.base.timeout_of(HandleRole::Reader),
        Duration::from_millis(1000),
        "the reader's timeout is restored after the barrier: {log:?}"
    );
    assert!(
        log.iter().all(|(role, _)| *role == HandleRole::Reader),
        "only the reader handle's timeout is touched: {log:?}"
    );
}

// ── T-C9: every golden G-code line passes the grammar ─────────────────────

#[test]
fn b23_golden_gcode_lines_pass_the_outbound_grammar() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut files = 0;
    let mut lines = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) != Some("gcode") {
            continue;
        }
        files += 1;
        let text = std::fs::read_to_string(&p).unwrap();
        // As both job paths do: split on '\n', trim, skip blanks and
        // ';' comment lines.
        for l in text.split('\n') {
            let l = l.trim();
            if l.is_empty() || l.starts_with(';') {
                continue;
            }
            lines += 1;
            assert!(
                classify_outbound(l).is_ok(),
                "{}: {l:?} is malformed to the grammar",
                p.display()
            );
        }
    }
    assert!(files >= 10 && lines > 100, "files {files}, lines {lines}");
}
