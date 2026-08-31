<script lang="ts">
	// The tree button in the menu bar. Nothing but the toggle: the shelf it
	// opens is `SystemShelf.svelte`, mounted by App at the top level because this
	// panel's `backdrop-filter` would trap a fixed-position descendant inside the
	// 40 px button.

	import { TreeDeciduous } from "lucide-svelte";

	let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<div class="system-menu">
	<button
		class="menu-toggle"
		class:active={open}
		onclick={() => (open = !open)}
		aria-expanded={open}
		aria-label="System menu"
		title="Systems, saving and files"
	>
		<TreeDeciduous size={20} strokeWidth={1.75} aria-hidden="true" />
	</button>
</div>

<style>
	.system-menu {
		position: relative;
		display: flex;
		align-items: center;
	}

	/* The toggle fills its `.menu-bar` panel rather than sitting inset in it, so
	   it carries the panel's radius. Not `inherit`: the immediate parent is the
	   unstyled `.system-menu` wrapper, so inheriting gives square corners and
	   the active accent border renders as a box inside a rounded panel. 9px is
	   the panel's 10px less its 1px border — the inner edge of the curve. */
	.menu-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border-radius: 9px;
		background: transparent;
		border-color: transparent;
		color: var(--text-dim);
	}

	.menu-toggle:hover {
		border-color: var(--border);
		color: var(--text);
	}

	.menu-toggle.active {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>
