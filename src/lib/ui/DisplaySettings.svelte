<script lang="ts">
  // The render-settings controls: radius exaggeration, trails and their length,
  // labels, axes, prediction, vectors, bloom, lensing.
  //
  // Extracted from `Toolbar.svelte` so the desktop popover and the compact
  // chrome's Display sheet are the same controls rather than two copies that
  // drift. The host owns the chrome around it — this is the contents only.

  import {
    ui,
    MIN_EXAGGERATION,
    MAX_EXAGGERATION,
    MIN_TRAIL_DAYS,
    MAX_TRAIL_DAYS,
    SELECTED_TRAIL_MULTIPLIER,
  } from '../state/ui.svelte';

  // Days read badly past a year or so; the slider's top end is 10 years.
  function formatDays(days: number): string {
    if (days < 365) return `${days} d`;
    return `${(days / 365.25).toFixed(1)} yr`;
  }

  // Both sliders are log-scaled: spanning ×1–×2000 (or 1–3650 days) linearly
  // would put every useful value in the first few percent of travel.
  function toSlider(value: number, min: number, max: number): number {
    const logMin = Math.log(min);
    return ((Math.log(value) - logMin) / (Math.log(max) - logMin)) * 1000;
  }

  function fromSlider(position: number, min: number, max: number): number {
    const logMin = Math.log(min);
    return Math.round(Math.exp(logMin + (position / 1000) * (Math.log(max) - logMin)));
  }

  const sliderValue = $derived(
    toSlider(ui.radiusExaggeration, MIN_EXAGGERATION, MAX_EXAGGERATION)
  );

  function onSlider(event: Event & { currentTarget: HTMLInputElement }) {
    ui.radiusExaggeration = fromSlider(
      Number(event.currentTarget.value),
      MIN_EXAGGERATION,
      MAX_EXAGGERATION
    );
  }

  const trailSliderValue = $derived(toSlider(ui.trailDays, MIN_TRAIL_DAYS, MAX_TRAIL_DAYS));

  function onTrailSlider(event: Event & { currentTarget: HTMLInputElement }) {
    ui.trailDays = fromSlider(Number(event.currentTarget.value), MIN_TRAIL_DAYS, MAX_TRAIL_DAYS);
  }
</script>

<div class="display-settings">
  <label class="row slider-row">
    <span>Body size ×{ui.radiusExaggeration.toLocaleString()}</span>
    <input
      type="range"
      min="0"
      max="1000"
      value={sliderValue}
      oninput={onSlider}
      aria-label="Body radius exaggeration"
    />
  </label>

  <label class="row">
    <input type="checkbox" bind:checked={ui.showTrails} />
    <span>Orbit trails</span>
  </label>

  <label
    class="row slider-row sub"
    class:disabled={!ui.showTrails}
    title="How much orbit history each trail shows. The selected body shows {SELECTED_TRAIL_MULTIPLIER}× this."
  >
    <span>Trail length {formatDays(ui.trailDays)}</span>
    <input
      type="range"
      min="0"
      max="1000"
      value={trailSliderValue}
      oninput={onTrailSlider}
      disabled={!ui.showTrails}
      aria-label="Orbit trail length in days"
    />
  </label>

  <label
    class="row sub"
    class:disabled={!ui.showTrails}
    title="Draw each trail around the body it orbits, so a moon shows its ellipse in any view. Off draws trails against the view center only."
  >
    <input type="checkbox" bind:checked={ui.parentRelativeTrails} disabled={!ui.showTrails} />
    <span>Around orbit parent</span>
  </label>

  <label class="row">
    <input type="checkbox" bind:checked={ui.showLabels} />
    <span>Labels</span>
  </label>

  <label class="row">
    <input type="checkbox" bind:checked={ui.showAxes} />
    <span>Rotation axes</span>
  </label>

  <label
    class="row"
    title="Shade the band of orbits where an earthlike planet could keep liquid water, estimated from each star's mass. A rough guide, not a verdict."
  >
    <input type="checkbox" bind:checked={ui.showHabitableZone} />
    <span>Habitable zone</span>
  </label>

  <label class="row" title="Dashed forward-integrated path. Shown for the selected body only.">
    <input type="checkbox" bind:checked={ui.showPrediction} />
    <span>Predicted orbit <em class="scope">(selected)</em></span>
  </label>

  <label class="row">
    <input type="checkbox" bind:checked={ui.showVectors} />
    <span>Velocity / accel. vectors</span>
  </label>

  <label class="row" title="Post-processing glow on stars. Turn off on weak GPUs.">
    <input type="checkbox" bind:checked={ui.bloom} />
    <span>Star bloom</span>
  </label>

  <label
    class="row"
    title="Bend light around black holes: Einstein ring, star arcs, and the enlarged shadow. Warps the view of nearby orbits."
  >
    <input type="checkbox" bind:checked={ui.lensing} />
    <span>Gravitational lensing</span>
  </label>

  <p class="note">Radii are exaggerated for visibility; distances are true to scale.</p>
</div>

<style>
  .display-settings {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    cursor: pointer;
  }

  .slider-row {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }

  /* Nested under the toggle it depends on. */
  .slider-row.sub {
    margin: -3px 0 0 21px;
  }

  .slider-row.disabled {
    opacity: 0.45;
    cursor: default;
  }

  .slider-row span {
    color: var(--text-dim);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }

  input[type='checkbox'] {
    accent-color: var(--accent);
  }

  .note {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-dim);
    opacity: 0.8;
  }

  /* Marks a toggle that only affects the currently selected body. */
  .scope {
    font-style: normal;
    font-size: 11px;
    color: var(--text-dim);
  }
</style>
