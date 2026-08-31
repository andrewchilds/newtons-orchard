<script lang="ts">
	import { missionGuide } from "../state/missionGuide.svelte";
	import { time } from "../state/time.svelte";
	import { formatSimDate } from "./formatTime";
	import { formatRate, shuttleRate } from "./shuttle";
	import { WARP_STEPS, WARP_TICKS, sliderToWarp, warpToSlider } from "./warp";
	import Shuttle from "./Shuttle.svelte";
	import TransportControls from "./TransportControls.svelte";
	import type { Simulation } from "../sim/simulation";

	let { sim }: { sim: Simulation } = $props();

	let displacement = $state(0);
	let held = $state(false);

	// The shuttle owns the clock for as long as it's held — inside the deadzone
	// included, where it holds time still. Only releasing it hands control back
	// to play/pause and the warp preset.
	$effect(() => {
		time.shuttleRate = shuttleRate(displacement);
		time.shuttleHeld = held;
	});

	const scrubbing = $derived(time.shuttleHeld);

	const warpSlider = $derived(warpToSlider(time.timeWarp));
	const warpLabel = $derived(formatRate(time.timeWarp));

	function onWarp(event: Event & { currentTarget: HTMLInputElement }) {
		time.timeWarp = sliderToWarp(Number(event.currentTarget.value));
	}
</script>

<div class="time-bar">
	<TransportControls {sim} disabled={scrubbing} />

	<!-- Log-scaled: the range spans 1 min/s to 1 yr/s, so a linear track would
       spend 99% of its travel below a day per second. Snaps to the presets
       marked by the ticks. -->
	<div class="warp" class:disabled={scrubbing}>
		<div class="warp-track">
			<input
				type="range"
				min="0"
				max={WARP_STEPS}
				value={warpSlider}
				oninput={onWarp}
				disabled={scrubbing}
				aria-label="Time warp"
				aria-valuetext={warpLabel}
				title={scrubbing ? "Shuttle overrides the warp rate" : "Time warp"}
			/>
			<!-- Drawn rather than a <datalist>: Chrome renders datalist ticks only
           for some control styles, and these mark where the snap grabs. -->
			<div class="warp-ticks" aria-hidden="true">
				{#each WARP_TICKS as tick (tick.value)}
					<span class="warp-tick" style="left: {tick.percent}%" title={tick.label}></span>
				{/each}
			</div>
		</div>
		<span class="warp-value">{warpLabel}</span>
	</div>

	<div class="readout">
		<span class="date" class:guide-glow={missionGuide.target?.kind === "date"}>
			{formatSimDate(time.simTime)}
		</span>
	</div>

	<Shuttle bind:displacement bind:held />

	<span class="status" class:visible={time.computing}>computing…</span>
</div>

<style>
	.time-bar {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-width: 0;
	}

	.warp {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		flex: none;
		width: 104px;
	}

	.warp-track {
		position: relative;
		width: 100%;
		display: flex;
		align-items: center;
	}

	.warp input[type="range"] {
		width: 100%;
		margin: 0;
		accent-color: var(--accent);
		cursor: ew-resize;
	}

	/* Ticks sit *above* the input — the range control paints its own opaque
     track, so anything behind it is invisible. They're click-through, and the
     thumb still reads clearly since they stop short of its full height. */
	.warp-ticks {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 1;
	}

	.warp-tick {
		position: absolute;
		top: 50%;
		width: 1px;
		height: 9px;
		margin-left: -0.5px;
		transform: translateY(-50%);
		background: var(--text);
		opacity: 0.45;
	}

	.warp.disabled {
		opacity: 0.4;
	}

	.warp.disabled input[type="range"] {
		cursor: default;
	}

	.warp-value {
		font-size: 11px;
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
		white-space: nowrap;
	}

	/* Floor is sized to the longest date the counters realistically reach, so the
	   row doesn't shift as the day rolls over. */
	.readout {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		min-width: 150px;
		font-variant-numeric: tabular-nums;
	}

	.date {
		font-size: 15px;
	}

	/* Lifted out of the flow so the shuttle gets this space: the label is only
     up while the sim is catching up, and a permanent 74px column for it cost
     more than floating it above the panel does. */
	.status {
		position: absolute;
		right: 0;
		bottom: calc(100% + 10px);
		font-size: 11px;
		color: var(--text-dim);
		visibility: hidden;
		pointer-events: none;
	}

	.status.visible {
		visibility: visible;
	}

	/* Portrait phones: the row (transport + warp slider + date + shuttle) is
     wider than the viewport, so it wraps into two. Transport and warp share the
     first line, the date and shuttle take the second. */
	@media (max-width: 560px) {
		.time-bar {
			flex-wrap: wrap;
			gap: 8px 10px;
		}

		/* Was a 150 px floor holding the row wide; on its own line it only needs
       to not collapse. */
		.readout {
			min-width: 0;
			flex: 1;
		}

		/* The shuttle is the widest child and the one that most wants room, so it
       claims a full line of its own. */
		.time-bar :global(.shuttle) {
			flex-basis: 100%;
		}

		/* Pinned to the panel's top-right corner would now overlap the wrapped
       second row; inline it instead. */
		.status {
			position: absolute;
			order: 99;
		}
	}
</style>
