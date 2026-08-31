<script lang="ts">
  // Side-panel roster: every body with its color, name and type, selectable in
  // sync with 3D picking, deletable behind a confirm step.

  import { system, deleteBody } from '../state/system.svelte';
  import { missionGuide } from '../state/missionGuide.svelte';
  import { revealWhenGuided } from './guideReveal';
  import { sim } from '../state/simInstance';
  import { time } from '../state/time.svelte';
  import { ui, BARYCENTER } from '../state/ui.svelte';
  import { TYPE_ICONS } from './units';

  // Which row is awaiting delete confirmation. Inline rather than a modal: a
  // dialog for "delete Planet 3" is heavier than the action deserves.
  let confirming = $state<string | null>(null);

  // The roster keeps bodies that aren't present at the viewed time (merged
  // away, deleted, or created further along); their rows dim rather than
  // vanish, since scrubbing can bring them back. The sim isn't reactive, so
  // this touches the clock and edit counter to resample it.
  const presentIds = $derived.by(() => {
    void time.simTime;
    void time.seekGeneration;
    return new Set(sim.aliveIds);
  });

  function select(id: string) {
    ui.selectedBodyId = id;
    confirming = null;
  }

  function focus(id: string) {
    ui.focusBody(id);
  }

  function remove(id: string) {
    // Selection and the reference frame may both point at the body about to
    // vanish; drop those references first so nothing renders against a ghost.
    if (ui.selectedBodyId === id) ui.selectedBodyId = null;
    if (ui.referenceFrame === id) ui.referenceFrame = BARYCENTER;
    if (ui.focusedBodyId === id) ui.clearFocus();
    confirming = null;
    deleteBody(id);
  }
</script>

<ul class="bodies">
  {#each system.bodies as body (body.id)}
    <li>
      <div
        class="row"
        class:selected={ui.selectedBodyId === body.id}
        class:gone={!presentIds.has(body.id)}
        class:guide-glow={missionGuide.targetsRoster(body.name)}
        use:revealWhenGuided={missionGuide.targetsRoster(body.name)}
      >
        <button
          class="body"
          onclick={() => select(body.id)}
          ondblclick={() => focus(body.id)}
          title={`${body.name} — double-click to focus the camera`}
        >
          <span class="dot" style="background: {body.color}"></span>
          <span class="icon" style="color: {body.color}">{TYPE_ICONS[body.type]}</span>
          <span class="name">{body.name}</span>
        </button>

        <!-- Only for present bodies: deleting a dead one is a no-op, and the
             selected row's info panel already explains the absence. -->
        {#if presentIds.has(body.id)}
          <button
            class="delete"
            onclick={() => (confirming = confirming === body.id ? null : body.id)}
            title="Delete {body.name}"
            aria-label="Delete {body.name}"
          >
            ×
          </button>
        {/if}
      </div>

      {#if confirming === body.id}
        <div class="confirm">
          <span>Delete {body.name}?</span>
          <button class="danger" onclick={() => remove(body.id)}>Delete</button>
          <button onclick={() => (confirming = null)}>Cancel</button>
        </div>
      {/if}
    </li>
  {/each}
</ul>

{#if system.bodies.length === 0}
  <p class="empty">Nothing here yet. Add an object to begin.</p>
{/if}

<style>
  .bodies {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 5px;
  }

  .row:hover {
    background: var(--bg-raised);
    border-color: var(--border);
  }

  .row.selected {
    background: var(--bg-raised);
    border-color: var(--accent);
  }

  /* Not present at the viewed time (merged, deleted, or not created yet). The
     row stays — scrubbing can bring the body back — but reads as history. */
  .row.gone .body {
    opacity: 0.4;
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    padding: 5px 7px;
    text-align: left;
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }

  .icon {
    font-size: 11px;
    flex: none;
    opacity: 0.9;
  }

  .name {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .delete {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1;
    padding: 4px 7px;
    opacity: 0;
  }

  .row:hover .delete,
  .row.selected .delete {
    opacity: 1;
  }

  .delete:hover {
    color: var(--danger, #e06c6c);
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-dim);
    padding: 5px 7px 6px;
  }

  .confirm span {
    flex: 1;
  }

  .confirm button {
    font-size: 11px;
    padding: 2px 6px;
  }

  .danger {
    color: var(--danger, #e06c6c);
    border-color: var(--danger, #e06c6c);
  }

  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
