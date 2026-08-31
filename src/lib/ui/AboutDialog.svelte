<script lang="ts">
	import { TreeDeciduous } from "lucide-svelte";
	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";
	import { GALLERY_FORM_URL } from "../presets/gallery";
	import { CONTACT_EMAIL } from "./contact";

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	const TABS = [
		{ id: "story", label: "Backstory" },
		{ id: "credits", label: "Credits" }
	] as const;

	type TabId = (typeof TABS)[number]["id"];

	let tab = $state<TabId>("story");

	const LIBRARIES = [
		{ name: "Svelte", url: "https://svelte.dev", role: "UI framework" },
		{ name: "Three.js", url: "https://threejs.org", role: "3D rendering" },
		{ name: "Lucide", url: "https://lucide.dev", role: "icons" },
		{ name: "Vite", url: "https://vite.dev", role: "build tool" },
		{ name: "Vitest", url: "https://vitest.dev", role: "tests" }
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
		aria-label="About Newton’s Orchard"
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<span class="mark" aria-hidden="true">
				<TreeDeciduous size={22} strokeWidth={1.5} />
			</span>
			<h2>Newton’s Orchard</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<div class="tabs" role="tablist" aria-label="About sections">
			{#each TABS as t (t.id)}
				<button
					class="tab"
					class:active={tab === t.id}
					role="tab"
					id="about-tab-{t.id}"
					aria-selected={tab === t.id}
					aria-controls="about-panel-{t.id}"
					onclick={() => (tab = t.id)}>{t.label}</button
				>
			{/each}
		</div>

		{#if tab === "story"}
			<div class="body" role="tabpanel" id="about-panel-story" aria-labelledby="about-tab-story">
				<p>
					Woolsthorpe Manor, near Grantham, Lincolnshire, England, is the birthplace and family home of Sir Isaac
					Newton. Surviving to this day within the Manor's orchard is <a
						href="https://en.wikipedia.org/wiki/Isaac_Newton#Apple_story"
						target="_blank"
						rel="noopener">Newton's famous apple tree</a
					>, where a falling apple set Newton on the path of questioning why an apple falls towards the Earth's
					center, and not sideways or upwards.
				</p>

				<p>
					Newton's Orchard was built by <a href="https://github.com/andrewchilds" target="_blank" rel="noopener"
						>Andrew Childs</a
					>. His son has enjoyed playing with the University of Colorado's
					<a href="https://phet.colorado.edu/en/simulations/gravity-and-orbits" target="_blank" rel="noopener"
						>PhET gravity simulations</a
					>
					and has been looking for more.
				</p>

				<p>
					Built a system worth sharing? Send it to the gallery through
					<a href={GALLERY_FORM_URL} target="_blank" rel="noopener">the submission form</a>. Questions and comments
					can be directed to the author by <a href="mailto:{CONTACT_EMAIL}">email</a>.
				</p>
			</div>
		{:else}
			<div class="body" role="tabpanel" id="about-panel-credits" aria-labelledby="about-tab-credits">
				<p>
					The code lives on
					<a href="https://github.com/andrewchilds/newtons-orchard" target="_blank" rel="noopener"> GitHub</a>, and
					relies on the following open-source libraries:
				</p>

				<ul class="libs">
					{#each LIBRARIES as lib (lib.name)}
						<li>
							<a href={lib.url} target="_blank" rel="noopener">{lib.name}</a>
							<span class="role">— {lib.role}</span>
						</li>
					{/each}
				</ul>

				<p>
					The surface maps of the planets and the Moon are public-domain NASA and USGS mosaics from the MESSENGER,
					Magellan, Lunar Reconnaissance Orbiter, Viking and Cassini missions, and NASA's
					<a href="https://visibleearth.nasa.gov/collection/1484/blue-marble" target="_blank" rel="noopener"
						>Blue Marble</a
					> imagery of Earth.
				</p>
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
		width: 460px;
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

	/* Same foliage green as the shelf's mark, and deliberately not `--ok`,
	   which means "mission complete" everywhere else in the app. */
	.mark {
		display: flex;
		color: #6bbf7c;
		opacity: 0.75;
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

	/* Folder tabs: each is a rounded-top card sitting on the tablist's border.
	   The active one drops that border along its own width (via the -1px
	   overhang and matching background) so it reads as continuous with the
	   panel below it. */
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
		overflow-y: auto;
		padding: 12px 14px 14px;
		font-size: 14px;
		line-height: 1.5;
	}

	.body p {
		margin: 0 0 10px;
	}

	ul {
		margin: 0 0 10px;
		padding-left: 18px;
	}

	li {
		margin: 2px 0;
	}

	a {
		color: var(--accent);
		text-decoration: none;
	}

	a:hover {
		text-decoration: underline;
	}

	.libs {
		list-style: none;
		padding-left: 0;
		margin-bottom: 0;
	}

	.role {
		color: var(--text-dim);
	}
</style>
