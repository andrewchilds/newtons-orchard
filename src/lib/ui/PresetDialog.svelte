<script lang="ts">
	// The preset picker: a grid of systems, each with a generated thumbnail —
	// plus a second tab for the user-submitted gallery.
	//
	// Thumbnails are produced by `npm run preset-screenshots`, which drives this
	// app in a real browser and photographs each preset (see
	// `scripts/preset-screenshots.py`). They're keyed by preset id, so a preset
	// that has never been photographed simply falls back to a placeholder rather
	// than showing a broken image.
	//
	// Gallery cards carry only eager metadata (`presets/gallery.ts`); the system
	// itself lives at `public/gallery/<id>.json` and is fetched when picked, then
	// validated like any untrusted import. A failed fetch or a malformed file is
	// an error toast — the grid stays up and nothing else breaks.

	import { PRESETS, type Preset } from "../presets/examples";
	import { GALLERY, GALLERY_FORM_URL, type GalleryEntry } from "../presets/gallery";
	import { mission } from "../state/mission.svelte";
	import { toast } from "../state/toasts.svelte";
	import { ImportError, parseSystemFile } from "../storage/persistence";
	import { CONTACT_EMAIL } from "./contact";
	import type { SystemFile } from "../types";
	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";

	interface Props {
		onpick: (preset: Preset) => void;
		/** A gallery entry's JSON, fetched and validated, ready to load. */
		onpickgallery: (entry: GalleryEntry, file: SystemFile) => void;
		/** "Submit yours" — hands off to the System JSON dialog's Export tab. */
		onsubmit: () => void;
		onclose: () => void;
	}

	let { onpick, onpickgallery, onsubmit, onclose }: Props = $props();

	const TABS = [
		{ id: "builtin", label: "Built-in" },
		{ id: "gallery", label: "From users" }
	] as const;

	let tab = $state<"builtin" | "gallery">("builtin");

	// Cards whose thumbnail 404s (never captured, or the file was cleaned).
	// Preset and gallery ids share the map; the URL prefix keeps them distinct.
	let missing = $state<Record<string, boolean>>({});

	function thumbnailUrl(id: string): string {
		return `${import.meta.env.BASE_URL}presets/${id}.jpg`;
	}

	function galleryThumbnailUrl(id: string): string {
		return `${import.meta.env.BASE_URL}gallery/${id}.jpg`;
	}

	function attribution(entry: GalleryEntry): string | null {
		if (entry.by && entry.from) return `${entry.by}, ${entry.from}`;
		return entry.by ?? entry.from ?? null;
	}

	// The id mid-fetch, so a slow network can't double-load or fire two picks.
	let loadingId = $state<string | null>(null);

	async function pickGallery(entry: GalleryEntry) {
		if (loadingId !== null) return;
		loadingId = entry.id;
		try {
			const response = await fetch(`${import.meta.env.BASE_URL}gallery/${entry.id}.json`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const file = parseSystemFile(await response.text());
			onpickgallery(entry, file);
		} catch (err) {
			// Malformed checked-in JSON and a dead network end the same way: a toast,
			// with the dialog still up.
			toast(
				"error",
				err instanceof ImportError
					? `Could not load “${entry.name}”: ${err.message}`
					: `Could not load “${entry.name}” — check your connection and try again.`
			);
		} finally {
			loadingId = null;
		}
	}

	function lockedBy(preset: Preset): number {
		if (preset.unlockAfterMissions === undefined) return 0;
		return Math.max(0, preset.unlockAfterMissions - mission.completedCount);
	}

	// Locked cards sort last, so the grid opens on what's actually playable. The
	// sort is stable, so unlocked presets keep their authored order.
	const cards = $derived(
		PRESETS.map((preset) => ({ preset, remaining: lockedBy(preset) })).sort(
			(a, b) => Number(a.remaining > 0) - Number(b.remaining > 0)
		)
	);
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
		aria-label="Load a system"
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<h2>Load a system</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<div class="tabs" role="tablist" aria-label="Built-in systems or the user gallery">
			{#each TABS as t (t.id)}
				<button
					class="tab"
					class:active={tab === t.id}
					role="tab"
					id="presets-tab-{t.id}"
					aria-selected={tab === t.id}
					aria-controls="presets-panel-{t.id}"
					onclick={() => (tab = t.id)}>{t.label}</button
				>
			{/each}
		</div>

		{#if tab === "builtin"}
			<div class="grid" role="tabpanel" id="presets-panel-builtin" aria-labelledby="presets-tab-builtin">
				{#each cards as { preset, remaining } (preset.id)}
					<button class="card" class:locked={remaining > 0} disabled={remaining > 0} onclick={() => onpick(preset)}>
						<span class="thumb">
							{#if missing[preset.id]}
								<span class="placeholder" aria-hidden="true">◍</span>
							{:else}
								<img
									src={thumbnailUrl(preset.id)}
									alt=""
									loading="lazy"
									onerror={() => (missing = { ...missing, [preset.id]: true })}
								/>
							{/if}
							{#if remaining > 0}
								<span class="lock" aria-hidden="true">🔒</span>
							{/if}
						</span>
						<span class="caption">
							<span class="name">{preset.name}</span>
							{#if remaining > 0}
								<span class="note">
									Locked — complete {remaining} more {remaining === 1 ? "mission" : "missions"} to unlock.
								</span>
							{:else}
								<span class="note">{preset.description}</span>
							{/if}
						</span>
					</button>
				{/each}
			</div>
		{:else}
			<div class="grid" role="tabpanel" id="presets-panel-gallery" aria-labelledby="presets-tab-gallery">
				{#each GALLERY as entry (entry.id)}
					<button class="card" disabled={loadingId !== null} onclick={() => pickGallery(entry)}>
						<span class="thumb">
							{#if missing[entry.id]}
								<span class="placeholder" aria-hidden="true">◍</span>
							{:else}
								<img
									src={galleryThumbnailUrl(entry.id)}
									alt=""
									loading="lazy"
									onerror={() => (missing = { ...missing, [entry.id]: true })}
								/>
							{/if}
						</span>
						<span class="caption">
							<span class="name">{loadingId === entry.id ? "Loading…" : entry.name}</span>
							{#if attribution(entry)}
								<span class="credit">Shared by {attribution(entry)}</span>
							{/if}
							<span class="note">{entry.blurb}</span>
						</span>
					</button>
				{:else}
					<p class="empty">Nothing here yet — the first submission could be yours.</p>
				{/each}
			</div>
		{/if}

		<footer>
			{#if tab === "builtin"}
				<p class="hint">Loading a system replaces the current one and resets the clock.</p>
			{:else}
				<p class="hint">
					Built something worth sharing?
					<button class="submit-link" onclick={onsubmit}>Export your system’s JSON</button>
					and send it through
					<a href={GALLERY_FORM_URL} target="_blank" rel="noreferrer">the submission form</a>, or
					<a href="mailto:{CONTACT_EMAIL}">email it to us</a>.
				</p>
			{/if}
		</footer>
	</div>
</div>

<style>
	/* Same viewport handling as the mission picker — see MissionDialog.svelte
     for why the height is left to `inset` and why `min-height: 0` matters. */
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10;
		padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
		box-sizing: border-box;
	}

	.dialog {
		width: 920px;
		max-width: 100%;
		max-height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg-panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
	}

	header {
		display: flex;
		align-items: center;
		flex: none;
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

	.tabs {
		display: flex;
		gap: 4px;
		flex: none;
		padding: 8px 10px 0;
		border-bottom: 1px solid var(--border);
	}

	/* Folder tabs, same construction as the System JSON dialog: rounded-top
     cards on the tablist's border, the active one dropping that border along
     its own width so it reads as continuous with the panel below. */
	.tab {
		position: relative;
		bottom: -1px;
		padding: 6px 12px 7px;
		font-size: 13px;
		color: var(--text-dim);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-bottom-color: var(--border);
		border-radius: 7px 7px 0 0;
	}

	.tab:hover:not(.active) {
		color: var(--text);
	}

	.tab.active {
		color: var(--text);
		background: var(--bg-panel);
		border-bottom-color: var(--bg-panel);
	}

	.grid {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		padding: 12px;
		display: grid;
		/* Auto-fit rather than a fixed column count: the dialog is width-capped by
       the viewport, and this degrades to two columns and then one. */
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		/* Rows size to their content and overflow into the scroll, rather than
       being divided up to fit the container's height — without this the
       fourteen cards compress to ~50 px each and the thumbnails flatten into
       strips with the captions squeezed out entirely. */
		grid-auto-rows: max-content;
		gap: 10px;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0;
		overflow: hidden;
		text-align: left;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.card:hover,
	.card:focus-visible {
		border-color: var(--accent);
	}

	/* Locked cards stay visible — the point is to show what's coming — but read
     as unavailable and don't take the accent border on hover. */
	.card.locked {
		cursor: default;
	}

	.card.locked:hover,
	.card.locked:focus-visible {
		border-color: var(--border);
	}

	.card.locked .thumb img {
		filter: grayscale(1) brightness(0.45);
	}

	.card.locked .name {
		color: var(--text-dim);
	}

	.lock {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 22px;
		/* The glyph carries its own colour; dim it to sit on the greyed thumb. */
		opacity: 0.75;
	}

	/* Fixed 16:10 box so a missing thumbnail doesn't collapse the card and the
     grid rows stay aligned. `flex: none` is what keeps the aspect ratio from
     being overridden: the card is a flex column, so without it the thumb
     shrinks to share the card's height with the caption and collapses to
     zero — leaving a row of bare names with no art. */
	.thumb {
		display: block;
		position: relative;
		flex: none;
		aspect-ratio: 16 / 10;
		background: #05070d;
		overflow: hidden;
	}

	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.placeholder {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 24px;
		color: var(--text-dim);
		opacity: 0.4;
	}

	.caption {
		display: flex;
		flex-direction: column;
		/* Same reason as `.thumb` above — the description is the first thing to
       vanish if this is allowed to compress. */
		flex: none;
		gap: 2px;
		padding: 7px 9px 9px;
	}

	.name {
		font-size: 15px;
		font-weight: 600;
	}

	.note {
		font-size: 14px;
		line-height: 1.35;
		color: var(--text-dim);
	}

	.credit {
		font-size: 14px;
		font-style: italic;
		color: var(--text-dim);
		opacity: 0.8;
	}

	.empty {
		grid-column: 1 / -1;
		margin: 24px 0;
		text-align: center;
		font-size: 13px;
		color: var(--text-dim);
	}

	.submit-link,
	.hint a {
		display: inline;
		padding: 0;
		background: none;
		border: none;
		font: inherit;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}

	footer {
		flex: none;
		padding: 9px 12px;
		border-top: 1px solid var(--border);
	}

	.hint {
		margin: 0;
		font-size: 11px;
		color: var(--text-dim);
	}

	/* --- narrow viewports -------------------------------------------------
     One column, full width. The thumbnail is what identifies a system, and
     splitting 390 px two ways makes it too small to read — a single large
     card per row gives the art the room it needs. The desktop caption sizes
     (13 px) are a mouse-distance density; they go up to match. */
	@media (max-width: 560px) {
		.backdrop {
			padding: 0;
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}

		.dialog {
			border-radius: 0;
			border-left: none;
			border-right: none;
		}

		.grid {
			grid-template-columns: 1fr;
			gap: 12px;
			padding: 12px;
		}

		h2 {
			font-size: 17px;
		}

		.caption {
			gap: 3px;
			padding: 10px 12px 12px;
		}

		.name {
			font-size: 17px;
			font-weight: 600;
		}

		.note {
			font-size: 16px;
			line-height: 1.4;
		}

		.hint {
			font-size: 13px;
		}

		footer {
			padding: 10px 12px;
		}
	}
</style>
