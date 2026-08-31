<script lang="ts">
	// Shown once, on a first visit — see `hasBeenWelcomed` in storage/persistence.

	import { fade, scale } from "svelte/transition";
	import { DIALOG_MS, DIALOG_SCALE, duration } from "./motion";

	interface Props {
		onpresets: () => void;
		onmissions: () => void;
		onclose: () => void;
	}

	let { onpresets, onmissions, onclose }: Props = $props();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- No backdrop-click dismissal: the first visit should end with a deliberate
     choice, not a stray click on the scene behind. -->
<div class="backdrop" role="presentation" transition:fade={{ duration: duration(DIALOG_MS) }}>
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-label="Welcome to Newton's Orchard"
		transition:scale={{ duration: duration(DIALOG_MS), start: DIALOG_SCALE, opacity: 0 }}
	>
		<header>
			<h2>Welcome to Newton's Orchard</h2>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</header>

		<div class="body">
			<p class="lede">Explore and experiment with space systems and gravity.</p>

			<p>
				Newton's Orchard is a playground for exploring how gravity, mass, and velocity work. Experiment with our own
				solar system, complete missions, or design your own solar system and experiments. Send us original systems that
				you've designed for inclusion in our gallery.
			</p>

			<div class="actions">
				<button class="action primary" onclick={onpresets}>
					<span class="title">Load a system</span>
					<span class="sub">Our solar system, binary stars, and other systems to explore</span>
				</button>

				<button class="action" onclick={onmissions}>
					<span class="title">Start a mission</span>
					<span class="sub">Question, predict, test, observe, repeat</span>
				</button>

				<button class="action quiet" onclick={onclose}>
					<span class="title">Just let me explore</span>
					<span class="sub">Start off in our own solar system</span>
				</button>
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
		padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
		box-sizing: border-box;
	}

	.dialog {
		width: 480px;
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
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}

	/* Matches the About dialog's serif title — this is the app introducing
     itself, not a piece of chrome. */
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

	.body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 14px 14px;
		font-size: 14px;
		line-height: 1.5;
	}

	.body p {
		margin: 0 0 10px;
	}

	.lede {
		font-size: 15px;
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}

	.action {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 9px 12px;
		text-align: left;
		background: var(--bg-raised);
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.action:hover,
	.action:focus-visible {
		border-color: var(--accent);
	}

	.action.primary {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
	}

	.action .title {
		font-size: 14px;
		font-weight: 600;
	}

	.action .sub {
		font-size: 12px;
		line-height: 1.35;
		color: var(--text-dim);
	}

	/* The way out reads as the way out: same hit target, less pull. */
	.action.quiet .title {
		font-weight: 500;
		color: var(--text-dim);
	}

	.action.quiet:hover .title,
	.action.quiet:focus-visible .title {
		color: var(--text);
	}

	/* --- narrow viewports ------------------------------------------------- */
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

		.action {
			padding: 11px 13px;
		}

		.action .title {
			font-size: 16px;
		}

		.action .sub {
			font-size: 13px;
		}
	}
</style>
