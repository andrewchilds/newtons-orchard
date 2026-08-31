<script lang="ts">
  // A labeled numeric input that speaks a display unit while the caller holds
  // SI. Conversion happens on the way in and out, so no caller ever stores a
  // display-unit number.
  //
  // The input's text is kept as local state rather than being re-derived from
  // `value` on every keystroke: round-tripping through the conversion would
  // fight the user mid-typing ("1.0" collapsing to "1", a half-typed "1e" being
  // rejected). It resyncs only when the SI value changes from outside.
  //
  // The input is type="text", not type="number": the field also evaluates
  // arithmetic ("333030*2", or "/2" applied to the current value) on Enter or
  // blur, and a number input refuses to even hold those characters. Plain
  // numbers still commit per keystroke; expressions commit only when complete.

  import { dragValue, DRAG_STEP_PX, DRAG_THRESHOLD, type DragModifiers } from './dragScrub';
  import { evaluateExpression, looksLikeExpression } from './expression';
  import { revealWhenGuided } from './guideReveal';
  import { significant } from './units';

  interface Props {
    label: string;
    /** SI value */
    value: number;
    /** SI → display */
    toDisplay?: (si: number) => number;
    /** display → SI */
    fromDisplay?: (display: number) => number;
    unit?: string;
    step?: string;
    min?: number;
    max?: number;
    error?: string;
    disabled?: boolean;
    /** The mission guide is pointing at this field — draws the pulsing ring. */
    highlight?: boolean;
    onchange: (si: number) => void;
  }

  let {
    label,
    value,
    toDisplay = (v: number) => v,
    fromDisplay = (v: number) => v,
    unit = '',
    step = 'any',
    min,
    max,
    error,
    disabled = false,
    highlight = false,
    onchange,
  }: Props = $props();

  // Unique per instance, so the label points at *this* field's input now that
  // the two are siblings rather than nested.
  const inputId = $props.id();

  const displayValue = $derived(significant(toDisplay(value)));

  // Last value we pushed out, so an echo of our own edit doesn't reset the text.
  let text = $state('');
  let lastSeen = $state<number | null>(null);

  $effect(() => {
    if (displayValue !== lastSeen) {
      lastSeen = displayValue;
      text = String(displayValue);
    }
  });

  function onInput(event: Event & { currentTarget: HTMLInputElement }) {
    text = event.currentTarget.value;
    // Expressions never commit mid-typing — "333030*" must not land as NaN.
    // Number() rejects them all, so the early return covers both cases.
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) return;
    lastSeen = significant(parsed);
    onchange(fromDisplay(parsed));
  }

  /**
   * Enter/blur: the moment arithmetic resolves. "333030*2" evaluates and the
   * field rewrites itself with the result; "/2" halves what's already there.
   * Text that is neither math nor a number (a half-typed expression left
   * behind, "abc") snaps back to the last good value rather than lingering.
   */
  function commitText() {
    if (looksLikeExpression(text)) {
      const result = evaluateExpression(text, displayValue);
      if (result !== null) {
        const next = significant(clamp(result));
        text = String(next);
        lastSeen = next;
        onchange(fromDisplay(next));
        return;
      }
    }
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      text = String(displayValue);
      lastSeen = displayValue;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') commitText();
  }

  // --- drag to scrub -------------------------------------------------------
  // The value math lives in dragScrub.ts; this half owns the pointer.

  /**
   * The caller's `step` is a string for the native input ('any' or '0.01').
   * A real number means the field has a meaningful absolute step and should
   * drag linearly; 'any' leaves it undefined so the drag scales proportionally.
   */
  const dragStep = $derived.by(() => {
    const parsed = Number(step);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  });

  let dragging = $state(false);
  // Nulls mean "no drag in flight" — checked in move/up so a stray event that
  // arrives after release (or without a matching down) can't move the value.
  let dragStart: number | null = null;
  let dragOrigin: number | null = null;

  function clamp(v: number): number {
    if (min !== undefined && v < min) return min;
    if (max !== undefined && v > max) return max;
    return v;
  }

  function onHandleDown(event: PointerEvent) {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); // don't steal focus from the input mid-edit
    dragging = true;
    dragOrigin = event.clientX;
    // Drag from the field's own text, not the incoming SI value: mid-edit the
    // two can disagree, and the handle should continue from what's on screen.
    const typed = Number(text);
    dragStart = Number.isFinite(typed) ? typed : displayValue;
    // Capture so the drag keeps tracking once the pointer leaves the button —
    // these handles are 22px wide and any real drag exits them immediately.
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onHandleMove(event: PointerEvent) {
    if (!dragging || dragStart === null || dragOrigin === null) return;
    const modifiers: DragModifiers = { shift: event.shiftKey, alt: event.altKey };
    const next = significant(
      clamp(dragValue(dragStart, event.clientX - dragOrigin, modifiers, dragStep)),
    );
    if (next === lastSeen) return;
    text = String(next);
    lastSeen = next;
    onchange(fromDisplay(next));
  }

  function endDrag(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    dragStart = null;
    dragOrigin = null;
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }

  /**
   * Keyboard equivalent, so the handle isn't mouse-only: arrows step it by the
   * same rule as a one-notch drag, with the same modifier scaling.
   */
  function onHandleKey(event: KeyboardEvent) {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction === 0 || disabled) return;
    event.preventDefault();
    const from = Number.isFinite(Number(text)) ? Number(text) : displayValue;
    const modifiers: DragModifiers = { shift: event.shiftKey, alt: event.altKey };
    const next = significant(
      clamp(dragValue(from, direction * (DRAG_STEP_PX + DRAG_THRESHOLD), modifiers, dragStep)),
    );
    text = String(next);
    lastSeen = next;
    onchange(fromDisplay(next));
  }
</script>

<div class="field" class:invalid={!!error}>
  <!-- The label wraps only the input: the drag handle is a separate control
       with its own label, and nesting it here would make clicking it focus
       the input instead. -->
  <label class="label" for={inputId}>
    {label}
    {#if unit}<span class="unit">{unit}</span>{/if}
  </label>
  <div class="row">
    <!-- type="text" so arithmetic can be typed; autocapitalize off so a
         mobile keyboard doesn't turn "x 2" into "X 2" (harmless here, but
         jarring). step/min/max stay props only — they drive the scrub handle
         and clamp, not native validation. -->
    <input
      id={inputId}
      type="text"
      inputmode="text"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      class:guide-glow={highlight}
      use:revealWhenGuided={highlight}
      value={text}
      {disabled}
      oninput={onInput}
      onkeydown={onKeydown}
      onblur={commitText}
      aria-invalid={!!error}
    />
    <button
      type="button"
      class="scrub"
      class:dragging
      {disabled}
      aria-label="Drag to change {label}"
      title="Drag left or right to change. Shift for coarse, Alt for fine."
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      onkeydown={onHandleKey}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5 13.5 8l-3 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
  {#if error}<span class="error">{error}</span>{/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .label {
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    gap: 4px;
    align-items: baseline;
  }

  .unit {
    opacity: 0.7;
  }

  .row {
    display: flex;
    align-items: stretch;
    gap: 4px;
    min-width: 0;
  }

  .row input {
    flex: 1;
    min-width: 0;
  }

  .scrub {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    padding: 0;
    border-radius: 5px;
    color: var(--text-dim);
    cursor: ew-resize;
    /* A drag that leaves the button must not select surrounding text or get
       hijacked by the browser's own scroll/pan gestures. */
    user-select: none;
    touch-action: none;
  }

  .scrub svg {
    width: 13px;
    height: 13px;
    display: block;
  }

  .scrub:hover:not(:disabled),
  .scrub:focus-visible {
    color: var(--text);
    border-color: var(--accent);
  }

  .scrub:focus-visible {
    outline: none;
  }

  .scrub.dragging {
    color: var(--accent);
    border-color: var(--accent);
  }

  .scrub:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .invalid input {
    border-color: var(--danger);
  }

  .error {
    font-size: 10px;
    color: var(--danger);
  }
</style>
