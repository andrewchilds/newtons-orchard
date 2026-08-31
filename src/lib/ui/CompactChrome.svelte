<script lang="ts">
	// The compact chrome: one icon toolbar across the top, and a single sheet
	// below it holding whichever panel the user tapped.
	//
	// The desktop chrome puts a 260 px column, a toolbar row and a 720 px time
	// panel over the scene at once, which on a phone leaves almost no scene. Here
	// the default state is the bare view: every panel is one tap away and only
	// one is up at a time.
	//
	// Everything inside the sheets is the *same component* the desktop chrome
	// uses — this file owns the toolbar, the sheet frame and the sizing, never a
	// second copy of a control.

	import BodyList from "./BodyList.svelte";
	import BodyInfo from "./BodyInfo.svelte";
	import BodyEditor from "./BodyEditor.svelte";
	import AddBodyMenu from "./AddBodyMenu.svelte";
	import TimeBar from "./TimeBar.svelte";
	import CameraControls from "./CameraControls.svelte";
	import ViewTargets from "./ViewTargets.svelte";
	import HistoryControls from "./HistoryControls.svelte";
	import DisplaySettings from "./DisplaySettings.svelte";
	import MissionSteps from "./MissionSteps.svelte";
	import SystemMenu from "./SystemMenu.svelte";
	import TransportControls from "./TransportControls.svelte";
	import { system } from "../state/system.svelte";
	import { ui } from "../state/ui.svelte";
	import { mission } from "../state/mission.svelte";
	import { missionGuide } from "../state/missionGuide.svelte";
	import { layout, type CompactPanel } from "../state/layout.svelte";
	import { sim } from "../state/simInstance";
	import { time } from "../state/time.svelte";
	import { history } from "../state/history.svelte";
	import { formatSimDate } from "./formatTime";
	import { PANEL_MS, duration } from "./motion";
	import { slide } from "svelte/transition";
	import { Clock, Eye, List, Redo2, SlidersHorizontal, Video } from "lucide-svelte";

	let {
		systemOpen = $bindable(false),
		ondebrief,
		oncreate
	}: {
		systemOpen?: boolean;
		ondebrief: () => void;
		oncreate: () => void;
	} = $props();

	const selected = $derived(system.byId(ui.selectedBodyId));
	const activeMission = $derived(mission.active);

	// The sheet holding the control the mission guide points at. While that
	// sheet is closed the control can't glow — it isn't mounted — so the tab
	// that opens it carries the ring instead. Play and the date sit in the
	// always-visible clock pill and never need this.
	const guidedPanel = $derived.by((): CompactPanel | null => {
		const t = missionGuide.target;
		if (!t) return null;
		if (t.kind === "roster" || t.kind === "add") return "objects";
		if (t.kind === "editor") return "properties";
		if (t.kind === "center") return "camera";
		return null;
	});

	/**
	 * The toolbar, in the order the tasks come up: what's in the system, what the
	 * selected thing is, when it is, where you're looking from, undo, and how it
	 * all draws.
	 */
	const TABS: {
		panel: CompactPanel;
		icon: typeof List;
		label: string;
	}[] = [
		{ panel: "objects", icon: List, label: "Objects" },
		{ panel: "properties", icon: SlidersHorizontal, label: "Properties" },
		{ panel: "time", icon: Clock, label: "Time" },
		{ panel: "camera", icon: Video, label: "Camera" },
		{ panel: "history", icon: Redo2, label: "History" },
		{ panel: "display", icon: Eye, label: "Display" }
	];

	/** The sheet's heading. Properties names the body, since that's the subject. */
	const title = $derived.by(() => {
		if (layout.panel === "properties") return selected?.name ?? "Properties";
		return TABS.find((tab) => tab.panel === layout.panel)?.label ?? "";
	});

	// Escape closes the sheet, matching every other dismissible surface here.
	// The chrome-hidden Escape in App only fires when the chrome is already gone.
	function onKeydown(event: KeyboardEvent) {
		if (event.key === "Escape" && layout.panel !== null) layout.close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="compact">
	<nav class="bar" aria-label="Controls">
		<!-- The tree keeps its usual leading spot and its own shelf, which is a
         full-height overlay rather than one of these sheets. -->
		<SystemMenu bind:open={systemOpen} />

		<div class="tabs">
			{#each TABS as { panel, icon: Icon, label } (panel)}
				<button
					class="tab"
					class:active={layout.panel === panel}
					class:dimmed={panel === "properties" && !selected}
					class:guide-glow={panel === guidedPanel && layout.panel !== panel}
					onclick={() => layout.toggle(panel)}
					aria-pressed={layout.panel === panel}
					aria-label={label}
					title={label}
				>
					<Icon size={19} strokeWidth={1.9} aria-hidden="true" />
					<!-- A dot, not a count: the toolbar's job is to say "there's
               something here", and a numeral at this size is unreadable. -->
					{#if panel === "history" && (history.canUndo || history.canRedo)}
						<span class="dot" aria-hidden="true"></span>
					{/if}
				</button>
			{/each}
		</div>
	</nav>

	<!-- The mission stays out of the sheets: it's the reason the user is here,
       and burying the question behind a tap defeats it. Collapsed to its chip
       by the same toggle as the desktop chrome. -->
	{#if activeMission}
		<section class="panel mission" style:--mission-color={activeMission.color}>
			<header>
				<button
					class="mission-head"
					onclick={() => (ui.missionOpen = !ui.missionOpen)}
					aria-expanded={ui.missionOpen}
					title={ui.missionOpen ? "Collapse the mission" : "Expand the mission"}
				>
					<span class="chip">{activeMission.name}</span>
				</button>
				<button class="dismiss" onclick={() => mission.abandon()} aria-label="Quit mission">✕</button>
			</header>
			{#if ui.missionOpen}
				<div class="mission-body" transition:slide={{ duration: duration(PANEL_MS) }}>
					<p class="question">{activeMission.question}</p>
					<MissionSteps />
					<button class="complete" onclick={ondebrief}>Complete Mission</button>
				</div>
			{/if}
		</section>
	{/if}

	{#if layout.panel !== null}
		<section class="panel sheet" transition:slide={{ duration: duration(PANEL_MS) }}>
			<header class="sheet-head">
				<h2>{title}</h2>
				{#if layout.panel === "objects"}
					<AddBodyMenu onmore={oncreate} />
				{:else if layout.panel === "properties" && selected}
					<button class="focus" onclick={() => ui.focusBody(selected.id)}>Focus</button>
				{/if}
				<button class="close" onclick={() => layout.close()} aria-label="Close panel">✕</button>
			</header>

			<div class="sheet-body">
				{#if layout.panel === "objects"}
					<BodyList />
				{:else if layout.panel === "properties"}
					{#if selected}
						<BodyInfo />
						<BodyEditor />
					{:else}
						<p class="empty">Select a body to edit it.</p>
					{/if}
				{:else if layout.panel === "time"}
					<TimeBar {sim} />
				{:else if layout.panel === "camera"}
					<div class="camera-sheet">
						<ViewTargets stacked />
						<CameraControls />
					</div>
				{:else if layout.panel === "history"}
					<HistoryControls labelled />
				{:else if layout.panel === "display"}
					<DisplaySettings />
				{/if}
			</div>
		</section>
	{/if}
</div>

<!-- Outside `.compact`, which is a top-anchored column: this is pinned to the
     opposite corner. Play/pause never goes in a sheet — stopping time is what
     you reach for while watching, and it can't cost a tap to reach. The Time
     sheet holds the rest (rewind, warp, shuttle), and the date opens it. -->
<div class="clock panel">
	<TransportControls {sim} rewindable={false} disabled={time.shuttleHeld} />
	<button
		class="date"
		class:active={layout.panel === "time"}
		class:guide-glow={missionGuide.target?.kind === "date"}
		onclick={() => layout.toggle("time")}
		aria-pressed={layout.panel === "time"}
		title="Time controls"
	>
		{formatSimDate(time.simTime)}
		<span class="status" class:visible={time.computing}>computing…</span>
	</button>
</div>

<style>
	/* One column pinned to the top: the toolbar, then whatever is open under it.
     Top rather than bottom so it never fights the phone's own home indicator
     or a browser's bottom URL bar, both of which sit in the last ~40 px. */
	.compact {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		/* The column is only as tall as its contents; the scene shows through
       around it, and the sheet caps its own height below. */
		max-height: 100%;
		min-height: 0;
		/* Taps land on the bar and the sheet, never on the gaps between them —
       otherwise this strip would swallow camera drags across the whole top. */
		pointer-events: none;
	}

	.compact > :global(*) {
		pointer-events: auto;
	}

	/* Shared chrome for every floating surface here — matches App's `.panel`. */
	.panel {
		background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(8px);
	}

	/* The tree sits in this row but is not one of the tabs — it opens a
     full-height shelf, not a sheet — so a gap separates it from the group
     rather than the 2px that spaces the tabs from each other. */
	.bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 3px 4px;
		background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(8px);
		pointer-events: auto;
	}

	/* The tabs share out whatever the tree button leaves, so the row fits any
     phone width without scrolling. */
	.tabs {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	/* Bottom-left, opposite the chrome toggle App pins bottom-right. Sized to its
     contents rather than the width, so the scene stays reachable beside it. */
	.clock {
		position: absolute;
		left: 8px;
		bottom: 8px;
		z-index: 4;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px 4px 4px;
	}

	/* The date doubles as the way into the Time sheet — the thing you'd tap to
     ask "when is this?" is the date itself. */
	.date {
		position: relative;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
		text-align: left;
		padding: 6px 8px;
		color: var(--text);
		background: transparent;
		border-color: transparent;
		white-space: nowrap;
	}

	.date.active {
		color: var(--accent);
		border-color: var(--accent);
	}

	/* Floated above the date rather than widening the pill — it's only up while
     the sim catches up, and a permanent column for it costs more. */
	.status {
		position: absolute;
		left: 8px;
		bottom: calc(100% + 6px);
		font-size: 10px;
		color: var(--text-dim);
		visibility: hidden;
		pointer-events: none;
	}

	.status.visible {
		visibility: visible;
	}

	/* 44 px tall: the smallest touch target that doesn't miss. Width is free to
     shrink, since the icons are 19 px and the padding is what gives. */
	.tab {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		color: var(--text-dim);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 8px;
	}

	.tab.active {
		color: var(--accent);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	/* Properties with nothing selected still opens (it explains itself), but it
     reads as unavailable until there's a subject. */
	.tab.dimmed {
		opacity: 0.4;
	}

	.dot {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}

	/* The scene has to stay visible: the sheet takes at most two-thirds of the
     viewport and scrolls inside that. */
	.sheet {
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: 66vh;
		padding: 8px 4px 10px 12px;
	}

	.sheet-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 8px;
		margin-bottom: 8px;
	}

	.sheet-head h2 {
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

	.sheet-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding-right: 8px;
	}

	.close,
	.focus {
		flex: none;
		font-size: 11px;
		padding: 4px 9px;
	}

	.close {
		color: var(--text-dim);
		background: transparent;
		border-color: transparent;
	}

	.empty {
		margin: 0;
		font-size: 13px;
		color: var(--text-dim);
	}

	/* The two camera groups stack: the selects want a full row each, and the
     zoom/turn buttons are a single centerd cluster under them. */
	.camera-sheet {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.camera-sheet :global(.control.camera) {
		align-self: flex-start;
	}

	/* Bigger hit targets than the desktop toolbar's 23 px glyphs. */
	.camera-sheet :global(.control.camera .icon) {
		padding: 10px 12px;
	}

	.mission {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 8px 10px;
		background: color-mix(in srgb, var(--mission-color) 9%, var(--bg-panel));
		border-color: color-mix(in srgb, var(--mission-color) 40%, var(--border));
	}

	.mission header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.mission-head {
		flex: 1;
		min-width: 0;
		display: flex;
		padding: 0;
		background: transparent;
		border-color: transparent;
		text-align: left;
	}

	.chip {
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

	.mission-body {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.question {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.35;
	}

	.complete {
		align-self: stretch;
		font-size: 14px;
		font-weight: 600;
		padding: 9px 12px;
		border-radius: 9px;
	}

	/* Landscape phones are short, not narrow: the sheet has to give up height
     rather than the scene disappearing behind it. */
	@media (max-height: 500px) {
		.sheet {
			max-height: 60vh;
		}
	}
</style>
