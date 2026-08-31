// Time-warp slider curve: slider position → sim-seconds per wall-second.
// Pure functions, unit-tested, mirroring shuttle.ts.
//
// WARP_PRESETS act as snap targets and tick marks so "1 day/s" stays exactly
// reachable rather than becoming 1.03 day/s because the handle landed a pixel
// off.

import { WARP_PRESETS } from '../state/time.svelte';

/** Slider bounds in sim-seconds per wall-second. */
export const MIN_WARP = WARP_PRESETS[0].value;
export const MAX_WARP = WARP_PRESETS[WARP_PRESETS.length - 1].value;

/** Slider travel, in steps. Fine enough that the snap does the aiming. */
export const WARP_STEPS = 1000;

const LOG_MIN = Math.log(MIN_WARP);
const LOG_MAX = Math.log(MAX_WARP);

/**
 * How close to a preset counts as on it, in slider steps.
 *
 * Steps, not a ratio window: the scale is log, so a fixed step count is the
 * same grab distance everywhere on the track. Six presets over 1000 steps sit
 * ~200 apart, so 12 can't capture the space between two of them.
 */
const SNAP_STEPS = 12;

/** Slider position (0…WARP_STEPS) for a rate, log-scaled. */
export function warpToSlider(rate: number): number {
  const clamped = Math.min(MAX_WARP, Math.max(MIN_WARP, rate));
  return ((Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * WARP_STEPS;
}

/**
 * Rate for a slider position, snapped to a preset when it lands near one.
 *
 * Returns the preset's exact value on a snap, so round-tripping through
 * `warpToSlider` is stable.
 */
export function sliderToWarp(position: number): number {
  const clamped = Math.min(WARP_STEPS, Math.max(0, position));

  for (const preset of WARP_PRESETS) {
    if (Math.abs(clamped - warpToSlider(preset.value)) <= SNAP_STEPS) return preset.value;
  }

  return Math.exp(LOG_MIN + (clamped / WARP_STEPS) * (LOG_MAX - LOG_MIN));
}

/** Preset tick positions as percentages of travel, for the slider's scale. */
export const WARP_TICKS = WARP_PRESETS.map((preset) => ({
  label: preset.label,
  value: preset.value,
  percent: (warpToSlider(preset.value) / WARP_STEPS) * 100,
}));
