<script lang="ts">
  // The in-flight mission's checklist, shared by both chrome layouts. Rendered
  // from missionGuide so the ticks here and the `guide-glow` ring on the
  // controls can never disagree about which step is live.
  import { missionGuide } from '../state/missionGuide.svelte';
</script>

<ol class="steps">
  {#each missionGuide.steps as step (step.index)}
    <li
      class:done={step.done}
      class:current={step.current}
      aria-current={step.current ? 'step' : undefined}
    >
      <span class="mark" aria-hidden="true">{step.done ? '✓' : step.index + 1}</span>
      <span class="text">{step.text}</span>
    </li>
  {/each}
</ol>

<style>
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-dim);
  }

  .mark {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 700;
  }

  /* The current step matches the glowing control: same accent, so the ring in
     the scene chrome reads as "this step, over here". */
  li.current {
    color: var(--text);
  }

  li.current .mark {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--text);
  }

  /* Same green as the completed mission cards — done is done everywhere. */
  li.done .mark {
    border-color: color-mix(in srgb, var(--ok) 60%, var(--border));
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
  }
</style>
