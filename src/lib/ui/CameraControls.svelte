<script lang="ts">
  // Explicit camera controls: zoom steps, and a quarter-turn button per world
  // axis that cycles the view through the four square orientations about it.
  //
  // These exist alongside the mouse gestures because a trackball camera is
  // hard to aim precisely — after a few tumbles the ecliptic sits at some
  // arbitrary angle, and there's no gesture that means "square this up". Each
  // button here is a request; the scene owns the camera and applies them.

  import { ui, ZOOM_STEP, type CameraTurn } from '../state/ui.svelte';
  import { ArrowDown, ArrowRight, RotateCw, ZoomIn, ZoomOut } from 'lucide-svelte';

  /**
   * The three quarter-turn buttons. Each is screen-relative — it does the same
   * visible thing from every vantage point — and each also levels the horizon,
   * so any of them doubles as the way back from a tumbled view.
   */
  const TURNS: {
    turn: CameraTurn;
    icon: typeof ArrowDown;
    label: string;
    hint: string;
  }[] = [
    {
      turn: 'down',
      icon: ArrowDown,
      label: 'Tip the view down',
      hint: 'Tip the view down a quarter turn',
    },
    {
      turn: 'right',
      icon: ArrowRight,
      label: 'Swing the view right',
      hint: 'Swing the view right a quarter turn',
    },
    {
      turn: 'roll',
      icon: RotateCw,
      label: 'Rotate the view',
      hint: 'Rotate the view a quarter turn clockwise',
    },
  ];
</script>

<div class="control camera">
  <div class="group zoom">
    <button
      class="icon"
      onclick={() => ui.moveCamera({ kind: 'zoom', factor: ZOOM_STEP })}
      title="Zoom out"
      aria-label="Zoom out"
    >
      <ZoomOut size={14} strokeWidth={2} />
    </button>
    <button
      class="icon"
      onclick={() => ui.moveCamera({ kind: 'zoom', factor: 1 / ZOOM_STEP })}
      title="Zoom in"
      aria-label="Zoom in"
    >
      <ZoomIn size={14} strokeWidth={2} />
    </button>
  </div>

  <div class="group turns">
    {#each TURNS as { turn, icon: Icon, label, hint } (turn)}
      <button
        class="icon turn"
        onclick={() => ui.moveCamera({ kind: 'quarterTurn', turn })}
        title={hint}
        aria-label={label}
      >
        <Icon size={14} strokeWidth={2} />
      </button>
    {/each}
  </div>
</div>

<style>
  /* Mirrors .control in Toolbar.svelte — same floating-chrome treatment, since
     these sit side by side in the toolbar row. */
  .control {
    display: flex;
    align-items: center;
    gap: 6px;
    background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  /* Hairline separator, so zoom and the axis turns read as separate tools
     without spending horizontal room the toolbar doesn't have. */
  .group + .group {
    margin-left: 3px;
    padding-left: 6px;
    border-left: 1px solid var(--border);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    background: none;
    border: none;
    border-radius: 4px;
    padding: 4px 5px;
    cursor: pointer;
  }

  .icon:hover {
    color: var(--text);
    background: var(--bg-raised);
  }

  /* The turn arrows read as directions, so they carry a touch more weight than
     the zoom glyphs beside them. */
  .turn {
    color: var(--text);
  }
</style>
