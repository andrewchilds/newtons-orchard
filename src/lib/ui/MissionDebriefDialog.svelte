<script lang="ts">
	// The mission debrief: "what happened?", opened after watching the sim.
	//
	// It states the outcome rather than asking for it back. The mission is
	// predict → observe → explain, and this is the explain step: the outcome
	// card says what the sim did, and "Why?" gives the mechanism and the idea it
	// generalises to. Nothing is graded — opening this dialog completes the
	// mission, because doing the experiment is the achievement, not guessing it.
	//
	// The prediction is deliberately not replayed here. It stays visible in the
	// mission panel behind the dialog while the sim runs, and nothing about it
	// is scored, so listing it back beside the outcome only invited reading the
	// pair as a mark. The debrief is about what the system did.
	//
	// The outcome *is* named by its letter ("It was C"), which is a different
	// thing: it identifies which of the offered options the sim bore out, and
	// the user's own letter is nowhere on screen to compare it to. Don't add it
	// back — a pair of letters side by side is a mark, whatever the copy says.

	import { choiceLetter, type Mission } from "../presets/missions";
	import { untrack } from "svelte";
	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";

	interface Props {
		mission: Mission;
		/** Fired once on open — reaching the debrief is what completes the mission. */
		oncomplete: () => void;
		onclose: () => void;
	}

	let { mission, oncomplete, onclose }: Props = $props();

	const outcome = $derived(mission.outcome);

	// Completion fires on mount rather than on a click: there's no answer to
	// submit any more, so arriving here *is* the completion. Untracked and
	// fired once — the effect must not re-run if a prop changes identity, and
	// `completeActive` is idempotent anyway, so this is belt and braces.
	$effect(() => {
		untrack(() => oncomplete());
	});
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
		aria-label="What happened"
		style:--mission-color={mission.color}
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<h2>{mission.name}: What happened?</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<div class="body">
			<p class="question">{mission.question}</p>

			<!-- The outcome, stated. Fronted by an icon and the mission's own
			     accent so it reads as the answer to the question above it. -->
			<div class="outcome">
				<span class="icon" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
						<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
						<ellipse cx="12" cy="12" rx="9.5" ry="4.4" transform="rotate(-28 12 12)" />
						<circle cx="20" cy="8.4" r="1.5" fill="currentColor" stroke="none" />
					</svg>
				</span>
				<div class="statement">
					<!-- Which of the offered options the sim bore out, by letter. It
					     names an option, not a mark: the user's own pick isn't shown
					     here (see the note at the top), so there's nothing to compare
					     it against — it's the tie back to the list they read. -->
					<p class="answer">It was <strong>{choiceLetter(outcome.choice)}</strong></p>
					<p>
						{outcome.summary}
						{#if outcome.measured}
							<span class="measured">Measured: {outcome.measured}.</span>
						{/if}
					</p>
				</div>
			</div>

			<section class="prose">
				<h3>Why?</h3>
				<p>{outcome.why}</p>
			</section>

			{#if mission.notes.followUps && mission.notes.followUps.length > 0}
				<section class="prose">
					<h3>Try next</h3>
					<ul class="follow-ups">
						{#each mission.notes.followUps as followUp (followUp)}
							<li>{followUp}</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section class="prose">
				<h3>Learn more</h3>
				<nav class="links" aria-label="Further reading">
					{#each mission.notes.links as link (link.url)}
						<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>
					{/each}
				</nav>
			</section>
		</div>

		<footer>
			<button class="done" onclick={onclose}>Done</button>
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
		width: 740px;
		max-width: 100%;
		max-height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg-panel);
		border: 1px solid var(--border);
		border-radius: 14px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
	}

	header {
		display: flex;
		align-items: center;
		flex: none;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border);
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}

	.close {
		background: none;
		border: none;
		font-size: 24px;
		line-height: 1;
		color: var(--text-dim);
		padding: 0 6px;
	}

	.close:hover {
		color: var(--text);
	}

	.body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior: contain;
		padding: 18px 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.question {
		margin: 0;
		font-size: 22px;
		font-weight: 700;
		line-height: 1.3;
	}

	/* The outcome card: the mission's accent, weighted like the headline it is.
     Sits directly under the question it answers. */
	.outcome {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 18px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--mission-color) 12%, var(--bg-raised));
		border: 1px solid color-mix(in srgb, var(--mission-color) 55%, var(--border));
	}

	.statement {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.outcome p {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
		line-height: 1.35;
	}

	/* The letter line is a label above the sentence, not part of it: smaller and
	   in the mission's accent, so the eye lands on what happened. */
	.outcome p.answer {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--mission-color);
	}

	.answer strong {
		font-size: 15px;
		font-weight: 800;
	}

	/* A measured value belongs with the statement, not in a section of its own —
     it's the same sentence, quantified. */
	.measured {
		display: block;
		margin-top: 4px;
		font-size: 15px;
		font-weight: 500;
		color: var(--text-dim);
	}

	/* The icon disc on the outcome card. */
	.icon {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--mission-color) 22%, transparent);
		border: 1px solid color-mix(in srgb, var(--mission-color) 60%, transparent);
		color: var(--mission-color);
	}

	.icon svg {
		width: 24px;
		height: 24px;
	}

	.prose {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.prose h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
		color: var(--text);
	}

	.prose > p {
		margin: 0;
		font-size: 15px;
		line-height: 1.5;
		color: var(--text);
	}

	.follow-ups {
		margin: 0;
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.follow-ups li {
		font-size: 15px;
		line-height: 1.45;
		color: var(--text-dim);
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.links a {
		font-size: 14px;
		color: var(--text);
		text-decoration: none;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 5px 12px;
	}

	.links a:hover,
	.links a:focus-visible {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, var(--bg-raised));
	}

	footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: none;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
	}

	.done {
		font-size: 16px;
		font-weight: 600;
		padding: 9px 24px;
		border-radius: 10px;
	}

	/* Narrow viewports — mirrors the mission picker's phone layout. */
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

		header {
			padding: 12px;
		}

		h2 {
			font-size: 17px;
		}

		.body {
			padding: 14px 12px;
		}

		.question {
			font-size: 19px;
		}

		.outcome {
			gap: 12px;
			padding: 14px;
		}

		/* The answer letter keeps its own size — it's a label, and `p.answer`
		   outranks this anyway. */
		.outcome p:not(.answer) {
			font-size: 17px;
		}

		/* The icon disc is the first thing to go: on a phone the sentence needs
       the width more than the decoration does. */
		.outcome .icon {
			display: none;
		}

		footer {
			padding: 12px;
		}
	}
</style>
