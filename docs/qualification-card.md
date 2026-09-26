# Qualification card: `scripts/probe-grbl.py`

How to run the GRBL probe for status-only evidence. The probe records what was
sent, what the controller reported, and markers for when the operator should
note whether motion stopped. It never records or implies anything about the
beam. There is no field for beam state on this card, and none may be added.

The script's own `--help` and module docstring carry the same rules. Where this
card and the script disagree, the script's refusal is what happens; report the
difference.

## 1. Prerequisites

- Kerf is closed, so the serial port is free.
- The laser output is isolated by the owner's established procedure for the S0 runs.
- The independent physical stop is within reach for every run.
- `--case settings` has been run, and these are noted from its log: `$21`, `$22`,
  `$30`, `$32`, `$130`, `$131`, the `G54` and `G92` offsets (or "unsupported"),
  and the state the controller reported when the port opened.
- `--case direction --home` has been run, and the observed direction of each of
  its four 1 mm steps is written down. The direction case keeps the beam off by
  sending `M5` first and no `M3`, `M4` or `S` word at all.
- A low-power ceiling for `--smax` has been chosen, at or below `$30`.

## 2. Homing

Every motion case (`direction`, `wedge`, `hold-m4`, `stop-m4`, `completion-m4`)
is run with `--home`; the probe refuses the command line without it, and refuses
`--home` on `settings`. The probe homes at the start of each invocation and at
no other time. It never sends `$X`.

If the controller is in Alarm when the port opens, `--home` is how it leaves it.
If the home step fails (an `error:` or `ALARM` reply to `$H`), the run ends
`RESULT INCOMPLETE`: stop there and keep the log. If the controller is not Idle
after homing, or the reported position lies outside the bed on your
`--x-dir`/`--y-dir`, the run ends `RESULT REFUSED` before any case line.

Because each invocation homes, the position a `hold-m4` or `stop-m4` reset
leaves behind is never trusted by the next run.

## 3. Print and review the dry run

Before every live run, print the exact matrix with the same arguments plus
`--dry-run`. It opens no port and writes no log.

```
python3 scripts/probe-grbl.py --case wedge --dry-run --home \
    --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --box-mm 60 --smax 0
```

Check that every `X` and `Y` in the printed lines lies inside the box: from
`origin` to `origin + box` on each axis, with the sign you gave. Check that no
`S` value exceeds `--smax`. The home step is printed first.

## 4. Cases, in order

Replace `PORT` and `LOG` with the port and a new log path (section 7). Each
positive-power step is an explicit operator choice of `--smax`; the default is 0.

1. `settings`:
   `python3 scripts/probe-grbl.py --case settings --port PORT --log-file LOG`
2. `direction`:
   `python3 scripts/probe-grbl.py --case direction --home --x-dir 1 --y-dir -1 --port PORT --log-file LOG`
3. `wedge` at S0, output isolated:
   `python3 scripts/probe-grbl.py --case wedge --home --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --smax 0 --port PORT --log-file LOG`
4. `stop-m4`:
   `python3 scripts/probe-grbl.py --case stop-m4 --home --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --feed 300 --smax SMAX --port PORT --log-file LOG`
5. `hold-m4`:
   `python3 scripts/probe-grbl.py --case hold-m4 --home --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --feed 300 --smax SMAX --port PORT --log-file LOG`
6. `completion-m4`:
   `python3 scripts/probe-grbl.py --case completion-m4 --home --origin-x 20 --origin-y 20 --x-dir 1 --y-dir -1 --feed 300 --smax SMAX --port PORT --log-file LOG`

The signs above are examples. Use the signs your own `direction` run confirmed.

`stop-m4` and `hold-m4` are one repetition per invocation; the probe refuses
`--reps` above 1 for them. Three repetitions are three invocations, each with a
fresh log and a fresh home. Their lines carry `--feed 300`: the probe refuses any
feed at which the 20 mm segment would end before the hold or stop is sent (above
600 mm/min).

Before a powered case the probe refuses, and moves nothing, unless the
controller reported `$32=1` (laser mode), `$30`, `$130` and `$131`, a zero `G54`
and `G92` offset on X and Y, and a box that fits the bed. `--smax` above `$30`
is refused. `hold-m4` never sends `~` or `0x9E`; it ends with a designed reset.

## 5. What to record per case

For each `## OBSERVE` marker in the log:

- the log's monotonic timestamp at the marker;
- the TX (`->`) and RX (`<-`) lines around it;
- the status state reported next to it. A marker beside an `Idle` report means
  motion had already ended, and the observation proves nothing;
- "motion ceased: y/n", written by hand.

There is no field for beam state.

## 6. The INCOMPLETE rule and the exit codes

Only a log whose last line is `RESULT COMPLETE` counts. A log ending
`RESULT REFUSED` or `RESULT INCOMPLETE`, or with no RESULT line at all, is kept
as evidence of what happened, never as a pass.

| Exit | Meaning |
|---|---|
| 0 | `RESULT COMPLETE` |
| 1 | `RESULT INCOMPLETE` (a fault, Ctrl-C, or the controller was not Idle before a repetition) |
| 2 | The command line was refused. Nothing was opened and no log was written. |
| 3 | `RESULT REFUSED` by the controller checks. Nothing moved except, at most, the home. |

After a fault or Ctrl-C the probe sends the realtime reset (`0x18`) first, then
only a short capture and one `?`. It sends no `M5`, no `$X`, no `$H`, and no next
variant. Recovery is an operator action: check settings and position again, then
start a new invocation.

## 7. Where logs go

Pass `--log-file` pointing into the private evidence register, whose location is
held outside this repository. The probe refuses an existing file and never
writes a log to a default name. Never commit a probe log to this repository.
