<script lang="ts">
	// The system shelf: New / presets / named save slots / export / import.
	//
	// Slides in from the left edge and overlaps the left stack rather than
	// pushing it aside — the panels underneath keep their layout, and the shelf
	// is dismissed the moment it's done being used.
	//
	// Mounted by App at the top level, not inside the menu bar: that panel's
	// `backdrop-filter` makes it a containing block for fixed-position
	// descendants, which would trap this shelf inside the 40 px toggle button.
	//
	// Also owns the autosave. It lives here rather than in a module-level effect
	// because it needs to be debounced against the *reactive* roster and clock,
	// and because everything else it touches (slot list refresh) is this
	// component's state anyway.

	import { TreeDeciduous } from "lucide-svelte";
	import { fly } from "svelte/transition";
	import { toast } from "../state/toasts.svelte";
	import { ui } from "../state/ui.svelte";
	import {
		system,
		currentLoadSource,
		currentSystemFile,
		loadSystemIntoUi,
		revertSystem,
		savedTimelineStart,
	} from "../state/system.svelte";
	import { formatSimDate } from "./formatTime";
	import { mission } from "../state/mission.svelte";
	import { MISSIONS } from "../presets/missions";
	import { randomSystem } from "../presets/randomSystem";
	import {
		deleteSlot,
		listSlots,
		loadSlot,
		saveSlot,
		writeAutosave,
		type SaveSlot
	} from "../storage/persistence";
	import { shareUrlFor } from "../storage/shareUrl";

	// Bindable so the owner can drive the open state — the toggle in the menu
	// bar is a separate component, and App holds the flag between them.
	let {
		open = $bindable(false),
		presetsOpen = $bindable(false),
		missionsOpen = $bindable(false),
		aboutOpen = $bindable(false),
		shortcutsOpen = $bindable(false),
		jsonOpen = $bindable(false),
		jsonTab = $bindable("export")
	}: {
		open?: boolean;
		presetsOpen?: boolean;
		missionsOpen?: boolean;
		aboutOpen?: boolean;
		shortcutsOpen?: boolean;
		jsonOpen?: boolean;
		jsonTab?: "export" | "import";
	} = $props();

	let slots = $state<SaveSlot[]>([]);
	let saveName = $state("");
	let savingAs = $state(false);

	// Nonzero after a mid-timeline edit, when every save path below (slots,
	// share link, export) silently makes that instant the new day 0. Surfaced
	// as a note because "I edited Jupiter in year 2 and my save lost the first
	// two years" is invisible until the reload.
	const flattenedAt = $derived(savedTimelineStart());

	/** How long the roster/clock must sit still before autosaving, ms. */
	const AUTOSAVE_DEBOUNCE = 1500;

	// --- autosave ----------------------------------------------------------
	//
	// Only the roster and the name are saved — the clock isn't, so a running
	// playback doesn't touch this at all and the debounce exists purely to
	// collapse bursts of edits (dragging a mass slider) into one write.

	$effect(() => {
		// Read for dependency tracking; the write itself goes through
		// `currentSystemFile` so stale entries stay out of the autosave too.
		const bodies = system.bodies;
		void system.name;

		if (bodies.length === 0) return;

		const handle = setTimeout(() => {
			writeAutosave(currentSystemFile(), Date.now(), currentLoadSource());
		}, AUTOSAVE_DEBOUNCE);

		return () => clearTimeout(handle);
	});

	// --- shelf --------------------------------------------------------------

	// The slot list is read on open rather than kept live: it's `localStorage`,
	// which nothing else in this tab writes while the shelf is up.
	$effect(() => {
		if (open) refreshSlots();
	});

	// Save-as is a transient mode, not a state the shelf should reopen into.
	$effect(() => {
		if (!open) savingAs = false;
	});

	// This component is mounted outside App's chrome block so its autosave keeps
	// running with the controls hidden — which means the shelf itself has to
	// honour the hide, or it stays over a bare scene with its toggle gone.
	// Watched rather than handled at the toggle: the screenshot script sets
	// `chromeHidden` directly (see `ui/capture.ts`), never through the button.
	$effect(() => {
		if (ui.chromeHidden) open = false;
	});

	function refreshSlots() {
		slots = listSlots();
	}

	function openPresets() {
		// Hand the viewport over to the picker: the modal covers the shelf, and
		// the shelf has nothing more to say until a preset comes back.
		open = false;
		presetsOpen = true;
	}

	function onGenerateRandom() {
		// A fresh seed per click; the builder itself is deterministic per seed.
		const { name, bodies } = randomSystem(Math.floor(Math.random() * 2 ** 32));
		loadSystemIntoUi(bodies, name);
		toast("ok", `Generated “${name}”.`);
		open = false;
	}

	function onRevert() {
		const name = system.loaded?.name ?? "";
		revertSystem();
		toast("ok", `Reverted to “${name}”.`);
		open = false;
	}

	function openMissions() {
		open = false;
		missionsOpen = true;
	}

	function openAbout() {
		open = false;
		aboutOpen = true;
	}

	function openShortcuts() {
		open = false;
		shortcutsOpen = true;
	}

	function save(name: string) {
		if (saveSlot(name, currentSystemFile(), Date.now())) {
			system.name = name;
			refreshSlots();
			toast("ok", `Saved “${name}”.`);
			open = false;
		} else {
			toast("error", "Could not save — browser storage is full or unavailable.");
		}
	}

	function onSave() {
		save(system.name);
	}

	function startSaveAs() {
		saveName = system.name;
		savingAs = true;
	}

	function commitSaveAs() {
		const name = saveName.trim();
		if (name) save(name);
	}

	function onLoadSlot(name: string) {
		const file = loadSlot(name);
		if (!file) {
			toast("error", `“${name}” could not be read.`);
			return;
		}
		loadSystemIntoUi(file.bodies, file.name, file.settings);
		open = false;
	}

	function onDeleteSlot(name: string) {
		deleteSlot(name);
		refreshSlots();
		toast("ok", `Deleted “${name}”.`);
	}

	// Both hand off to the JSON dialog — one component, opened on the matching
	// tab, owns the textarea, the copy button and the file paths.
	function openExport() {
		open = false;
		jsonTab = "export";
		jsonOpen = true;
	}

	function openImport() {
		open = false;
		jsonTab = "import";
		jsonOpen = true;
	}

	// One catch for both ways this can fail: no `CompressionStream` (old
	// browser) and a denied clipboard write.
	async function onCopyShareLink() {
		try {
			const link = await shareUrlFor(currentSystemFile());
			await navigator.clipboard.writeText(link);
			toast(
				"ok",
				link.length > 2000
					? `Share link copied — it's ${Math.round(link.length / 1000)}k characters, so chat apps may truncate it.`
					: "Share link copied."
			);
			open = false;
		} catch {
			toast("error", "Could not copy a share link in this browser.");
		}
	}

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	/**
	 * Close on a click anywhere outside the shelf.
	 *
	 * Without this the shelf sits over the left column until it's explicitly
	 * dismissed, which hides the very scene the user just loaded a preset into.
	 * Bound on `pointerdown` rather than `click` so it fires before a canvas drag
	 * starts orbiting the camera behind it.
	 *
	 * No exemption for the menu-bar toggle, unlike a dropdown anchored to its
	 * button: the shelf covers the left edge including that button, so a click
	 * can never reach it while the shelf is up. The header's × and Escape are
	 * the ways out, and any click on the scene behind dismisses it.
	 */
	function onPointerDown(event: PointerEvent) {
		if (!open || !root) return;
		if (!root.contains(event.target as Node)) open = false;
	}

	let root = $state<HTMLElement | null>(null);

	function relativeTime(ms: number): string {
		if (!ms) return "";
		const seconds = Math.max(0, (Date.now() - ms) / 1000);
		if (seconds < 60) return "just now";
		if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
		return `${Math.floor(seconds / 86400)} d ago`;
	}
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={(e) => e.key === "Escape" && (open = false)} />

{#if open}
	<aside
		class="shelf"
		bind:this={root}
		aria-label="System menu"
		transition:fly={{ x: -320, duration: 180 }}
	>
		<header class="shelf-head">
			<!-- Echoes the toggle the shelf slid out of — the button itself is
			     underneath, so this is what confirms which control opened this.
			     Decorative: the heading below already names the panel. -->
			<span class="shelf-mark" aria-hidden="true">
				<TreeDeciduous size={34} strokeWidth={1.4} />
			</span>
			<h2 class="app-title">Newton’s Orchard</h2>
			<button class="close" onclick={() => (open = false)} aria-label="Close">×</button>
		</header>

		<div class="items">
			<button class="item" onclick={openPresets}>Load system…</button>
			<button class="item" onclick={openMissions}>
				<span>Start a mission…</span>
				<span class="item-note">{mission.completedCount} of {MISSIONS.length} completed</span>
			</button>
			<button class="item" onclick={onGenerateRandom}>
				<span>Generate random system</span>
				<span class="item-note">A new star, planets and moons every time</span>
			</button>
			{#if system.loaded}
				<button class="item" onclick={onRevert}>
					<span>Revert system</span>
					<span class="item-note">Reload “{system.loaded.name}” from the start</span>
				</button>
			{/if}

			<div class="sep" role="separator"></div>

			{#if flattenedAt > 0}
				<p class="flatten-note">
					Saving or sharing starts the system at your last edit ({formatSimDate(flattenedAt)}) —
					the timeline before it isn't kept.
				</p>
			{/if}
			<button class="item" onclick={onSave}>Save</button>
			{#if savingAs}
				<div class="save-as-row">
					<input
						type="text"
						bind:value={saveName}
						aria-label="Save name"
						use:focusOnMount
						onkeydown={(e) => {
							if (e.key === "Enter") commitSaveAs();
							if (e.key === "Escape") {
								e.stopPropagation();
								savingAs = false;
							}
						}}
					/>
					<button onclick={commitSaveAs}>Save</button>
				</div>
			{:else}
				<button class="item" onclick={startSaveAs}>Save as…</button>
			{/if}

			{#if slots.length > 0}
				<div class="sep" role="separator"></div>
				<div class="section-label">Saved systems</div>
				{#each slots as slot (slot.name)}
					<div class="slot">
						<button class="item slot-load" onclick={() => onLoadSlot(slot.name)}>
							<span class="slot-name">{slot.name}</span>
							<span class="slot-note">
								{slot.bodyCount} bodies · {relativeTime(slot.savedAt)}
							</span>
						</button>
						<button
							class="delete"
							onclick={() => onDeleteSlot(slot.name)}
							title="Delete this save"
							aria-label="Delete {slot.name}"
						>
							✕
						</button>
					</div>
				{/each}
			{/if}

			<div class="sep" role="separator"></div>

			<button class="item" onclick={onCopyShareLink}>
				<span>Copy share link</span>
				<span class="item-note">The whole system, packed into a URL</span>
			</button>
			<button class="item" onclick={openExport}>Export JSON…</button>
			<button class="item" onclick={openImport}>Import JSON…</button>

			<div class="sep" role="separator"></div>

			<button class="item" onclick={openShortcuts}>Keyboard shortcuts</button>
			<button class="item" onclick={openAbout}>About</button>
		</div>
	</aside>
{/if}

<style>
	/* Flush to the left edge and full height, overlapping the left stack. Fixed
	   rather than absolute so it's measured against the viewport — App mounts it
	   at the top level precisely so no panel's `backdrop-filter` can catch it.
	   Opaque, and a step brighter than `--bg-panel`, so the roster sliding under
	   it doesn't read through. */
	.shelf {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 6;
		width: 288px;
		max-width: 86vw;
		display: flex;
		flex-direction: column;
		background: var(--bg-shelf);
		box-shadow: 4px 0 28px rgba(0, 0, 0, 0.5);

		/* The global `--border` and `--bg-raised` are tuned against `--bg-panel`;
		   on this brighter background both fall to a couple of levels of contrast
		   and read as nothing. Rebound for the whole subtree rather than
		   overridden per rule, so the separators, the hover fill and any control
		   that inherits them all step up together.

		   These apply to this element's own `var()` uses too — a custom property
		   set on an element wins for that element regardless of source order — so
		   the outer edge below uses `--border-outer` rather than reading a
		   `--border` that no longer means what it does elsewhere. */
		--border: #333949;
		--bg-raised: #262b38;
		--border-outer: #232733;

		/* Divides the shelf from the scene, not one shelf row from the next, so
		   it stays at the darker global weight. */
		border-right: 1px solid var(--border-outer);
	}

	/* Icon over title, both left-aligned. The close button is taken out of the
	   flow and pinned to the top-right corner rather than sharing the title's
	   row — in a column stack it would otherwise sit level with the icon and
	   read as a second mark beside it. */
	.shelf-head {
		position: relative;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		padding: 16px 12px 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	/* The orchard's tree, in leaf. Faded back because it's a restatement of the
	   button that opened the shelf: it should register without competing with
	   the title under it. */
	.shelf-mark {
		display: flex;
		/* Its own foliage green, deliberately not `--ok` — that token means
		   "mission complete" throughout the app, and a mark that borrows it
		   reads as a status the shelf isn't reporting. */
		color: #6bbf7c;
		opacity: 0.55;
	}

	.app-title {
		max-width: 100%;
		min-width: 0;
		margin: 0;
		font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
		font-size: 19px;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--text);
	}

	.close {
		position: absolute;
		top: 12px;
		right: 10px;
		flex: none;
		padding: 0 7px;
		background: transparent;
		border-color: transparent;
		color: var(--text-dim);
		font-size: 18px;
		line-height: 1.2;
	}

	.close:hover {
		color: var(--text);
		border-color: var(--border);
	}

	/* The list scrolls, not the shelf: the header stays put however many save
	   slots pile up. */
	.items {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 10px 14px;
	}

	.sep {
		height: 1px;
		margin: 7px 2px;
		background: var(--border);
		flex: none;
	}

	.section-label {
		padding: 3px 9px 4px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-dim);
	}

	/* Sits above Save but speaks for every write path in the shelf (slots,
	   share link, export). Quiet — it's a fact about the format, not an error. */
	.flatten-note {
		margin: 0 0 2px;
		padding: 4px 9px;
		flex: none;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-dim);
	}

	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		width: 100%;
		flex: none;
		padding: 6px 9px;
		font-size: 13px;
		text-align: left;
		background: transparent;
		border: 0;
		border-radius: 5px;
	}

	.item:hover {
		background: var(--bg-raised);
	}

	.item-note {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--text-dim);
		line-height: 1.3;
	}

	.slot {
		display: flex;
		align-items: stretch;
		gap: 2px;
		flex: none;
	}

	.slot-load {
		flex: 1;
		min-width: 0;
	}

	.slot-name {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.slot-note {
		font-size: 11px;
		color: var(--text-dim);
		line-height: 1.3;
	}

	.delete {
		flex: none;
		padding: 0 7px;
		background: transparent;
		border-color: transparent;
		color: var(--text-dim);
		font-size: 11px;
		opacity: 0;
	}

	.slot:hover .delete,
	.delete:focus-visible {
		opacity: 1;
	}

	.delete:hover {
		color: var(--danger, #ff8080);
		border-color: var(--border);
	}

	.save-as-row {
		display: flex;
		gap: 5px;
		padding: 2px;
		flex: none;
	}

	.save-as-row input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 13px;
		color: var(--text);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 3px 6px;
	}

	.save-as-row button {
		font-size: 12px;
		padding: 3px 9px;
	}
</style>
