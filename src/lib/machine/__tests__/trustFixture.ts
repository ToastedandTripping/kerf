/**
 * Motion trust (B2+B3) test fixture: the store scalars an accepted native
 * snapshot writes when the machine is homed, in mm, idle and observed. Jog
 * tests that are about something else (the clip, the bed, the offset) start
 * from this so the trust gate is not what they measure.
 */
export function trustedStore(pos: { x: number; y: number; z: number }, basisSeq = 1) {
  return {
    grblHoming: true,
    trustHomed: true,
    machineHomed: true,
    trustUnitsMm: true,
    motionPending: false,
    trustObserved: true,
    basisSeq,
    basisPosition: pos,
  };
}

/** The native snapshot trust fields that produce `trustedStore`. */
export function trustedSnapshotFields(pos: [number, number, number], observedSeq: number) {
  return {
    homed: true,
    unitsMm: true,
    motionPending: false,
    observedSeq,
    observedPos: pos,
  };
}
