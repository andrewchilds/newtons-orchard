// Shared durations for the chrome's transitions, and the reduced-motion gate.
//
// Svelte's transitions are JS-driven and never see the reduced-motion media
// query, so anything using `svelte/transition` must zero its own duration.

/** Dialog fade + scale, ms. */
export const DIALOG_MS = 140;

/** Panel expand/collapse slide, ms. Shorter: it fires far more often. */
export const PANEL_MS = 160;

/** Scale a dialog grows from as it fades in. */
export const DIALOG_SCALE = 0.96;

/**
 * True when the user has asked for reduced motion. Read at transition time, not
 * cached, so toggling the OS setting applies without a reload. `matchMedia` is
 * guarded for the non-DOM test environment.
 */
export function reducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** `ms`, or 0 when the user has asked for reduced motion. */
export function duration(ms: number): number {
  return reducedMotion() ? 0 : ms;
}
