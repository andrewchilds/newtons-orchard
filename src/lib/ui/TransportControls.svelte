<script lang="ts">
	// Rewind and play/pause. Shared by the desktop time panel and the compact
	// chrome's always-visible bar, where play/pause sits outside the sheets —
	// stopping the clock is the one thing you reach for constantly, and it can't
	// cost a tap to reach.
	//
	// `rewindable` drops the rewind button for hosts that only want the toggle.

	import { missionGuide } from "../state/missionGuide.svelte";
	import { time, rewind } from "../state/time.svelte";
	import { Pause, Play, SkipBack } from "lucide-svelte";
	import type { Simulation } from "../sim/simulation";

	let {
		sim,
		rewindable = true,
		disabled = false
	}: { sim: Simulation; rewindable?: boolean; disabled?: boolean } = $props();
</script>

<div class="controls">
	{#if rewindable}
		<button class="icon" onclick={() => rewind(sim)} title="Rewind to start" aria-label="Rewind to start">
			<SkipBack size={15} strokeWidth={2} fill="currentColor" />
		</button>
	{/if}
	<button
		class="icon play"
		class:guide-glow={missionGuide.target?.kind === "play"}
		onclick={() => (time.playing = !time.playing)}
		{disabled}
		title={time.playing ? "Pause (Space)" : "Play (Space)"}
		aria-label={time.playing ? "Pause" : "Play"}
	>
		<!-- Filled rather than outline: at 17px a hollow triangle reads as a
         bookmark, and these are transport controls people scan by shape. -->
		{#if time.playing}
			<Pause size={17} strokeWidth={2} fill="currentColor" />
		{:else}
			<Play size={17} strokeWidth={2} fill="currentColor" />
		{/if}
	</button>
</div>

<style>
	.controls {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* Flex-centered rather than text-centered: the glyphs are inline SVGs now, so
     line-height and text-align have nothing to act on. */
	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 30px;
		padding: 0;
	}

	/* Play is the control you reach for most, so it gets a bigger target than
     the rewind beside it. */
	.play {
		width: 44px;
		height: 38px;
		color: var(--accent);
	}

	button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	button:disabled:hover {
		border-color: var(--border);
	}
</style>
