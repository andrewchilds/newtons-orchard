<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
  import { SCENE_SCALE, SceneManager } from './sceneManager';
  import { SceneInteraction } from './interaction';
  import { Flight, FLIGHT_RATE, flightKeyFor, Orbit, ORBIT_RATE } from './flight';
  import { dominantAttractor } from '../physics/orbitInfo';
  import { sim } from '../state/simInstance';
  import { tick, time } from '../state/time.svelte';
  import { isSatelliteLanding, system } from '../state/system.svelte';
  import { quarterTurnTarget, turnDuration } from './cameraTurn';
  import { ui, SELECTED_TRAIL_MULTIPLIER, type CameraMove } from '../state/ui.svelte';

  let container: HTMLDivElement;
  let labelLayer: HTMLDivElement;
  let pivotMarker: HTMLDivElement;

  // Trackball's dynamic damping glides every gesture, but only rotation and the
  // wheel should keep it: a drag zoom or pan that coasts after release feels
  // like the camera slipping, while a wheel tick has no release — the damping
  // is what spreads its step over a few frames instead of landing it whole.
  // These overrides make drag zoom/pan consume their delta at once. The methods
  // are internal and undeclared in the typings, hence the typed prototype view
  // rather than `super`.
  const trackballInternals = TrackballControls.prototype as unknown as {
    _zoomCamera(): void;
    _panCamera(): void;
  };

  /** Trackball's internal gesture states; PAN is what a held Shift selects. */
  const STATE_NONE = -1;
  const STATE_ROTATE = 0;
  const STATE_ZOOM = 1;
  const STATE_PAN = 2;
  const STATE_TOUCH_ROTATE = 3;

  /** The internals the Shift-to-pan override reaches for, none of them typed. */
  type TrackballKeyInternals = {
    keyState: number;
    _onKeyDown: (event: KeyboardEvent) => void;
    _onKeyUp: (event: KeyboardEvent) => void;
  };

  class SpaceControls extends TrackballControls {
    _zoomCamera() {
      // Only a drag sets ZOOM; wheel deltas arrive with the state unset and
      // stay on the damped path (touch pinch takes its own branch upstream).
      if ((this as unknown as { state: number }).state !== STATE_ZOOM) {
        // The damped path applies the *whole remaining* delta as a factor each
        // frame and only decays the remainder by dynamicDampingFactor, so a
        // tick's summed travel lands at ~1/dynamicDampingFactor times the
        // static amount. Scale the speed down so the glide's total matches a
        // static consume of the same tick.
        const speed = this.zoomSpeed;
        this.zoomSpeed = speed * this.dynamicDampingFactor;
        trackballInternals._zoomCamera.call(this);
        this.zoomSpeed = speed;
        return;
      }
      const damped = this.staticMoving;
      this.staticMoving = true;
      trackballInternals._zoomCamera.call(this);
      this.staticMoving = damped;
    }
    _panCamera() {
      const damped = this.staticMoving;
      this.staticMoving = true;
      trackballInternals._panCamera.call(this);
      this.staticMoving = damped;
    }

    /**
     * Trackball's stock modifier keys are A/S/D on a *window* listener, which
     * swallows those letters anywhere on the page — including while typing a
     * body's name. Swap in Shift-for-pan, matched on `shiftKey` so either Shift
     * works (the stock path compares `event.code` and sees only one).
     *
     * The base class binds and registers these as instance fields in its
     * constructor, so overriding means reassigning and re-adding the listeners
     * rather than defining a method.
     */
    constructor(...args: ConstructorParameters<typeof TrackballControls>) {
      super(...args);

      const internals = this as unknown as TrackballKeyInternals;
      window.removeEventListener('keydown', internals._onKeyDown);
      window.removeEventListener('keyup', internals._onKeyUp);

      internals._onKeyDown = (event: KeyboardEvent) => {
        if (!this.enabled || this.noPan) return;
        if (!event.shiftKey || isTypingTarget(event.target)) return;
        internals.keyState = STATE_PAN;
      };
      internals._onKeyUp = (event: KeyboardEvent) => {
        if (!this.enabled) return;
        if (event.shiftKey) return;
        internals.keyState = STATE_NONE;
      };

      window.addEventListener('keydown', internals._onKeyDown);
      window.addEventListener('keyup', internals._onKeyUp);
    }
  }

  /** Shift is a normal modifier while typing — never a camera gesture there. */
  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  }

  onMount(() => {
    const manager = new SceneManager(container, labelLayer);

    // Trackball, not OrbitControls: orbit pins rotation to a fixed up axis and
    // hard-stops at the poles, an artificial ceiling/floor in a scene with
    // neither. The cost of free tumbling is that up can roll away from the
    // ecliptic normal, so Focus/Center re-level it (see frameBody).
    const controls = new SpaceControls(manager.camera, manager.domElement);
    // Trackball's default rotate/pan speeds cover far less arc per unit drag.
    controls.rotateSpeed = 3;
    controls.panSpeed = 0.8;
    controls.dynamicDampingFactor = 0.1;
    // Room to get inside a planet's orbit and out past the whole system.
    controls.minDistance = 0.002;
    controls.maxDistance = 2e5;

    // Direct manipulation (click-to-place, body drags), registered on the
    // container in the capture phase so it sees events before the camera
    // controls, which own the canvas's listeners.
    const interaction = new SceneInteraction(manager, container);

    // Focus is a follow, not a one-shot: the camera moves with the body every
    // frame — translated by its rendered delta, and (for a focus, not a
    // center-follow) rotated to hold the anchor's viewport bearing — so
    // orbit/zoom/pan still work relative to it. `followValid` stays false until
    // a frame captures a position, so a fresh focus never applies a bogus delta.
    let followId: string | null = null;
    /** true when the follow is a focus (rotate to hold the anchor's bearing),
     *  false when it's just tracking the center body (translation only) */
    let followIsFocus = false;
    const followPos = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    let followValid = false;

    // Previous frame's bearing of the anchor (center / parent) from the focused
    // body. A focus-follow rotates the camera about the body by however much
    // this moved, so the anchor holds its viewport place as the body orbits.
    // Like `followValid`, invalid until a frame has captured it.
    const anchorDir = new THREE.Vector3();
    const anchorDirNow = new THREE.Vector3();
    const anchorRotation = new THREE.Quaternion();
    let anchorDirValid = false;

    /**
     * A body's position in rendered (reference-frame) coordinates, read from
     * the sim rather than the scene graph: the camera updates *before* each
     * render, and the scene's own positions are a frame stale at that point —
     * a large fraction of the viewport at high warp. Mirrors the frame math in
     * `SceneManager.render`: subtract the reference body's position (skipped if
     * it isn't alive), then scale.
     */
    const scratchRef = new THREE.Vector3();
    function simRenderedPosition(id: string, out: THREE.Vector3): boolean {
      const p = sim.positionOf(id);
      if (!p) return false;
      out.set(p.x, p.y, p.z);
      const refId = ui.referenceBodyId;
      if (refId !== null) {
        const r = sim.positionOf(refId);
        if (r) out.sub(scratchRef.set(r.x, r.y, r.z));
      }
      out.divideScalar(SCENE_SCALE);
      return true;
    }

    /**
     * The point worth keeping in frame behind a focused body: the
     * reference-frame origin — the barycenter, or the frame body, both of
     * which render at (0,0,0) — unless the body sits on or near it (it *is*
     * the frame body, or a star at the barycenter), in which case its
     * dominant attractor. False when nothing qualifies.
     */
    function focusAnchor(id: string, bodyPos: THREE.Vector3, minDistance: number, out: THREE.Vector3): boolean {
      out.set(0, 0, 0);
      if (bodyPos.lengthSq() > minDistance * minDistance) return true;
      const index = sim.aliveIds.indexOf(id);
      if (index < 0) return false;
      const parent = dominantAttractor(index, sim.state.mass, sim.state.pos, sim.state.n);
      if (parent === null) return false;
      return (
        simRenderedPosition(sim.aliveIds[parent], out) &&
        out.distanceToSquared(bodyPos) > minDistance * minDistance
      );
    }

    /**
     * Snap the camera into the standard framing of `id`: target on the body,
     * pulled back to a fixed multiple of its radius and aimed so the body's
     * anchor (frame origin or parent) sits in the background — "this body, with
     * what it orbits behind it" rather than empty sky. Shared by focusing and by
     * the Center button. False if the body isn't alive.
     */
    const focusTarget = new THREE.Vector3();
    const focusAnchorPos = new THREE.Vector3();
    function frameBody(id: string): boolean {
      if (!simRenderedPosition(id, focusTarget)) return false;
      const radius = manager.visualRadius(id);
      // ~15% of viewport height: a subject in a scene, not a wall.
      const distance = Math.max(radius * 14, 0.01);
      const offset = new THREE.Vector3();
      if (focusAnchor(id, focusTarget, distance * 4, focusAnchorPos)) {
        offset.subVectors(focusTarget, focusAnchorPos).setLength(distance);
        // Lift out of the orbital plane (z — see camera.up in SceneManager) so
        // the anchor clears the body's disc, on whichever side the camera is
        // already on. An in-plane lift would only skew azimuth, and the follow
        // rotation keeps an out-of-plane component stable for a whole orbit.
        const side = manager.camera.position.z - controls.target.z < 0 ? -1 : 1;
        offset.z += distance * 0.35 * side;
      } else {
        // No anchor (lone star, dead parent) — keep the current view direction.
        offset.copy(manager.camera.position).sub(controls.target);
      }
      controls.target.copy(focusTarget);
      manager.camera.position.copy(focusTarget).add(offset.setLength(distance));
      // Free tumbling rolls the camera off the ecliptic; a snap to the standard
      // framing is the moment to level the horizon again.
      manager.camera.up.set(0, 0, 1);
      return true;
    }

    function focusOn(id: string) {
      if (!frameBody(id)) {
        // Not alive right now — don't leave the Focus dropdown claiming it.
        if (ui.focusedBodyId === id) ui.clearFocus();
        return;
      }
      followId = id;
      followIsFocus = true;
      followValid = false;
      anchorDirValid = false;
    }

    // --- explicit camera moves --------------------------------------------
    // The toolbar's quarter-turn and zoom buttons, all working on the camera's
    // offset from `controls.target` so they compose with a focus-follow (which
    // moves target and camera together) and with any user pan offset.

    const moveOffset = new THREE.Vector3();

    /**
     * The in-flight button move. Held as an *offset from the target* plus an up
     * vector rather than absolute positions: the follow below moves target and
     * camera together every frame, and a tween toward a world position would
     * fight it, crawling toward a point the body has already left. Interpolating
     * the offset means the animation describes the shot (bearing, elevation,
     * distance) while the follow supplies the subject.
     *
     * Wall-clock timed, not sim-timed: pure display, so it must run while paused
     * and must not vary with warp.
     */
    interface CameraTween {
      fromOffset: THREE.Vector3;
      toOffset: THREE.Vector3;
      fromUp: THREE.Vector3;
      toUp: THREE.Vector3;
      /** seconds elapsed / total */
      elapsed: number;
      duration: number;
    }

    let cameraTween: CameraTween | null = null;

    const ZOOM_SECONDS = 0.22;

    /** Smoothstep — zero velocity at both ends, so no start/stop jerk. */
    function easeInOut(t: number): number {
      return t * t * (3 - 2 * t);
    }

    /**
     * Starting from the *live* camera rather than the previous tween's
     * destination is what lets clicks interrupt each other smoothly.
     */
    function startTween(toOffset: THREE.Vector3, toUp: THREE.Vector3, duration: number): void {
      const camera = manager.camera;
      cameraTween = {
        fromOffset: new THREE.Vector3().subVectors(camera.position, controls.target),
        toOffset: toOffset.clone(),
        fromUp: camera.up.clone(),
        toUp: toUp.clone(),
        elapsed: 0,
        duration,
      };
    }

    /**
     * Called every frame *before* the follow, so the follow's delta lands on top
     * of the tweened offset and a move made while following tracks the body.
     */
    const tweenOffset = new THREE.Vector3();
    const tweenUp = new THREE.Vector3();
    function updateCameraTween(wallDelta: number): void {
      const t = cameraTween;
      if (!t) return;

      t.elapsed += wallDelta;
      const progress = t.duration <= 0 ? 1 : Math.min(t.elapsed / t.duration, 1);
      const eased = easeInOut(progress);

      // Slerp the offset: a straight lerp cuts the chord through a quarter
      // turn, diving the camera at the target and back out. Distance is lerped
      // separately so a simultaneous zoom still reads as a smooth in/out.
      tweenOffset.copy(t.fromOffset).normalize();
      tweenUp.copy(t.toOffset).normalize();
      const dot = Math.min(Math.max(tweenOffset.dot(tweenUp), -1), 1);
      const omega = Math.acos(dot);
      if (omega < 1e-6) {
        tweenOffset.copy(tweenUp);
      } else {
        // Antipodal offsets have no unique arc. The clamp above bounds omega,
        // and the near-zero case is handled by the branch above.
        const sinOmega = Math.sin(omega);
        tweenOffset
          .multiplyScalar(Math.sin((1 - eased) * omega) / sinOmega)
          .addScaledVector(tweenUp, Math.sin(eased * omega) / sinOmega);
      }
      const length = t.fromOffset.length() * (1 - eased) + t.toOffset.length() * eased;

      manager.camera.position.copy(controls.target).addScaledVector(tweenOffset, length);
      manager.camera.up.copy(t.fromUp).lerp(t.toUp, eased).normalize();

      if (progress >= 1) cameraTween = null;
    }

    // Destination of an in-flight quarter turn (see scene/cameraTurn.ts).
    const turnOffset = new THREE.Vector3();
    const turnUp = new THREE.Vector3();

    function applyCameraMove(move: CameraMove): void {
      const camera = manager.camera;
      // Measured from the tween's destination when one is in flight, so a
      // second click queues off where the camera is *going*: three fast clicks
      // land three quadrants on, not between one and two.
      if (cameraTween) moveOffset.copy(cameraTween.toOffset);
      else moveOffset.subVectors(camera.position, controls.target);
      const distance = moveOffset.length();
      // Only degenerate if the camera sits exactly on its target (minDistance
      // prevents it), but a zoom from zero stays at zero and the normalize
      // below would produce NaNs.
      if (distance === 0) return;

      switch (move.kind) {
        case 'quarterTurn': {
          quarterTurnTarget(move.turn, moveOffset, camera.up, turnOffset, turnUp);
          startTween(turnOffset, turnUp, turnDuration(moveOffset, turnOffset));
          break;
        }
        case 'zoom': {
          // The same range the wheel obeys, so buttons can't walk the camera
          // somewhere a drag could never reach.
          const next = Math.min(
            Math.max(distance * move.factor, controls.minDistance),
            controls.maxDistance
          );
          // A zoom leaves up alone, but the tween still needs a destination.
          startTween(moveOffset.clone().setLength(next), camera.up, ZOOM_SECONDS);
          break;
        }
      }
    }

    // --- pointer handling -------------------------------------------------
    // A drag that ends over a body shouldn't select it, so clicks are only
    // honored when the pointer barely moved between down and up.
    let downX = 0;
    let downY = 0;
    let moved = false;

    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      // A button move in flight would fight the drag, and the hand always wins.
      cameraTween = null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) moved = true;
    };

    const onClick = (e: MouseEvent) => {
      if (moved) return;
      ui.selectedBodyId = manager.pick(e);
    };

    const onDoubleClick = (e: MouseEvent) => {
      const id = manager.pick(e);
      if (!id) return;
      // Via the shared helper, not focusOn, so the toolbar's Focus dropdown
      // reflects it; the frame loop picks the request up.
      ui.focusBody(id);
    };

    const canvas = manager.domElement;

    // Name labels sit in a DOM layer above the canvas, so canvas listeners never
    // see them. They select and frame like the body does, which matters for
    // distant bodies whose dot is a pixel but whose label is an easy target.
    const onLabelClick = (e: MouseEvent) => {
      const id = manager.labelTarget(e.target);
      if (!id) return;
      ui.selectedBodyId = id;
    };

    const onLabelDoubleClick = (e: MouseEvent) => {
      const id = manager.labelTarget(e.target);
      if (!id) return;
      ui.focusBody(id);
    };

    // Labels take pointer events so they're clickable, which also means they
    // swallow wheel events — zoom would die wherever a name sat under the
    // cursor. Replay on the canvas so the trackball's listener and onWheel see it.
    const onLabelWheel = (e: WheelEvent) => {
      if (e.target === labelLayer) return;
      const forwarded = new WheelEvent('wheel', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        cancelable: true,
      });
      canvas.dispatchEvent(forwarded);
      // Trackball preventDefaults its wheel events to stop the browser
      // page-zooming on a trackpad pinch. The synthetic event's call doesn't
      // reach the real one, so pass it along by hand.
      if (forwarded.defaultPrevented) e.preventDefault();
    };

    // --- merge bursts and accretion flares --------------------------------
    // The burst goes where the survivor ended up — the mass-weighted position,
    // i.e. the impact site. Its lifetime is sim time inside MergeBursts, so
    // scrubbing replays it.
    //
    // A black hole capture gets a flare instead: debris spraying out of the
    // horizon is the one thing that can't happen, while the accretion glow (in
    // the *absorbed* body's color — that body's matter lighting up) is the real
    // signature. Two black holes merging emit no light, so that case gets none.
    const unsubscribeMerge = sim.onMerge((event) => {
      const survivor = system.byId(event.survivorId);
      if (survivor?.type === 'blackhole') {
        if (system.byId(event.absorbedId)?.type === 'blackhole') return;
        const color = system.byId(event.absorbedId)?.color ?? '#ffd9a0';
        manager.addAccretionFlare(event.t, event.survivorId, color);
        return;
      }
      // A spacecraft coming down gets no burst: debris thrown planet-wide from
      // a metres-sized craft reads as the planet exploding. The toast carries
      // the arrival instead.
      if (isSatelliteLanding(event)) return;
      const at = sim.positionOf(event.survivorId);
      if (!at) return;
      const color = survivor?.color ?? '#ffd9a0';
      manager.addMergeBurst(event.t, at.x, at.y, at.z, color);
    });

    // --- arrow-key flight and orbit ---------------------------------------
    // Fly the camera like a spaceship: arrows translate camera and target
    // together — a pan in effect, so orbit, zoom and follows keep composing —
    // with the ramp-in/glide-out smoothing living in scene/flight.ts. Shift
    // swaps the same keys for a slow orbit about the target.
    const flight = new Flight();
    const orbit = new Orbit();
    const flightForward = new THREE.Vector3();
    const flightRight = new THREE.Vector3();
    const flightStep = new THREE.Vector3();

    const onFlightKeyDown = (e: KeyboardEvent) => {
      // defaultPrevented: a focused control that already consumed the arrow
      // (the shuttle, a number field) keeps it. Modified arrows are browser
      // and OS shortcuts — all but Shift, which is ours.
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = flightKeyFor(e.key);
      if (!key) return;
      // Auto-repeat keeps firing keydown while the arrow is held, so pressing
      // or lifting Shift mid-hold lands here and switches drives. The other
      // drive must let go, or the camera flies and orbits at once.
      if (e.shiftKey) {
        orbit.press(key);
        flight.release(key);
      } else {
        flight.press(key);
        orbit.release(key);
      }
      // A button move in flight would fight the keys, and the hand wins.
      cameraTween = null;
      // Arrows scroll whatever container can scroll otherwise.
      e.preventDefault();
    };
    const onFlightKeyUp = (e: KeyboardEvent) => {
      // Unconditional — the matching keydown may have been consumed by a
      // control that has since lost focus, and a missed release wedges the
      // camera in motion. Both drives: Shift may have changed since the press.
      const key = flightKeyFor(e.key);
      if (!key) return;
      flight.release(key);
      orbit.release(key);
    };
    const onFlightBlur = () => {
      flight.releaseAll();
      orbit.releaseAll();
    };
    window.addEventListener('keydown', onFlightKeyDown);
    window.addEventListener('keyup', onFlightKeyUp);
    window.addEventListener('blur', onFlightBlur);

    // Wheel zoom grabs the camera without going through pointerdown — same
    // rule, the hand wins.
    const onWheel = () => {
      cameraTween = null;
    };

    canvas.addEventListener('wheel', onWheel, { passive: true });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onDoubleClick);
    labelLayer.addEventListener('click', onLabelClick);
    labelLayer.addEventListener('dblclick', onLabelDoubleClick);
    labelLayer.addEventListener('wheel', onLabelWheel, { passive: false });

    // --- idle-frame skip --------------------------------------------------
    // While paused, every visual change originates from user input: nothing
    // in the scene animates on wall clock (bursts and flares age on sim time,
    // the starfield is static), and the camera only moves under a gesture,
    // tween or follow. So "no input for a while" is a safe proxy for "the
    // last rendered frame is still correct" — skipping the render leaves that
    // frame composited. The deadband is generous so everything an input sets
    // in motion (camera damping, a tween, texture loads after a system
    // switch) settles well inside it. Scripted mutations arrive with no input
    // events, so seek/load generation bumps count as activity too.
    const IDLE_RENDER_DELAY_MS = 5000;
    // Duplicates ui/capture.ts's isCaptureRun — scene/ can't import ui/. The
    // screenshot script drives the app programmatically and then photographs
    // the canvas, so it must never see a skipped (stale) frame.
    const captureRun = new URLSearchParams(window.location.search).get('capture') === '1';
    let lastActivity = performance.now();
    const markActivity = () => {
      lastActivity = performance.now();
    };
    // Window-level with capture: panel edits, roster clicks and keyboard
    // shortcuts change the frame just as much as canvas gestures do.
    window.addEventListener('pointerdown', markActivity, { capture: true, passive: true });
    window.addEventListener('pointermove', markActivity, { capture: true, passive: true });
    window.addEventListener('wheel', markActivity, { capture: true, passive: true });
    window.addEventListener('keydown', markActivity, { capture: true, passive: true });

    // --- resize -----------------------------------------------------------
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      if (w === 0 || h === 0) return;
      manager.setSize(w, h);
      // Trackball caches the canvas rect for its drag→arc math.
      controls.handleResize();
      markActivity();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // --- frame loop -------------------------------------------------------
    // Reactive state is read here, once per frame, and never written per-frame
    // except for the explicit focus handshake. Physics data never enters
    // reactivity at all.
    let lastFrame = performance.now();
    const gestureInternals = controls as unknown as { state: number; keyState: number };
    let pivotShown = false;
    let lastFocusRequest = ui.focusRequest;
    let lastCenterRequest = ui.centerRequest;
    let lastReferenceFrame = ui.referenceBodyId;
    let lastLoadGeneration = system.loadGeneration;
    let lastSeekGeneration = time.seekGeneration;
    const scratch = new THREE.Vector3();
    const scratchStar = new THREE.Vector3();

    // Smallest scene-unit change worth republishing (1e-3 units = 1e6 m, below
    // the readout's precision at any zoom, so this only filters no-op frames).
    const readoutOffset = new THREE.Vector3();
    const READOUT_EPSILON = 1e-3;

    let raf = requestAnimationFrame(function loop(now: number) {
      const wallDelta = (now - lastFrame) / 1000;
      lastFrame = now;

      tick(sim, wallDelta);

      // Bursts and flares belong to the timeline that recorded them; a load
      // starts a new one, and a stale burst would replay at the old system's
      // coordinates once the new clock passed its sim time. Keyed off loads
      // alone: seekGeneration also bumps on edits and scrubs, where replaying
      // the effects is the point.
      if (system.loadGeneration !== lastLoadGeneration) {
        lastLoadGeneration = system.loadGeneration;
        manager.clearBursts();
        lastActivity = now;
      }
      if (time.seekGeneration !== lastSeekGeneration) {
        lastSeekGeneration = time.seekGeneration;
        lastActivity = now;
      }

      const referenceId = ui.referenceBodyId;

      // All camera work happens *before* the render, against the sim's
      // just-ticked positions. Running it after leaves the camera a frame
      // behind the body it follows: invisible at low warp, but past ~10 days/s
      // a frame of orbital motion is a large fraction of the focus distance and
      // the body jitters around (or leaves) the viewport.

      // Changing the center changes what every rendered position means. With a
      // focus active, re-frame the same body against the new anchor; without
      // one, park the camera on the new center — which doubles as follow, since
      // the center body is the origin of the rendered world.
      //
      // Focus / center / zoom re-framings write the camera outright and run
      // before the tween advances below, so an in-flight button move would
      // overwrite them. The re-frame is the newer instruction and wins.
      if (
        cameraTween &&
        (referenceId !== lastReferenceFrame ||
          ui.focusRequest !== lastFocusRequest ||
          ui.centerRequest !== lastCenterRequest ||
          ui.zoomRequest !== null)
      ) {
        cameraTween = null;
      }

      if (referenceId !== lastReferenceFrame) {
        lastReferenceFrame = referenceId;
        if (ui.focusedBodyId) {
          focusOn(ui.focusedBodyId);
        } else {
          followId = referenceId;
          followIsFocus = false;
          followValid = false;
          if (referenceId === null) controls.target.set(0, 0, 0);
          else if (simRenderedPosition(referenceId, scratch)) controls.target.copy(scratch);
        }
      }

      // A focus that arrives with a system load (a preset's opening view) lands
      // a frame before this frame's render builds the new visuals, and framing
      // against the fallback visualRadius parks the camera ~1e10 m out. Leave
      // the request pending until the visual exists; a body with no sim
      // position will never get one, so it's handled now (focusOn clears it).
      if (ui.focusRequest !== lastFocusRequest) {
        const id = ui.focusedBodyId;
        if (id === null || manager.hasVisual(id) || !sim.positionOf(id)) {
          lastFocusRequest = ui.focusRequest;
          if (id) focusOn(id);
        }
      }

      // Focus cancelled from the UI (the dropdown's "None") — stop following
      // and leave the camera where it is.
      if (followIsFocus && ui.focusedBodyId === null) {
        followId = null;
        followIsFocus = false;
        followValid = false;
      }

      // The toolbar's Center button, using the same full re-frame a focus does.
      // The barycenter has no radius to frame against, so it resets to the
      // cold-load view; fitting the outermost body instead reads as empty sky
      // (2× Pluto puts every planet sub-pixel and past the label cull).
      // `recenter` already cleared any focus above.
      if (ui.centerRequest !== lastCenterRequest) {
        lastCenterRequest = ui.centerRequest;
        if (referenceId === null || !frameBody(referenceId)) {
          controls.target.set(0, 0, 0);
          manager.camera.position.set(0, 90, 260);
          manager.camera.up.set(0, 0, 1);
        }
        followId = referenceId;
        followIsFocus = false;
        followValid = false;
      }

      // Swing to the lit side (the screenshot script — see ui.svelte). Runs
      // before the zoom so that only the distance is left to set: this picks the
      // direction, `zoomRequest` picks how far along it.
      //
      // The lit direction is target → brightest star, and the camera goes on
      // that side of the target, keeping its existing out-of-plane lift so the
      // shot still looks down on the ecliptic rather than edge-on.
      if (ui.sunwardRequest) {
        ui.sunwardRequest = false;
        // Resolved from the sim's own roster, not the manager's visuals: on the
        // frame a shot is set up the visuals still belong to the previous
        // system, so their ids aren't in the new sim and the lookup fails.
        // Heaviest star, matching the PointLight budget's ordering.
        let starId: string | null = null;
        let starMass = -Infinity;
        for (const body of sim.bodies) {
          if (body.type !== 'star') continue;
          if (body.mass > starMass) {
            starId = body.id;
            starMass = body.mass;
          }
        }

        // The target is whatever the shot centered on, which renders at the
        // origin when it's the reference body; taking it from `controls` keeps
        // the barycentric case (Full Stop) right too.
        if (starId !== null && simRenderedPosition(starId, scratchStar)) {
          const lift = manager.camera.position.z - controls.target.z;
          const offset = scratchStar.sub(controls.target);
          offset.z = 0;
          if (offset.lengthSq() > 0) {
            const distance = manager.camera.position.distanceTo(controls.target);
            offset.setLength(distance);
            offset.z = lift;
            manager.camera.position.copy(controls.target).add(offset);
            manager.camera.up.set(0, 0, 1);
          }
        }
      }

      // Explicit camera distance (the preset-screenshot script and preset
      // opening views — see ui.svelte). Consumed after center/focus so it
      // overrides the framing they chose rather than being overwritten: the
      // request is "that subject, this scale". Held while a focus request is
      // pending (deferred above), or the focus framing that lands a frame
      // later would overwrite the distance this set.
      if (ui.zoomRequest !== null && ui.focusRequest === lastFocusRequest) {
        const distance = ui.zoomRequest / SCENE_SCALE;
        ui.zoomRequest = null;
        manager.camera.position
          .sub(controls.target)
          .setLength(distance)
          .add(controls.target);
        manager.camera.up.set(0, 0, 1);
      }

      // Drained here rather than in the UI because the camera lives in this
      // module, and applied before the follow so a move made while following is
      // carried by that body's delta on the same frame instead of a frame late.
      if (ui.cameraMoves.length > 0) {
        for (const move of ui.cameraMoves) applyCameraMove(move);
        ui.cameraMoves = [];
      }
      // Wall-clock: a display transition, not a simulated motion, so it runs at
      // the same rate while paused and at any warp.
      updateCameraTween(wallDelta);

      // Deltas rather than absolute positions, so user pan offsets persist and
      // a seek that teleports the body carries the camera along.
      if (followId) {
        if (simRenderedPosition(followId, scratch)) {
          if (followValid) {
            followDelta.subVectors(scratch, followPos);
            controls.target.add(followDelta);
            manager.camera.position.add(followDelta);
          }
          followPos.copy(scratch);
          followValid = true;

          // A focus-follow also *rotates*: swing camera and target about the
          // body by the frame-to-frame change in the anchor's bearing, so the
          // center holds its viewport place across the orbit. The anchor only
          // counts when it sits beyond the camera — pinning something inside the
          // shot is meaningless and numerically twitchy.
          if (
            followIsFocus &&
            focusAnchor(
              followId,
              scratch,
              manager.camera.position.distanceTo(scratch),
              focusAnchorPos
            )
          ) {
            anchorDirNow.subVectors(scratch, focusAnchorPos).normalize();
            if (anchorDirValid) {
              anchorRotation.setFromUnitVectors(anchorDir, anchorDirNow);
              manager.camera.position.sub(scratch).applyQuaternion(anchorRotation).add(scratch);
              controls.target.sub(scratch).applyQuaternion(anchorRotation).add(scratch);
            }
            anchorDir.copy(anchorDirNow);
            anchorDirValid = true;
          } else {
            anchorDirValid = false;
          }
        } else {
          // Merged away or deleted — stay put rather than jump elsewhere.
          if (followIsFocus && ui.focusedBodyId === followId) ui.clearFocus();
          followId = null;
          followIsFocus = false;
          followValid = false;
        }
      }

      // Arrow-key flight, after the follow so the step lands on top of the
      // followed body's delta. Directions come from the camera basis — forward
      // is where you're looking, including any pitch — and the cruise speed
      // scales with the camera–target distance, which the translation itself
      // preserves.
      manager.camera.getWorldDirection(flightForward);
      flightRight.setFromMatrixColumn(manager.camera.matrixWorld, 0);
      const flightSpeed = manager.camera.position.distanceTo(controls.target) * FLIGHT_RATE;
      if (flight.step(wallDelta, flightForward, flightRight, flightSpeed, flightStep)) {
        manager.camera.position.add(flightStep);
        controls.target.add(flightStep);
      }
      // Shift-arrow orbit. The translation above leaves the camera's basis
      // untouched, so `flightRight` is still this frame's right; controls.update
      // below re-aims the camera at the target from wherever this leaves it.
      orbit.step(
        wallDelta,
        ORBIT_RATE,
        controls.target,
        manager.camera.up,
        flightRight,
        manager.camera.position
      );

      controls.update();

      // The rotation-pivot marker: while a rotate drag is in progress, show
      // where the camera is orbiting *around*. The trackball always looks at
      // its target, so the pivot projects to the exact viewport center — a
      // fixed overlay, no projection needed. `keyState` wins over `state`
      // exactly as the trackball's own update resolves the gesture, so a
      // Shift-pan never reads as a rotate. Direct DOM, not reactive state —
      // nothing per-frame goes through reactivity.
      const gesture =
        gestureInternals.keyState !== STATE_NONE ? gestureInternals.keyState : gestureInternals.state;
      // Keyboard orbiting shows the pivot too — it's the same question, "what
      // am I swinging around?"
      const rotating =
        gesture === STATE_ROTATE || gesture === STATE_TOUCH_ROTATE || orbit.active;
      if (rotating !== pivotShown) {
        pivotShown = rotating;
        pivotMarker.classList.toggle('visible', rotating);
      }

      // Publish the camera offset for the corner readout, after controls.update
      // so it's the pose this frame renders. Gated on real movement: an idle
      // camera would otherwise invalidate a reactive read 60 times a second for
      // identical numbers.
      readoutOffset.subVectors(manager.camera.position, controls.target);
      if (
        Math.abs(readoutOffset.x - ui.cameraOffset.x / SCENE_SCALE) > READOUT_EPSILON ||
        Math.abs(readoutOffset.y - ui.cameraOffset.y / SCENE_SCALE) > READOUT_EPSILON ||
        Math.abs(readoutOffset.z - ui.cameraOffset.z / SCENE_SCALE) > READOUT_EPSILON
      ) {
        ui.cameraOffset = {
          x: readoutOffset.x * SCENE_SCALE,
          y: readoutOffset.y * SCENE_SCALE,
          z: readoutOffset.z * SCENE_SCALE,
        };
      }

      // Placement ghost — after the camera work, so it unprojects against the
      // camera this frame will actually render.
      interaction.update();

      // `computing` keeps catch-up frames rendering even past the deadband —
      // a long seek grinds for longer than 5 s with no further input.
      const idle =
        !captureRun &&
        !time.playing &&
        !time.shuttleHeld &&
        !time.computing &&
        cameraTween === null &&
        !flight.active &&
        !orbit.active &&
        now - lastActivity > IDLE_RENDER_DELAY_MS;

      if (!idle) {
        manager.render(
          sim,
          system.bodies,
          {
            radiusExaggeration: ui.radiusExaggeration,
            showLabels: ui.showLabels,
            showTrails: ui.showTrails,
            trailDays: ui.trailDays,
            parentRelativeTrails: ui.parentRelativeTrails,
            selectedTrailMultiplier: SELECTED_TRAIL_MULTIPLIER,
            showAxes: ui.showAxes,
            showVectors: ui.showVectors,
            showHabitableZone: ui.showHabitableZone,
            showPrediction: ui.showPrediction,
            bloom: ui.bloom,
            lensing: ui.lensing,
            referenceFrame: referenceId,
            selectedBodyId: ui.selectedBodyId,
            placementParentId: ui.placementParentId,
            interactionDragging: interaction.isDragging,
            // Paused-only: a draggable arrow over a velocity that changes every
            // frame would be a lie.
            velocityGizmo:
              ui.selectedBodyId !== null && !time.playing && ui.placementType === null,
          },
          time.seekGeneration
        );
      }

      raf = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribeMerge();
      interaction.dispose();
      window.removeEventListener('keydown', onFlightKeyDown);
      window.removeEventListener('keyup', onFlightKeyUp);
      window.removeEventListener('blur', onFlightBlur);
      window.removeEventListener('pointerdown', markActivity, { capture: true });
      window.removeEventListener('pointermove', markActivity, { capture: true });
      window.removeEventListener('wheel', markActivity, { capture: true });
      window.removeEventListener('keydown', markActivity, { capture: true });
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      labelLayer.removeEventListener('click', onLabelClick);
      labelLayer.removeEventListener('dblclick', onLabelDoubleClick);
      labelLayer.removeEventListener('wheel', onLabelWheel);
      controls.dispose();
      manager.dispose();
    };
  });
</script>

<div class="scene" class:placing={ui.placementType !== null} bind:this={container}>
  <div class="labels" bind:this={labelLayer}></div>
  <div class="pivot" bind:this={pivotMarker} aria-hidden="true"></div>
</div>

<style>
  .scene {
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
  }

  .scene.placing,
  .scene.placing :global(canvas) {
    cursor: crosshair;
  }

  .scene :global(canvas) {
    display: block;
  }

  .labels {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 1;
  }

  /* The orbit pivot — a small + at the viewport center while rotating. The
     show delay keeps a plain click (pointerdown → ROTATE until pointerup)
     from flashing it. */
  .pivot {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 15px;
    height: 15px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 1;
    opacity: 0;
    transition: opacity 150ms ease;
  }

  /* `visible` arrives via classList from the frame loop, invisible to the
     compiler's unused-selector pruning — hence :global. */
  .pivot:global(.visible) {
    opacity: 1;
    transition-delay: 120ms;
  }

  .pivot::before,
  .pivot::after {
    content: '';
    position: absolute;
    background: rgba(232, 236, 245, 0.85);
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
  }

  .pivot::before {
    left: 50%;
    top: 0;
    width: 1px;
    height: 100%;
    transform: translateX(-50%);
  }

  .pivot::after {
    top: 50%;
    left: 0;
    width: 100%;
    height: 1px;
    transform: translateY(-50%);
  }

  /* The layer stays click-through so canvas drags orbit the camera; only the
     names take pointer events, since clicking one selects the body. */
  .labels :global(.body-label) {
    font-size: 11px;
    letter-spacing: 0.02em;
    text-shadow:
      0 0 4px #000,
      0 0 8px #000;
    white-space: nowrap;
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
  }

  .labels :global(.body-label:hover) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Click-through — the invisible pick sphere under each is the drag target.
     Colors must match the arrows they label (gizmo.ts AXIS_COLORS). */
  .labels :global(.gizmo-speed) {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-shadow:
      0 0 4px #000,
      0 0 8px #000;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }

  .labels :global(.gizmo-speed.axis-x) {
    color: #ff6b6b;
  }

  .labels :global(.gizmo-speed.axis-y) {
    color: #7ddf64;
  }

  .labels :global(.gizmo-speed.axis-z) {
    color: #6ea8ff;
  }

  /* The move handle — the only target that grabs the body (interaction.ts).
     Padding fattens the hit area well past the 13px glyph for fingertips;
     symmetric, so the CSS2D centering keeps the glyph on the body center.
     touch-action: none, or the browser claims a touch drag for scrolling and
     cancels the grab mid-gesture. */
  .labels :global(.gizmo-move) {
    pointer-events: auto;
    touch-action: none;
    cursor: grab;
    padding: 10px;
    user-select: none;
    color: rgba(232, 236, 245, 0.9);
    filter: drop-shadow(0 0 3px rgba(0, 0, 0, 0.9));
  }

  .labels :global(.gizmo-move:active) {
    cursor: grabbing;
  }

  .labels :global(.gizmo-move svg) {
    display: block;
  }
</style>
