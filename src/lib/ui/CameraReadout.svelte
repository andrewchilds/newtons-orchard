<script lang="ts">
  // Camera bearing, bottom-right. Deliberately faint — a watermark-weight
  // orientation cue, not a control.
  //
  // Angles about the view center, not xyz distance: distance is apparent from
  // the view itself, direction isn't. The axis buttons move the camera in these
  // same terms, so a squared-up view reads as multiples of 90°.

  import { ui } from '../state/ui.svelte';
  import { cameraAngles, formatDegrees } from './units';

  /**
   * Height of the time panel below, px. Measured by App rather than assumed
   * here: the panel's contents wrap on a narrow viewport, so it's a runtime
   * fact, not a constant.
   */
  let { clearance = 0 }: { clearance?: number } = $props();

  const offset = $derived(ui.cameraOffset);
  const angles = $derived(cameraAngles(offset.x, offset.y, offset.z));
</script>

<div class="camera-readout" aria-hidden="true" style:--clearance="{clearance}px">
  <span class="angle" title="Bearing around the vertical axis">az {formatDegrees(angles.azimuth)}</span>
  <span class="angle" title="Angle above the x–y plane">el {formatDegrees(angles.elevation)}</span>
</div>

<style>
  /* Bottom-right, clear of the chrome toggle and the time panel. The panel is
     `min(720px, 100% - 24px)` wide, so on a narrow viewport it reaches this
     corner and the readout must sit above it, not beside it. */
  .camera-readout {
    position: absolute;
    right: 14px;
    /* Clearance is the time panel's measured height, plus its own bottom offset. */
    bottom: calc(var(--clearance, 0px) + 20px);
    z-index: 3;
    display: flex;
    align-items: baseline;
    gap: 8px;
    /* Purely informational — never eat a drag meant for the scene behind it. */
    pointer-events: none;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    /* No panel chrome — a border and blur would read as another control. The
       shadow keeps the text legible over a bright starfield or planet. */
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
    opacity: 0.55;
    user-select: none;
  }

  .angle {
    color: var(--text-dim);
  }
</style>
