<script lang="ts">
  // Create a body: identity + type defaults, then placement in one of two
  // modes. Orbit mode is the one users want (elements around a parent);
  // manual mode takes raw state vectors for anyone who has them.

  import {
    system,
    addBody,
    makeBody,
    defaultNameFor,
    orbitState,
    previewPeriod,
  } from '../state/system.svelte';
  import { ui } from '../state/ui.svelte';
  import type { Body, BodyType } from '../types';
  import { vec3 } from '../physics/vec3';
  import { unlocks } from '../state/unlocks.svelte';
  import { fade, scale } from 'svelte/transition';
  import { DIALOG_MS, DIALOG_SCALE, duration } from './motion';
  import NumberField from './NumberField.svelte';
  import {
    TYPE_DEFAULTS,
    TYPE_ICONS,
    distanceToSi,
    formatPeriod,
    fromDays,
    fromEarthMasses,
    toDays,
    toEarthMasses,
    toKm,
    fromKm,
    validateBody,
    validateOrbit,
    type DistanceUnit,
    type OrbitInput,
  } from './units';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let type = $state<BodyType>('rocky');
  let name = $state(defaultNameFor('rocky'));
  let color = $state(TYPE_DEFAULTS.rocky.color);
  let mass = $state(TYPE_DEFAULTS.rocky.mass);
  let radius = $state(TYPE_DEFAULTS.rocky.radius);
  let rotationPeriod = $state(TYPE_DEFAULTS.rocky.rotationPeriod);
  let axialTilt = $state(TYPE_DEFAULTS.rocky.axialTilt);

  let mode = $state<'orbit' | 'manual'>('orbit');

  // Orbit placement. Default the parent to the most massive body, which is the
  // star in any system that has one.
  let parentId = $state<string | null>(heaviestBodyId());
  let distanceUnit = $state<DistanceUnit>('au');
  let distanceValue = $state(1);
  let eccentricity = $state(0);
  let inclination = $state(0);
  let phase = $state(0);

  // Manual placement, SI.
  let position = $state(vec3());
  let velocity = $state(vec3());

  let submitted = $state(false);

  function heaviestBodyId(): string | null {
    let best: Body | null = null;
    for (const b of system.bodies) if (!best || b.mass > best.mass) best = b;
    return best?.id ?? null;
  }

  /**
   * Switching type reloads the physical defaults, and the name too if the user
   * hasn't renamed it away from the auto-generated one.
   */
  function onTypeChange(next: BodyType) {
    const wasAutoNamed = name === defaultNameFor(type) || name.trim() === '';
    const defaults = TYPE_DEFAULTS[next];
    type = next;
    color = defaults.color;
    mass = defaults.mass;
    radius = defaults.radius;
    rotationPeriod = defaults.rotationPeriod;
    axialTilt = defaults.axialTilt;
    if (wasAutoNamed) name = defaultNameFor(next);
  }

  const orbit = $derived<OrbitInput>({
    parentId,
    distance: distanceToSi(distanceValue, distanceUnit),
    eccentricity,
    inclination,
    phase,
  });

  const draft = $derived<Partial<Body>>({
    name,
    color,
    type,
    mass,
    radius,
    rotationPeriod,
    axialTilt,
    position,
    velocity,
  });

  const bodyErrors = $derived(validateBody(draft).errors);
  const orbitErrors = $derived(mode === 'orbit' ? validateOrbit(orbit).errors : {});
  const valid = $derived(
    Object.keys(bodyErrors).length === 0 && Object.keys(orbitErrors).length === 0
  );

  const period = $derived(mode === 'orbit' ? previewPeriod(orbit, mass) : null);
  const parentName = $derived(system.byId(parentId)?.name ?? 'none');

  function create() {
    submitted = true;
    if (!valid) return;

    let placement = { position: vec3(position.x, position.y, position.z), velocity: vec3(velocity.x, velocity.y, velocity.z) };

    if (mode === 'orbit') {
      const state = orbitState(orbit, mass);
      if (!state) return; // parent gone — validation already flags it
      placement = state;
    }

    const body = makeBody(type, {
      name: name.trim(),
      color,
      mass,
      radius,
      rotationPeriod,
      axialTilt,
      position: placement.position,
      velocity: placement.velocity,
    });

    addBody(body);
    ui.selectedBodyId = body.id;
    onclose();
  }

  function err(key: string): string | undefined {
    if (!submitted) return undefined;
    return bodyErrors[key] ?? orbitErrors[key];
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
  transition:fade={{ duration: duration(DIALOG_MS) }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Create body"
    transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
  >
    <header>
      <h2>New body</h2>
      <button class="close" onclick={onclose} aria-label="Close">×</button>
    </header>

    <div class="body">
      <section>
        <div class="types">
          {#each unlocks.offeredTypes(type) as t (t)}
            <button
              class="type"
              class:active={type === t}
              onclick={() => onTypeChange(t)}
              title={t}
            >
              <span class="glyph">{TYPE_ICONS[t]}</span>
              <span>{t}</span>
            </button>
          {/each}
        </div>

        <div class="grid">
          <label class="field span2">
            <span class="label">Name</span>
            <input type="text" bind:value={name} />
            {#if err('name')}<span class="error">{err('name')}</span>{/if}
          </label>

          <label class="field color-field">
            <span class="label">Color</span>
            <input type="color" bind:value={color} />
          </label>
        </div>

        <div class="grid">
          <NumberField
            label="Mass"
            unit="M⊕"
            value={mass}
            toDisplay={toEarthMasses}
            fromDisplay={fromEarthMasses}
            error={err('mass')}
            onchange={(v) => (mass = v)}
          />
          <NumberField
            label="Radius"
            unit="km"
            value={radius}
            toDisplay={toKm}
            fromDisplay={fromKm}
            error={err('radius')}
            onchange={(v) => (radius = v)}
          />
          <NumberField
            label="Rotation"
            unit="d"
            value={rotationPeriod}
            toDisplay={toDays}
            fromDisplay={fromDays}
            error={err('rotationPeriod')}
            onchange={(v) => (rotationPeriod = v)}
          />
          <NumberField
            label="Axial tilt"
            unit="°"
            value={axialTilt}
            error={err('axialTilt')}
            onchange={(v) => (axialTilt = v)}
          />
        </div>
      </section>

      <section>
        <div class="modes">
          <button class:active={mode === 'orbit'} onclick={() => (mode = 'orbit')}>Orbit</button>
          <button class:active={mode === 'manual'} onclick={() => (mode = 'manual')}>
            Manual
          </button>
        </div>

        {#if mode === 'orbit'}
          <div class="grid">
            <label class="field span2">
              <span class="label">Orbits</span>
              <select bind:value={parentId}>
                {#each system.bodies as b (b.id)}
                  <option value={b.id}>{b.name}</option>
                {/each}
              </select>
              {#if err('parentId')}<span class="error">{err('parentId')}</span>{/if}
            </label>

            <label class="field unit-field">
              <span class="label">Units</span>
              <select bind:value={distanceUnit}>
                <option value="au">AU</option>
                <option value="km">km</option>
              </select>
            </label>
          </div>

          <div class="grid">
            <NumberField
              label="Distance"
              unit={distanceUnit === 'au' ? 'AU' : 'km'}
              value={distanceValue}
              error={err('distance')}
              onchange={(v) => (distanceValue = v)}
            />
            <NumberField
              label="Eccentricity"
              value={eccentricity}
              min={0}
              max={0.99}
              step="0.01"
              error={err('eccentricity')}
              onchange={(v) => (eccentricity = v)}
            />
            <NumberField
              label="Inclination"
              unit="°"
              value={inclination}
              error={err('inclination')}
              onchange={(v) => (inclination = v)}
            />
            <NumberField
              label="Phase"
              unit="°"
              value={phase}
              error={err('phase')}
              onchange={(v) => (phase = v)}
            />
          </div>

          <p class="preview">
            {#if period !== null}
              Orbital period around {parentName}: <strong>{formatPeriod(period)}</strong>
            {:else}
              Choose a parent and distance to preview the period.
            {/if}
          </p>
        {:else}
          <p class="hint">Barycentric state vector, SI units.</p>
          <div class="grid">
            <NumberField
              label="Position x"
              unit="m"
              value={position.x}
              onchange={(v) => (position = { ...position, x: v })}
            />
            <NumberField
              label="Position y"
              unit="m"
              value={position.y}
              onchange={(v) => (position = { ...position, y: v })}
            />
            <NumberField
              label="Position z"
              unit="m"
              value={position.z}
              onchange={(v) => (position = { ...position, z: v })}
            />
            <NumberField
              label="Velocity x"
              unit="m/s"
              value={velocity.x}
              onchange={(v) => (velocity = { ...velocity, x: v })}
            />
            <NumberField
              label="Velocity y"
              unit="m/s"
              value={velocity.y}
              onchange={(v) => (velocity = { ...velocity, y: v })}
            />
            <NumberField
              label="Velocity z"
              unit="m/s"
              value={velocity.z}
              onchange={(v) => (velocity = { ...velocity, z: v })}
            />
          </div>
        {/if}
      </section>
    </div>

    <footer>
      {#if submitted && !valid}
        <span class="footer-error">Fix the highlighted fields.</span>
      {/if}
      <button onclick={onclose}>Cancel</button>
      <button class="primary" onclick={create}>Create</button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }

  .dialog {
    width: 420px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  header {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    flex: 1;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .close {
    background: none;
    border: none;
    font-size: 17px;
    line-height: 1;
    color: var(--text-dim);
    padding: 2px 6px;
  }

  .body {
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .types {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }

  .type {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    font-size: 10px;
    padding: 5px 2px;
    text-transform: capitalize;
  }

  .glyph {
    font-size: 13px;
  }

  .type.active {
    border-color: var(--accent);
    color: var(--accent);
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

  .span2 {
    grid-column: span 1;
  }

  .color-field,
  .unit-field {
    max-width: 90px;
  }

  .label {
    font-size: 11px;
    color: var(--text-dim);
  }

  .modes {
    display: flex;
    gap: 4px;
  }

  .modes button {
    flex: 1;
    font-size: 12px;
  }

  .modes button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .preview {
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
  }

  .preview strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
  }

  .error {
    font-size: 10px;
    color: var(--danger);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }

  .footer-error {
    flex: 1;
    font-size: 11px;
    color: var(--danger);
  }

  .primary {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
