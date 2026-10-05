import type { AppState } from "./storeTypes";

/** TB3 publication guard: the exact store fields `generateGcode` reads.
 *  This is the generator's own inventory, not a list of edit sites. A field
 *  read through the `inputs` argument outside this set fails `tsc`; a direct
 *  store read inside gcodeGen.ts fails the source tripwire in
 *  generationGuard.test.tsx. Add a field here (or pass it in) when the
 *  generator starts reading it. */
export const GENERATION_INPUT_KEYS = [
  "objects",
  "layers",
  "workspaceWidth",
  "workspaceHeight",
  "originTop",
  "startCorner",
  "grblSValueMax",
  "grblLaserMode",
  "grblAccelX",
  "grblAccelY",
  "grblMaxFeedRateX",
  "grblMaxFeedRateY",
] as const;

export type GenerationInputKey = (typeof GENERATION_INPUT_KEYS)[number];
export type GenerationInputs = Pick<AppState, GenerationInputKey>;

/** Copies the twelve input references (no cloning). */
export function selectGenerationInputs(state: GenerationInputs): GenerationInputs {
  const out = {} as Record<GenerationInputKey, unknown>;
  for (const k of GENERATION_INPUT_KEYS) out[k] = state[k];
  return out as GenerationInputs;
}

/** True when any input differs under Object.is. Store updates are immutable,
 *  so this is conservative: a re-allocated equal array counts as changed. */
export function inputsChanged(a: GenerationInputs, b: GenerationInputs): boolean {
  for (const k of GENERATION_INPUT_KEYS) {
    if (!Object.is(a[k], b[k])) return true;
  }
  return false;
}

/** Captured by `beginGeneration()` in one synchronous step. */
export interface GenerationTicket {
  seq: number;
  epoch: number;
  inputs: GenerationInputs;
}

export type PublishOutcome =
  | "published"
  | "published-stale"
  | "discarded-project"
  | "discarded-superseded";
