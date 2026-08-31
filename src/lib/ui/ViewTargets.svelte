<script lang="ts">
  // The two "what is the camera looking at" selectors: Focus (the body the
  // camera follows) and Center (the reference frame the view is drawn in).
  //
  // Each caption is itself a button — clicking it snaps the camera back after
  // the user has panned away.
  //
  // `stacked` lays them out as full-width labelled rows for the compact
  // chrome's Camera sheet; the default is the desktop toolbar's inline pills.

  import { system } from '../state/system.svelte';
  import { missionGuide } from '../state/missionGuide.svelte';
  import { ui, BARYCENTER } from '../state/ui.svelte';

  let { stacked = false }: { stacked?: boolean } = $props();

  function onFocusChange(event: Event & { currentTarget: HTMLSelectElement }) {
    const id = event.currentTarget.value;
    if (id === '') ui.clearFocus();
    else ui.focusBody(id);
  }

  function onCenterChange(event: Event & { currentTarget: HTMLSelectElement }) {
    ui.referenceFrame = event.currentTarget.value;
  }
</script>

<div
  class="control focus"
  class:stacked
  title="Camera follows this body, keeping the center in view. None stops following."
>
  <button
    class="control-label"
    onclick={() => ui.refocus()}
    disabled={ui.focusedBodyId === null}
    title="Snap the camera back onto the focused body"
  >
    Focus
  </button>
  <select value={ui.focusedBodyId ?? ''} onchange={onFocusChange} aria-label="Focus body">
    <option value="">None</option>
    {#each system.bodies as body (body.id)}
      <option value={body.id}>{body.name}</option>
    {/each}
  </select>
</div>

<div
  class="control center"
  class:stacked
  title="Keep this body (or the barycenter) at the origin. Physics stays inertial."
>
  <button class="control-label" onclick={() => ui.recenter()} title="Snap the camera back onto the center">
    Center
  </button>
  <select
    class:guide-glow={missionGuide.target?.kind === 'center'}
    value={ui.referenceFrame}
    onchange={onCenterChange}
    aria-label="Center of the view"
  >
    <option value={BARYCENTER}>Barycenter</option>
    {#each system.bodies as body (body.id)}
      <option value={body.id}>{body.name}</option>
    {/each}
  </select>
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
    /* Each control keeps its contents on one line; wrapping happens between
       controls, not inside them. */
    flex: none;
  }

  /* A button dressed as a caption: clicking it snaps the camera back
     (re-frame the focus / re-center the view) after the user pans away. */
  .control-label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .control-label:hover:not(:disabled) {
    color: var(--text);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .control-label:disabled {
    cursor: default;
  }

  select {
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 4px;
    max-width: 140px;
  }

  /* Sheet layout: the caption sits at a fixed width on the left and the select
     takes the rest of the row, so the two line up as a small form. */
  .control.stacked {
    background: none;
    border: none;
    padding: 0;
    gap: 10px;
  }

  .control.stacked .control-label {
    flex: none;
    width: 52px;
    text-align: left;
  }

  .control.stacked select {
    flex: 1;
    min-width: 0;
    max-width: none;
    font-size: 15px;
    padding: 8px 6px;
  }
</style>
