// Owns the Three.js scene: mesh lifecycle, materials, lights, labels, trails,
// selection, and the per-frame sync from simulation state.
//
// Invariants (GUIDE.md — Architecture, Pitfalls):
//
//  * Meshes are keyed by body id and reconciled against `sim.aliveIds` every
//    frame; merges and seeks make bodies appear and vanish mid-timeline. GPU
//    resources for bodies that leave are disposed.
//  * Rotation is derived from absolute `simTime`, never accumulated per frame —
//    accumulation desyncs the moment anyone scrubs.
//  * Distances are true-to-scale; only *radii* get the exaggeration factor, and
//    only at render time. Physics never sees it.
//  * Reference frames are render-only: every rendered position has the
//    reference body's position subtracted. Physics stays inertial.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { DEFAULT_TRAIL_INTERVAL, type Simulation } from "../sim/simulation";
import type { Body, BodyType, RealTextureKey } from "../types";
import {
	applyHueRotation,
	createBodyTexture,
	createRealBodyTexture,
	createStarfield,
	neutralizeHueRotation
} from "./textures";
import { Trails, type TrailAnchor } from "./trails";
import { Picker, SelectionMarker } from "./picking";
import { Atmosphere, CometTail, Rings, Spacecraft } from "./bodyEffects";
import { AccretionFlares, HabitableZones, MergeBursts, PlacementGhost, PredictionPath, VectorArrows } from "./overlays";
import { BodyDots } from "./bodyDots";
import { LensingPass, type LensSource } from "./lensing";
import { axisForHandleId, VelocityGizmo, type GizmoAxis } from "./gizmo";
import { dominantAttractor, summarizeOrbit } from "../physics/orbitInfo";
import { predictionDt, predictionHorizon, predictPath } from "../sim/predictPath";
import { DAY, G, YEAR } from "../physics/constants";

/** 1 scene unit = 1e9 m. Earth's orbit is ~150 units, so float32 stays happy. */
export const SCENE_SCALE = 1e9;

/**
 * Hard ceiling on retained trail points per body: `sim.trailInterval` (the
 * loaded system's sample grid) times the user's trail-length slider. The cost it
 * bounds is the reverse scrub, where rebuilds run every frame at O(bodies ×
 * capacity). Hitting the cap loses the oldest history, not correctness.
 *
 * **Coupled to `MAX_TRAIL_DAYS` in `state/ui.svelte.ts`:** sized so that slider
 * maximum (10 years) is fully drawable on the default 6-hour grid — 3650 days ×
 * 4/day = 14,600. Raise `MAX_TRAIL_DAYS` and this must rise with it, or the top
 * of the slider's travel silently clips instead of lengthening the trail.
 *
 * The selected body's ×`SELECTED_TRAIL_MULTIPLIER` slice is deliberately not
 * covered (58,400 points/body); past ~2.5 years of slider it stops outrunning
 * the rest. The satellite swarm clips past ~10 days of slider.
 */
const MAX_TRAIL_SAMPLES = 14_600;

/** Fallback length, in sim-days, when settings don't specify one. */
const DEFAULT_TRAIL_DAYS = 200;

/** Sample count for a trail of `days`, floored at two points so a line exists. */
function samplesForDays(days: number, interval: number): number {
	const samples = Math.ceil((days * DAY) / interval);
	return Math.min(MAX_TRAIL_SAMPLES, Math.max(2, samples));
}

/** At most this many PointLights; beyond it, extra stars are emissive only. */
const MAX_STAR_LIGHTS = 3;

/**
 * A body's fallback dot is fully lit while its drawn disc is below the first
 * radius (CSS px) and gone above the second — by then the disc itself is a few
 * pixels wide and carries the body. The ramp between them is what keeps zooming
 * out from popping a dot on.
 */
const DOT_FULL_BELOW_PX = 0.75;
const DOT_GONE_ABOVE_PX = 2.25;

/**
 * A dot fades out as it closes on its SOI parent on screen (angular
 * separation, CSS px). Dots blend additively, so a satellite cluster that
 * collapses onto its planet from afar stacks unboundedly — Domania and its
 * five craft summed to a white spark that blinked as rasterization shifted.
 * The parent's own dot (or disc) carries the group, like label crowding.
 */
const DOT_CROWD_GONE_PX = 2;
const DOT_CROWD_FULL_PX = 5;

/**
 * A star's disc never draws below this radius (CSS px). Near a pixel wide, the
 * emissive disc lands on different samples every frame and its bloom flickers —
 * from a system-wide view the star reads as intermittent explosions. Clamping
 * the disc keeps the star one steady glow however far the camera pulls back;
 * it also keeps a star above the dot ramp, which its emissive surface would
 * fight with.
 */
const STAR_MIN_RADIUS_PX = 3;

function stateVectorAt(pos: Float64Array, vel: Float64Array, i: number) {
	const i3 = i * 3;
	return {
		position: { x: pos[i3], y: pos[i3 + 1], z: pos[i3 + 2] },
		velocity: { x: vel[i3], y: vel[i3 + 1], z: vel[i3 + 2] }
	};
}

/** Rough size of a path, used to scale its dash length. */
function pathExtent(points: Float32Array): number {
	if (points.length < 6) return 1;
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (let i = 0; i < points.length; i += 3) {
		minX = Math.min(minX, points[i]);
		maxX = Math.max(maxX, points[i]);
		minZ = Math.min(minZ, points[i + 2]);
		maxZ = Math.max(maxZ, points[i + 2]);
	}
	return Math.max(maxX - minX, maxZ - minZ, 0.001);
}

export function exaggerationFor(type: BodyType, factor: number): number {
	if (type === "blackhole") {
		// Never exaggerated: a supermassive horizon is already ~17 Sun radii, so
		// even the star curve would swallow the tight 10–20 r_s orbits that are the
		// whole point of one.
		return 1;
	}
	if (type === "star") {
		// Damped: the Sun is ~109 Earth radii, so a factor that makes Earth a
		// visible speck inflates it past Earth's 150-unit orbit (348 units at ×500),
		// swallowing the inner system and enclosing the camera in unlit back-faces.
		// Cube root keeps the slider useful at the top without running away:
		// factor 1 → 1 (true scale), 50 → ~7, 500 → ~16, 2000 → ~25.
		return Math.cbrt(factor) * 2;
	}
	if (type === "satellite") {
		// The opposite problem from stars: tens of meters across, so no slider value
		// a planet can live with makes one visible. Sublinear for the same reason as
		// stars — the planet it shares the frame with scales linearly, and matching
		// that would leave the swarm legible at only one slider value.
		//
		// The cap is set by orbital *clearance*, not orbit radius: LEO is 6.8e6 m
		// from Earth's center but only ~400 km above the surface, so a craft drawn
		// much wider than ~1e5 m sinks into the planet it orbits. (At the old 8e5,
		// sized for a fictional shell, a LEO craft rendered as a 1600 km sphere
		// half-buried in Earth.)
		return Math.min(9_000 * Math.pow(factor, 0.45), 6e4);
	}
	return factor;
}

/**
 * Reference radius for satellite size compression (m) — roughly a mid-sized
 * craft, and the size that comes through the compression unchanged.
 */
const SATELLITE_REFERENCE_RADIUS = 12;

/**
 * Compress a satellite's physical radius toward the reference before it is
 * exaggerated. The swarm spans 0.08 m (Vanguard 1) to 54 m (ISS) — nearly 700×,
 * and one exaggeration big enough for the smallest makes the largest wider than
 * its orbit shell. The cube root pulls that to ~9× and stays monotonic, so sizes
 * keep their order. Rendered size only; collision radii use the true value.
 */
function sizeBoost(radius: number): number {
	if (radius <= 0) return radius;
	return SATELLITE_REFERENCE_RADIUS * Math.cbrt(radius / SATELLITE_REFERENCE_RADIUS);
}

/**
 * Labels hide past this camera distance (scene units) — far enough to keep a
 * whole planetary system labelled when framed, close enough to drop the deep
 * field where labels pile into a smear.
 */
const LABEL_MAX_DISTANCE = 100000;

/**
 * A body's label hides until it visually separates from its SOI parent — from
 * a system view Earth and the Moon project to the same pixel and the two names
 * render on top of each other. Show/hide thresholds differ (hysteresis): a
 * body orbiting right at a single threshold would blink its label every frame.
 */
const LABEL_CROWD_HIDE_PX = 24;
const LABEL_CROWD_SHOW_PX = 32;

/**
 * Comet tails switch on inside this distance from the nearest star. ~4 AU is
 * roughly where solar-system comets develop a visible coma.
 */
const COMET_ACTIVITY_RADIUS = 4 * 1.495978707e11;

/**
 * Longest predicted path we'll integrate. Cost is flat in the horizon
 * (`predictionDt` coarsens the step to a fixed budget), so this is about
 * usefulness: 250 years closes every solar-system orbit, Pluto's 248 included.
 */
const MAX_PREDICTION_HORIZON = 250 * YEAR;

/** Horizon used when the selected body isn't on a closed orbit. */
const UNBOUND_PREDICTION_HORIZON = YEAR;

/**
 * Fraction of the horizon the clock may consume before the path is recomputed.
 * Determinism keeps a computed path correct as time advances — the body just
 * travels along it — so a refresh only restores the far end.
 */
const PREDICTION_REFRESH_FRACTION = 1 / 8;

/**
 * Recompute the prediction path at most this often (wall-clock ms): it
 * integrates the whole system, so every frame would cost more than the sim.
 */
const PREDICTION_THROTTLE_MS = 250;

export interface RenderSettings {
	radiusExaggeration: number;
	showLabels: boolean;
	showTrails: boolean;
	/** trail history drawn per body, in sim-days */
	trailDays: number;
	/** anchor each trail (and the predicted path) to its SOI parent */
	parentRelativeTrails: boolean;
	/** multiplier on `trailDays` for the selected body */
	selectedTrailMultiplier: number;
	showAxes: boolean;
	showVectors: boolean;
	/** shaded liquid-water annulus around each star */
	showHabitableZone: boolean;
	showPrediction: boolean;
	bloom: boolean;
	/** gravitational lensing around black holes */
	lensing: boolean;
	/** body id, or null for the inertial/barycentric frame */
	referenceFrame: string | null;
	selectedBodyId: string | null;
	/** body the armed placement would orbit — gets a highlight ring */
	placementParentId: string | null;
	/**
	 * A direct-manipulation drag is committing edits. Forces the predicted path
	 * visible (it's the drag's live feedback, whatever the Display toggle says)
	 * and tightens its recompute throttle.
	 */
	interactionDragging: boolean;
	/** show the draggable velocity arrow on the selected body (paused only) */
	velocityGizmo: boolean;
}

interface BodyVisual {
	group: THREE.Group;
	/**
	 * The spinning part of the body: a sphere, or a modeled spacecraft's group for
	 * satellites. The frame loop only scales and rotates it, so either works.
	 */
	mesh: THREE.Object3D;
	/**
	 * null for satellites (materials live on the Spacecraft) and for black
	 * holes (they share the manager-owned void material).
	 */
	material: THREE.MeshStandardMaterial | null;
	/** null for black holes, which have no surface to texture */
	texture: THREE.Texture | null;
	/** modeled craft, present only for `satellite` bodies */
	spacecraft: Spacecraft | null;
	hitSphere: THREE.Mesh;
	axis: THREE.Line | null;
	axisMaterial: THREE.LineBasicMaterial | null;
	label: CSS2DObject;
	labelElement: HTMLDivElement;
	/** crowding-hidden last frame — the hysteresis state for the label pass */
	labelCrowded: boolean;
	light: THREE.PointLight | null;
	/** rim glow, present only while the body has an atmosphere */
	atmosphere: Atmosphere | null;
	/** ring system, present only while the body has rings */
	rings: Rings | null;
	/** comet tail, present only for ice/asteroid bodies */
	tail: CometTail | null;
	type: BodyType;
	color: string;
	/** photographic map in use, undefined for procedural surfaces */
	textureKey: RealTextureKey | undefined;
	name: string;
	rotationPeriod: number;
	rotationPhase: number;
	axialTilt: number;
	/** true radius in meters, so effects can size themselves against it */
	radius: number;
	/** radius in scene units after exaggeration, updated each frame */
	visualRadius: number;
}

export class SceneManager {
	readonly scene = new THREE.Scene();
	readonly camera: THREE.PerspectiveCamera;

	private renderer: THREE.WebGLRenderer;
	private labelRenderer: CSS2DRenderer;
	private starfield: THREE.Points;
	private trails: Trails;
	private picker = new Picker();
	private marker = new SelectionMarker();
	/** White, not selection-blue: rings the armed placement's parent, and both
	 * can show at once (the old selection persists while placing). */
	private placementMarker = new SelectionMarker(0xffffff, 0xffffff);
	private ambient: THREE.AmbientLight;

	/** post-processing chain, used while bloom or lensing is active */
	private composer: EffectComposer;
	private bloomPass: UnrealBloomPass;
	private lensPass = new LensingPass();
	/** black holes visible this frame, rebuilt in the body loop */
	private lensSources: LensSource[] = [];

	private dots = new BodyDots();
	private vectors = new VectorArrows();
	private bursts = new MergeBursts();
	private flares = new AccretionFlares();
	private prediction = new PredictionPath();
	private ghost = new PlacementGhost();
	private gizmo = new VelocityGizmo();
	private habitableZones = new HabitableZones();

	private visuals = new Map<string, BodyVisual>();
	/** shared across all bodies — scaled per-mesh, disposed once */
	private sphereGeometry = new THREE.SphereGeometry(1, 48, 24);
	/**
	 * The event-horizon material, shared by every black hole. MeshBasicMaterial
	 * deliberately: it ignores lights, so the disc is #000000 from any angle. A
	 * MeshStandardMaterial keeps a dielectric specular term even at black albedo
	 * and star light puts a visible sheen on it.
	 *
	 * The 1 r_s mesh mostly hides inside the lens pass's 2.6 r_s shadow, but is
	 * still the depth-correct occluder (that shadow is screen-space and can't know
	 * about bodies behind the hole) and the fallback silhouette when the pass
	 * skips a sub-pixel-deflection hole.
	 */
	private blackHoleMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
	private hitGeometry = new THREE.SphereGeometry(1, 12, 8);
	/** shared by every atmosphere shell; each is scaled per-body. Matches the
	 * surface sphere's resolution — a dense atmosphere's cloud deck is opaque,
	 * so its limb is a silhouette and a coarser sphere shows its polygons. */
	private atmosphereGeometry = new THREE.SphereGeometry(1, 48, 24);

	/** reused scratch to keep the frame loop allocation-free */
	private refPosition = new THREE.Vector3();
	/** body id → trail anchor; empty when the toggle is off */
	private trailAnchors = new Map<string, TrailAnchor>();
	/** body id → SOI parent id, rebuilt with the trail anchors */
	private labelParents = new Map<string, string>();
	// SOI parents are a function of the integrated state, so they can only
	// change when the clock moves, an edit lands, or the roster is swapped —
	// the alive-array identity covers a load at an identical sim time. Skipping
	// the O(n²) rescan on idle frames matters: it was 8% of the paused profile.
	private anchorsTime = NaN;
	private anchorsGeneration = -1;
	private anchorsAlive: readonly string[] | null = null;
	private anchorsParentRelative = false;
	private scratch = new THREE.Vector3();
	private scratchB = new THREE.Vector3();
	private scratchC = new THREE.Vector3();

	/** last seekGeneration seen; a change means history is invalid */
	private lastSeekGeneration = -1;

	/** throttle + invalidation state for the predicted-orbit path */
	private lastPredictionAt = -Infinity;
	private lastPredictionKey = "";

	constructor(canvasContainer: HTMLElement, labelContainer: HTMLElement) {
		// Log depth buffer: near/far spans nine orders of magnitude, and a linear
		// 24-bit depth buffer's resolution at outer-planet distances is tens of
		// scene units — bigger than an exaggerated planet, so ring/atmosphere
		// fragments behind a body pass the depth test and draw over it from afar.
		this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		canvasContainer.appendChild(this.renderer.domElement);

		this.labelRenderer = new CSS2DRenderer({ element: labelContainer });

		this.scene.background = new THREE.Color(0x05060a);

		// Near/far tuned for the scene scale: 0.001 units = 1000 km, far enough out
		// to contain the starfield sphere.
		this.camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1e6);
		// Kepler-built orbits lie in the xy-plane, so +Z is the ecliptic normal. The
		// follow loop's lookAt uses `up` every frame: with +Y up, a camera tracking
		// a body around its orbit sweeps its view direction through the up axis
		// twice per orbit and degenerates. Focus/Center re-level back to this +Z.
		this.camera.up.set(0, 0, 1);
		this.camera.position.set(0, 90, 260);

		this.ambient = new THREE.AmbientLight(0xffffff, 0.07);
		this.scene.add(this.ambient);

		this.starfield = createStarfield();
		this.scene.add(this.starfield);

		// Both are re-set per frame from the loaded system's own trail interval;
		// these just give the buffer a valid shape before the first render.
		this.trails = new Trails({
			interval: DEFAULT_TRAIL_INTERVAL,
			capacity: samplesForDays(DEFAULT_TRAIL_DAYS, DEFAULT_TRAIL_INTERVAL)
		});
		this.scene.add(this.trails.object);
		this.scene.add(this.dots.object);
		this.scene.add(this.marker.object);
		this.scene.add(this.placementMarker.object);
		this.scene.add(this.vectors.object);
		this.scene.add(this.bursts.object);
		this.scene.add(this.flares.object);
		this.scene.add(this.prediction.object);
		this.scene.add(this.ghost.object);
		this.scene.add(this.gizmo.object);
		this.scene.add(this.habitableZones.object);

		// Bloom chain. The composer renders into linear float targets with the
		// renderer's tone mapping *disabled*; `OutputPass` applies tone mapping and
		// sRGB once at the end. Leaving the renderer's own toneMapping on
		// double-applies it, crushing the background to black so bloom looks like it
		// dims the scene.
		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		// Lensing must run before bloom: the arcs a star smears into near the
		// Einstein ring should glow like the star did, and glow must not leak across
		// the shadow edge from pixels the warp is about to move.
		this.composer.addPass(this.lensPass);
		// (resolution, strength, radius, threshold). Threshold 0.62 sits above the
		// brightest lit planet but below a star's emissive output, so only stars
		// bloom. Strength and radius stay low: a star fills the frame up close, and
		// a strong wide bloom tints the viewport and blows granulation to white.
		this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.28, 0.62);
		this.composer.addPass(this.bloomPass);
		this.composer.addPass(new OutputPass());
	}

	get domElement(): HTMLCanvasElement {
		return this.renderer.domElement;
	}

	setSize(width: number, height: number): void {
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(width, height);
		this.labelRenderer.setSize(width, height);
		// The composer keeps its own render targets, which must track the canvas
		// or the bloom pass samples a stale-sized buffer after a resize.
		this.composer.setSize(width, height);
		this.bloomPass.setSize(width, height);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
	}

	/**
	 * Repopulate trail history from the sim's snapshots, covering the span the
	 * trail buffer can hold and ending at the current time.
	 *
	 * **A rebuilt trail can only be as fine as the snapshot grid**, which is
	 * coarser than `trailInterval` — still better than per-frame catch-up
	 * sampling, which chords across the ellipse. Every seek comes through here, so
	 * a preset wanting finer trails must tighten `snapshotInterval` too (as
	 * `artemis-ii` does), or trails coarsen the moment you scrub.
	 */
	private rebuildTrails(sim: Simulation): void {
		const now = sim.time;
		const span = this.trails.buffer.capacity * Math.max(sim.snapshotSpacing, this.trails.buffer.interval);
		const samples = sim.snapshotsBetween(Math.max(0, now - span), now);
		this.trails.rebuildFrom(samples, SCENE_SCALE, now, sim.aliveIds, sim.state.pos);
	}

	/**
	 * Extend trail history with only the snapshots recorded since the newest
	 * sample. This is the every-frame path at high warp; a full rebuild there is
	 * O(capacity × bodies) per frame and its allocation churn shows up as GC
	 * pauses.
	 */
	private catchUpTrails(sim: Simulation): void {
		const now = sim.time;
		const samples = sim.snapshotsBetween(this.trails.buffer.newestTime, now);
		this.trails.catchUpFrom(samples, SCENE_SCALE, now, sim.aliveIds, sim.state.pos);
	}

	/** Record a merge burst at a collision site (inertial-frame meters). */
	addMergeBurst(t: number, x: number, y: number, z: number, color: string): void {
		this.bursts.add(t, this.scratch.set(x / SCENE_SCALE, y / SCENE_SCALE, z / SCENE_SCALE), color);
	}

	/**
	 * Record an accretion flare on black hole `anchorId` — the capture
	 * counterpart of a merge burst, in the absorbed body's color.
	 */
	addAccretionFlare(t: number, anchorId: string, color: string): void {
		this.flares.add(t, anchorId, color);
	}

	/** Drop every merge burst and flare — system load or full reset. */
	clearBursts(): void {
		this.bursts.clear();
		this.flares.clear();
	}

	/**
	 * The body whose name label an event landed on, or null. Labels are CSS2D
	 * elements over the canvas and never reach the raycaster, so this is the
	 * DOM-side counterpart to `pick`. Hidden labels don't answer.
	 */
	labelTarget(target: EventTarget | null): string | null {
		if (!(target instanceof HTMLElement)) return null;
		const element = target.closest<HTMLElement>(".body-label");
		const id = element?.dataset.bodyId;
		if (!id) return null;
		const visual = this.visuals.get(id);
		return visual && visual.label.visible ? id : null;
	}

	/** Raycast a click against the hit spheres. */
	pick(event: { clientX: number; clientY: number }): string | null {
		const targets: THREE.Object3D[] = [];
		for (const visual of this.visuals.values()) targets.push(visual.hitSphere);
		return this.picker.pick(event, this.renderer.domElement, this.camera, targets);
	}

	/**
	 * The velocity-gizmo axis under a pointer event, or null. Picking the nearest
	 * of the three handles is what lets overlapping arrows (an axis pointing
	 * near-straight at the camera) resolve to one component.
	 */
	pickGizmoHandle(event: { clientX: number; clientY: number }): GizmoAxis | null {
		if (!this.gizmo.object.visible) return null;
		return axisForHandleId(this.picker.pick(event, this.renderer.domElement, this.camera, this.gizmo.handleObjects));
	}

	/** Whether a pointer event landed on the gizmo's move handle — see `VelocityGizmo.isMoveTarget`. */
	isMoveIconTarget(target: EventTarget | null): boolean {
		return this.gizmo.isMoveTarget(target);
	}

	/** The gizmo's current length mapping, m/s per scene unit. */
	gizmoScale(): number {
		return this.gizmo.scale;
	}

	/** Freeze the gizmo mapping across a drag, so it can't re-scale mid-pull. */
	setGizmoFrozen(frozen: boolean): void {
		this.gizmo.setFrozen(frozen);
	}

	/** Body → gizmo origin (scene units) — the offset axis drags anchor to. */
	gizmoOriginOffset(out: THREE.Vector3): THREE.Vector3 {
		return this.gizmo.originOffset(out);
	}

	/** Visible radius in scene units, for camera framing on focus. */
	visualRadius(id: string): number {
		return this.visuals.get(id)?.visualRadius ?? 1;
	}

	/** Whether a render has built this body's visual yet — see SceneCanvas's focus deferral. */
	hasVisual(id: string): boolean {
		return this.visuals.has(id);
	}

	/**
	 * Show the click-to-place ghost. `point` and `radiusScene` are scene units
	 * (radius already exaggerated); the radius is clamped to a minimum screen
	 * footprint so a to-scale planet doesn't preview as an invisible dot.
	 */
	showGhost(
		point: THREE.Vector3,
		radiusScene: number,
		color: string,
		orbit: { center: THREE.Vector3; radius: number; normal: THREE.Vector3 } | null
	): void {
		const height = this.renderer.domElement.clientHeight || 1;
		const perPixel = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
		const minRadius = this.camera.position.distanceTo(point) * perPixel * 5;
		this.ghost.show(point, Math.max(radiusScene, minRadius), color, orbit);
	}

	hideGhost(): void {
		this.ghost.hide();
	}

	/** Drop all trail history — seek-backward, edits, system load. */
	clearTrails(): void {
		this.trails.clear();
	}

	/**
	 * Sync the whole scene to the sim's current state and render one frame.
	 *
	 * `roster` supplies appearance/metadata (color, type, spin, tilt); the sim
	 * supplies positions and which bodies are alive.
	 */
	render(sim: Simulation, roster: readonly Body[], settings: RenderSettings, seekGeneration: number): void {
		// History-derived visuals are rebuilt, not extended, whenever the timeline
		// jumped. Rebuilding from snapshots rather than clearing is what keeps a
		// trail smooth across the discontinuity: per-frame sampling only records
		// where the sim was when a frame ran, so a jump leaves the trail chording
		// between the bracketing frames.
		const jumped = seekGeneration !== this.lastSeekGeneration;
		this.lastSeekGeneration = seekGeneration;

		const alive = sim.aliveIds;
		const { pos, vel, acc, mass, radius } = sim.state;
		const simTime = sim.time;

		const byId = new Map<string, Body>();
		for (const body of roster) byId.set(body.id, body);

		this.reconcile(alive, byId);

		// Trail samples are taken in the inertial frame and the frame subtraction
		// happens at draw time, so changing the reference frame doesn't invalidate
		// history.
		//
		// Appending one point per frame is faithful only while the sim advances less
		// than a sample interval per frame; at high warp or on an autosave restore
		// it moves thousands of steps in one frame and the chords draw a star. When
		// the sim outruns the grid, the gap is filled from snapshots instead —
		// incrementally while history is still valid, from scratch when it isn't.
		//
		// The loaded system dictates the grid, and changing it clears the ring
		// (samples on two grids can't share a buffer), so this is a no-op on every
		// frame but the first after a load.
		const regridded = this.trails.buffer.interval !== sim.trailInterval;
		this.trails.buffer.setInterval(sim.trailInterval);

		// Every body shares one history, so the ring must hold the *longest* trail
		// drawn — the selected body's. Others draw a shorter slice at update() time.
		const trailDays = settings.trailDays > 0 ? settings.trailDays : DEFAULT_TRAIL_DAYS;
		const selectedTrailDays = trailDays * Math.max(1, settings.selectedTrailMultiplier);
		const selectedTrailSamples = samplesForDays(selectedTrailDays, sim.trailInterval);
		// Growing the ring permits more history but doesn't backfill, so rebuild from
		// snapshots — otherwise a longer trail draws in over the next sim-days.
		const grew = selectedTrailSamples > this.trails.buffer.capacity;
		this.trails.setCapacity(selectedTrailSamples);

		if (jumped || grew || regridded) {
			this.rebuildTrails(sim);
		} else if (this.trails.outranSampling(simTime)) {
			this.catchUpTrails(sim);
		}
		this.trails.maybeRecord(simTime, alive, pos, SCENE_SCALE);

		// Resolve the reference-frame origin before positioning anything.
		this.refPosition.set(0, 0, 0);
		const refId = settings.referenceFrame;
		if (refId !== null) {
			const refIndex = alive.indexOf(refId);
			if (refIndex >= 0) {
				const r3 = refIndex * 3;
				this.refPosition.set(pos[r3] / SCENE_SCALE, pos[r3 + 1] / SCENE_SCALE, pos[r3 + 2] / SCENE_SCALE);
			}
		}

		let lightsUsed = 0;

		// Arrows are normalized against the frame's largest magnitudes, so the maxima
		// must be known before any arrow is sized.
		let maxSpeed = 0;
		let maxAccel = 0;
		if (settings.showVectors) {
			for (let i = 0; i < alive.length; i++) {
				const i3 = i * 3;
				maxSpeed = Math.max(maxSpeed, Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]));
				maxAccel = Math.max(maxAccel, Math.hypot(acc[i3], acc[i3 + 1], acc[i3 + 2]));
			}
		}

		// Star positions feed comet tail direction.
		const stars: { index: number; position: THREE.Vector3 }[] = [];
		this.lensSources.length = 0;

		this.vectors.hideAll();
		this.dots.begin();
		this.habitableZones.begin();
		const height = this.renderer.domElement.clientHeight;
		const pxPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));

		for (let i = 0; i < alive.length; i++) {
			const id = alive[i];
			const visual = this.visuals.get(id);
			if (!visual) continue;

			const body = byId.get(id);
			if (body) this.applyAppearance(visual, body);

			const i3 = i * 3;
			visual.group.visible = true;
			visual.group.position.set(
				pos[i3] / SCENE_SCALE - this.refPosition.x,
				pos[i3 + 1] / SCENE_SCALE - this.refPosition.y,
				pos[i3 + 2] / SCENE_SCALE - this.refPosition.z
			);

			// Radii are exaggerated; distances above are not.
			//
			// The sim's radius array is the *collision* size, which presets may
			// inflate well beyond the drawn size to make merges fire. Scale back by
			// the body's own display-to-collision ratio rather than reading
			// Body.radius, so a merged survivor still grows on screen —
			// volume-conserving merges preserve the ratio.
			const displayScale = body?.collisionRadius ? body.radius / body.collisionRadius : 1;
			const exaggeration = exaggerationFor(visual.type, settings.radiusExaggeration);
			const shownRadius = visual.type === "satellite" ? sizeBoost(radius[i]) : radius[i] * displayScale;
			let visualRadius = (shownRadius * exaggeration) / SCENE_SCALE;
			this.scratch.copy(this.camera.position).sub(visual.group.position);
			const distance = this.scratch.length();
			if (visual.type === "star" && distance > 0) {
				visualRadius = Math.max(visualRadius, (STAR_MIN_RADIUS_PX * distance) / pxPerRadian);
			}
			visual.visualRadius = visualRadius;
			visual.mesh.scale.setScalar(visualRadius);
			if (visual.axis) visual.axis.scale.setScalar(visualRadius);

			// Sized off the same exaggerated radius as the body, so they stay locked
			// to it as the slider moves.
			if (visual.atmosphere) {
				visual.atmosphere.object.scale.setScalar(visualRadius);
			}
			if (visual.rings) visual.rings.mesh.scale.setScalar(visualRadius);

			this.applyOrientation(visual, simTime);

			visual.hitSphere.position.copy(visual.group.position);
			if (visual.axis) visual.axis.visible = settings.showAxes;

			// A sub-pixel disc still registers as a dot, like the starfield behind
			// it. Black holes excepted: reading as an absence is their entire visual.
			// The dot is lifted off the near surface toward the camera — at the
			// body's center it sits behind the front faces and its own disc wins the
			// depth test.
			if (visual.type !== "blackhole") {
				const px = distance > 0 ? (visualRadius / distance) * pxPerRadian : Infinity;
				if (px < DOT_GONE_ABOVE_PX) {
					let fade = Math.min(1, (DOT_GONE_ABOVE_PX - px) / (DOT_GONE_ABOVE_PX - DOT_FULL_BELOW_PX));
					// `labelParents` lags one frame behind (it's rebuilt after this
					// loop), which SOI parentage can't meaningfully change in.
					const parentId = this.labelParents.get(id);
					const parentIndex = parentId !== undefined ? alive.indexOf(parentId) : -1;
					if (parentIndex >= 0 && distance > 0) {
						const p3 = parentIndex * 3;
						const separation =
							(Math.hypot(pos[i3] - pos[p3], pos[i3 + 1] - pos[p3 + 1], pos[i3 + 2] - pos[p3 + 2]) /
								SCENE_SCALE /
								distance) *
							pxPerRadian;
						fade *= Math.min(
							1,
							Math.max(0, (separation - DOT_CROWD_GONE_PX) / (DOT_CROWD_FULL_PX - DOT_CROWD_GONE_PX))
						);
					}
					if (fade > 0) {
						this.dots.add(
							id,
							this.scratch.multiplyScalar((visualRadius * 1.5) / distance).add(visual.group.position),
							fade
						);
					}
				}
			}

			if (visual.light) {
				if (lightsUsed < MAX_STAR_LIGHTS) {
					visual.light.position.copy(visual.group.position);
					visual.light.visible = true;
					lightsUsed += 1;
				} else {
					visual.light.visible = false;
				}
			}

			if (visual.type === "star") {
				stars.push({ index: i, position: visual.group.position.clone() });
				if (settings.showHabitableZone) {
					// Sized from the sim's live mass, not the roster's t = 0 value, so
					// the band tracks mass edits and merges at the current time.
					this.habitableZones.show(id, visual.group.position, mass[i], SCENE_SCALE);
				}
			}

			if (visual.type === "blackhole") {
				// The sim's radius for a hole is the horizon, so this is r_s in scene
				// units. `position` is a live reference into the group, final for this
				// frame by the time the lens pass reads it.
				this.lensSources.push({ id, position: visual.group.position, rs: radius[i] / SCENE_SCALE });
			}

			if (settings.showVectors) {
				this.vectors.show(
					id,
					visual.group.position,
					this.scratchB.set(vel[i3], vel[i3 + 1], vel[i3 + 2]),
					this.scratchC.set(acc[i3], acc[i3 + 1], acc[i3 + 2]),
					maxSpeed,
					maxAccel,
					// Scaled by view distance, not body size, so arrows stay legible on
					// a moon and on the whole system alike.
					this.camera.position.distanceTo(visual.group.position) * 0.12
				);
			}
		}

		this.dots.commit();
		this.habitableZones.commit();
		this.updateCometTails(alive, pos, stars, pxPerRadian);

		this.vectors.setVisible(settings.showVectors);
		this.bursts.update(simTime, this.refPosition, this.bodyScaleHint(alive, radius, settings));
		// Flares ride their black hole rather than a fixed impact site, so resolving
		// against the live visuals keeps them correct in any reference frame.
		this.flares.update(simTime, (id) => {
			const visual = this.visuals.get(id);
			if (!visual || !visual.group.visible) return null;
			return { position: visual.group.position, radius: visual.visualRadius };
		});
		this.updatePrediction(sim, settings, alive, seekGeneration);
		this.updateGizmo(sim, settings, alive);

		// Anchor each trail to the body it orbits: shape from an index-aligned
		// subtraction against the parent's *historical* track, placement from the
		// parent's *current* rendered position — so a moon's history reads as an
		// ellipse around its planet rather than a helix, in any reference frame.
		// Bodies with no SOI parent keep the view-frame trail. The same scan
		// feeds `labelParents`, so it now runs with the trail toggle off too.
		if (
			this.anchorsTime !== simTime ||
			this.anchorsGeneration !== seekGeneration ||
			this.anchorsAlive !== alive ||
			this.anchorsParentRelative !== settings.parentRelativeTrails
		) {
			this.anchorsTime = simTime;
			this.anchorsGeneration = seekGeneration;
			this.anchorsAlive = alive;
			this.anchorsParentRelative = settings.parentRelativeTrails;
			this.trailAnchors.clear();
			this.labelParents.clear();
			for (let i = 0; i < alive.length; i++) {
				const parent = dominantAttractor(i, mass, pos, alive.length);
				if (parent === null) continue;
				const parentVisual = this.visuals.get(alive[parent]);
				if (!parentVisual) continue;
				this.labelParents.set(alive[i], alive[parent]);
				if (!settings.parentRelativeTrails) continue;
				// The anchor's position is a live reference into the parent's
				// group, so a cached entry keeps tracking it across frames.
				this.trailAnchors.set(alive[i], { id: alive[parent], position: parentVisual.group.position });
			}
		}

		// After the anchor scan (labels need the parents) and after the body loop
		// (crowding compares against parent positions set this frame, and the
		// parent may come later in the roster than its satellite).
		this.updateLabels(alive, settings.showLabels);

		// Trail length is a *time* window, not a sample count: after a snapshot
		// rebuild the ring holds day-grid samples, and a count sized for the finer
		// live grid would draw several times the intended span — undo/redo left
		// every eccentric orbit fanned out in multi-pass chords. Quantized to the
		// sample grid so the value holds still between slots and update()'s
		// identical-frame skip keeps working.
		const oldestFor = (days: number) => Math.floor((simTime - days * DAY) / sim.trailInterval) * sim.trailInterval;
		this.trails.update(
			refId,
			settings.showTrails,
			oldestFor(trailDays),
			settings.selectedBodyId,
			oldestFor(selectedTrailDays),
			this.trailAnchors
		);

		// Hit spheres are sized in screen space, so they need the viewport height.
		this.picker.updateHitSpheres(
			[...this.visuals.values()].map((v) => ({ sphere: v.hitSphere, visualRadius: v.visualRadius })),
			this.camera,
			height
		);

		const selected = settings.selectedBodyId ? this.visuals.get(settings.selectedBodyId) : undefined;
		if (selected && selected.group.visible) {
			this.marker.show(selected.group.position, selected.visualRadius, this.camera, height);
		} else {
			this.marker.hide();
		}

		// The armed placement's parent gets its own ring: at system zoom the
		// ghost's orbit circle around a planet is sub-pixel, so the ring is what
		// says the snap happened.
		const placementParent = settings.placementParentId ? this.visuals.get(settings.placementParentId) : undefined;
		if (placementParent && placementParent.group.visible) {
			this.placementMarker.show(placementParent.group.position, placementParent.visualRadius, this.camera, height);
		} else {
			this.placementMarker.hide();
		}

		// Backdrop: park it on the camera so it never parallaxes or falls outside
		// the far plane.
		this.starfield.position.copy(this.camera.position);

		// Exactly one stage may tone-map: `OutputPass` on the composer path, the
		// renderer itself on the direct path.
		//
		// The starfield stays out of the bloom by being dim rather than by a second
		// render pass — `RenderPass` clears the target, so an excluded layer means
		// rendering the world twice and hand-managing autoClear. See
		// `createStarfield`.
		//
		// Lensing is a full-frame warp so it can only exist as a pass, but `refresh`
		// gates it on a hole being worth lensing (on/near screen, deflection above a
		// pixel), keeping the cheap direct path for hole-free systems.
		const lensing = settings.lensing
			? this.lensPass.refresh(this.lensSources, this.camera, height)
			: this.lensPass.deactivate();
		// An actively-lensed hole's horizon mesh must not render: the warp treats it
		// as background and re-images the black disc onto the Einstein ring. The
		// pass's shadow is the silhouette meanwhile; the mesh returns when the pass
		// drops the hole. See `activeIds`.
		for (const source of this.lensSources) {
			const visual = this.visuals.get(source.id);
			if (visual) visual.mesh.visible = !this.lensPass.activeIds.has(source.id);
		}
		this.bloomPass.enabled = settings.bloom;
		if (settings.bloom || lensing) {
			this.renderer.toneMapping = THREE.NoToneMapping;
			this.composer.render();
		} else {
			this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
			this.renderer.render(this.scene, this.camera);
		}
		this.labelRenderer.render(this.scene, this.camera);
	}

	dispose(): void {
		for (const id of [...this.visuals.keys()]) this.removeVisual(id);
		this.trails.dispose();
		this.dots.dispose();
		this.marker.dispose();
		this.placementMarker.dispose();
		this.vectors.dispose();
		this.bursts.dispose();
		this.flares.dispose();
		this.prediction.dispose();
		this.ghost.dispose();
		this.gizmo.dispose();
		this.habitableZones.dispose();
		this.sphereGeometry.dispose();
		this.hitGeometry.dispose();
		this.atmosphereGeometry.dispose();
		this.blackHoleMaterial.dispose();
		this.lensPass.dispose();
		this.starfield.geometry.dispose();
		(this.starfield.material as THREE.Material).dispose();
		this.composer.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}

	/**
	 * Point every comet tail away from its nearest star, scaled by proximity.
	 * Distance is in true meters, not exaggerated scene units: activity is a
	 * physical relationship to the star, not a visual one.
	 */
	private updateCometTails(
		alive: readonly string[],
		pos: Float64Array,
		stars: { index: number; position: THREE.Vector3 }[],
		pxPerRadian: number
	): void {
		for (let i = 0; i < alive.length; i++) {
			const visual = this.visuals.get(alive[i]);
			if (!visual?.tail) continue;

			if (stars.length === 0) {
				visual.tail.hide();
				continue;
			}

			// Nearest star wins, so in a binary the tail swings between them.
			const i3 = i * 3;
			let nearest = stars[0];
			let nearestDistance = Infinity;
			for (const star of stars) {
				const s3 = star.index * 3;
				const d = Math.hypot(pos[s3] - pos[i3], pos[s3 + 1] - pos[i3 + 1], pos[s3 + 2] - pos[i3 + 2]);
				if (d < nearestDistance) {
					nearestDistance = d;
					nearest = star;
				}
			}

			const cameraDistance = this.camera.position.distanceTo(visual.group.position);
			visual.tail.update(
				visual.group.position,
				nearest.position,
				nearestDistance,
				COMET_ACTIVITY_RADIUS,
				// Scales with the body so it stays proportionate as the exaggeration
				// slider moves, with a floor so it never vanishes.
				Math.max(visual.visualRadius * 24, (nearestDistance / SCENE_SCALE) * 0.035),
				cameraDistance > 0 ? pxPerRadian / cameraDistance : 0
			);
		}
	}

	/**
	 * Recompute the selected body's predicted path when it is stale. Throttled on
	 * wall time *and* keyed on what invalidates it (selection, reference frame,
	 * seek generation), since integrating every frame costs more than the sim.
	 */
	private updatePrediction(
		sim: Simulation,
		settings: RenderSettings,
		alive: readonly string[],
		seekGeneration: number
	): void {
		const id = settings.selectedBodyId;
		if ((!settings.showPrediction && !settings.interactionDragging) || id === null) {
			this.prediction.hide();
			return;
		}

		const index = alive.indexOf(id);
		if (index < 0) {
			this.prediction.hide();
			return;
		}

		const referenceIndex = settings.referenceFrame === null ? null : alive.indexOf(settings.referenceFrame);

		const { mass, pos, vel } = sim.state;
		const parent = dominantAttractor(index, mass, pos, sim.state.n);

		// Same anchor the trail uses (SOI parent when parent-relative trails are on,
		// view frame otherwise), so dashed future and solid history trace one curve.
		// The offset must track the parent's rendered position every frame, not just
		// on recompute; for a frame-reference anchor that position is the origin.
		const anchorIndex = settings.parentRelativeTrails && parent !== null ? parent : referenceIndex;
		const anchorVisual = anchorIndex !== null && anchorIndex >= 0 ? this.visuals.get(alive[anchorIndex]) : undefined;
		if (anchorVisual) this.prediction.object.position.copy(anchorVisual.group.position);
		else this.prediction.object.position.set(0, 0, 0);

		// One full orbit around whatever dominates it, so the path closes. O(1) on
		// top of the attractor scan, so it can run every frame — which the staleness
		// key below needs.
		let horizon = UNBOUND_PREDICTION_HORIZON;
		if (parent !== null) {
			const summary = summarizeOrbit(
				mass[parent],
				stateVectorAt(pos, vel, parent),
				stateVectorAt(pos, vel, index),
				mass[index]
			);
			horizon = predictionHorizon(summary.period, UNBOUND_PREDICTION_HORIZON, MAX_PREDICTION_HORIZON);
		}

		// Sim time enters the key quantized to a fraction of the horizon: a drawn
		// path stays correct as the clock runs, so playback only recomputes once a
		// real fraction of it is behind the body. The seek generation is what
		// invalidates *immediately* on edits — a drag commits new state every frame
		// while the clock stands still, which no sim-time keying would notice. The
		// throttle tightens during a drag, where 250 ms reads as lag.
		const quantum = horizon * PREDICTION_REFRESH_FRACTION;
		const key = `${id}:${anchorIndex}:${Math.floor(sim.time / quantum)}:${seekGeneration}`;
		const throttle = settings.interactionDragging ? 50 : PREDICTION_THROTTLE_MS;
		const now = performance.now();
		if (key === this.lastPredictionKey || now - this.lastPredictionAt < throttle) {
			return;
		}
		this.lastPredictionKey = key;
		this.lastPredictionAt = now;

		const points = predictPath(sim.state, index, {
			horizon,
			dt: predictionDt(horizon, sim.dt),
			scale: SCENE_SCALE,
			referenceIndex: anchorIndex !== null && anchorIndex >= 0 ? anchorIndex : null
		});

		const visual = this.visuals.get(id);
		if (visual) this.prediction.setColor(visual.color);
		// Dash size must be set before the points are uploaded: `setPoints` runs
		// `computeLineDistances` and the dash pattern is measured against those baked
		// distances, so setting it after leaves the line solid until the next
		// recompute.
		this.prediction.setDashScale(pathExtent(points));
		this.prediction.setPoints(points);
	}

	/**
	 * Redraw the velocity gizmo for the selected body: velocity relative to the
	 * dominant attractor, scaled so the larger of the relative and local circular
	 * speed fills a set view fraction. That puts "circular orbit" at a predictable
	 * arrow length from a moon to an outer planet.
	 */
	private updateGizmo(sim: Simulation, settings: RenderSettings, alive: readonly string[]): void {
		const id = settings.selectedBodyId;
		if (!settings.velocityGizmo || id === null) {
			this.gizmo.hide();
			return;
		}

		const index = alive.indexOf(id);
		const visual = this.visuals.get(id);
		if (index < 0 || !visual) {
			this.gizmo.hide();
			return;
		}

		const { mass, pos, vel, n } = sim.state;
		const i3 = index * 3;
		const parent = dominantAttractor(index, mass, pos, n);

		let refSpeed: number;
		if (parent !== null) {
			const p3 = parent * 3;
			this.scratchB.set(vel[i3] - vel[p3], vel[i3 + 1] - vel[p3 + 1], vel[i3 + 2] - vel[p3 + 2]);
			const r = Math.hypot(pos[i3] - pos[p3], pos[i3 + 1] - pos[p3 + 1], pos[i3 + 2] - pos[p3 + 2]);
			const circular = r > 0 ? Math.sqrt((G * (mass[parent] + mass[index])) / r) : 0;
			refSpeed = Math.max(circular, this.scratchB.length());
		} else {
			this.scratchB.set(vel[i3], vel[i3 + 1], vel[i3 + 2]);
			refSpeed = this.scratchB.length();
		}

		const height = this.renderer.domElement.clientHeight || 1;
		const perPixel = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
		// Up-right of the body on screen, whatever the view direction, leaving the
		// body itself to the move grab. Diagonal on purpose: typical views project
		// one world axis near-horizontal and another near-vertical, and a purely
		// horizontal offset leaves those arrows' shafts crossing back over the
		// body — the diagonal keeps both families clear of it.
		this.scratchC
			.setFromMatrixColumn(this.camera.matrixWorld, 0)
			.addScaledVector(this.scratch.setFromMatrixColumn(this.camera.matrixWorld, 1), 0.6);
		this.gizmo.update(
			visual.group.position,
			this.scratchC,
			this.scratchB,
			refSpeed,
			this.camera.position.distanceTo(visual.group.position),
			perPixel,
			// The *rendered* radius, not the true one: at ×50 exaggeration an origin
			// offset measured from the true surface would land inside the inflated
			// disc, its knobs invisible and outranked by the body's own hit sphere.
			this.visualRadius(id),
			// The reference body can't be dragged (moving the rendered origin is a
			// runaway), so it gets no move icon.
			id !== settings.referenceFrame
		);
	}

	/** Typical body size in scene units — sets how far a merge burst sprays. */
	private bodyScaleHint(alive: readonly string[], radius: Float64Array, settings: RenderSettings): number {
		if (alive.length === 0) return 1;
		let largest = 0;
		for (let i = 0; i < alive.length; i++) largest = Math.max(largest, radius[i]);
		return Math.max((largest * settings.radiusExaggeration) / SCENE_SCALE, 0.5);
	}

	/**
	 * Create visuals for newly-alive bodies and dispose those that died; merges
	 * and seeks across them both land here.
	 */
	private reconcile(alive: readonly string[], byId: Map<string, Body>): void {
		for (const id of alive) {
			if (this.visuals.has(id)) continue;
			const body = byId.get(id);
			if (body) this.createVisual(body);
		}

		if (this.visuals.size === alive.length) return;

		const aliveSet = new Set(alive);
		for (const id of [...this.visuals.keys()]) {
			if (aliveSet.has(id)) continue;
			const visual = this.visuals.get(id)!;
			if (byId.has(id)) {
				// In the roster but merged away at this point on the timeline. Keep the
				// GPU objects (scrubbing back before the merge resurrects it) but stop
				// drawing.
				visual.group.visible = false;
				visual.hitSphere.visible = false;
				visual.label.visible = false;
				if (visual.light) visual.light.visible = false;
				// The tail hangs off the scene, not the group, so it needs hiding
				// explicitly or it outlives the body that owns it.
				visual.tail?.hide();
			} else {
				// Deleted from the roster entirely.
				this.removeVisual(id);
			}
		}

		for (const id of alive) {
			const visual = this.visuals.get(id);
			if (visual) visual.hitSphere.visible = true;
		}
	}

	private createVisual(body: Body): void {
		const group = new THREE.Group();
		const isStar = body.type === "star";

		// Black holes have no baked surface and no manifest entry; the drawn sphere
		// is the event horizon, pure black under any lighting. Real bodies get
		// their photographic map instead of the procedural (type, id-hash) one.
		const texture =
			body.type === "blackhole"
				? null
				: body.texture
					? createRealBodyTexture(body.texture)
					: createBodyTexture(body.type, body.id);

		// Satellites are modeled objects rather than textured spheres — the
		// silhouette is what identifies a spacecraft.
		let mesh: THREE.Object3D;
		let material: THREE.MeshStandardMaterial | null = null;
		let spacecraft: Spacecraft | null = null;

		if (body.type === "satellite" && texture) {
			spacecraft = new Spacecraft(texture, body.color, body.id);
			mesh = spacecraft.object;
		} else if (body.type === "blackhole") {
			// `material` stays null: the void material is shared and manager-owned,
			// so removeVisual's per-body dispose must not touch it.
			mesh = new THREE.Mesh(this.sphereGeometry, this.blackHoleMaterial);
		} else {
			material = new THREE.MeshStandardMaterial({
				map: texture,
				roughness: isStar ? 1 : 0.9,
				metalness: 0,
				// Stars carry their own light: emissive so they read as sources rather
				// than unlit spheres, and so the bloom pass has something to catch.
				emissive: new THREE.Color(isStar ? body.color : 0x000000),
				emissiveMap: isStar ? texture : null,
				emissiveIntensity: isStar ? 1.4 : 0
			});
			// Maps are baked in a per-type reference color; the body's own color is a
			// shader hue rotation. A photographic map is already the body's true
			// colors, so it takes no rotation and `color` can't recolor the surface.
			if (!body.texture) applyHueRotation(material, body.type, body.color);
			mesh = new THREE.Mesh(this.sphereGeometry, material);
		}

		group.add(mesh);
		this.scene.add(group);

		// A faint polar axis makes tilt readable even on a slow rotator.
		const axisMaterial = new THREE.LineBasicMaterial({
			color: new THREE.Color(body.color),
			transparent: true,
			opacity: 0.5,
			depthWrite: false
		});
		const axisGeometry = new THREE.BufferGeometry().setFromPoints([
			new THREE.Vector3(0, -1.7, 0),
			new THREE.Vector3(0, 1.7, 0)
		]);
		const axis = new THREE.Line(axisGeometry, axisMaterial);
		group.add(axis);

		// Invisible, generously sized so small bodies stay clickable.
		const hitSphere = new THREE.Mesh(this.hitGeometry, new THREE.MeshBasicMaterial({ visible: false }));
		hitSphere.userData.bodyId = body.id;
		this.scene.add(hitSphere);

		const labelElement = document.createElement("div");
		labelElement.className = "body-label";
		labelElement.textContent = body.name;
		labelElement.style.color = body.color;
		// The id rides on the element so clicking a name is a DOM lookup rather than
		// a raycast: labels sit above the canvas, often offset from the sub-pixel
		// dot they name.
		labelElement.dataset.bodyId = body.id;
		const label = new CSS2DObject(labelElement);
		label.position.set(0, 0, 0);
		label.center.set(0, 1.4);
		group.add(label);

		let light: THREE.PointLight | null = null;
		if (isStar) {
			// decay 0, not the physical 2: it lights the whole system evenly
			// regardless of orbital distance, which is what a 30 AU span needs.
			light = new THREE.PointLight(new THREE.Color(body.color), 2.6, 0, 0);
			this.scene.add(light);
		}

		this.trails.setColor(body.id, body.color);
		this.dots.setColor(body.id, body.color);

		const visual: BodyVisual = {
			group,
			mesh,
			material,
			texture,
			spacecraft,
			hitSphere,
			axis,
			axisMaterial,
			label,
			labelElement,
			labelCrowded: false,
			light,
			atmosphere: null,
			rings: null,
			tail: null,
			type: body.type,
			color: body.color,
			textureKey: body.texture,
			name: body.name,
			rotationPeriod: body.rotationPeriod,
			rotationPhase: body.rotationPhase ?? 0,
			axialTilt: body.axialTilt,
			radius: body.radius,
			visualRadius: 1
		};

		this.syncEffects(visual, body);
		this.visuals.set(body.id, visual);
	}

	/**
	 * Create, update, or tear down the optional per-body effects to match the
	 * body's current definition. Runs on creation and on every roster change, so
	 * toggling an atmosphere off in the editor actually removes it.
	 */
	private syncEffects(visual: BodyVisual, body: Body): void {
		visual.radius = body.radius;

		if (body.atmosphere) {
			if (visual.atmosphere) {
				visual.atmosphere.update(body.atmosphere.color, body.atmosphere.density);
			} else {
				visual.atmosphere = new Atmosphere(
					this.atmosphereGeometry,
					body.atmosphere.color,
					body.atmosphere.density,
					body.id
				);
				// Inside the group, so it inherits position and tilt but *not* the
				// mesh's spin — the deck's own drift comes via setSpin.
				visual.group.add(visual.atmosphere.object);
			}
		} else if (visual.atmosphere) {
			visual.group.remove(visual.atmosphere.object);
			visual.atmosphere.dispose();
			visual.atmosphere = null;
		}

		if (body.rings) {
			if (visual.rings) {
				visual.rings.update(body.rings, body.radius);
			} else {
				visual.rings = new Rings(body.rings, body.radius, body.id);
				// On the group, not the mesh: rings inherit axial tilt but must not
				// spin with the body's rotation.
				visual.group.add(visual.rings.mesh);
			}
		} else if (visual.rings) {
			visual.group.remove(visual.rings.mesh);
			visual.rings.dispose();
			visual.rings = null;
		}

		// Only icy/rocky debris outgasses.
		const wantsTail = body.type === "ice" || body.type === "asteroid";
		if (wantsTail) {
			if (visual.tail) {
				visual.tail.setColor(body.color);
			} else {
				visual.tail = new CometTail(body.color);
				// Positioned in world space (they point away from a star, not along a
				// body axis), so they hang off the scene, not the group.
				this.scene.add(visual.tail.points);
			}
		} else if (visual.tail) {
			this.scene.remove(visual.tail.points);
			visual.tail.dispose();
			visual.tail = null;
		}
	}

	/**
	 * Push roster changes (color, name, type, spin, tilt) onto existing visuals.
	 * Only a type or color change costs a texture regeneration.
	 */
	private applyAppearance(visual: BodyVisual, body: Body): void {
		visual.rotationPeriod = body.rotationPeriod;
		visual.rotationPhase = body.rotationPhase ?? 0;
		visual.axialTilt = body.axialTilt;

		if (visual.name !== body.name) {
			visual.name = body.name;
			visual.labelElement.textContent = body.name;
		}

		// Reconciled every frame regardless of color/type, since the editor can
		// toggle a ring on without touching either.
		this.syncEffects(visual, body);

		if (visual.color === body.color && visual.type === body.type && visual.textureKey === body.texture) return;

		// Editing into or out of `satellite`/`blackhole` changes the object graph,
		// not just materials, so rebuild the whole visual. Only happens on an edit.
		const specials: BodyType[] = ["satellite", "blackhole"];
		if (visual.type !== body.type && (specials.includes(visual.type) || specials.includes(body.type))) {
			this.removeVisual(body.id);
			this.createVisual(body);
			return;
		}

		visual.color = body.color;
		visual.type = body.type;
		visual.textureKey = body.texture;

		if (body.type === "blackhole") {
			// The mesh stays black regardless of color; only the accents follow it.
			visual.labelElement.style.color = body.color;
			visual.axisMaterial?.color.set(body.color);
			this.trails.setColor(body.id, body.color);
			return;
		}

		// The old texture is not disposed: body textures are shared and owned by
		// `textures.ts`, so another body of the same type may still use it. Color
		// isn't in the pixels — a color edit reuses the map and only retargets the
		// hue-rotation uniform.
		const texture = body.texture ? createRealBodyTexture(body.texture) : createBodyTexture(body.type, body.id);
		visual.texture = texture;

		if (visual.spacecraft) {
			visual.spacecraft.setHullTexture(texture);
			visual.spacecraft.setColor(body.color);
		} else if (visual.material) {
			visual.material.map = texture;

			const isStar = body.type === "star";
			visual.material.emissive.set(isStar ? body.color : 0x000000);
			visual.material.emissiveMap = isStar ? texture : null;
			visual.material.emissiveIntensity = isStar ? 1.4 : 0;
			// A photographic map takes no hue rotation; if this material had one
			// (the body was edited off a procedural surface), zero it in place.
			if (body.texture) neutralizeHueRotation(visual.material);
			else applyHueRotation(visual.material, body.type, body.color);
			visual.material.needsUpdate = true;
		}

		visual.labelElement.style.color = body.color;
		visual.axisMaterial?.color.set(body.color);
		if (visual.light) visual.light.color.set(body.color);
		this.trails.setColor(body.id, body.color);
		this.dots.setColor(body.id, body.color);
	}

	/**
	 * Set axial tilt and spin from absolute sim time. Deriving the angle from
	 * `simTime` instead of accumulating per frame is what makes rotation
	 * scrub-safe: time T always shows the same face, at any frame rate.
	 */
	private applyOrientation(visual: BodyVisual, simTime: number): void {
		const tilt = (visual.axialTilt * Math.PI) / 180;
		const phase = (visual.rotationPhase * Math.PI) / 180;
		const spin = phase + (visual.rotationPeriod === 0 ? 0 : (simTime / visual.rotationPeriod) * Math.PI * 2);

		// The mesh's pole (and the axis line, and the rings' normal) is local +Y,
		// but Kepler-built orbits lie in the xy-plane with +Z as the ecliptic
		// normal. Stand the pole up to +Z first, then tilt it back into the plane
		// by axialTilt — rotating about +Z instead keeps the pole *in* the orbital
		// plane, rendering every body at an effective 90° obliquity. The tilt's
		// azimuth (toward −Y) is arbitrary: the data model carries no pole RA.
		visual.group.rotation.set(Math.PI / 2 + tilt, 0, 0);
		visual.mesh.rotation.set(0, spin, 0);
		visual.atmosphere?.setSpin(spin);
	}

	private updateLabels(alive: readonly string[], show: boolean): void {
		const height = this.renderer.domElement.clientHeight;
		for (const id of alive) {
			const visual = this.visuals.get(id);
			if (!visual) continue;
			// Hide via the CSS2DObject's `visible` flag, never `style.display`:
			// CSS2DRenderer rewrites the element's display from that flag on every
			// render (which runs after this), so a style set here silently does
			// nothing.
			if (!show) {
				visual.label.visible = false;
				continue;
			}
			// Distant labels are clutter.
			const distance = this.camera.position.distanceTo(visual.group.position);
			visual.label.visible = distance <= LABEL_MAX_DISTANCE && !this.crowdedByParent(id, visual, height);
		}
	}

	/** Whether this body's label should hide against its SOI parent's. */
	private crowdedByParent(id: string, visual: BodyVisual, height: number): boolean {
		const parentId = this.labelParents.get(id);
		const parent = parentId !== undefined ? this.visuals.get(parentId) : undefined;
		if (!parent) {
			visual.labelCrowded = false;
			return false;
		}
		// The pair's *potential* screen separation — as if viewed broadside — not
		// the projected one: a planet transiting in front of its parent is a
		// passing line-of-sight alignment, and its label blinking out mid-transit
		// reads as a bug. Only a pair too tight to resolve at this zoom from any
		// angle hides.
		const separation = this.scratch.copy(visual.group.position).sub(parent.group.position).length();
		const distance = this.camera.position.distanceTo(visual.group.position);
		if (distance === 0) return visual.labelCrowded;
		const pxPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
		const separationPx = (separation / distance) * pxPerRadian;
		visual.labelCrowded = separationPx < (visual.labelCrowded ? LABEL_CROWD_SHOW_PX : LABEL_CROWD_HIDE_PX);
		return visual.labelCrowded;
	}

	private removeVisual(id: string): void {
		const visual = this.visuals.get(id);
		if (!visual) return;

		this.scene.remove(visual.group);
		this.scene.remove(visual.hitSphere);
		if (visual.light) this.scene.remove(visual.light);
		if (visual.tail) this.scene.remove(visual.tail.points);

		visual.material?.dispose();
		visual.spacecraft?.dispose();
		// `visual.texture` is deliberately not disposed: shared across every body of
		// the same type and color, and owned by `textures.ts`.
		visual.axis?.geometry.dispose();
		visual.axisMaterial?.dispose();
		(visual.hitSphere.material as THREE.Material).dispose();
		visual.label.removeFromParent();
		visual.labelElement.remove();
		visual.light?.dispose();
		visual.atmosphere?.dispose();
		visual.rings?.dispose();
		visual.tail?.dispose();

		this.trails.remove(id);
		this.dots.remove(id);
		this.vectors.remove(id);
		this.habitableZones.remove(id);
		this.visuals.delete(id);
	}
}
