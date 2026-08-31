<script lang="ts">
  // Undo/redo for body edits. Shared by the desktop toolbar (icons only) and
  // the compact chrome's History sheet (`labelled`, which spells out what each
  // button will undo — a bare glyph in a sheet has no row of neighbours to give
  // it context).

  import { undo, redo } from '../state/system.svelte';
  import { history, UNDO_MODIFIER as modifier } from '../state/history.svelte';
  import { Undo2, Redo2 } from 'lucide-svelte';

  let { labelled = false }: { labelled?: boolean } = $props();
</script>

<div class="history" class:labelled>
  <button
    class="icon"
    onclick={undo}
    disabled={!history.canUndo}
    title="Undo the last body edit ({modifier}Z)"
    aria-label="Undo"
  >
    <Undo2 size={15} strokeWidth={2} />
    {#if labelled}<span>Undo</span>{/if}
  </button>
  <button
    class="icon"
    onclick={redo}
    disabled={!history.canRedo}
    title="Redo ({modifier}⇧Z)"
    aria-label="Redo"
  >
    <Redo2 size={15} strokeWidth={2} />
    {#if labelled}<span>Redo</span>{/if}
  </button>
</div>

<style>
  /* Undo/redo sit tighter than the labelled controls — two glyphs, no caption. */
  .history {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* Flex, not text: the label is an SVG, so it centers as a box rather than
     riding a text baseline. `currentColor` on the stroke ties it to the
     hover/disabled color changes below. */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-dim);
    background: none;
    border: none;
    border-radius: 4px;
    padding: 4px 6px;
    cursor: pointer;
  }

  .icon:hover:not(:disabled) {
    color: var(--text);
    background: var(--bg-raised);
  }

  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* In a sheet the two buttons are the whole content, so they become full-width
     rows with room for a finger rather than 23 px glyphs. */
  .history.labelled {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  .history.labelled .icon {
    justify-content: flex-start;
    font-size: 14px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
  }
</style>
