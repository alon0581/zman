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

/**
 * PROJECTS gates the projects layer: the third tab, the board, the projects tools
 * in the model's list, and the prompt guidance. Same contract as above — unset
 * means the app behaves exactly as it did before, and only "1" or "true" turns it
 * on.
 *
 * Note what it does NOT gate: the scheduling engine. `planSchedule` is a pure
 * function, and SCHEDULER_V2 gates the AI *tool surface*, not the engine — so the
 * board's deadline-risk maths works with SCHEDULER_V2 off. Only `plan_project`
 * needs both flags, because it returns a plan_id that only `apply_plan` (a
 * V2-only tool) can commit.
 */
export function projectsEnabled(): boolean {
  const raw = process.env.PROJECTS
  return raw === '1' || raw === 'true'
}

/**
 * PHASES gates the life-phase layer: the phase tools, the phase-aware PERSON
 * PROFILE, and the phase filter on learned priors.
 *
 * Same contract as the two above — unset means the app behaves exactly as it did
 * before, and only "1" or "true" turns it on. The profile rewrite is additionally
 * self-gating: `buildSystemPrompt` takes an optional phase context, and with that
 * argument absent it returns the legacy block byte for byte. So even a half-wired
 * call site degrades to today's behaviour rather than to something new.
 */
export function phasesEnabled(): boolean {
  const raw = process.env.PHASES
  return raw === '1' || raw === 'true'
}

/**
 * PLACES gates the places layer: the place tools (`save_place`, `list_places`,
 * `delete_place`), the `place_id` parameter on `create_event`, and the places
 * guidance block.
 *
 * Same contract as the three above — unset means the app behaves exactly as it
 * did before, and only "1" or "true" turns it on.
 */
export function placesEnabled(): boolean {
  const raw = process.env.PLACES
  return raw === '1' || raw === 'true'
}
