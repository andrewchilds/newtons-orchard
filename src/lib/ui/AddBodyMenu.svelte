<script lang="ts">
  // The "+ Add" popover: pick a body type, then click in the scene to place
  // it (scene/interaction.ts handles the drop). "More options…" opens the
  // full-form CreateBodyDialog — mounted by App, not here, because this panel's
  // backdrop-filter traps fixed-position descendants.

  import type { BodyType } from '../types';
  import { missionGuide } from '../state/missionGuide.svelte';
  import { ui } from '../state/ui.svelte';
  import { unlocks } from '../state/unlocks.svelte';
  import { TYPE_DEFAULTS, TYPE_ICONS } from './units';

  let { onmore }: { onmore: () => void } = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  const types = $derived(unlocks.offeredTypes());

  function arm(type: BodyType) {
    open = false;
    ui.armPlacement(type);
  }

  function more() {
    open = false;
    ui.cancelPlacement();
    onmore();
  }

  // Same dismissal pattern as SystemMenu: pointerdown so it beats a canvas
  // drag, Escape as the keyboard way out.
  function onPointerDown(event: PointerEvent) {
    if (!open || !root) return;
    if (!root.contains(event.target as Node)) open = false;
  }
</script>

<svelte:window
  onpointerdown={onPointerDown}
  onkeydown={(e) => e.key === 'Escape' && (open = false)}
/>

<div class="add-menu" bind:this={root}>
  <button
    class="add"
    class:active={open}
    class:guide-glow={missionGuide.target?.kind === 'add'}
    onclick={() => (open = !open)}
    aria-expanded={open}
    title="Add a body"
  >
    + Add
  </button>

  {#if open}
    <div class="popover">
      <p class="lead">Pick a type, then click in space to place it.</p>
      <div class="types">
        {#each types as t (t)}
          <button class="type" onclick={() => arm(t)} title="Place a {t}">
            <span class="glyph" style="color: {TYPE_DEFAULTS[t].color}">{TYPE_ICONS[t]}</span>
            <span class="name">{t}</span>
          </button>
        {/each}
      </div>
      <button class="more" onclick={more}>More options…</button>
    </div>
  {/if}
</div>

<style>
  .add-menu {
    position: relative;
    flex: none;
  }

  .add {
    font-size: 11px;
    padding: 2px 8px;
  }

  .add.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 228px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    z-index: 1;
  }

  .lead {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-dim);
  }

  .types {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }

  .type {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 2px;
    background: transparent;
    border-color: transparent;
    font-size: 10px;
    color: var(--text-dim);
  }

  .type:hover {
    background: var(--bg-raised);
    border-color: var(--border);
    color: var(--text);
  }

  .glyph {
    font-size: 15px;
    line-height: 1;
  }

  .name {
    text-transform: capitalize;
  }

  .more {
    font-size: 11px;
    padding: 4px 7px;
  }
</style>
