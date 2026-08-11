/**
 * featureFlags.ts — the one place a flag is read.
 *
 * SCHEDULER_V2 gates the whole scheduling-engine path in the AI layer: the tool
 * list the model is shown, and the branches inside the tool dispatcher. With the
 * variable unset, `schedulerV2Enabled()` is false everywhere and every call site
 * takes the pre-existing branch — behaviour is byte-identical to before the
 * engine landed. That is deliberate: this repo auto-deploys, so the new path has
 * to be opt-in rather than opt-out.
 *
 * Read through this function, never `process.env.SCHEDULER_V2` directly — one
 * definition of "on" is what keeps the flag from being half-on somewhere.
 */
export function schedulerV2Enabled(): boolean {
  const raw = process.env.SCHEDULER_V2
  return raw === '1' || raw === 'true'
}
