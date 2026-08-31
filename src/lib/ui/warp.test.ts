import { describe, expect, it } from 'vitest';
import {
  MAX_WARP,
  MIN_WARP,
  WARP_STEPS,
  WARP_TICKS,
  sliderToWarp,
  warpToSlider,
} from './warp';
import { WARP_PRESETS } from '../state/time.svelte';
import { DAY } from '../physics/constants';

describe('warpToSlider', () => {
  it('maps the bounds to the ends of the travel', () => {
    expect(warpToSlider(MIN_WARP)).toBe(0);
    expect(warpToSlider(MAX_WARP)).toBe(WARP_STEPS);
  });

  it('clamps out-of-range rates onto the track', () => {
    expect(warpToSlider(MIN_WARP / 100)).toBe(0);
    expect(warpToSlider(MAX_WARP * 100)).toBe(WARP_STEPS);
  });

  it('is log-scaled: equal ratios are equal distances', () => {
    // MIN→MIN×10 and MIN×10→MIN×100 are the same ratio, so the same travel.
    const first = warpToSlider(MIN_WARP * 10) - warpToSlider(MIN_WARP);
    const second = warpToSlider(MIN_WARP * 100) - warpToSlider(MIN_WARP * 10);
    expect(second).toBeCloseTo(first, 6);
  });

  it('is monotonic', () => {
    const rates = [60, 600, 3600, DAY, 7 * DAY, MAX_WARP];
    const positions = rates.map(warpToSlider);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});

describe('sliderToWarp', () => {
  it('snaps to a preset when the handle lands near one', () => {
    for (const preset of WARP_PRESETS) {
      const at = warpToSlider(preset.value);
      expect(sliderToWarp(at)).toBe(preset.value);
      expect(sliderToWarp(at + 5)).toBe(preset.value);
      expect(sliderToWarp(at - 5)).toBe(preset.value);
    }
  });

  it('leaves rates between presets unsnapped', () => {
    const between = (warpToSlider(DAY) + warpToSlider(7 * DAY)) / 2;
    const rate = sliderToWarp(between);
    expect(rate).toBeGreaterThan(DAY);
    expect(rate).toBeLessThan(7 * DAY);
    expect(WARP_PRESETS.some((p) => p.value === rate)).toBe(false);
  });

  it('round-trips a preset exactly, so the readout does not drift', () => {
    for (const preset of WARP_PRESETS) {
      expect(sliderToWarp(warpToSlider(preset.value))).toBe(preset.value);
    }
  });

  it('round-trips an unsnapped rate to within floating-point error', () => {
    const rate = 3.7 * DAY;
    expect(sliderToWarp(warpToSlider(rate))).toBeCloseTo(rate, 6);
  });

  it('clamps positions off either end of the track', () => {
    expect(sliderToWarp(-50)).toBe(MIN_WARP);
    expect(sliderToWarp(WARP_STEPS + 50)).toBe(MAX_WARP);
  });

  it('never returns a non-positive rate — a stopped clock is play/pause', () => {
    for (let position = 0; position <= WARP_STEPS; position += 25) {
      expect(sliderToWarp(position)).toBeGreaterThan(0);
    }
  });
});

describe('WARP_TICKS', () => {
  it('places every preset within the track', () => {
    expect(WARP_TICKS).toHaveLength(WARP_PRESETS.length);
    for (const tick of WARP_TICKS) {
      expect(tick.percent).toBeGreaterThanOrEqual(0);
      expect(tick.percent).toBeLessThanOrEqual(100);
    }
  });

  it('anchors the ends', () => {
    expect(WARP_TICKS[0].percent).toBe(0);
    expect(WARP_TICKS[WARP_TICKS.length - 1].percent).toBe(100);
  });
});
