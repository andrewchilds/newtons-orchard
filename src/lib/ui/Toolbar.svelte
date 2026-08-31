<script lang="ts">
  // Floating toolbar over the viewport: undo/redo for body edits, the
  // camera-focus selector, the center (reference-frame) selector, the explicit
  // camera controls (zoom / quarter-turns / level), and a render-settings
  // popover (radius exaggeration, labels, trails, axes). The system menu lives
  // in the top-left title bar.

  import CameraControls from './CameraControls.svelte';
  import DisplaySettings from './DisplaySettings.svelte';
  import HistoryControls from './HistoryControls.svelte';
  import ViewTargets from './ViewTargets.svelte';

  let settingsOpen = $state(false);
  let settingsRoot = $state<HTMLElement | null>(null);

  function toggleSettings() {
    settingsOpen = !settingsOpen;
  }

  // Close on a click anywhere outside the popover, mirroring SystemMenu: bound
  // on `pointerdown` rather than `click` so it fires before a canvas drag
  // starts orbiting the camera behind it.
  function onPointerDown(event: PointerEvent) {
    if (!settingsOpen || !settingsRoot) return;
    if (!settingsRoot.contains(event.target as Node)) settingsOpen = false;
  }
</script>

<svelte:window
  onpointerdown={onPointerDown}
  onkeydown={(e) => e.key === 'Escape' && (settingsOpen = false)}
/>

<div class="toolbar">
  <div class="control history">
    <HistoryControls />
  </div>

  <ViewTargets />

  <CameraControls />

  <div class="settings" bind:this={settingsRoot}>
    <button
      class:active={settingsOpen}
      onclick={toggleSettings}
      title="Render settings"
      aria-expanded={settingsOpen}
    >
      Display
    </button>

    {#if settingsOpen}
      <div class="popover">
        <DisplaySettings />
      </div>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    /* Wrap rather than overflow: this row is pinned to the viewport's right
       edge, so on a narrow window its first controls would otherwise be pushed
       off the left edge and become unreachable. */
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 6px;
    background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    /* Each control keeps its contents on one line; wrapping happens between
       controls, not inside them. */
    flex: none;
  }

  /* Undo/redo sit tighter than the labelled controls — two glyphs, no caption. */
  .history {
    padding: 3px 4px;
  }

  .settings {
    position: relative;
  }

  button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 220px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
</style>
