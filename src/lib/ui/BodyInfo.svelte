<script lang="ts">
	// Live readout for the selected body: speed, distance from its parent,
	// orbital period, and apsides.
	//
	// Every number here is derived from the sim's *current* state vector, so it
	// describes whatever time is being viewed — scrub back and the numbers follow.
	// Nothing is accumulated.
	//
	// The sim is not reactive, so this samples it on an interval rather than in
	// the render loop. At 5 Hz the readout looks live but costs nothing next to
	// the frame loop, and physics data still never enters Svelte's reactive graph
	// (only the handful of derived display numbers below do).

	import { onMount } from "svelte";
	import { sim } from "../state/simInstance";
	import { isSatelliteLanding, system } from "../state/system.svelte";
	import { ui } from "../state/ui.svelte";
	import { dominantAttractor, summarizeOrbit } from "../physics/orbitInfo";
	import { C } from "../physics/constants";
	import { formatSimDate } from "./formatTime";
	import { formatNumber, formatPeriod, toAu } from "./units";

	/** How often to resample the sim, ms. */
	const SAMPLE_INTERVAL = 200;

	/**
	 * Show the clock-rate row only once the effect reaches 0.05%. Everything in
	 * a planetary system sits far below that (Earth's orbital motion is ~5e-9),
	 * so the row appears exactly where it means something: near a black hole.
	 */
	const CLOCK_RATE_THRESHOLD = 0.9995;

	/**
	 * Why a selected body isn't in the state right now, with the date that
	 * bounds its presence: absorbed in the past, or created at a time the clock
	 * hasn't reached. `absent` is the fallback when neither timeline record
	 * exists (e.g. the birth was invalidated by an edit at an earlier time).
	 */
	type GoneInfo =
		| { kind: "merged"; into: string; landing: boolean; t: number }
		| { kind: "deleted"; t: number; returns: number | null }
		| { kind: "unborn"; t: number }
		| { kind: "absent" };

	interface Readout {
		alive: boolean;
		gone?: GoneInfo;
		/** m/s in the inertial frame */
		speed: number;
		parentName: string | null;
		/** m, center to center */
		distance: number | null;
		/**
		 * Height above the parent's surface, m — `distance` less both radii.
		 *
		 * Shown only when it's small against the parent (see the template): for a
		 * planet around a star, distance-from-center and height-above-surface are
		 * the same number to four digits and the second line is noise. For anything
		 * in real low orbit it's the number that identifies the orbit — the ISS
		 * reads 6797 km from Earth's center, which is 426 km up.
		 */
		altitude: number | null;
		relativeSpeed: number | null;
		period: number | null;
		apoapsis: number | null;
		periapsis: number | null;
		eccentricity: number | null;
		inclination: number | null;
		bound: boolean;
		/**
		 * dτ/dt — proper seconds per sim second, from the weak-field combination
		 * √(1 − Σ r_s/d − v²/c²): gravitational dilation summed over every black
		 * hole plus the special-relativistic term from inertial speed. Derived
		 * from the current state vector like everything else here, never
		 * accumulated. Null when so close to 1 the row would be noise.
		 */
		clockRate: number | null;
	}

	let readout = $state<Readout | null>(null);

	function sample(): void {
		const id = ui.selectedBodyId;
		if (id === null) {
			readout = null;
			return;
		}

		const index = sim.aliveIds.indexOf(id);
		if (index < 0) {
			// Selected but not alive: absorbed by now, or created later on.
			readout = {
				alive: false,
				gone: goneInfo(id),
				clockRate: null,
				speed: 0,
				parentName: null,
				distance: null,
				altitude: null,
				relativeSpeed: null,
				period: null,
				apoapsis: null,
				periapsis: null,
				eccentricity: null,
				inclination: null,
				bound: false
			};
			return;
		}

		const { pos, vel, mass, n } = sim.state;
		const i3 = index * 3;
		const speed = Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]);
		const clockRate = clockRateAt(index, speed);

		const parent = dominantAttractor(index, mass, pos, n);
		if (parent === null) {
			// The most massive body orbits nothing; only its speed is meaningful.
			readout = {
				alive: true,
				speed,
				clockRate,
				parentName: null,
				distance: null,
				altitude: null,
				relativeSpeed: null,
				period: null,
				apoapsis: null,
				periapsis: null,
				eccentricity: null,
				inclination: null,
				bound: false
			};
			return;
		}

		const summary = summarizeOrbit(mass[parent], stateAt(parent), stateAt(index), mass[index]);

		// Surface to surface. The physics `radius` array is the collision size,
		// which some presets inflate (see Body.collisionRadius); the roster's is
		// the true one, so read altitude from that and fall back to the physics
		// value only if the body somehow isn't in the roster.
		const trueRadius = (i: number): number => {
			const body = system.byId(sim.aliveIds[i]);
			return body?.radius ?? sim.state.radius[i];
		};
		const gap = summary.distance - trueRadius(parent) - trueRadius(index);

		readout = {
			alive: true,
			speed,
			clockRate,
			parentName: system.byId(sim.aliveIds[parent])?.name ?? "—",
			distance: summary.distance,
			altitude: gap,
			relativeSpeed: summary.relativeSpeed,
			period: summary.period,
			apoapsis: summary.apoapsis,
			periapsis: summary.periapsis,
			eccentricity: summary.eccentricity,
			inclination: summary.inclination,
			bound: summary.bound
		};
	}

	function goneInfo(id: string): GoneInfo {
		const merge = sim.merges.find((e) => e.absorbedId === id && e.t <= sim.time);
		if (merge) {
			return {
				kind: "merged",
				into: merge.survivorName,
				landing: isSatelliteLanding(merge),
				t: merge.t
			};
		}
		const deleted = sim.deletedAt(id);
		// An undo further along the timeline can bring a deleted body back;
		// `appearsAt` finds that re-entry, so the message can name it.
		if (deleted !== null) return { kind: "deleted", t: deleted, returns: sim.appearsAt(id) };
		const birth = sim.appearsAt(id);
		if (birth !== null) return { kind: "unborn", t: birth };
		return { kind: "absent" };
	}

	function stateAt(i: number) {
		const { pos, vel } = sim.state;
		const i3 = i * 3;
		return {
			position: { x: pos[i3], y: pos[i3 + 1], z: pos[i3 + 2] },
			velocity: { x: vel[i3], y: vel[i3 + 1], z: vel[i3 + 2] }
		};
	}

	/** See Readout.clockRate. Null when the effect is below the display threshold. */
	function clockRateAt(index: number, speed: number): number | null {
		const { pos, rs, n } = sim.state;
		const i3 = index * 3;

		let gravitational = 0;
		for (let j = 0; j < n; j++) {
			if (j === index || rs[j] === 0) continue;
			const j3 = j * 3;
			const d = Math.hypot(pos[j3] - pos[i3], pos[j3 + 1] - pos[i3 + 1], pos[j3 + 2] - pos[i3 + 2]);
			if (d > 0) gravitational += rs[j] / d;
		}

		const beta = speed / C;
		const rate = Math.sqrt(Math.max(0, 1 - gravitational - beta * beta));
		return rate < CLOCK_RATE_THRESHOLD ? rate : null;
	}

	onMount(() => {
		sample();
		const handle = setInterval(sample, SAMPLE_INTERVAL);
		return () => clearInterval(handle);
	});

	// Resample immediately on selection change rather than waiting out the
	// interval, so clicking a body doesn't show the previous one's numbers.
	$effect(() => {
		void ui.selectedBodyId;
		sample();
	});

	/**
	 * Whether the altitude line earns its row. Below 90% of the center-to-center
	 * distance the two numbers are visibly different and the surface one is what
	 * a low orbit is normally quoted by; above that they'd read as duplicates.
	 * A negative gap (overlapping bodies, mid-merge) is also worth showing.
	 */
	function showAltitude(r: Readout): boolean {
		if (r.altitude === null || r.distance === null || r.distance <= 0) return false;
		return r.altitude / r.distance < 0.9;
	}

	/** Distance reads in AU beyond ~0.01 AU, and in km below it (moons). */
	function formatDistance(meters: number): string {
		const au = toAu(meters);
		if (au >= 0.01) return `${formatNumber(au, 4)} AU`;
		return `${formatNumber(meters / 1e3, 4)} km`;
	}
</script>

{#if readout}
	<div class="info">
		{#if !readout.alive}
			{#if readout.gone?.kind === "merged"}
				<p class="gone">
					{readout.gone.landing ? "Landed on" : "Merged into"}
					{readout.gone.into} — {formatSimDate(readout.gone.t)}.
				</p>
			{:else if readout.gone?.kind === "deleted"}
				<p class="gone">
					Deleted — {formatSimDate(readout.gone.t)}.
					{#if readout.gone.returns !== null}Returns {formatSimDate(readout.gone.returns)}.{/if}
				</p>
			{:else if readout.gone?.kind === "unborn"}
				<p class="gone">Not created yet — appears {formatSimDate(readout.gone.t)}.</p>
			{:else}
				<p class="gone">Not present at this time.</p>
			{/if}
		{:else}
			<dl>
				<!-- Named for its frame, not just "Speed". For anything in orbit around
             a planet the inertial figure is dominated by the parent's own
             motion — Hubble reads ~33 km/s inertially and ~7.6 km/s around
             Earth, and only the second is the number anyone quotes a satellite
             by — so an unqualified "Speed" reads as the sim being wrong. -->
				<dt>Speed <span class="frame">(abs.)</span></dt>
				<dd>{formatNumber(readout.speed / 1e3, 4)} km/s</dd>

				<!-- Appears only when relativity is measurable — in practice, near a
             black hole. 0.893 means this body's clock runs at 89.3% of sim
             time, from gravity and speed combined. -->
				{#if readout.clockRate !== null}
					<dt>Clock rate</dt>
					<dd>{formatNumber(readout.clockRate, 4)}×</dd>
				{/if}

				{#if readout.parentName}
					<dt>Orbits</dt>
					<dd>{readout.parentName}</dd>

					<dt>Distance</dt>
					<dd>{formatDistance(readout.distance ?? 0)}</dd>

					<!-- Only where it says something the line above doesn't: in close
               orbit the two differ by most of the number, out at planetary
               distances they agree to four digits. -->
					{#if showAltitude(readout)}
						<dt>Altitude</dt>
						<dd>{formatDistance(readout.altitude ?? 0)}</dd>
					{/if}

					<dt>Speed <span class="frame">(rel. {readout.parentName})</span></dt>
					<dd>{formatNumber((readout.relativeSpeed ?? 0) / 1e3, 4)} km/s</dd>

					<dt>Period</dt>
					<dd>{readout.bound ? formatPeriod(readout.period ?? 0) : "n/a"}</dd>

					<dt>Periapsis</dt>
					<dd>{formatDistance(readout.periapsis ?? 0)}</dd>

					<dt>Apoapsis</dt>
					<dd>{readout.apoapsis === null ? "n/a" : formatDistance(readout.apoapsis)}</dd>

					<dt>Eccentricity</dt>
					<dd>{formatNumber(readout.eccentricity ?? 0, 3)}</dd>

					<dt>Inclination</dt>
					<dd>{formatNumber(readout.inclination ?? 0, 3)}°</dd>
				{:else}
					<dt>Orbits</dt>
					<dd class="dim">nothing — most massive body</dd>
				{/if}
			</dl>

			{#if readout.parentName && !readout.bound}
				<p class="note">Unbound trajectory — this body is escaping.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.info {
		margin-bottom: 10px;
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 0;
		font-size: 12px;
	}

	dt {
		color: var(--text-dim);
	}

	dd {
		margin: 0;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	dd.dim {
		color: var(--text-dim);
	}

	/* The frame qualifier is context for the label, not part of it. */
	.frame {
		opacity: 0.65;
		font-size: 10px;
	}

	.note,
	.gone {
		margin: 8px 0 0;
		font-size: 11px;
		color: var(--text-dim);
		line-height: 1.4;
	}
</style>
