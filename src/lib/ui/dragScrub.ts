// Drag-to-scrub math for the number fields: pointer displacement → new value.
// Pure functions, unit-tested; the component owns pointer capture.
//
// The fields span eccentricity (0–0.99) to positions in meters (~1e11), so no
// fixed step works. Default stepping is proportional — a fixed fraction of the
// current magnitude per pixel — for equal felt sensitivity at every scale. A
// caller with a meaningful absolute step passes it and gets linear stepping.

/** Pixels of travel before the first increment, so a click isn't a drag. */
export const DRAG_THRESHOLD = 3;

/** Drag distance one arrow-key press stands in for, so keyboard and pointer share a rule. */
export const DRAG_STEP_PX = 4;

/** Fraction of the current magnitude applied per pixel of horizontal drag. */
const PROPORTIONAL_PER_PX = 0.005;

/**
 * Proportional stepping has no magnitude to scale at zero and would stick
 * there. Below this the drag falls back to a fixed step.
 */
const NEAR_ZERO = 1e-12;

/** Step used to escape zero when there's no magnitude to scale and no caller step. */
const ZERO_ESCAPE_STEP = 0.01;

export interface DragModifiers {
  /** Coarse: ×10 per pixel. */
  shift?: boolean;
  /** Fine: ×0.1 per pixel. */
  alt?: boolean;
}

/** Multiplier from the held modifiers; holding both cancels out. */
export function modifierScale({ shift, alt }: DragModifiers): number {
  let scale = 1;
  if (shift) scale *= 10;
  if (alt) scale *= 0.1;
  return scale;
}

/**
 * Value after dragging `dx` pixels from where the drag started.
 *
 * Computed from the drag-start value, never accumulated per pointer event:
 * accumulation would compound rounding and make the result depend on how many
 * move events the browser coalesced, i.e. on frame rate.
 *
 * @param startValue value when the pointer went down (display units)
 * @param dx         horizontal pixels moved, right positive
 * @param step       absolute step per pixel; omit for proportional stepping
 */
export function dragValue(
  startValue: number,
  dx: number,
  modifiers: DragModifiers = {},
  step?: number,
): number {
  if (!Number.isFinite(startValue)) startValue = 0;

  // Deadzone: the first few pixels select the axis, they don't move the value.
  const travel = Math.abs(dx) <= DRAG_THRESHOLD ? 0 : dx - Math.sign(dx) * DRAG_THRESHOLD;
  if (travel === 0) return startValue;

  const scale = modifierScale(modifiers);

  if (step !== undefined && Number.isFinite(step) && step > 0) {
    return startValue + travel * step * scale;
  }

  const magnitude = Math.abs(startValue);
  if (magnitude < NEAR_ZERO) {
    return startValue + travel * ZERO_ESCAPE_STEP * scale;
  }

  // Exponential in drag distance, so the same gesture is the same *ratio*
  // change at any magnitude. Applied to the magnitude and re-signed: on a
  // negative value a right-drag must move toward zero, which multiplying by a
  // >1 factor would get backwards.
  //
  // Consequence: a proportional drag approaches zero asymptotically and never
  // crosses it. Deliberate — on the fields that straddle zero sign is a
  // direction, and flipping it mid-drag reads as a glitch. Type it to cross.
  const sign = startValue < 0 ? -1 : 1;
  const factor = Math.exp(sign * travel * PROPORTIONAL_PER_PX * scale);
  return sign * Math.abs(startValue) * factor;
}
