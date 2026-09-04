<script lang="ts">
	import SceneCanvas from "./lib/scene/SceneCanvas.svelte";
	import TimeBar from "./lib/ui/TimeBar.svelte";
	import Toolbar from "./lib/ui/Toolbar.svelte";
	import BodyList from "./lib/ui/BodyList.svelte";
	import BodyEditor from "./lib/ui/BodyEditor.svelte";
	import BodyInfo from "./lib/ui/BodyInfo.svelte";
	import SystemMenu from "./lib/ui/SystemMenu.svelte";
	import SystemShelf from "./lib/ui/SystemShelf.svelte";
	import AddBodyMenu from "./lib/ui/AddBodyMenu.svelte";
	import CreateBodyDialog from "./lib/ui/CreateBodyDialog.svelte";
	import PresetDialog from "./lib/ui/PresetDialog.svelte";
	import MissionDialog from "./lib/ui/MissionDialog.svelte";
	import MissionDebriefDialog from "./lib/ui/MissionDebriefDialog.svelte";
	import MissionSteps from "./lib/ui/MissionSteps.svelte";
	import AboutDialog from "./lib/ui/AboutDialog.svelte";
	import ShortcutsDialog from "./lib/ui/ShortcutsDialog.svelte";
	import SystemJsonDialog from "./lib/ui/SystemJsonDialog.svelte";
	import WelcomeDialog from "./lib/ui/WelcomeDialog.svelte";
	import Toasts from "./lib/ui/Toasts.svelte";
	import CameraReadout from "./lib/ui/CameraReadout.svelte";
	import CompactChrome from "./lib/ui/CompactChrome.svelte";
	import { toast } from "./lib/state/toasts.svelte";
	import { ui } from "./lib/state/ui.svelte";
	import { layout } from "./lib/state/layout.svelte";
	import { mission } from "./lib/state/mission.svelte";
	import { missionGuide } from "./lib/state/missionGuide.svelte";
	import {
		system,
		isSatelliteLanding,
		loadSystemIntoUi,
		markLoadedAsMission,
		undo,
		redo
	} from "./lib/state/system.svelte";
	import { historyShortcut } from "./lib/state/history.svelte";
	import { sharedSystem, sim } from "./lib/state/simInstance";
	import { formatSimDate } from "./lib/ui/formatTime";
	import { installCaptureApi, isCaptureRun } from "./lib/ui/capture";
	import { hasBeenWelcomed, markWelcomed } from "./lib/storage/persistence";
	import { slide } from "svelte/transition";
	import { PANEL_MS, duration } from "./lib/ui/motion";
	import type { MergeEvent } from "./lib/sim/simulation";

	// Hook for `npm run preset-screenshots`. Inert unless the script is driving.
	installCaptureApi();

	let creating = $state(false);
	let systemOpen = $state(false);
	let presetsOpen = $state(false);
	let missionsOpen = $state(false);
	let debriefOpen = $state(false);
	let aboutOpen = $state(false);
	let shortcutsOpen = $state(false);
	let jsonOpen = $state(false);
	let jsonTab = $state<"export" | "import">("export");

	// First visit only. Marked as seen at the moment it opens rather than when
	// it's dismissed, so a reload with the dialog still up doesn't show it again
	// — a welcome that reappears reads as broken. Suppressed for the screenshot
	// script, whose throwaway profile is a first visit on every run, and for a
	// share-link visit — the visitor came to see a specific system, and every
	// call to action in the dialog would navigate away from it. Not marked as
	// seen in that case, so their next organic visit still gets the welcome.
	const showWelcome = !isCaptureRun() && !hasBeenWelcomed() && !sharedSystem;
	if (showWelcome) markWelcomed();
	let welcomeOpen = $state(showWelcome);

	// Both measured, not assumed: each wraps to extra rows on a narrow viewport,
	// so the readout's clearance and the left stack's top offset must follow.
	let timePanelHeight = $state(0);
	let toolbarHeight = $state(0);

	const selected = $derived(system.byId(ui.selectedBodyId));
	const placementParent = $derived(system.byId(ui.placementParentId));
	const activeMission = $derived(mission.active);

	function onKeydown(event: KeyboardEvent) {
		// An armed placement owns the cursor, so Escape cancels it first.
		if (event.key === "Escape" && ui.placementType !== null) {
			ui.cancelPlacement();
			return;
		}
		// Escape only un-hides the chrome, so it doesn't compete with the popovers
		// and dialogs that close on Escape while the chrome is up.
		if (event.key === "Escape" && ui.chromeHidden) ui.chromeHidden = false;

		// `preventDefault` so the browser doesn't also run its own undo.
		const action = historyShortcut(event);
		if (action !== null) {
			event.preventDefault();
			if (action === "undo") undo();
			else redo();
		}
	}

	// Follow the viewport across resizes and rotations, so the chrome swaps
	// layouts without a reload.
	$effect(() => layout.watch());

	// Latch the mission checklist's moment-shaped observations ("selected",
	// "played") — a state write, so it can't live in the guide's deriveds.
	$effect(() => missionGuide.observe());

	// The text announcement alongside the scene's particle burst. A spacecraft
	// reaching a planet is an arrival, not a collision of worlds, so it gets
	// arrival wording (and no burst — see `isSatelliteLanding`): re-entry where
	// the survivor has an atmosphere to re-enter, impact where it doesn't.
	$effect(() =>
		sim.onMerge((event: MergeEvent) => {
			const landing = isSatelliteLanding(event);
			const text = !landing
				? `${event.absorbedName} merged into ${event.survivorName}`
				: system.byId(event.survivorId)?.atmosphere
					? `${event.absorbedName} re-entered ${event.survivorName}'s atmosphere`
					: `${event.absorbedName} impacted ${event.survivorName}`;
			toast("ok", `${text} — ${formatSimDate(event.t)}`, 6000);
		})
	);
</script>

<svelte:window onkeydown={onKeydown} />

<!-- The scene fills the window; every control floats over it. -->
<div class="app" style:--toolbar-height="{toolbarHeight}px">
	<SceneCanvas />

	<!-- Two chrome layouts over the same scene and the same state. The compact
	     one collapses every panel into one icon toolbar; see
	     `state/layout.svelte.ts` for where the line is drawn. -->
	{#if !ui.chromeHidden && layout.compact}
		<CompactChrome bind:systemOpen ondebrief={() => (debriefOpen = true)} oncreate={() => (creating = true)} />

		<!-- Bottom, not top: the compact bar owns the top edge, and the scene
		     between them is exactly what this is asking the user to tap. -->
		{#if ui.placementType !== null}
			<div class="placement-hint compact-hint" role="status">
				Tap in space to place a <strong>{ui.placementType}</strong>
				{#if placementParent}orbiting <strong class="parent-name">{placementParent.name}</strong>{/if}
			</div>
		{/if}
	{:else if !ui.chromeHidden}
		<div class="left-stack">
			<div class="panel menu-bar">
				<SystemMenu bind:open={systemOpen} />
			</div>

			{#if activeMission}
				<section
					class="panel mission-panel"
					class:collapsed={!ui.missionOpen}
					style:--mission-color={activeMission.color}
				>
					<header class="panel-head">
						<button
							class="collapse"
							onclick={() => (ui.missionOpen = !ui.missionOpen)}
							aria-expanded={ui.missionOpen}
							title={ui.missionOpen ? "Collapse the mission" : "Expand the mission"}
						>
							<span class="chevron" aria-hidden="true"></span>
							<h2><span class="mission-chip">{activeMission.name}</span></h2>
						</button>
						<button
							class="dismiss"
							onclick={() => mission.abandon()}
							title="Quit this mission"
							aria-label="Quit mission"
						>
							✕
						</button>
					</header>
					{#if ui.missionOpen}
						<!-- Wrapped, not sliding each child: siblings collapsing on their
						     own would drop the column's `gap` between them in steps. -->
						<div class="mission-body" transition:slide={{ duration: duration(PANEL_MS) }}>
							<p class="mission-question">{activeMission.question}</p>
							<MissionSteps />
							<button class="mission-complete" onclick={() => (debriefOpen = true)}> Complete Mission </button>
						</div>
					{/if}
				</section>
			{/if}

			<section class="panel bodies-panel" class:collapsed={!ui.bodiesOpen}>
				<header class="panel-head">
					<button
						class="collapse"
						onclick={() => (ui.bodiesOpen = !ui.bodiesOpen)}
						aria-expanded={ui.bodiesOpen}
						title={ui.bodiesOpen ? "Collapse the roster" : "Expand the roster"}
					>
						<span class="chevron" aria-hidden="true"></span>
						<h2>Objects</h2>
					</button>
					<AddBodyMenu onmore={() => (creating = true)} />
				</header>
				{#if ui.bodiesOpen}
					<!-- The slide goes on a wrapper, never on `.panel-body`: `slide` sets
					     `overflow: hidden`, which fights the scroller and jumps a scrolled
					     roster to the top as it collapses. -->
					<div class="panel-slide" transition:slide={{ duration: duration(PANEL_MS) }}>
						<div class="panel-body">
							<BodyList />
						</div>
					</div>
				{/if}
			</section>

			{#if selected}
				<section class="panel properties-panel" class:collapsed={!ui.propertiesOpen}>
					<header class="panel-head">
						<button
							class="collapse"
							onclick={() => (ui.propertiesOpen = !ui.propertiesOpen)}
							aria-expanded={ui.propertiesOpen}
							title={ui.propertiesOpen ? "Collapse the properties" : "Expand the properties"}
						>
							<span class="chevron" aria-hidden="true"></span>
							<h2>{selected.name}</h2>
						</button>
						<button
							class="focus"
							onclick={() => ui.focusBody(selected.id)}
							title="Frame the camera on this body and follow it"
						>
							Focus
						</button>
					</header>
					{#if ui.propertiesOpen}
						<div class="panel-slide" transition:slide={{ duration: duration(PANEL_MS) }}>
							<div class="panel-body">
								<BodyInfo />
								<BodyEditor />
							</div>
						</div>
					{/if}
				</section>
			{/if}
		</div>

		<div class="toolbar-slot" bind:clientHeight={toolbarHeight}>
			<Toolbar />
		</div>

		{#if ui.placementType !== null}
			<div class="placement-hint" role="status">
				Click in space to place a <strong>{ui.placementType}</strong>
				{#if placementParent}orbiting <strong class="parent-name">{placementParent.name}</strong>{/if}
				— Esc cancels
			</div>
		{/if}

		<div class="panel time-panel" bind:clientHeight={timePanelHeight}>
			<TimeBar {sim} />
		</div>

		<CameraReadout clearance={timePanelHeight} />
	{/if}

	<!-- Outside the chrome block: it's the way back when everything else is
	     hidden. -->
	<button
		class="chrome-toggle"
		class:hidden-chrome={ui.chromeHidden}
		onclick={() => (ui.chromeHidden = !ui.chromeHidden)}
		aria-pressed={ui.chromeHidden}
		title={ui.chromeHidden ? "Show the controls (Esc)" : "Hide all controls for a clear view"}
		aria-label={ui.chromeHidden ? "Show controls" : "Hide controls"}
	>
		{ui.chromeHidden ? "⤢" : "⤡"}
	</button>
</div>

<!-- Outside the chrome-hidden block: merge announcements still show over a
     bare scene. -->
<Toasts />

{#if creating}
	<CreateBodyDialog onclose={() => (creating = false)} />
{/if}

<!-- Mounted here, not inside SystemMenu: that panel's `backdrop-filter` makes it
     a containing block, trapping the fixed-position shelf inside a 40 px button.
     Never gated on `chromeHidden` — this component owns the autosave, so
     unmounting it would stop saving. -->
<SystemShelf bind:open={systemOpen} bind:presetsOpen bind:missionsOpen bind:aboutOpen bind:shortcutsOpen bind:jsonOpen bind:jsonTab />

{#if aboutOpen}
	<AboutDialog onclose={() => (aboutOpen = false)} />
{/if}

{#if shortcutsOpen}
	<ShortcutsDialog onclose={() => (shortcutsOpen = false)} />
{/if}

{#if jsonOpen}
	<SystemJsonDialog tab={jsonTab} onclose={() => (jsonOpen = false)} />
{/if}

<!-- Both call-to-action routes hand straight off to the picker they name, so
     the welcome closes as that dialog opens rather than stacking behind it. -->
{#if welcomeOpen}
	<WelcomeDialog
		onpresets={() => {
			welcomeOpen = false;
			presetsOpen = true;
		}}
		onmissions={() => {
			welcomeOpen = false;
			missionsOpen = true;
		}}
		onclose={() => (welcomeOpen = false)}
	/>
{/if}

{#if presetsOpen}
	<PresetDialog
		onpick={(preset) => {
			loadSystemIntoUi(preset.build(), preset.name, preset.timing, { kind: "preset", id: preset.id });
			presetsOpen = false;
		}}
		onpickgallery={(entry, file) => {
			// The file's own settings ride along, so a submission tuned to short
			// orbits reloads on its own timing grids like any saved system.
			loadSystemIntoUi(file.bodies, entry.name, file.settings, { kind: "gallery", id: entry.id });
			presetsOpen = false;
		}}
		onsubmit={() => {
			// "Submit yours": hand off to the JSON dialog's Export tab, where the
			// copyable JSON lives.
			presetsOpen = false;
			jsonTab = "export";
			jsonOpen = true;
		}}
		onclose={() => (presetsOpen = false)}
	/>
{/if}

{#if missionsOpen}
	<MissionDialog
		onpick={(picked, prediction) => {
			// Load first: it clears any in-flight mission, so arming comes after.
			loadSystemIntoUi(picked.build(), picked.name, picked.timing);
			mission.start(picked.id, prediction);
			markLoadedAsMission(picked.id, prediction);
			missionsOpen = false;
		}}
		onclose={() => (missionsOpen = false)}
	/>
{/if}

{#if debriefOpen && activeMission}
	<MissionDebriefDialog
		mission={activeMission}
		oncomplete={() => mission.completeActive()}
		onclose={() => {
			debriefOpen = false;
			// Reading the debrief retires the mission; the system stays loaded.
			mission.abandon();
		}}
	/>
{/if}

<style>
	.app {
		position: relative;
		height: 100%;
		overflow: hidden;
	}

	/* Shared chrome for every floating panel. */
	.panel {
		background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(8px);
	}

	.left-stack {
		position: absolute;
		top: 10px;
		left: 10px;
		z-index: 3;
		width: 260px;
		/* Stop short of the time panel at the bottom. */
		max-height: calc(100% - 110px);
		display: flex;
		flex-direction: column;
		gap: 8px;
		/* The stack itself never scrolls — the panels inside it do. */
		min-height: 0;
	}

	/* Sized to the button, not the column: what it opens is fixed to the
     viewport's left edge. Padding 0 so the toggle fills it edge to edge. */
	.menu-bar {
		flex: none;
		align-self: flex-start;
		display: flex;
		align-items: center;
		padding: 0;
		/* Above the bodies panel, so the toggle stays clickable while the
       Add-body popover below it is open. */
		position: relative;
		z-index: 2;
	}

	/* Same trap one panel down: the Add-body popover drops over the properties
     panel below it. */
	.bodies-panel {
		position: relative;
		z-index: 1;
	}

	/* Fixed by its text, so it never competes with the roster for height. */
	.mission-panel {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 10px 12px;
		background: color-mix(in srgb, var(--mission-color) 9%, var(--bg-panel));
		border-color: color-mix(in srgb, var(--mission-color) 40%, var(--border));
	}

	.mission-panel .panel-head {
		margin-bottom: 0;
		padding-right: 0;
	}

	/* The chip is a fixed-height pill, so the chevron needs more room than it
     does against the 11 px headings below. */
	.mission-panel .collapse {
		gap: 7px;
	}

	/* Overrides the shared dim/uppercase panel heading — this one is a chip. */
	.mission-panel .panel-head h2 {
		overflow: visible;
		text-transform: none;
		letter-spacing: normal;
	}

	.mission-chip {
		display: inline-block;
		max-width: 100%;
		font-size: 13px;
		font-weight: 700;
		padding: 3px 10px;
		border-radius: 999px;
		color: #0a0b0f;
		background: var(--mission-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: middle;
	}

	.mission-question {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.35;
	}

	.mission-complete {
		align-self: stretch;
		margin-top: 3px;
		font-size: 14px;
		font-weight: 600;
		padding: 7px 12px;
		border-radius: 9px;
	}

	.dismiss {
		flex: none;
		padding: 0 5px;
		background: transparent;
		border-color: transparent;
		color: var(--text-dim);
		font-size: 14px;
		line-height: 1;
	}

	.dismiss:hover {
		color: var(--danger, #ff8080);
		border-color: var(--border);
	}

	/* The whole heading is the collapse hit target, dressed as a heading. */
	.collapse {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 0;
		background: transparent;
		border-color: transparent;
		text-align: left;
	}

	.collapse:hover,
	.collapse:focus,
	.collapse:focus-visible {
		border-color: transparent;
		outline: none;
		box-shadow: none;
	}

	/* A clipped box, not a ▾/▸ glyph: those render at a fraction of their
     nominal font-size and vary by font. One arrow that rotates within a fixed
     8×8 box, never two that swap — a swap resizes the box and nudges the
     heading sideways. Untransformed state points right (collapsed). */
	.chevron {
		flex: none;
		width: 8px;
		height: 8px;
		margin-right: 2px;
		background: var(--text-dim);
		/* Symmetric about both center lines, so the rotation pivots on the arrow
       rather than swinging it around. */
		clip-path: polygon(1.5px 0, 6.5px 4px, 1.5px 8px);
		transition:
			transform 0.12s ease,
			background-color 0.12s ease;
	}

	.collapse[aria-expanded="true"] .chevron {
		transform: rotate(90deg);
	}

	.collapse:hover .chevron {
		background: var(--text);
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}

	.collapse:hover h2 {
		color: var(--text);
	}

	.bodies-panel,
	.properties-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: 8px 4px 8px 10px;
	}

	/* Never `flex: 1 1 auto` — that made the roster the stack's give, so
     selecting a body resized the list under the cursor. The properties panel
     takes the leftover instead. */
	.bodies-panel {
		flex: 0 0 auto;
		max-height: 40vh;
	}

	.properties-panel {
		flex: 0 1 auto;
		max-height: 55vh;
	}

	/* A collapsed panel is its header alone, and must not keep claiming the
     stack's leftover height. */
	.bodies-panel.collapsed,
	.properties-panel.collapsed {
		flex: none;
		max-height: none;
	}

	.collapsed .panel-head {
		margin-bottom: 0;
	}

	.panel-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 6px;
		margin-bottom: 8px;
	}

	.panel-head h2 {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Not `flex: 1`: the flex algorithm overrides the inline `height` that
     `slide` animates, so the panel would snap shut instead of sliding.
     `.panel-body` inside does the growing. `min-height: 0` so the panel's
     `max-height` reaches the scroller. */
	.panel-slide {
		flex: 0 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 6px;
	}

	/* Carries the column gap its children used to get from the panel itself. */
	.mission-body {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.focus {
		flex: none;
		font-size: 11px;
		padding: 2px 8px;
	}

	.time-panel {
		position: absolute;
		bottom: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 3;
		width: min(720px, calc(100% - 24px));
		display: flex;
		align-items: center;
		padding: 8px 14px;
	}

	.toolbar-slot {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 3;
		/* Stay clear of the left stack and wrap rather than pushing the toolbar's
       first controls off the left edge. */
		max-width: calc(100% - 290px);
		display: flex;
		justify-content: flex-end;
	}

	/* Click-through, so it never eats the very click it's asking for. */
	.placement-hint {
		position: absolute;
		top: 14px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 3;
		pointer-events: none;
		font-size: 13px;
		color: var(--text);
		background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
		border: 1px solid var(--accent);
		border-radius: 8px;
		padding: 7px 14px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
	}

	.placement-hint strong {
		text-transform: capitalize;
	}

	/* Body names are proper nouns already; only the type name needs dressing. */
	.placement-hint .parent-name {
		text-transform: none;
	}

	/* The compact chrome holds the top edge, so its hint takes the bottom one —
	   full-bleed, since centered 13px text wraps badly at phone widths. */
	.compact-hint {
		top: auto;
		bottom: 14px;
		left: 10px;
		right: 10px;
		transform: none;
		text-align: center;
		font-size: 12px;
		padding: 6px 10px;
	}

	/* Bottom-right, clear of the bottom-center time panel. */
	.chrome-toggle {
		position: absolute;
		right: 12px;
		bottom: 12px;
		z-index: 4;
		width: 28px;
		height: 28px;
		padding: 0;
		font-size: 13px;
		line-height: 1;
		color: var(--text-dim);
		background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
		border: 1px solid var(--border);
		border-radius: 6px;
		backdrop-filter: blur(8px);
	}

	.chrome-toggle:hover {
		color: var(--text);
		border-color: var(--accent);
	}

	/* The only thing left over the scene once the chrome is gone, so it fades
     almost out — findable by hovering, invisible in a screenshot. */
	.chrome-toggle.hidden-chrome {
		opacity: 0.12;
		background: transparent;
		border-color: transparent;
	}

	.chrome-toggle.hidden-chrome:hover,
	.chrome-toggle.hidden-chrome:focus-visible {
		opacity: 1;
		background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
		border-color: var(--border);
	}

	/* --- narrow viewports -------------------------------------------------
     Everything above assumes a desktop window. The chrome is all absolutely
     positioned, so on a phone it overlaps rather than reflowing. These rules
     reclaim room in the order that costs least: wrap the toolbar, shrink the
     left column, then stop reserving space for it. */

	/* The toolbar can no longer share a row with the left column. */
	@media (max-width: 900px) {
		.toolbar-slot {
			max-width: calc(100% - 20px);
			flex-wrap: wrap;
		}
	}

	/* Landscape phones — wide but very short, so the vertical caps are what
     matter: two panels can't each claim 40–55vh of a ~390 px stack. */
	@media (max-height: 480px) {
		.left-stack {
			max-height: calc(100% - 86px);
		}

		.bodies-panel {
			max-height: 30vh;
		}

		.properties-panel {
			max-height: 42vh;
		}
	}

	/* Portrait phones. The left column spans the width and the toolbar moves
     above it rather than sitting beside it. */
	@media (max-width: 560px) {
		.left-stack {
			width: calc(100% - 20px);
			/* Below the toolbar, which wraps to a variable number of rows here —
         hence the measured height. 10px is the toolbar's own top offset. */
			top: calc(var(--toolbar-height, 32px) + 18px);
			max-height: calc(100% - var(--toolbar-height, 32px) - 168px);
			/* Above the toolbar, a later sibling that would otherwise win the tie
         and paint over the system menu. */
			z-index: 4;
		}

		/* The left inset leaves the hamburger its corner. */
		.toolbar-slot {
			top: 10px;
			right: 10px;
			left: 52px;
			max-width: none;
			justify-content: flex-start;
		}

		/* Lifted into the gutter the toolbar leaves at the top-left, so one 30 px
       button doesn't cost a full row. Anchored against .left-stack, whose top
       offset is subtracted to land it level with the toolbar. */
		.menu-bar {
			position: absolute;
			top: calc(-1 * var(--toolbar-height, 32px) - 8px);
			left: 0;
			z-index: 4;
		}

		/* Both panels can't hold their desktop caps here; the roster yields. */
		.bodies-panel {
			max-height: 34vh;
		}

		.properties-panel {
			max-height: 44vh;
		}

		/* Full-bleed — a 720 px panel has nothing to center within at this width. */
		.time-panel {
			bottom: 8px;
			width: calc(100% - 16px);
			padding: 8px 10px;
		}

		/* A full-width strip: centered 13 px text wraps badly at 390 px. */
		.placement-hint {
			left: 10px;
			right: 10px;
			transform: none;
			text-align: center;
			font-size: 12px;
			padding: 6px 10px;
		}
	}
</style>
