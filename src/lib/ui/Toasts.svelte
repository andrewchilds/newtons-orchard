<script lang="ts">
  import { fly } from 'svelte/transition';
  import { toasts } from '../state/toasts.svelte';
</script>

<!-- Top-right, clear of the toolbar which owns that corner. pointer-events:
     none so a toast can never intercept a click aimed at the scene below. -->
{#if toasts.length > 0}
  <div class="toasts" aria-live="polite">
    {#each toasts as t (t.id)}
      <div class="toast" class:error={t.kind === 'error'} transition:fly={{ y: -8, duration: 150 }}>
        {t.text}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toasts {
    position: fixed;
    top: 52px;
    right: 10px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    pointer-events: none;
  }

  .toast {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
  }

  .toast.error {
    border-left-color: var(--danger, #ff8080);
    color: var(--danger, #ff8080);
  }
</style>
