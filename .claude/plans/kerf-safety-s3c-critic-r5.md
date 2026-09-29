## Applicability

Project type: safety-critical laser-controller desktop application (Tauri/Rust serial transport plus React/TypeScript motion admission), including an owner hardware qualification procedure. Reviewed revision 5 of `kerf-safety-s3c.md`; plan line numbers below refer to that file. Supporting code and `.claude/DECISIONS.md` were inspected in the supplied worktree at HEAD `287f5c1`. This is a plan review, not execution of the proposed tests or hardware card.

Core dimensions 1–10 are active [GATING]: Problem-fit; Approach soundness; Completeness; Right-sizing & reuse; Security; Failure modes; Change safety; Data integrity & compatibility; Verifiability; Maintainability.

- X1 Physical & human safety — FIRES [GATING]: changes admission of physical motion and prescribes powered motor tests on a laser machine.
- X2 Privacy & data stewardship — DOES NOT FIRE, N/A: this change handles controller coordinates/settings, not personal, health, child or client records.
- X3 Evidence & source integrity — FIRES [GATING]: the owner card and its pass labels produce factual safety/qualification claims used to authorize later operation.
- X4 Audience, brand & money accuracy — FIRES [ADVISORY]: ships operator-facing recovery messages and release restrictions; no money, legal terms or signature.
- X5 Concurrency & re-entrancy — FIRES [GATING]: asynchronous commands, settings reads and polling share safety state; X1 makes concurrency gating.
- X6 Operability & observability — FIRES [ADVISORY]: changes a released desktop application's recovery and field diagnostics.
- X7 Self-modification safety — DOES NOT FIRE, N/A: changes Kerf's machine controls, not MARVIN's gates, hooks, skills or automation; using a mutation runner is not modifying it.
- X8 Dependencies, performance & cost — FIRES [ADVISORY]: operates on the existing roughly 250 ms polling path and introduces reactive hold diagnostics.

## Dimension verdicts

PASS — 1. Problem-fit [GATING]: the explicit Intent/Summary (L38–50) addresses home-before-jog and unsettled motion, without undoing the standing bed-confirmation decision; the failures below concern whether the promised controls work.
FAIL — 2. Approach soundness [GATING]: “an event with ALARM or a banner” (L128) assumes native delivery that does not exist for idle-time banners; fix the native event contract and test actual transport-to-store revocation (A).
FAIL — 3. Completeness [GATING]: “The settings parser reads `$13`” (L110) omits console `$$`, absent-field clearing, read failures and stale-generation rejection; specify one complete units-readback contract across all callers (B).
CONCERN — 4. Right-sizing & reuse [GATING]: the nine-file waiver is explicit (L19), but the claimed `src/`-only boundary excludes required native fixes and the seven deferrals are only promised for after merge (L17, L341); revise batches/dependencies and put the deferrals in the actual ROADMAP Parking Lot before closure.
PASS — 5. Security [GATING]: the scoped changes introduce no secret handling, authentication bypass, new remote interface or dependency; physical command-boundary defects are assessed under X1/X5 rather than mistaken for an auth control.
FAIL — 6. Failure modes [GATING]: spontaneous reset can remain invisible while trust stays true, and a failed settings read need not clear units under the specified edits (L125–133, L186–187); route reset evidence reliably and revoke units on every failed/invalid read (A, B).
FAIL — 7. Change safety [GATING]: “motion is bounded by ... the hard-limit precondition” (L358) treats an enabled setting as a verified physical stop, and rollback restores open hazards with advice alone (L357); require a safe qualification prerequisite and enforce containment or an explicit release dependency (D).
FAIL — 8. Data integrity & compatibility [GATING]: finite MPos plus a later settings parse does not establish a coherent, current millimetre position; the units grant is not generation-fenced and the report's acquisition time is not proven by poll invocation time (L103–112, L130); bind units and position provenance to validated generations/native freshness (B, C).
FAIL — 9. Verifiability [GATING]: R5/T9 inject banners into `drained`/events (L227, L249) which the native implementation discards; the TS-only battery cannot falsify that missing delivery, so add native transport fixtures and cross-boundary assertions before claiming closure (A, C).
CONCERN — 10. Maintainability [GATING]: the lifecycle table helps, but “one rule” still means two differently parsed position writers and a non-reactive cause getter (L102–107, L212–217); specify shared validation/provenance rules and a subscribed diagnostic state with transition tests.
FAIL — X1. Physical & human safety [GATING]: frame FAILED/INCONCLUSIVE leaves live jog controls enabled under an expressly non-interlocking restriction (L339), while the card assumes switch containment (L308, L325); establish an enforceable qualification/release boundary and physically qualified test bounds (D).
FAIL — X3. Evidence & source integrity [GATING]: “That is the bound that makes the direction test safe” (L308) is not established by a `$21=1` capture, and `Frame PASSED` is overgeneralized from an incomplete card (L336); cite actual switch/clearance evidence and narrow qualification to what was measured (D).
CONCERN — X4. Audience, brand & money accuracy [ADVISORY]: “Kerf only knows where the bed edge is after homing” (L156) hides the admitted frame mismatch, and “Reconnect, or send $$” (L162) conflicts with the claimed quit-only recovery (L366); use precise trust language and advice supported by implemented recovery paths (B, E).
FAIL — X5. Concurrency & re-entrancy [GATING]: lease counters fence overlapping motion but do not fence the proposed `$13` grant or prove queued serial reports postdate motion; fresh-looking state can pass after an interleaving (L110, L130); add generation-fenced readback and native ordering tests (B, C).
CONCERN — X6. Operability & observability [ADVISORY]: `motionHoldCause()` plus an effect “keyed on the reason plus the cause” (L212–217) does not itself subscribe React to cause changes, and console `$$` recovery is unwired; specify observable cause transitions and test recovery through the actual UI/console entry points (B).
PASS — X8. Dependencies, performance & cost [ADVISORY]: no new packages/services are proposed, lease updates are constant-time and the extra wait uses the existing poll cadence; the subscription gap is a correctness issue, not a demonstrated resource regression.

### A. Reset revocation is unreachable on real native paths

The plan says “`surfaceUnsolicited`: revoke on ALARM and on a banner” (L188), and tests a “`drained` line [carrying] `Grbl 1.1f ...`” (L227). In `src-tauri/src/commands/serial_pump.rs:310–328`, `drain_classified` surfaces only Alarm/Msg; Banner goes into `dropped`. `serial.rs:509–511` logs dropped lines, while its actual reply at L554–557 contains `drained: drain.surfaced`. The TypeScript callback cannot revoke on a banner it never receives.

Polling has the same defect: `read_status_bounded` (`serial_pump.rs:379–385`) puts banners into `dropped`; `serial_get_status_inner` (`serial.rs:660–688`) logs them and returns only `events: read.surfaced`. Its stop-in-flight banner handling is not a general frontend trust revocation. A homed machine can reset independently, have its banner discarded, then deliver Idle/MPos while the TS homed flag remains true. This violates the plan's within-one-connection claim; S3d does not excuse it.

Also audit the direct `readbackGrblSettings` invoke (`connection.ts:958–973`): it forwards drained lines but does not route all response lines through `send()`'s proposed revocation logic. A banner terminating that read is another bypass. Fix delivery and consumption on every path, including errors after already observing a revocation event. Add native tests with real banner bytes in the pre-drain and poll streams, then prove zero jog sends after a later Idle until a new clean home. The batch must expand or gain an explicit native prerequisite.

### B. The proposed units flag is neither complete nor race-safe

“`store.setGrblReportMm(value === 0)`” in the settings parser (L110) sets true without the parser's `gen` being checked. The existing parser checks generation for laser mode through `applyLaserModeReadback`, not for every setting. A full read begun before `$13=1` can resolve late and restore true after the write's invalidations. The all-finite MPos check then happily accepts inch coordinates as millimetres. Submission/settlement invalidation alone cannot defeat a late grant.

The plan also says “Reconnect, or send $$” (L162) and T14 expects console readback recovery (L254). Actual console `send("$$")` calls only `applyLaserModeReadback` (`connection.ts:656–658`), not the full settings parser. L186–187 leaves that route unchanged. A parser branch for key 13 also does not clear a previously true flag when the next response omits 13; the existing readback catch clears only laser mode. Starting T14 from a false flag would miss this failure.

Specify a single units grant function: absent, malformed, contradictory, failed or stale-generation readback yields false; valid current `$13=0` alone yields true. Wire full readback and console `$$` deliberately, including their failure paths. Test true→missing, true→throw, a stale `$13=0` completion after `$13=1` has settled, and actual console recovery. Establish which report is allowed to become authoritative when the units generation changes; do not relabel coordinates acquired under an older units state.

### C. A later poll invocation does not prove a later machine sample

L144 claims a valid MPos report “taken after the last settle”; L130 enforces `tickAtInvoke === motionTick`. That proves something about host task ordering, not the age of bytes consumed from the serial reader. `read_status_bounded` writes `?` and returns the first status frame it reads, including a frame already buffered before that probe (`serial_pump.rs:356–382`). Busy polls themselves send probes (`serial.rs:631–636`). A buffered old Idle can therefore receive a new publication sequence and be accepted as the post-settle report. The TS consumer stamps acceptance with `Date.now()`, so neither that age nor the new sequence proves sample freshness.

The command path separately admits an in-pump MPos without participating in the poll watermark/age contract (L106, T13 at L253). Removing WPos confusion is necessary but does not establish the promised single authoritative fresh coordinate. Define a native acquisition/order contract that distinguishes queued pre-motion reports from qualified post-motion state, and a rule preventing unqualified command samples from replacing the clipping coordinate. Demonstrate the failure using buffered byte fixtures across acknowledgement/probe boundaries, not just mocked promises carrying newly invented snapshots. If the protocol cannot prove the proposed freshness claim, narrow the claim and supply conservative admission behavior instead of asserting the guarantee.

### D. The hardware card still substitutes settings and instructions for containment

L308 says a move toward home “ends on a limit switch with an ALARM, not on the frame.” A historical `$21=1` read proves configuration, not switch wiring, switch location, stopping clearance, or present function. Homing moving both axes does not by itself establish safe hard-limit behavior at the card's jog speed. The card has no demonstrated safe qualification of that bound before relying on it. Laser power isolation removes emission from this card but does not prevent a carriage crash or material damage.

The 20 mm reserve (L327) also assumes commanded millimetres correspond to physical travel; step 3 asks for a 1 mm observation, but the `Frame PASSED` predicate (L336) explicitly requires directions and margins without an explicit scale-accuracy acceptance criterion. The subsequent console steps say only “a value 20 mm back toward home” and “30 mm toward home” (L331–332), without requiring that much verified available travel from the actual starting point on each axis. `G92.1` alone is not a demonstration that every work-coordinate offset is absent; the card must verify its actual coordinate interpretation before absolute moves.

Fix the card with independently established stop/clearance prerequisites, explicit measured scale tolerance and available-travel checks, and stop immediately on any failed prerequisite. Define a safe qualification route that does not depend on the very unqualified jog envelope being tested. L339 correctly admits its restriction is not an interlock, but admission still permits a failed frame. Keep S3e separate if useful, while making activation/release of the physical safety claim depend on its enforced qualification, or obtain an explicit owner decision on that residual exposure. A plan revision cap is not that decision. Do not silently reverse the standing full-feature release ruling; escalate the actual conflict.

### E. The S3d split does not support a blanket independence claim

“S3c's recovery advice does not depend on S3d” (L26) and “Recovery advice routes through quitting Kerf, not reconnecting” (L366) conflict with the new units message's explicit reconnect instruction (L162). Quitting ends host work only once the process has exited; it does not retroactively cancel a command that reached the controller before exit. The acknowledged unfenced native send remains available during normal reconnects, regardless of which note is shown. Distinguish a bounded within-connection improvement from a safe general recovery procedure, remove contradictory advice, and state the S3d prerequisite/residual exposure consistently. Do not claim TS generation fencing cancels native writes.

## Stress test 1 — Pre-mortem

Three months later, the type-specific worst case is unintended laser-machine motion that crashes the head into the frame, damages the work or injures someone clearing the machine. Laser isolation bounds emission during the card only.

1. An idle controller resets after successful homing. Rust drops the banner during a status read, later Idle/MPos is accepted, and jogging remains enabled without re-homing. The warning was tests that injected an event the transport never delivered.
2. A delayed `$13=0` settings read overwrites a newer units invalidation. Inch MPos is clipped against a millimetre bed, allowing excess travel. The warning was a units grant specified as a parser assignment instead of a generation-checked readback transaction.
3. The owner trusts the direction card's `$21=1` promise, but the physical limit does not arrest travel as assumed, or a failed frame is used later through still-enabled controls. The warning was the explicit “operating restriction, not an interlock,” combined with a qualification label stronger than the actual evidence.

## Stress test 2 — Load-bearing assumptions

- **Every reset observation reaches the trust owner — confidence: contradicted by inspected code.** Native drains and polls discard banners. Consequence: reset leaves stale homing trust. Resolve before implementation by changing and testing the delivery contract.
- **A poll begun after settle returns a sample taken after settle — confidence: low/unverified.** The native reader accepts the first buffered status frame and issues fresh publication metadata. Consequence: a stale Idle/position can release the lease. Resolve before implementation using actual native stream ordering fixtures and a defensible freshness contract.
- **The units flag describes the authoritative coordinate under concurrent settings activity — confidence: low.** The proposed grant lacks generation validation, complete clearing rules and consistent callers. Consequence: inch/mm confusion and excessive travel. Resolve before implementation with a unified readback/provenance contract.
- **Enabled hard limits safely contain the owner's test moves — confidence: unverified.** The cited setting is not independent physical validation of switch function/clearance or travel scale. Consequence: the qualification procedure itself can damage hardware. Resolve before any hardware execution; an INCONCLUSIVE result must not authorize motion by default.

## Stress test 3 — Inversion

The rejected larger/native prerequisite wins if frontend-only enforcement lacks the evidence needed to decide safely. That condition is already true: native code withholds reset banners and does not prove the sample timing claimed by the lease. The rejected enforced frame restriction wins if the software knowingly enables motion after qualification FAILED/INCONCLUSIVE; L339 expressly describes that state. Conversely, a small independent S3c can still be worthwhile if its claims are narrowed, transport prerequisites are actually supplied, and remaining physical exposure is explicitly resolved under the standing release decisions. Merely relabeling S3d/S3e “independent” or stopping after the fifth review does not establish those conditions.

## Overall verdict

FAIL — gate blocked. Revision 5 contains useful motion accounting but cannot uphold its within-connection reset and freshness guarantees against the real native transport, and its units contract can grant stale trust. Its owner card additionally relies on unverified physical containment while leaving failed qualification unenforced. These are concrete control failures, not requests to absorb every neighboring project. Correct the transport/readback contracts and qualify the physical procedure; if the revision cap prevents another rewrite, send these findings to Lee as unresolved decisions without recording a passing safety gate.

Prioritized must-fix list:

1. **P0 — Reset delivery:** carry banners and alarm evidence across real native drain/poll/direct-readback/error paths; prove revocation through native-to-frontend tests.
2. **P0 — Units and freshness:** unify generation-fenced `$13` readback/clearing and console recovery; establish a native post-motion sample contract and prevent unqualified position overwrites.
3. **P0 — Hardware containment:** independently qualify physical bounds, scale and available travel before the card; resolve enforced frame qualification versus the release ruling explicitly.
4. **P1 — Honest recovery and scope:** reconcile reconnect/quit advice and S3d/S3e dependencies; update the batch waiver/graph and actual ROADMAP deferral index to match required work.
5. **P1 — Verification and diagnostics:** expand beyond TS-only mocks to native byte-order cases, and make hold-cause transitions observable in React with actual recovery-path tests.
