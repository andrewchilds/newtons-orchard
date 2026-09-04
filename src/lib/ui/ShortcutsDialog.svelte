<script lang="ts">
	import { Keyboard } from "lucide-svelte";
	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";
	import { IS_MAC } from "../state/history.svelte";

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	// Platform glyphs, matching what the keycaps themselves say: a Mac user
	// reads "Alt" and looks for a key that isn't there.
	const SHIFT = IS_MAC ? "⇧" : "Shift";
	const ALT = IS_MAC ? "⌥" : "Alt";
	const CMD = IS_MAC ? "⌘" : "Ctrl";

	interface Shortcut {
		// Each inner array is one chord, rendered as keycaps joined by "+"; the
		// outer list holds alternatives, joined by "or".
		keys: string[][];
		does: string;
	}

	interface Group {
		title: string;
		shortcuts: Shortcut[];
	}

	const GROUPS: Group[] = [
		{
			title: "Fly the camera",
			shortcuts: [
				{ keys: [["↑"], ["↓"]], does: "Fly forward and back" },
				{ keys: [["←"], ["→"]], does: "Fly left and right" },
				{ keys: [[ALT, "↑"], [ALT, "↓"]], does: "Climb and descend" },
				{ keys: [[SHIFT, "arrows"]], does: "Orbit slowly around the view center" },
				{ keys: [["+"], ["−"]], does: "Zoom in and out" }
			]
		},
		{
			title: "Mouse and trackpad",
			shortcuts: [
				{ keys: [["Drag"]], does: "Orbit around the view center" },
				{ keys: [[SHIFT, "Drag"], ["Right drag"]], does: "Pan" },
				{ keys: [["Scroll"]], does: "Zoom" }
			]
		},
		{
			title: "Edit",
			shortcuts: [
				{ keys: [[CMD, "Z"]], does: "Undo the last body edit" },
				{ keys: IS_MAC ? [[CMD, SHIFT, "Z"]] : [[CMD, SHIFT, "Z"], [CMD, "Y"]], does: "Redo" },
				{ keys: [["Esc"]], does: "Cancel a drag in progress, or an armed placement" }
			]
		},
		{
			title: "Time",
			shortcuts: [
				{ keys: [["←"], ["→"]], does: "Scrub backward and forward, with the shuttle focused" },
				{ keys: [["Home"], ["Esc"]], does: "Let the shuttle settle back to center" }
			]
		},
		{
			title: "Everywhere",
			shortcuts: [
				{ keys: [["Esc"]], does: "Close the open menu or dialog, or bring hidden controls back" }
			]
		}
	];
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

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
		aria-label="Keyboard shortcuts"
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<span class="mark" aria-hidden="true">
				<Keyboard size={22} strokeWidth={1.5} />
			</span>
			<h2>Keyboard shortcuts</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<!-- One grid for every group, not one per group: separate grids would
		     each size the key column to their own widest chord, and the
		     descriptions would jog left and right down the page. -->
		<div class="body">
			<div class="table">
				{#each GROUPS as group (group.title)}
					<h3>{group.title}</h3>
					{#each group.shortcuts as shortcut (shortcut.does)}
						<div class="keys">
							{#each shortcut.keys as chord, i (i)}
								{#if i > 0}<span class="or">or</span>{/if}
								<span class="chord">
									{#each chord as key, j (j)}
										{#if j > 0}<span class="plus">+</span>{/if}
										<kbd>{key}</kbd>
									{/each}
								</span>
							{/each}
						</div>
						<div class="does">{shortcut.does}</div>
					{/each}
				{/each}
			</div>
		</div>
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
		width: 480px;
		max-width: calc(100vw - 32px);
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
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}

	.mark {
		display: flex;
		color: var(--text-dim);
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 16px;
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
		padding: 6px 14px 14px;
		font-size: 13px;
		line-height: 1.4;
	}

	h3 {
		grid-column: 1 / -1;
		margin: 14px 0 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-dim);
	}

	.table {
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: 14px;
		row-gap: 6px;
		margin: 0;
		align-items: baseline;
	}

	.keys {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}

	.chord {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.plus,
	.or {
		font-size: 11px;
		color: var(--text-dim);
	}

	.or {
		margin: 0 2px;
	}

	kbd {
		display: inline-block;
		min-width: 18px;
		padding: 1px 6px;
		font-family: inherit;
		font-size: 12px;
		line-height: 1.4;
		text-align: center;
		color: var(--text);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: 4px;
	}
</style>
