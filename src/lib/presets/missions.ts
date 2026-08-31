// Missions: a starting system plus a question to answer by experimenting.
//
// A mission loads an *unmodified* system in the app — the student makes the
// change and watches what happens. The shape is predict → observe → explain,
// not a quiz: nothing grades, and the debrief states what happened rather than
// replaying the prediction beside it for comparison.
//
// A card portrait shows the mission's *starting point*, framed on its subject:
// the system pre-rolled to lay down trails, then the edit made — and shot right
// there, before any consequence has played out. The picture poses the question
// rather than answering it. Nothing in the app calls `setup`; it runs only
// under `npm run preset-screenshots -- --missions`.

import { AU, schwarzschildRadius } from "../physics/constants";
import { circularVelocityAt, type StateVector } from "../physics/kepler";
import type { Body, BodyType } from "../types";
import type { PresetShot, PresetTiming } from "./examples";
import { figureEight, presetById } from "./examples";
import { solarSystem } from "./solarSystem";

/**
 * What actually happened, revealed by "Complete mission".
 *
 * `choice` indexes the mission's `choices`. Nothing compares it against the
 * user's pick — it is not a grade, and the mission completes either way — but
 * the scenario tests pin it, so a sim outcome that moves fails a test rather
 * than silently mis-stating the physics.
 */
export interface MissionOutcome {
	/** Index into `choices` of what the sim actually does. */
	choice: number;
	/** The headline: what happened, stated plainly. */
	summary: string;
	/**
	 * Why it happened — the mechanism, then the idea it generalises to. Two or
	 * three sentences: the general point lands harder attached to the mechanism
	 * that produced it than pulled out into a callout of its own.
	 */
	why: string;
	/** For a measured outcome, the value to state alongside — "about 65 days". */
	measured?: string;
}

/**
 * Closing notes shown with the outcome. Kept out of the picker and the
 * prediction step: they discuss the outcome, so they must not appear until the
 * student has watched the sim.
 */
export interface MissionNotes {
	/** Further reading, opened in a new tab. */
	links: { label: string; url: string }[];
	/** Experiments to try next with the same controls. */
	followUps: string[];
}

/**
 * A mission's edit, *described* rather than performed — the student's own
 * keystroke, expressed as data.
 *
 * Declarative because `presets/` must not import app state: the mutation path
 * lives in `state/system.svelte.ts`, which imports `mission.svelte.ts`, which
 * imports this registry. Calling the former from here closes that loop and
 * `MISSIONS` is undefined at module init. So a setup names what to change and
 * `ui/capture.ts` — which already owns the app-state dependency — applies it
 * through the ordinary mutation path, at the current time, after the pre-roll.
 *
 * Every variant identifies its target by *name*, resolved against the live
 * roster at the moment of the edit rather than the array `build()` returned.
 */
export type MissionEdit =
	/** Scale a body's mass — "type *2 in the Mass box". */
	| { kind: "scaleMass"; body: string; factor: number }
	/**
	 * Scale all three velocity components — 0 stops a body dead, -1 reverses it.
	 * Applied to the body's *live* velocity: after a pre-roll the roster still
	 * holds the t = 0 one, and reversing that would send a body off in a
	 * direction it hadn't been travelling for months.
	 */
	| { kind: "scaleVelocity"; body: string; factor: number }
	/** Scale one velocity component, for a nudge along a named axis. */
	| { kind: "scaleVelocityAxis"; body: string; axis: "x" | "y" | "z"; factor: number }
	/** Retype a body, carrying whatever radius the new type implies. */
	| { kind: "setType"; body: string; type: BodyType; radius: (mass: number) => number }
	/** Delete a body. */
	| { kind: "delete"; body: string }
	/**
	 * Place a body on a circular orbit around `around` at `distance` metres —
	 * what a drag drops (`previewDrop`), rather than a teleport that leaves the
	 * old velocity attached. `body` may name one that doesn't exist yet, in
	 * which case `create` builds it.
	 */
	| {
			kind: "circularOrbit";
			body: string;
			around: string;
			distance: number;
			create?: (position: StateVector["position"], velocity: StateVector["velocity"]) => Body;
	  };

/** A mission's edit as a list, since nothing yet needs more than one step. */
export type MissionSetup = MissionEdit[];

/**
 * A control the chrome points at while a step is current. Named abstractly —
 * "the Mass box", "the Center selector" — and resolved by whichever component
 * renders that control: each candidate applies the global `guide-glow` class
 * *declaratively* when it matches, never via a DOM query, so the highlight
 * tracks mount and layout for free (including targets that don't exist yet,
 * like an editor field before its body is selected).
 */
export type StepTarget =
	/** The body's row in the Objects list. */
	| { kind: "roster"; body: string }
	/** A field in the body editor; glows only while `body` is the one selected. */
	| {
			kind: "editor";
			body: string;
			field: "mass" | "radius" | "type" | "velocity";
			/** One velocity component; omitted means all three. */
			axis?: "x" | "y" | "z";
	  }
	/** The Center (reference frame) selector. */
	| { kind: "center" }
	/** The + Add menu over the Objects list. */
	| { kind: "add" }
	| { kind: "play" }
	/** The date readout in the time panel. */
	| { kind: "date" };

/** The roster fields the mutation path reports to the mission checklist. */
export type EditedField = "mass" | "radius" | "type" | "velocity" | "position";

/**
 * How the app tells a step happened, so the checklist ticks itself.
 *
 * Two families. `selected`/`edited`/`playing` are *latched* observations
 * (`mission.note`): they describe moments, and reading them live would un-tick
 * "Press Play" the instant the student pauses to look. The rest read live
 * state, where un-ticking is the truthful answer — setting the Sun's type back
 * from blackhole really does undo that step.
 *
 * `edited` is an event, not a comparison against the loaded roster, because
 * every commit rebases every body's position and velocity to the current time
 * — there is nothing stable to compare a velocity edit against. The mutation
 * path names the fields that changed instead.
 */
export type StepCheck =
	| { kind: "selected"; body: string }
	| { kind: "edited"; body: string; field: EditedField }
	| { kind: "typeIs"; body: string; type: BodyType }
	| { kind: "deleted"; body: string }
	/** Any body beyond the loaded roster — creation issues fresh ids. */
	| { kind: "added" }
	| { kind: "centerIs"; body: string }
	/** Two bodies within `within` metres of each other, by live position. */
	| { kind: "near"; body: string; other: string; within: number }
	| { kind: "playing" };

/**
 * One instruction in the mission panel's checklist. A step without a `check`
 * is a watch-finale — nothing completes it, so the current-step pointer parks
 * there. That's why checkless steps must come last (a registry test enforces
 * it): a checked step after one would never become current.
 */
export interface MissionStep {
	text: string;
	/** What to highlight while this step is current. */
	target?: StepTarget;
	/** How the checklist ticks it; absent on watch-finales. */
	check?: StepCheck;
}

export interface Mission {
	id: string;
	name: string;
	/**
	 * Picker section heading. The picker groups *consecutive* runs, so a
	 * category's missions must sit adjacent in `MISSIONS` or a straggler gets a
	 * duplicate heading (a test enforces contiguity).
	 */
	category: string;
	/** The question to answer — posed before playing, so it invites a prediction. */
	question: string;
	/**
	 * What to do, one action per step, each pointing at the control it happens
	 * in — without spoiling the outcome. Shown only in the in-flight mission
	 * panel: the picker stops at the prediction, so these are read beside the
	 * controls they highlight rather than memorized from a dialog.
	 */
	steps: MissionStep[];
	/**
	 * The prediction step's sub-prompt, asking for the guess in terms of what to
	 * watch where `question` states the scenario.
	 */
	predictPrompt: string;
	/**
	 * Prediction options, posed before the mission loads. Array order is both
	 * display order and the labelling — choices are A, B, C by position
	 * (`choiceLetter`) — so reordering renames them and `outcome.choice` must
	 * move with them.
	 */
	choices: string[];
	/** What happens, and why — revealed by "Complete mission". */
	outcome: MissionOutcome;
	/** Shown with the outcome — see `MissionNotes`. */
	notes: MissionNotes;
	/**
	 * Missions completed before this one is offered — same contract as
	 * `Preset.unlockAfterMissions`. Gates *offering* only; nothing else checks it.
	 */
	unlockAfterMissions?: number;
	/** Card accent in the picker — loosely the subject body's own color. */
	color: string;
	/**
	 * How `npm run preset-screenshots -- --missions` photographs the card image
	 * (`public/missions/<id>.jpg`): a close portrait of the body the question is
	 * about, not the whole system. Same contract as `Preset.shot`.
	 *
	 * `days` is a **pre-roll of the unedited system**, run only to lay down
	 * trails; the edit lands after it and the shot fires immediately. So the
	 * span must stay short of anything the mission asks the student to discover
	 * — see `MissionSetup`.
	 */
	shot: PresetShot;
	build: () => Body[];
	/**
	 * The mission's edit, made on the live system after the pre-roll and just
	 * before the shutter. It stands in for what the student types into the
	 * editor, so it goes through `state/system.svelte.ts` like any other edit.
	 *
	 * Two failure modes it sits between. Without it, every mission in a category
	 * photographs the same untouched solar system — Dark Sun showed an ordinary
	 * Sun. Run it and then integrate, though, and the card shows the *answer*:
	 * Full Stop drew Earth halfway down its fall, which is the thing the student
	 * is asked to predict. The edit is made and immediately photographed.
	 */
	setup?: MissionSetup;
	/** Timing-grid overrides, same contract as `Preset.timing`. */
	timing?: PresetTiming;
}

/** Every mission, in menu order. Missions sharing a `category` must sit together. */
export const MISSIONS: Mission[] = [
	{
		id: "half-a-sun",
		name: "Half a Sun",
		category: "The Sun",
		question: "What if the Sun lost half its mass?",
		steps: [
			{
				text: "Pick the Sun in the Objects list.",
				target: { kind: "roster", body: "Sun" },
				check: { kind: "selected", body: "Sun" }
			},
			{
				text: "In the Mass box, type /2 and press Enter.",
				target: { kind: "editor", body: "Sun", field: "mass" },
				check: { kind: "edited", body: "Sun", field: "mass" }
			},
			{
				text: "Press Play and watch the planets.",
				target: { kind: "play" },
				check: { kind: "playing" }
			}
		],
		predictPrompt: "What do you think will happen to the planets' orbits?",
		choices: ["They stay the same", "They get a little bigger", "They get much bigger, and most escape"],
		outcome: {
			choice: 2,
			summary: "The planets swung into much larger orbits, and most escaped.",
			why: "Our Sun's mass determines how strongly it pulls on the planets. With only half the mass, its gravity became too weak to keep the planets in their old orbits."
		},
		notes: {
			links: [
				{ label: "Escape velocity", url: "https://en.wikipedia.org/wiki/Escape_velocity" },
				{ label: "Orbit", url: "https://en.wikipedia.org/wiki/Orbit" }
			],
			followUps: [
				"Reset the mission and try /1.9 instead of /2. Which planet escapes its orbit?",
				"Did the Moon continue to orbit the Earth?"
			]
		},
		color: "#ffd27f",
		// The Sun itself, close: the mission is about its mass, and the card should
		// put the student in front of the star they're about to halve. 40 days of
		// Mercury's orbit (88-day period) draws a live arc past it for scale
		// without showing anything about the outcome.
		shot: { days: 40, exaggeration: 60, center: "Sun", zoom: 9e10 },
		build: solarSystem,
		setup: [{ kind: "scaleMass", body: "Sun", factor: 0.5 }]
	},
	{
		id: "double-sun",
		name: "Double Sun",
		category: "The Sun",
		question: "What if the Sun got twice as heavy?",
		steps: [
			{
				text: "Pick the Sun in the Objects list.",
				target: { kind: "roster", body: "Sun" },
				check: { kind: "selected", body: "Sun" }
			},
			{
				text: "In the Mass box, type *2 and press Enter.",
				target: { kind: "editor", body: "Sun", field: "mass" },
				check: { kind: "edited", body: "Sun", field: "mass" }
			},
			{
				text: "Press Play and watch the shape each orbit traces.",
				target: { kind: "play" },
				check: { kind: "playing" }
			}
		],
		predictPrompt: "What shape will the planets' orbits become?",
		choices: ["Circles, just smaller", "Ellipses (ovals)", "The planets will fall into the Sun"],
		outcome: {
			choice: 1,
			summary: "The planetary orbits became ellipses.",
			why: "Every planet was moving at the speed its old orbit needed. When you double the Sun's mass, that speed is too slow to hold a circle, so each planet falls inward, speeds up, and swings back out to where it started."
		},
		notes: {
			links: [
				{ label: "Elliptic orbit", url: "https://en.wikipedia.org/wiki/Elliptic_orbit" },
				{ label: "Apsis", url: "https://en.wikipedia.org/wiki/Apsis" }
			],
			followUps: [
				"A heavier Sun needs a faster planet. Try *1.4 on each of Earth's three Velocity numbers — can you get its circle back?",
				"How heavy must the Sun get before a planet actually falls into it?",
				"What might life on Earth be like if this was our orbit?"
			]
		},
		color: "#ff9f5a",
		// Also a Sun-mass mission, so deliberately framed unlike Half a Sun's tight
		// portrait: further out and a longer pre-roll, showing the Sun held in the
		// ring of circular inner orbits this mission is about to distort. The
		// circles are the *starting* state — what they become is the question.
		shot: { days: 200, exaggeration: 100, center: "Sun", zoom: 3e10 },
		build: solarSystem,
		setup: [{ kind: "scaleMass", body: "Sun", factor: 2 }]
	},
	{
		id: "lights-out",
		name: "Lights Out",
		category: "The Sun",
		question: "What if the Sun disappeared?",
		steps: [
			{
				text: "Find the Sun in the Objects list and delete it with its × button.",
				target: { kind: "roster", body: "Sun" },
				check: { kind: "deleted", body: "Sun" }
			},
			{
				text: "Press Play.",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Look at the shape of each path — curved or straight?"
			}
		],
		predictPrompt: "What do you think the planets will do without the Sun?",
		choices: ["Keep circling the empty spot", "They fly off in a straight line", "Spiral slowly outward"],
		outcome: {
			choice: 1,
			summary: "Each planet flew off in a straight line.",
			why: "Gravity was the only thing bending each planet's path. With the Sun gone there's nothing left to bend it, so every planet simply carries on in the direction it was already heading."
		},
		notes: {
			links: [
				{ label: "Newton's laws of motion", url: "https://en.wikipedia.org/wiki/Newton%27s_laws_of_motion" },
				{ label: "Inertia", url: "https://en.wikipedia.org/wiki/Inertia" }
			],
			followUps: [
				"Watch Earth closely as it leaves. Does the Moon go with it?",
				"Can you figure out which planet is moving the fastest away from the center?"
			]
		},
		color: "#8a7fff",
		shot: { days: 2 * 365, exaggeration: 10, zoom: 9.1e11 },
		build: solarSystem,
		// The only deletion among the setups, and the one edit that is visible on
		// its own: the star is simply gone from the middle of its own orbits.
		setup: [{ kind: "delete", body: "Sun" }]
	},
	{
		// Unlocks with the blackhole body type itself (threshold read off the
		// black-hole preset, the one place it's written) because the task needs
		// that type in the picker. A same-mass hole swaps Newtonian for
		// Paczyński–Wiita, so "nothing changes" is honest rather than exact: the
		// correction at 1 AU is ~1e-7 of the force, and the scenario test bounds
		// the year's drift well under 1e-3 AU. The radius step's 3 km is the
		// Sun's real Schwarzschild radius, 2GM/c² ≈ 2.95 km.
		id: "dark-sun",
		name: "Dark Sun",
		category: "The Sun",
		question: "What if the Sun collapsed into a black hole?",
		steps: [
			{
				text: "Pick the Sun in the Objects list.",
				target: { kind: "roster", body: "Sun" },
				check: { kind: "selected", body: "Sun" }
			},
			{
				text: "Set its Type to blackhole.",
				target: { kind: "editor", body: "Sun", field: "type" },
				check: { kind: "typeIs", body: "Sun", type: "blackhole" }
			},
			{
				text: "Set its Radius to 3 — that's 3 km, the real size of a black hole as heavy as the Sun.",
				target: { kind: "editor", body: "Sun", field: "radius" },
				check: { kind: "edited", body: "Sun", field: "radius" }
			},
			{
				text: "Press Play and watch the planets for a year.",
				target: { kind: "play" },
				check: { kind: "playing" }
			}
		],
		predictPrompt: "What do you think will happen to the planets' orbits?",
		choices: [
			"Everything gets pulled in to the black hole",
			"None of the orbits change at all",
			"The planets drift away into space"
		],
		outcome: {
			choice: 1,
			summary: "Nothing changed. Every planet held the same orbit it already had.",
			why: "Gravity depends on how much mass there is and how far away you are from it. The Sun's mass didn't change, and the planets are just as far from its center as before, so they feel the same gravitational force as before."
		},
		notes: {
			links: [
				{ label: "Schwarzschild radius", url: "https://en.wikipedia.org/wiki/Schwarzschild_radius" },
				{ label: "Black hole", url: "https://en.wikipedia.org/wiki/Black_hole" }
			],
			followUps: []
		},
		color: "#b8a27f",
		shot: { days: 500, exaggeration: 1000, center: "Sun", zoom: 1.9e10 },
		build: solarSystem,
		setup: [{ kind: "setType", body: "Sun", type: "blackhole", radius: schwarzschildRadius }],
		unlockAfterMissions: presetById("black-hole")?.unlockAfterMissions
	},
	{
		id: "mighty-moon",
		name: "Mighty Moon",
		category: "Earth & the Moon",
		question: "What if the Moon got twice as heavy?",
		steps: [
			{
				text: "Pick the Moon in the Objects list.",
				target: { kind: "roster", body: "Moon" },
				check: { kind: "selected", body: "Moon" }
			},
			{
				text: "In the Mass box, type *2 and press Enter.",
				target: { kind: "editor", body: "Moon", field: "mass" },
				check: { kind: "edited", body: "Moon", field: "mass" }
			},
			{
				text: "Set Center to Earth, so the view holds Earth still.",
				target: { kind: "center" },
				check: { kind: "centerIs", body: "Earth" }
			},
			{
				text: "Press Play and watch the Moon's path.",
				target: { kind: "play" },
				check: { kind: "playing" }
			}
		],
		predictPrompt: "What do you think will happen to the Moon's orbit?",
		choices: ["It swings in closer to Earth", "It drifts away from Earth", "Nothing much"],
		outcome: {
			choice: 2,
			summary: "Almost nothing changed about the Moon's orbit, but Earth wobbled a little more.",
			why: "What holds the Moon in its orbit is Earth's mass. Doubling the Moon does change how hard it tugs back on Earth, so the two now swing around a shared balance point that has moved further from Earth's center."
		},
		notes: {
			links: [
				{ label: "Barycenter", url: "https://en.wikipedia.org/wiki/Barycenter_(astronomy)" },
				{ label: "Two-body problem", url: "https://en.wikipedia.org/wiki/Two-body_problem" }
			],
			followUps: [
				"Keep going: *10, then *40. When do you first see a difference — and is it the Moon's path that changes, or Earth's?",
				"*81 makes the Moon as heavy as Earth. What does the pair look like then?"
			]
		},
		color: "#c9d2e0",
		// The subject is the Moon, so the card is the Moon's own portrait — the one
		// mission centered on it rather than on Earth, which is most of what makes
		// it distinguishable from the three Earth cards that follow. Ten days of
		// lunar orbit behind it; the mass edit itself has no visible signature.
		shot: { days: 10, exaggeration: 10, center: "Moon", zoom: 7e7, sunward: true },
		build: solarSystem,
		setup: [{ kind: "scaleMass", body: "Moon", factor: 2 }]
	},
	{
		// Measured (see the scenario test): at Earth ×300 the Moon is far below
		// the new circular speed and merges at t ≈ 7.2 hours, while Earth's own
		// heliocentric a and e move by ~1e-5 over five years. Hence a composite
		// answer, like Wrong Way Earth's: the orbit doesn't care, the satellite
		// very much does.
		id: "heavy-earth",
		name: "Heavy Earth",
		category: "Earth & the Moon",
		question: "What if Earth were as heavy as Jupiter?",
		steps: [
			{
				text: "Pick Earth in the Objects list.",
				target: { kind: "roster", body: "Earth" },
				check: { kind: "selected", body: "Earth" }
			},
			{
				text: "In the Mass box, type *300 and press Enter — that's Jupiter's weight.",
				target: { kind: "editor", body: "Earth", field: "mass" },
				check: { kind: "edited", body: "Earth", field: "mass" }
			},
			{
				text: "Set Center to Earth, so the view holds Earth still.",
				target: { kind: "center" },
				check: { kind: "centerIs", body: "Earth" }
			},
			{
				text: "Press Play and watch what the Moon does in the first day.",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Keep playing and watch the date — does Earth's year still take twelve months?",
				target: { kind: "date" }
			}
		],
		predictPrompt: "What do you think will happen to Earth's orbit? And to the Moon?",
		choices: [
			"Its year gets shorter",
			"Same orbit, same year, but the Moon comes crashing down",
			"It spirals into the Sun"
		],
		outcome: {
			choice: 1,
			summary: "Earth kept the same orbit and the same year, but the Moon crashed within hours.",
			why: "Heavy things and light things fall the same way. The Moon was moving at the right speed for the old Earth, and against 300 times the pull that's far too slow to stay up."
		},
		notes: {
			links: [
				{ label: "Equivalence principle", url: "https://en.wikipedia.org/wiki/Equivalence_principle" },
				{ label: "Orbital speed", url: "https://en.wikipedia.org/wiki/Orbital_speed" }
			],
			followUps: [
				"Find the heaviest Earth the Moon can survive. Its orbit pulls in tighter well before it falls.",
				"The Sun didn't care about Earth ×300. Try *30000 and watch what the Sun itself starts doing."
			]
		},
		color: "#3f7fd6",
		// Earth close up, lit, with the Moon still out on its orbit — the pair as
		// they stand at the moment of the edit. The old card ran a day *past* it,
		// by which point the Moon had merged and the card showed a lone Earth,
		// which is the mission's answer. A week of pre-roll gives the Moon a
		// visible arc; the ×300 leaves no mark of its own.
		shot: { days: 7, exaggeration: 25, center: "Earth", zoom: 8e8, sunward: true },
		build: solarSystem,
		setup: [{ kind: "scaleMass", body: "Earth", factor: 300 }]
	},
	{
		id: "full-stop",
		name: "Full Stop",
		category: "Earth & the Moon",
		question: "If Earth stopped moving, how long until it hits the Sun?",
		steps: [
			{
				text: "Pick Earth in the Objects list.",
				target: { kind: "roster", body: "Earth" },
				check: { kind: "selected", body: "Earth" }
			},
			{
				text: "Set Vel x, Vel y and Vel z all to 0 — that stops Earth dead.",
				target: { kind: "editor", body: "Earth", field: "velocity" },
				check: { kind: "edited", body: "Earth", field: "velocity" }
			},
			{
				text: "Press Play.",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Watch the date — how long does the fall take?",
				target: { kind: "date" }
			}
		],
		predictPrompt: "How long do you think the fall will take?",
		choices: ["About a week", "About two months", "About a year"],
		// Fall time is half the period of a degenerate orbit with a = ½ AU:
		// 365.25 · 0.5^1.5 / 2 ≈ 64.6 days. The numeric test pins the formula.
		outcome: {
			choice: 1,
			summary: "Earth fell straight into the Sun in about two months.",
			why: "Like any orbit, Earth's sideways speed is what keeps it from falling into the Sun.",
			measured: "about 65 days"
		},
		notes: {
			links: [
				{
					label: "Kepler's laws of planetary motion",
					url: "https://en.wikipedia.org/wiki/Kepler%27s_laws_of_planetary_motion"
				},
				{ label: "Free fall", url: "https://en.wikipedia.org/wiki/Free_fall" }
			],
			followUps: [
				"Stop Jupiter instead. Guess first: it's much further out, so does its fall take months or years?",
				"Instead of stopping Earth, try halving its speed (*0.5 on each Velocity number). How close to the Sun does it get?"
			]
		},
		color: "#5aa7ff",
		// Earth stopped on its own orbit, the Sun across the frame from it: the
		// setup for a fall that hasn't started. The old card ran 50 of the ~65 days
		// and drew the fall itself, trail aimed at the Sun — the answer to "how
		// long until it hits", handed over before the question was asked. 90 days
		// of pre-roll puts a quarter-orbit of trail behind Earth.
		shot: { days: 90, exaggeration: 400, zoom: 2.4e11 },
		build: solarSystem,
		setup: [{ kind: "scaleVelocity", body: "Earth", factor: 0 }]
	},
	{
		id: "wrong-way-earth",
		name: "Wrong Way Earth",
		category: "Earth & the Moon",
		question: "What if Earth went round the Sun backwards — would the Moon come too?",
		steps: [
			{
				text: "Pick Earth in the Objects list — just Earth, not the Moon.",
				target: { kind: "roster", body: "Earth" },
				check: { kind: "selected", body: "Earth" }
			},
			{
				text: "Put a - in front of Vel x, Vel y and Vel z, to send Earth back the way it came.",
				target: { kind: "editor", body: "Earth", field: "velocity" },
				check: { kind: "edited", body: "Earth", field: "velocity" }
			},
			{
				text: "Set Center to Earth, so the view holds Earth still.",
				target: { kind: "center" },
				check: { kind: "centerIs", body: "Earth" }
			},
			{
				text: "Press Play for a few days and watch the Moon.",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Then keep playing for a year to see Earth's own orbit."
			}
		],
		predictPrompt: "What do you think will happen to Earth's orbit, and to the Moon?",
		// Two answers in one, which is the point: a velocity flip leaves the
		// ellipse alone (gravity depends on position, not heading), but it's
		// applied to Earth alone, so Earth and the Moon part at ~60 km/s — far
		// beyond Earth's grip. The Moon is ~14 Earth–Moon distances away after a
		// day and ends on its own ~1.07 AU orbit. The scenario test pins both.
		choices: [
			"Earth keeps the same orbit backwards, and the Moon is left behind",
			"Earth keeps the same orbit backwards, and the Moon follows it round",
			"Earth spirals into the Sun, taking the Moon with it"
		],
		outcome: {
			choice: 0,
			summary: "Earth traced the very same orbit, just backwards — and the Moon was left behind.",
			why: "Gravity depends on where you are, not on which way you're going, so reversing Earth leaves the shape and size of its orbit untouched. The Moon kept its original heading, though."
		},
		notes: {
			links: [
				{
					label: "Retrograde and prograde motion",
					url: "https://en.wikipedia.org/wiki/Retrograde_and_prograde_motion"
				},
				{ label: "Escape velocity", url: "https://en.wikipedia.org/wiki/Escape_velocity" }
			],
			followUps: [
				"Reverse the Moon instead of Earth. Where does it end up?",
				"Reverse everything — every body, all three Velocity numbers. Does anything change?"
			]
		},
		color: "#5ad0c8",
		// Earth and the Moon still together, at the instant Earth is sent back the
		// way it came — five days *after* the flip was the old card, by which point
		// the Moon is 60 km/s behind and abandoned, which is the answer.
		//
		// Framed from further out than the other two Earth cards and looking down
		// the ecliptic, so the pair reads as a pair against the orbit they share:
		// this mission is about the two of them parting, where Mighty Moon is a
		// lunar portrait and Heavy Earth an Earth one.
		shot: { days: 20, exaggeration: 45, center: "Earth", zoom: 2.2e9, sunward: true },
		build: solarSystem,
		setup: [{ kind: "scaleVelocity", body: "Earth", factor: -1 }]
	},
	{
		id: "hot-jupiter",
		name: "Hot Jupiter",
		category: "Farther afield",
		question: "What if Jupiter moved in closer to the Sun than Mercury?",
		steps: [
			{
				text: "Pick Jupiter in the Objects list.",
				target: { kind: "roster", body: "Jupiter" },
				check: { kind: "selected", body: "Jupiter" }
			},
			{
				// Live-position check rather than an `edited` note: a wiggle that
				// leaves Jupiter out past Mars shouldn't tick "park it inside
				// Mercury". 0.38 AU is Mercury's own distance.
				text: "Grab the four-arrows handle on Jupiter and drag it until it sits between the Sun and Mercury.",
				check: { kind: "near", body: "Jupiter", other: "Sun", within: 0.38 * AU }
			},
			{
				text: "Press Play for a few years.",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Watch Mercury, Venus and Earth — do their orbits hold?"
			}
		],
		predictPrompt: "What do you think will happen to the inner planets?",
		// The drag drops Jupiter on a *circular* orbit (previewDrop), and a
		// circular interior perturber ~10 Hill radii inside Mercury only drives
		// slow precession — under 1% shift over a few years (scenario test). The
		// real hot-Jupiter carnage happens during migration, far too slowly to watch.
		choices: ["Almost nothing", "Their orbits get wrecked in a few years", "They start orbiting Jupiter instead"],
		outcome: {
			choice: 0,
			summary: "Almost nothing happened. The inner planets carried on much as before.",
			why: "Jupiter is easily the biggest planet, but the Sun is still a thousand times heavier. Next to a pull that strong, even a Jupiter parked inside Mercury's orbit is a small correction. The Sun holds almost all the mass in our solar system, so its gravity sets nearly every orbit."
		},
		notes: {
			links: [
				{ label: "Hot Jupiter", url: "https://en.wikipedia.org/wiki/Hot_Jupiter" },
				{ label: "Hill sphere", url: "https://en.wikipedia.org/wiki/Hill_sphere" }
			],
			followUps: [
				"Now make that Jupiter *10 heavier. How long does the neighborhood last?",
				"Drag Jupiter right next to Earth instead. Does the Moon stay loyal?"
			]
		},
		color: "#e8a06a",
		// Jupiter's own portrait, close, freshly parked beside the Sun — the
		// mission's premise in one image, and nothing about how the inner planets
		// take it. Centered on Jupiter rather than the Sun, which is what keeps it
		// from being a third wide inner-system plate. The pre-roll draws the outer
		// system's trails; the move itself happens at the shutter.
		shot: { days: 365, exaggeration: 900, center: "Jupiter", zoom: 6e10, sunward: true },
		build: solarSystem,
		// The steps say drag, and a drag drops the body on a *circular* orbit
		// (`previewDrop`), so reproduce that rather than teleporting Jupiter and
		// leaving it on its old 13 km/s velocity — which would fling it out and
		// show an outcome the mission doesn't have. 0.25 AU is inside Mercury.
		setup: [{ kind: "circularOrbit", body: "Jupiter", around: "Sun", distance: 0.25 * AU }]
	},
	{
		id: "two-year-planet",
		name: "The Two-Year Planet",
		category: "Farther afield",
		question: "How far out must a planet be for its year to last two of ours?",
		steps: [
			{
				text: "Open + Add → More options…. Set Orbits to Sun, then try Distance values until the orbital period preview reads about 2 years — and Create it.",
				target: { kind: "add" },
				check: { kind: "added" }
			},
			{
				text: "Press Play and race it against Earth: does Earth lap it twice per year of its own?",
				target: { kind: "play" },
				check: { kind: "playing" }
			},
			{
				text: "Check the Distance you needed — how many times Earth's?"
			}
		],
		predictPrompt: "How far out do you think it needs to be?",
		choices: ["Twice as far as Earth — 2 AU", "A bit less — about 1.6 AU", "Quite a bit more — about 2.8 AU"],
		// Kepler's third law: a = 2^(2/3) ≈ 1.587 AU. The numeric test pins it.
		outcome: {
			choice: 1,
			summary: "A two-year planet sits about 1.6 times as far out as Earth — not twice.",
			why: "Moving further out costs a planet twice over: it has a longer way around, and the Sun's weaker pull out there lets it travel more slowly. The year stretches faster than the distance does, so doubling the year takes much less than doubling the distance. That's Kepler's third law — square the year and you get the cube of the distance — and it holds for every planet, moon and satellite.",
			measured: "about 1.6 AU"
		},
		notes: {
			links: [
				{
					label: "Kepler's laws of planetary motion",
					url: "https://en.wikipedia.org/wiki/Kepler%27s_laws_of_planetary_motion"
				},
				{ label: "Orbital period", url: "https://en.wikipedia.org/wiki/Orbital_period" }
			],
			followUps: [
				"Now find the half-year orbit. Is it halfway in?",
				"Jupiter's year is twelve of ours. Guess how far out it must be, then click Jupiter and check."
			]
		},
		color: "#7fe8b0",
		// The answer to this one is a *distance*, so the card must not draw the new
		// orbit beside Earth's to compare — the old wide shot did exactly that,
		// with two years of trails showing one lap against two. Instead: a close
		// portrait of the new planet, freshly placed, its distance unreadable.
		shot: { days: 365, exaggeration: 6, center: "Two-Year Planet", zoom: 1.6e9, sunward: true },
		build: solarSystem,
		// The planet the mission asks for, added the way the picker's "add a planet"
		// drop would add it: a circular orbit at the mission's own answer,
		// a = 2^(2/3) AU.
		setup: [
			{
				kind: "circularOrbit",
				body: "Two-Year Planet",
				around: "Sun",
				distance: 2 ** (2 / 3) * AU,
				create: (position, velocity) => ({
					id: crypto.randomUUID(),
					name: "Two-Year Planet",
					type: "rocky",
					color: "#7fe8b0",
					mass: 5.972e24,
					radius: 6.371e6,
					rotationPeriod: 86400,
					axialTilt: 0,
					position,
					velocity
				})
			}
		]
	},
	{
		id: "butterfly-stars",
		name: "Butterfly Stars",
		category: "Farther afield",
		question: "Three stars chase each other in a figure-eight. What if you nudge one a little bit?",
		steps: [
			{
				text: "Pick Star A in the Objects list.",
				target: { kind: "roster", body: "Star A" },
				check: { kind: "selected", body: "Star A" }
			},
			{
				text: "In the Vel y box, type *1.05 and press Enter — that speeds it up by 5%.",
				target: { kind: "editor", body: "Star A", field: "velocity", axis: "y" },
				check: { kind: "edited", body: "Star A", field: "velocity" }
			},
			{
				text: "Press Play and watch it go round.",
				target: { kind: "play" },
				check: { kind: "playing" }
			}
		],
		predictPrompt: "What do you think a 5% nudge will do to the pattern?",
		choices: [
			"The eight pattern slowly rotates, but holds together",
			"The stars crash into each other right away",
			"The stars crash into each other after 13 years"
		],
		// Measured: one loop is ~366 days. A 5% vy nudge on Star A holds the eight's
		// ~2 AU span for a dozen loops — the peak separation only creeps from 1.98
		// to 2.06 AU — and then Star A and Star C merge at day 4485 (year 12.3).
		// Nothing is ejected first; the collision is how it ends.
		//
		// The merge time is not monotonic in the nudge, which is the point of the
		// mission: *1.02 lasts 23.5 years, *1.03 20.7, *1.05 12.3, *1.06 34.0,
		// *1.1 5.4. Don't rewrite the outcome to "bigger nudge, sooner crash".
		// Only *1.01 survives the full 60-year scan intact, which is why the older
		// version of this mission (a 1% nudge) legitimately answered "drift".
		//
		// The steps name Star A and the Vel y box because the axis matters: vx drifts
		// at half the rate of vy, so "one Velocity box" gave students visibly
		// different systems.
		outcome: {
			choice: 2,
			summary: "The stars crash into each other after 13 years",
			why: "For a dozen loops the eight keeps its shape and the nudge looks harmless. It isn't: the error is growing the whole time, too small to see, until two stars pass close enough to fall together."
		},
		notes: {
			links: [
				{ label: "Three-body problem", url: "https://en.wikipedia.org/wiki/Three-body_problem" },
				{ label: "n-body choreography", url: "https://en.wikipedia.org/wiki/N-body_choreography" }
			],
			followUps: [
				"Turn the nudge up: *1.1, then *1.3. How hard of a kick can the pattern survive?",
				"Nudge two stars by the same amount in opposite directions. Does that keep it balanced?"
			]
		},
		color: "#ff7fb2",
		// Two clean loops of the unperturbed choreography, then the nudge: the card
		// is the crisp single curve the question is asked *about*. Six loops after
		// the nudge was the old card, and the thickened drifting eight it drew is
		// the answer — the whole mission is which of three things that nudge does.
		shot: { days: 2 * 366, exaggeration: 600, trailDays: 2 * 366, zoom: 4.6e11 },
		build: figureEight,
		// Star A's Velocity Y ×1.05, exactly the step's nudge — the axis matters
		// (vx drifts at half the rate), so this must stay the y component.
		setup: [{ kind: "scaleVelocityAxis", body: "Star A", axis: "y", factor: 1.05 }]
	}
];

export function missionById(id: string): Mission | undefined {
	return MISSIONS.find((m) => m.id === id);
}

/**
 * The label a prediction choice is offered under — A, B, C by position, used by
 * the prediction buttons, the mission panel and the debrief. Display-only and
 * derived from the index alone, so no mission can label its choices
 * inconsistently with the order they render in.
 */
export function choiceLetter(index: number): string {
	return String.fromCharCode(65 + index);
}
