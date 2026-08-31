<script lang="ts">
	// Export / import as copy-paste text, not files alone. Managed school
	// machines often can't download or open files, and sharing a system — or
	// submitting one to the gallery — is "copy the JSON, paste it somewhere".
	// The file download and picker stay on as the secondary path.

	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";
	import { toast } from "../state/toasts.svelte";
	import { currentSystemFile, loadSystemIntoUi, savedTimelineStart } from "../state/system.svelte";
	import { formatSimDate } from "./formatTime";
	import {
		ImportError,
		downloadSystemFile,
		parseSystemFile,
		serializeSystemFile
	} from "../storage/persistence";

	interface Props {
		/** which tab the dialog opens on — the shelf has an item for each */
		tab?: "export" | "import";
		onclose: () => void;
	}

	let { tab: initialTab = "export", onclose }: Props = $props();

	const TABS = [
		{ id: "export", label: "Export" },
		{ id: "import", label: "Import" }
	] as const;

	// The prop is only the opening tab; the tabs own it from here. The component
	// remounts on every open, so the capture is the point.
	// svelte-ignore state_referenced_locally
	let tab = $state<"export" | "import">(initialTab);

	// Snapshotted once on open: the dialog is modal, so nothing edits the
	// roster while it's up.
	const file = currentSystemFile();
	const exported = serializeSystemFile(file);
	const flattenedAt = savedTimelineStart();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(exported);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1600);
		} catch {
			toast("error", "Could not copy — select the text and copy it manually.");
		}
	}

	let importText = $state("");
	let importError = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	function importNow() {
		try {
			const parsed = parseSystemFile(importText);
			loadSystemIntoUi(parsed.bodies, parsed.name, parsed.settings);
			toast("ok", `Imported “${parsed.name}” — ${parsed.bodies.length} bodies.`);
			onclose();
		} catch (err) {
			importError = err instanceof ImportError ? err.message : "Could not read that JSON.";
		}
	}

	// Fills the textarea rather than importing directly, so a picked file and a
	// paste go through the same Import button — and the user sees what's loaded.
	async function onPickFile(event: Event & { currentTarget: HTMLInputElement }) {
		const picked = event.currentTarget.files?.[0];
		// Reset so re-picking the same file fires change again.
		event.currentTarget.value = "";
		if (!picked) return;
		importText = await picked.text();
		importError = null;
	}

	function focusOnMount(node: HTMLTextAreaElement) {
		node.focus();
	}
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
		aria-label="System JSON"
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<h2>System JSON</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<div class="tabs" role="tablist" aria-label="Export or import">
			{#each TABS as t (t.id)}
				<button
					class="tab"
					class:active={tab === t.id}
					role="tab"
					id="json-tab-{t.id}"
					aria-selected={tab === t.id}
					aria-controls="json-panel-{t.id}"
					onclick={() => (tab = t.id)}>{t.label}</button
				>
			{/each}
		</div>

		{#if tab === "export"}
			<div class="body" role="tabpanel" id="json-panel-export" aria-labelledby="json-tab-export">
				<p class="hint">
					“{file.name}” as a portable file — copy it to share your system, or to submit it to the
					gallery.
					{#if flattenedAt > 0}
						This copy starts at your last edit ({formatSimDate(flattenedAt)}); the timeline before
						it isn't included.
					{/if}
				</p>
				<textarea
					class="json"
					readonly
					rows={14}
					spellcheck="false"
					aria-label="Exported system JSON"
					value={exported}
					onfocus={(e) => e.currentTarget.select()}
				></textarea>
				<div class="actions">
					<button class="primary" onclick={copy}>{copied ? "Copied ✓" : "Copy JSON"}</button>
					<button onclick={() => downloadSystemFile(file)}>Download file</button>
				</div>
			</div>
		{:else}
			<div class="body" role="tabpanel" id="json-panel-import" aria-labelledby="json-tab-import">
				<p class="hint">Paste a system's JSON below. Importing replaces the current system.</p>
				<textarea
					class="json"
					rows={14}
					spellcheck="false"
					aria-label="System JSON to import"
					placeholder="Paste a system's JSON here…"
					bind:value={importText}
					oninput={() => (importError = null)}
					use:focusOnMount
				></textarea>
				{#if importError}
					<p class="error" role="alert">{importError}</p>
				{/if}
				<div class="actions">
					<button class="primary" disabled={importText.trim() === ""} onclick={importNow}>
						Import system
					</button>
					<button onclick={() => fileInput?.click()}>Choose a file…</button>
					<input
						class="hidden-input"
						type="file"
						accept="application/json,.json"
						bind:this={fileInput}
						onchange={onPickFile}
					/>
				</div>
			</div>
		{/if}
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
		width: 520px;
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

	h2 {
		flex: 1;
		margin: 0;
		font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
		font-size: 18px;
		font-weight: 600;
		letter-spacing: 0.01em;
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

	/* Folder tabs, same construction as the About dialog: rounded-top cards on
	   the tablist's border, the active one dropping that border along its own
	   width so it reads as continuous with the panel below. */
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

	.body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
		padding: 12px 14px 14px;
		font-size: 14px;
		line-height: 1.5;
	}

	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--text-dim);
	}

	.json {
		width: 100%;
		box-sizing: border-box;
		min-height: 120px;
		resize: vertical;
		font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--text);
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 8px 10px;
		white-space: pre;
	}

	.json:focus {
		outline: none;
		border-color: var(--accent);
	}

	.error {
		margin: 0;
		font-size: 12px;
		color: var(--danger);
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.actions button {
		font-size: 13px;
		padding: 5px 12px;
	}

	.primary {
		border-color: var(--accent);
		color: var(--accent);
	}

	.primary:disabled {
		opacity: 0.5;
		border-color: var(--border);
		color: var(--text-dim);
	}

	.hidden-input {
		display: none;
	}
</style>
