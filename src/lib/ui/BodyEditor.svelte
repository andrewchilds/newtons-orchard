<script lang="ts">
  // Editor for the selected body. Every change routes through updateBody, so
  // each keystroke invalidates the future and re-simulates from now — which is
  // the behavior the batch is about: change a mass mid-flight and the orbits
  // after this instant change, while the past stays exactly as it was.

  import { system, updateBody, liveStateOf } from '../state/system.svelte';
  import { missionGuide } from '../state/missionGuide.svelte';
  import { ui } from '../state/ui.svelte';
  import { time } from '../state/time.svelte';
  import type { BodyType } from '../types';
  import NumberField from './NumberField.svelte';
  import { revealWhenGuided } from './guideReveal';
  import { unlocks } from '../state/unlocks.svelte';
  import {
    TYPE_DEFAULTS,
    formatNumber,
    fromDays,
    fromEarthMasses,
    fromKm,
    toDays,
    toEarthMasses,
    toKm,
    validateBody,
  } from './units';

  const body = $derived(system.byId(ui.selectedBodyId));


  // Live state — read off the sim each time the clock moves, not from the
  // roster, so the readout tracks the body as it flies.
  const live = $derived.by(() => {
    // Touch the reactive clock so this recomputes as time advances.
    void time.simTime;
    return body ? liveStateOf(body.id) : null;
  });

  const speed = $derived(
    live ? Math.hypot(live.velocity.x, live.velocity.y, live.velocity.z) : null
  );

  const errors = $derived(body ? validateBody(body).errors : {});

  // The mission step pointing into this editor, if it's about the body shown —
  // a step about the Sun must not light up fields while Mercury is selected.
  const guided = $derived.by(() => {
    const t = missionGuide.target;
    return t?.kind === 'editor' && body && t.body === body.name ? t : null;
  });

  /** Whether a velocity component's field should carry the guide ring. */
  function guidesVelocity(axis: 'x' | 'y' | 'z'): boolean {
    return guided?.field === 'velocity' && (guided.axis === undefined || guided.axis === axis);
  }

  function set(changes: Parameters<typeof updateBody>[1]) {
    if (!body) return;
    updateBody(body.id, changes);
  }

  /**
   * Changing type only swaps the *appearance* defaults, never mass/radius/spin
   * — those are the user's numbers, and silently rewriting them because
   * someone reclassified a body as a dwarf would be destructive.
   */
  function setType(next: BodyType) {
    if (!body) return;
    const wasDefaultColor = body.color === TYPE_DEFAULTS[body.type].color;
    set({
      type: next,
      color: wasDefaultColor ? TYPE_DEFAULTS[next].color : body.color,
    });
  }

  function toggleAtmosphere(on: boolean) {
    set({ atmosphere: on ? { color: '#7fb2ff', density: 0.3 } : undefined });
  }

  function toggleRings(on: boolean) {
    if (!body) return;
    set({
      rings: on
        ? {
            innerRadius: body.radius * 1.5,
            outerRadius: body.radius * 2.5,
            color: '#d8c9a8',
            opacity: 0.6,
          }
        : undefined,
    });
  }
</script>

<!-- Only while the body is present at the viewed time: BodyInfo's "gone"
     message explains the absence, and edits route through the current-time
     roster, where a dead body has no entry to receive them. -->
{#if body && live}
  <div class="editor">
    <div class="grid">
      <label class="field span2">
        <span class="label">Name</span>
        <input
          type="text"
          value={body.name}
          oninput={(e) => set({ name: e.currentTarget.value })}
        />
        {#if errors.name}<span class="error">{errors.name}</span>{/if}
      </label>

      <!-- A photographic surface (real planets) isn't recolorable; the color
           still drives the trail, label and selection accents. -->
      <label
        class="field color-field"
        title={body.texture
          ? 'This body uses a photographic surface map, so color only tints its trail and label.'
          : undefined}
      >
        <span class="label">Color</span>
        <input
          type="color"
          value={body.color}
          oninput={(e) => set({ color: e.currentTarget.value })}
        />
      </label>
    </div>

    <label class="field">
      <span class="label">Type</span>
      <select
        class:guide-glow={guided?.field === 'type'}
        use:revealWhenGuided={guided?.field === 'type'}
        value={body.type}
        onchange={(e) => setType(e.currentTarget.value as BodyType)}
      >
        {#each unlocks.offeredTypes(body.type) as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>

    <div class="grid">
      <NumberField
        label="Mass"
        unit="M⊕"
        value={body.mass}
        toDisplay={toEarthMasses}
        fromDisplay={fromEarthMasses}
        error={errors.mass}
        highlight={guided?.field === 'mass'}
        onchange={(v) => set({ mass: v })}
      />
      <NumberField
        label="Radius"
        unit="km"
        value={body.radius}
        toDisplay={toKm}
        fromDisplay={fromKm}
        error={errors.radius}
        highlight={guided?.field === 'radius'}
        onchange={(v) => set({ radius: v })}
      />
      <NumberField
        label="Rotation"
        unit="d"
        value={body.rotationPeriod}
        toDisplay={toDays}
        fromDisplay={fromDays}
        error={errors.rotationPeriod}
        onchange={(v) => set({ rotationPeriod: v })}
      />
      <NumberField
        label="Axial tilt"
        unit="°"
        value={body.axialTilt}
        error={errors.axialTilt}
        onchange={(v) => set({ axialTilt: v })}
      />
    </div>

    <!-- Atmosphere: any body may have one, independent of type. -->
    <section class="feature">
      <label class="toggle">
        <input
          type="checkbox"
          checked={!!body.atmosphere}
          onchange={(e) => toggleAtmosphere(e.currentTarget.checked)}
        />
        <span>Atmosphere</span>
      </label>

      {#if body.atmosphere}
        {@const atmosphere = body.atmosphere}
        <div class="grid">
          <label class="field color-field">
            <span class="label">Color</span>
            <input
              type="color"
              value={atmosphere.color}
              oninput={(e) => set({ atmosphere: { ...atmosphere, color: e.currentTarget.value } })}
            />
          </label>

          <label class="field">
            <span class="label">Density {atmosphere.density.toFixed(2)}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={atmosphere.density}
              oninput={(e) =>
                set({ atmosphere: { ...atmosphere, density: Number(e.currentTarget.value) } })}
            />
          </label>
        </div>
      {/if}
    </section>

    <section class="feature">
      <label class="toggle">
        <input
          type="checkbox"
          checked={!!body.rings}
          onchange={(e) => toggleRings(e.currentTarget.checked)}
        />
        <span>Rings</span>
      </label>

      {#if body.rings}
        {@const rings = body.rings}
        <div class="grid">
          <NumberField
            label="Inner"
            unit="km"
            value={rings.innerRadius}
            toDisplay={toKm}
            fromDisplay={fromKm}
            error={errors.rings}
            onchange={(v) => set({ rings: { ...rings, innerRadius: v } })}
          />
          <NumberField
            label="Outer"
            unit="km"
            value={rings.outerRadius}
            toDisplay={toKm}
            fromDisplay={fromKm}
            onchange={(v) => set({ rings: { ...rings, outerRadius: v } })}
          />
          <label class="field color-field">
            <span class="label">Color</span>
            <input
              type="color"
              value={rings.color}
              oninput={(e) => set({ rings: { ...rings, color: e.currentTarget.value } })}
            />
          </label>
          <label class="field">
            <span class="label">Opacity {rings.opacity.toFixed(2)}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={rings.opacity}
              oninput={(e) => set({ rings: { ...rings, opacity: Number(e.currentTarget.value) } })}
            />
          </label>
        </div>
      {/if}
    </section>

    <section class="feature">
      <span class="section-title">State vector</span>

      {#if live}
        <dl class="readout">
          <dt>Speed</dt>
          <dd>{formatNumber(speed! / 1e3)} km/s</dd>
          <dt>Position</dt>
          <dd>
            {formatNumber(live.position.x / 1e9, 3)}, {formatNumber(live.position.y / 1e9, 3)},
            {formatNumber(live.position.z / 1e9, 3)} Gm
          </dd>
        </dl>
      {:else}
        <p class="hint">Not present at this time.</p>
      {/if}

      {#if live}
        {@const state = live}
        <div class="grid">
          <NumberField
            label="Pos x"
            unit="m"
            value={state.position.x}
            onchange={(v) => set({ position: { ...state.position, x: v } })}
          />
          <NumberField
            label="Pos y"
            unit="m"
            value={state.position.y}
            onchange={(v) => set({ position: { ...state.position, y: v } })}
          />
          <NumberField
            label="Pos z"
            unit="m"
            value={state.position.z}
            onchange={(v) => set({ position: { ...state.position, z: v } })}
          />
          <NumberField
            label="Vel x"
            unit="m/s"
            value={state.velocity.x}
            highlight={guidesVelocity('x')}
            onchange={(v) => set({ velocity: { ...state.velocity, x: v } })}
          />
          <NumberField
            label="Vel y"
            unit="m/s"
            value={state.velocity.y}
            highlight={guidesVelocity('y')}
            onchange={(v) => set({ velocity: { ...state.velocity, y: v } })}
          />
          <NumberField
            label="Vel z"
            unit="m/s"
            value={state.velocity.z}
            highlight={guidesVelocity('z')}
            onchange={(v) => set({ velocity: { ...state.velocity, z: v } })}
          />
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .color-field {
    max-width: 90px;
  }

  .label {
    font-size: 11px;
    color: var(--text-dim);
  }

  .feature {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 9px;
    border-top: 1px solid var(--border);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    cursor: pointer;
  }

  .section-title {
    font-size: 12px;
    color: var(--text);
  }

  .readout {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
    font-size: 11px;
  }

  .readout dt {
    color: var(--text-dim);
  }

  .readout dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.35;
  }

  .error {
    font-size: 10px;
    color: var(--danger);
  }

  input[type='range'] {
    width: 100%;
  }
</style>
