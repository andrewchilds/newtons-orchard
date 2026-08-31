<script lang="ts">
  import { shuttleRate, formatRate, DEADZONE } from './shuttle';

  let {
    /** normalized displacement, -1 … 1; bound so the parent can read the rate */
    displacement = $bindable(0),
    /**
     * True while the handle is actively held, center included. The parent needs
     * this separately from the rate: held at center is a deliberate hold, and
     * reads as 0 rate exactly like a released shuttle does.
     */
    held = $bindable(false),
  }: { displacement?: number; held?: boolean } = $props();

  let track: HTMLDivElement;
  let dragging = $state(false);
  let pointerId: number | null = null;

  const rate = $derived(shuttleRate(displacement));

  /** Pointer x → normalized displacement about the track center. */
  function displacementFrom(clientX: number): number {
    const box = track.getBoundingClientRect();
    const center = box.left + box.width / 2;
    const half = box.width / 2;
    if (half === 0) return 0;
    return Math.max(-1, Math.min(1, (clientX - center) / half));
  }

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    held = true;
    pointerId = event.pointerId;
    track.setPointerCapture(event.pointerId);
    displacement = displacementFrom(event.clientX);
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    displacement = displacementFrom(event.clientX);
  }

  /** Spring back to center — the shuttle only scrubs while actively held. */
  function release() {
    if (!dragging) return;
    dragging = false;
    held = false;
    if (pointerId !== null && track.hasPointerCapture(pointerId)) {
      track.releasePointerCapture(pointerId);
    }
    pointerId = null;
    displacement = 0;
  }

  // Keyboard: arrows step the handle, so the shuttle is reachable without a
  // pointer. Held keys repeat natively, which reads as a sustained scrub.
  function onKeyDown(event: KeyboardEvent) {
    const STEP = 0.1;
    if (event.key === 'ArrowLeft') {
      displacement = Math.max(-1, displacement - STEP);
      held = true;
    } else if (event.key === 'ArrowRight') {
      displacement = Math.min(1, displacement + STEP);
      held = true;
    } else if (event.key === 'Home' || event.key === 'Escape') {
      // Recentering is an exit, not a hold: it's how you get out of a scrub
      // without a key to let go of.
      displacement = 0;
      held = false;
    } else {
      return;
    }
    event.preventDefault();
  }

  // Keyboard scrubbing has no pointer-release to spring it back, so returning
  // to center is explicit: let go of the key and it settles.
  function onKeyUp(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      displacement = 0;
      held = false;
    }
  }
</script>

<div class="shuttle">
  <div
    class="track"
    bind:this={track}
    role="slider"
    tabindex="0"
    aria-label="Shuttle — scrub forward and back"
    aria-valuemin={-1}
    aria-valuemax={1}
    aria-valuenow={displacement}
    aria-valuetext={formatRate(rate)}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={release}
    onpointercancel={release}
    onlostpointercapture={release}
    onkeydown={onKeyDown}
    onkeyup={onKeyUp}
  >
    <!-- Tick marks: direction cues, densest at the fast extremes. -->
    <div class="ticks" aria-hidden="true">
      <span class="tick">◀◀◀</span>
      <span class="tick">◀◀</span>
      <span class="tick">◀</span>
      <span class="tick dot">·</span>
      <span class="detent"></span>
      <span class="tick dot">·</span>
      <span class="tick">▶</span>
      <span class="tick">▶▶</span>
      <span class="tick">▶▶▶</span>
    </div>

    <!-- Fill from center to the handle, so direction reads at a glance. -->
    <div
      class="fill"
      class:active={rate !== 0}
      style="--from: {Math.min(50, 50 + displacement * 50)}%; --to: {Math.max(
        50,
        50 + displacement * 50
      )}%"
      aria-hidden="true"
    ></div>

    <div
      class="handle"
      class:dragging
      class:engaged={rate !== 0}
      style="left: {50 + displacement * 50}%"
      aria-hidden="true"
    ></div>
  </div>

  <div class="readout" class:engaged={rate !== 0}>{formatRate(rate)}</div>
</div>

<style>
  .shuttle {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    /* Takes whatever the fixed-width controls leave, but never gives up so
       much that the tick marks crowd — the track is the widest control here
       because it's the one being aimed. */
    flex: 1 1 auto;
    min-width: 240px;
  }

  .track {
    position: relative;
    width: 100%;
    height: 26px;
    border-radius: 13px;
    background: var(--bg);
    border: 1px solid var(--border);
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
    overflow: hidden;
  }

  .track:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .ticks {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: space-around;
    font-size: 9px;
    color: var(--text-dim);
    opacity: 0.5;
    pointer-events: none;
  }

  .tick.dot {
    font-size: 13px;
  }

  /* Center detent: the resting position the handle springs back to. */
  .detent {
    width: 2px;
    height: 12px;
    border-radius: 1px;
    background: var(--text-dim);
    opacity: 0.9;
  }

  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--from);
    right: calc(100% - var(--to));
    background: var(--accent);
    opacity: 0;
    pointer-events: none;
  }

  .fill.active {
    opacity: 0.18;
  }

  .handle {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 20px;
    border-radius: 3px;
    background: var(--text);
    border: 1px solid var(--bg);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  /* Snap home when released; follow the finger 1:1 while held. */
  .handle:not(.dragging) {
    transition: left 140ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .handle.engaged {
    background: var(--accent);
  }

  .readout {
    font-size: 11px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .readout.engaged {
    color: var(--accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .handle:not(.dragging) {
      transition: none;
    }
  }
</style>
