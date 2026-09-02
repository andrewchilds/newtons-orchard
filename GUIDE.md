# Newton’s Orchard — working guide

Invariants, traps, and how to verify a change.

Check for a running dev server first (`curl -s localhost:5317`) — HMR picks up
changes without a restart.

---

## Architecture

Svelte 5 (runes) + Vite + TypeScript; Three.js used raw (physics drives
positions imperatively per frame); Vitest; localStorage + JSON export/import;
static build.

**Layering:** `physics/` and `sim/` import nothing from Svelte or Three.js;
`scene/` imports nothing from `ui/`. This keeps physics unit-testable without a
DOM or GPU.

```
src/lib/
  physics/    constants vec3 gravity integrator kepler diagnostics orbitInfo
  sim/        simulation snapshots predictPath
  state/      system.svelte.ts   // roster + the single mutation path
              time.svelte.ts     // simTime, playing, warp, computedUntil
              ui.svelte.ts       // selection, panels, render settings
              simInstance.ts     // the Simulation instance — NOT reactive
              history.svelte.ts  // undo/redo stack of whole rosters
  scene/      SceneCanvas sceneManager textures textureCore trails trailBuffer
              interaction gizmo bodyEffects picking
  ui/         TimeBar BodyList BodyEditor CreateBodyDialog Toolbar SystemMenu
              PresetDialog Shuttle NumberField units capture
  presets/    solarSystem examples swarms
  storage/    persistence
```

**Units:** SI everywhere internally (m, kg, s; `G = 6.67430e-11`); float64 is
plenty at ~1e11 m. Display units (AU, Earth masses, days, degrees) convert only
at the UI edge, in `ui/units.ts`. **Scene units: 1 unit = 1e9 m**, applied at
render time only (keeps GPU float32 in range).

### Core invariants

Breaking any of these causes subtle, hard-to-trace bugs.

- **Physics state never goes in Svelte reactive state.** Hot arrays live in the
  `Simulation` instance (`state/simInstance.ts`, deliberately not `.svelte.ts`).
  The render loop reads sim positions directly, once per frame.
- **Determinism.** Fixed `dt` (default 600 s), never frame delta. The sim only
  exists on the `stepIndex · dt` grid; off-grid requests floor. Seek restores a
  snapshot and re-integrates forward — never backward, never interpolated.
- **The three timing grids (`dt`, `snapshotInterval`, `trailInterval`) are
  per-system and change only in `sim.load`** — a load resets to t = 0, the only
  moment with no step grid or snapshot store to reconcile. Omitted grids fall
  back to the defaults, not the outgoing system's. The save format carries all
  three. Defaults are sized for planetary orbits; short-period systems tighten
  all three (`satellite-swarm` runs `dt` 60 s — see `SATELLITE_TIMING`). Cost
  is linear in 1/dt (83 bodies at 60 s ≈ 6% of a core at 1 sim-day/s). A preset
  that tightens `trailInterval` **must** tighten `snapshotInterval` too — see
  trails below.
- **Derive visuals from `simTime`, never accumulate per frame** — accumulation
  breaks scrubbing. Rotation angle is `simTime / rotationPeriod`.
- **Snapshots carry mass/radius/roster, not just pos/vel.** Scrubbing back
  across a merge must resurrect the absorbed body.
- **Edits are timeline events, replayed on forward integration.** A mid-run
  `applyBodyEdits` records the post-edit state; `advanceTo` restores it when
  stepping across the edit instant. Integration alone can re-derive merges but
  not interventions — without the record, rewinding past an edit and playing
  forward computes a timeline where the edit never happened (a body added at
  year 3 never appears until a backward scrub restores a post-edit snapshot).
  Invalidating the future truncates these events like snapshots.
- **A merged-away body stays dead through edits.** Its roster entry is kept
  (pre-merge snapshots need the metadata), but `applyBodyEdits` skips bodies
  absorbed at or before the current time; their ids surface as
  `sim.staleBodyIds`, which every written file filters out. Breaking either
  half resurrects crashed bodies — on the next edit in-session, or on the next
  load of a file carrying the ghost (usually straight back onto its collision
  course). An _unedited_ roster is true t = 0 conditions, where saves keep
  merged-away bodies so the file replays its collisions.
- **A mid-run deletion is a timeline event, not an erasure.** The body existed
  before the edit, so its roster entry is retained (rewinding must still render
  it — dropping the entry left planets orbiting an invisible mass) and a
  deletion record keeps it dead through later edits, exactly like the merge
  rule above; it joins `staleBodyIds` so saves exclude it. Only an edit that
  hands the body back _state-authoritative_ revives it — that's undo — which is
  why `rosterAtCurrentTime()` excludes dead bodies: a ghost entry riding in a
  recorded history roster would be resurrected by undoing an unrelated later
  edit. Deleting at t = 0 is a true removal (there is no past to survive in).
- **Every mutating body edit goes through `state/system.svelte.ts`**
  (`addBody`/`updateBody`/`deleteBody` → `commit`): calls `sim.applyBodyEdits`,
  bumps `seekGeneration` so trails rebuild, re-mirrors the roster. Nothing else
  touches `sim` or `system.bodies`. The sim is the source of truth.
- **Edits apply at the current time, not t = 0.** `rosterAtCurrentTime()`
  snapshots live positions first; the roster's `position`/`velocity` are
  _initial_ state only, used verbatim for unknown bodies — skipping this
  teleports everything back to t = 0 on any edit. The most expensive trap in
  the codebase.
- **Position/velocity edits must be flagged state-authoritative**, or the
  anti-teleport rule keeps live state and silently drops exactly the fields
  being edited.
- **Undo is a stack of whole rosters** (`state/history.svelte.ts`), pushed
  before commit. Restoring flags _every_ body state-authoritative — otherwise
  an undo restores names and masses but leaves the orbit where the drag put
  it. Continuous gestures pass `coalesceAs` so per-frame commits collapse into
  one entry; `history.endCoalescing()` closes the group. `loadSystem` clears
  the stack.
- **Trails are index-aligned across all bodies** — relative-frame rendering is
  `trail[i] − refTrail[i]`. Sample on sim-time interval, never per frame. Every
  body gets a slot at every sample time with an `alive` flag; a trail draws
  only over the newest run where both it and the reference are alive.
- **Dispose Three.js geometries/materials when a body leaves** — never the
  shared textures, which `textures.ts` owns.
- **Only the move handle (`.gizmo-move`) grabs a body.** A press on the body
  itself — selected or not — selects it and leaves the gesture to the camera;
  grabbing the body's own disc made every close-up camera orbit a silent edit
  to its orbit. The handle is a CSS2D element above the canvas, so the grab is
  a DOM containment check in `scene/interaction.ts`, never a raycast, and like
  the velocity knobs it claims on contact for mouse and touch alike (the
  canvas — and so TrackballControls — never sees the pointerdown at all).
  Touch fallout, all in `scene/interaction.ts`:
  - A second finger cancels an in-flight drag and rolls it back (like Escape) —
    a pinch starting on the move handle is a zoom.
  - Slop is per-gesture: `TOUCH_SLOP_PX` well above the mouse's 4 (a fingertip
    rolls several px through a "stationary" tap). Track finger count
    resynchronized from `isPrimary`, never a `Set` of pointer ids — a pointer
    that dies without `pointerup` leaks forever and wedges dragging off.

### Data model

```ts
type BodyType =
	| "star"
	| "earthlike"
	| "rocky"
	| "gas"
	| "ice"
	| "dwarf"
	| "moon"
	| "asteroid"
	| "satellite"
	| "blackhole";

interface Body {
	id: string; // crypto.randomUUID()
	name: string;
	color: string; // hex — hue-rotates the texture, tints trail + UI
	type: BodyType; // texture style + material (stars emissive + light)
	texture?: RealTextureKey; // photographic map; exempt from hue rotation
	mass: number; // kg
	radius: number; // m
	rotationPeriod: number; // s; negative = retrograde
	axialTilt: number; // degrees
	position: Vec3; // m — barycentric; INITIAL state only, see above
	velocity: Vec3; // m/s
	atmosphere?: { color: string; density: number };
	rings?: {
		innerRadius: number;
		outerRadius: number; // m
		color: string;
		opacity: number;
	};
}

interface SystemFile {
	version: 1;
	name: string;
	bodies: Body[]; // state at t = 0
	settings: {
		// the system's timing grids
		dt: number;
		snapshotInterval: number;
		trailInterval?: number; // optional: v1 files predate it
	};
}
```

### Conventions

TypeScript strict. Svelte 5 runes only — never stores or `$:`; shared reactive
modules are `.svelte.ts`. No CSS framework — dark theme via custom properties
in `app.css`.

**Comments explain WHY, nothing else** — a gotcha, a counter-intuitive choice,
a lesson from a bug. Never restate what the code says; no doc comments that
paraphrase a signature. A comment that would survive renaming the function it
sits on is probably worth keeping; one that wouldn't isn't.

---

## Verifying in the browser

Most changes have **manual acceptance criteria** — drive the app and look at a
screenshot. `driver.py` loads the app in a real browser, waits for the canvas,
screenshots, and reports console errors (exit 1 on failure). It launches the
_system_ Chrome with SwiftShader flags (Playwright's Chromium isn't installed
and `npx playwright install` is slow/blocked):

```bash
/Users/andrew/Projects/local-python-env/bin/python driver.py            # load + one shot
/Users/andrew/Projects/local-python-env/bin/python driver.py steps.txt  # drive it
```

A steps file is one command per line (`#` comments ignored). Quote selectors
containing spaces; `eval` needs an explicit `return`:

```
click "button[aria-label='System menu']"
click "text=Load system…"
click "text=Solar System"
click ".bodies .name >> nth=3"
box .properties-panel
text ".time-panel .date"
eval "const e=document.querySelector('.bodies-panel .panel-body'); return e.scrollHeight"
shot 02-selected
```

Commands: `click` `dblclick` `fill` `select` `key` `wait` `shot` `box` `text`
`eval` `drag` `shiftdrag`. Options: `--url --out --width --height --headed
--keep-open`. Screenshots land in `screenshots/` (gitignored).

Useful selectors: `.bodies .name` (roster), `.editor` (body editor),
`.time-panel button.play` (**not** the first button — that's rewind ⏮,
`button[aria-label="Rewind to start"]`),
`.time-panel .date`, `.body-label` (CSS2D name sprites),
`button[aria-label="System menu"]` (opens `.shelf`), `.add-menu .add`,
`.placement-hint`, `.gizmo-speed`, `.gizmo-move` (the move handle on the
selected body while paused — the **only** grab target for a body `drag`).
To move a body: select it, `box .gizmo-move`, then `drag` from that box's
center. To select with a click, aim at its label's CSS2D anchor —
`(rect.left, rect.top + 1.4 × rect.height)` — the hit sphere is only ~14 px.

Two expected sights that are not bugs: planets are sub-pixel at the default
×20 exaggeration from a system-wide view, and a body at 5 AU sits outside the
default camera framing.

**The first-visit welcome dialog is suppressed** — Playwright's fresh profile
reads as a first visit every run, and the dialog covers the UI so clicks
behind it time out. `driver.py` pre-seeds the welcomed flag before load; pass
`--welcome` when the welcome flow itself is what you're driving.

**Picking limitation:** label anchors track _orbital_ geometry, not drawn
radius, so from afar Earth and the Moon resolve to the same pixel and a press
lands on Earth (even with the Moon selected — the press reselects Earth).
A label crowded against its SOI parent (potential screen separation under
`LABEL_CROWD_HIDE_PX`) hides entirely, so a moon's label is only clickable
once the camera is close enough to separate the pair — focus the parent
first.
Corollary for scripts: **after the camera moves, a stale coordinate no longer
lands on the target** — a label anchor misses the hit sphere, and a drag aimed
at where `.gizmo-move` used to be orbits the camera instead of moving the body.
Re-aim (`box` again) between gestures; don't reuse a coordinate across a camera
move.

---

## Pitfalls by subsystem

Each of these cost real debugging time.

### Time, seeking and trails

- **Trail sampling can't be driven by the render loop alone.** During catch-up
  (autosave restore, high warp) the sim moves thousands of steps per frame, so
  per-frame sampling chords across orbits — Mercury drew a five-pointed star.
  Rebuild from **snapshots** whenever the sim outran the sample grid
  (`TrailBuffer.outranSampling`) or the timeline jumped.
  - `seekGeneration` alone can't trigger the rebuild — it changes once at boot
    (nothing to rebuild) then stays put through the catch-up.
  - Cap the rebuild with _live_ state: snapshots lag up to their spacing, so a
    snapshot-only rebuild still reads as "outran sampling" and loops per frame.
  - **A rebuilt trail is only as fine as the snapshot grid** — every seek goes
    through this path, hence the tighten-both rule. Symptom: trails look right
    while playing, coarsen the instant you scrub.
- **Changing `trailInterval` clears the buffer** — mixing two sample grids in
  one ring corrupts the spacing the trail's shape is read from. Only `sim.load`
  changes it.
- **The shuttle scrubs in reverse continuously** — `seekGeneration` bumps every
  frame, so the trail rebuild must be cheap enough to run per-frame.
- **The frame tick abandons a time target it can't reach in the step budget**,
  clamping `simTime` to `sim.time`. Mid-catch-up `simTime` is not a time the
  user asked for — never persist it or treat it as a destination. Multi-frame
  arrivals need a target held outside the tick.
- **Bodies appear/disappear mid-timeline** (merges, seeks across them): key
  meshes by body id, reconcile against `aliveIds` every frame, dispose dead
  bodies' GPU resources.
- **Merge bursts age on sim time, not wall time** — scrubbing back replays the
  burst, pausing freezes it; expired bursts hide rather than destroy. Accretion
  flares (black-hole captures) follow the same pattern, plus: they anchor to
  the hole's live visual (so they track reference frames), and `add` dedupes on
  (t, anchor) — seek-replay re-emits merge events and additive glow would stack
  brighter every scrub.
  - **A system load must clear bursts and flares** (`clearBursts`, driven by
    `system.loadGeneration`) — a hidden burst from the old system replays at
    old coordinates once the new clock passes its sim time. `seekGeneration`
    can't drive this: it bumps on edits and scrubs, where replaying is the
    point.

### Orbits and physics

- **"Which body does this orbit?" is a sphere-of-influence question, not
  strongest-pull.** The Sun out-pulls Earth on the Moon ~2× — Earth only wins
  the differential. `dominantAttractor` ranks by distance in SOI radii
  (`r·(m/M)^{2/5}`) and only considers bodies more massive than the subject.
- **Systems built from orbital elements carry the satellites' net momentum**
  and drift out of frame unless `balanceMomentum` is called — unbalanced, the
  solar system drifts ~12 m/s. Presets that filter `solarSystem()` down must
  re-balance **after** dropping bodies.
- Corollary for tests: once the Sun moves, elements recovered against it are no
  longer heliocentric J2000 values (Earth's e off 2.4%). `solarSystem.test.ts`
  measures against the Sun at rest, which recovers inputs exactly.
- **Eccentricity is capped below 1** — `e = 1` is parabolic and the state
  vector blows up.
- Softening epsilon (~1e3 m) in `gravity.ts` keeps near-collisions from NaN.
- **Black holes are the one non-Newtonian force, keyed off `PhysicsState.rs`.**
  A `blackhole` carries its Schwarzschild radius in `rs` (always
  `schwarzschildRadius(mass)`; the horizon is its radius and collision radius);
  any pair with `rs > 0` uses Paczyński–Wiita `G·m/(d − r_s)²` (real periapsis
  precession, ISCO at 3 r*s). Ordinary pairs take the untouched Newtonian path,
  bit-for-bit. Traps: `rs` must be threaded everywhere state is built, copied,
  compacted or snapshotted (or a snapshot restores the hole as a Newtonian
  mass); a black hole always survives a merge, growing `rs` linearly; only
  \_supermassive* holes work at app scale (a stellar horizon is below SOFTENING
  and sub-pixel), hence Sgr A\*-sized defaults. Orbit readouts and prediction
  are still Newtonian and quietly wrong within a few tens of r_s.

### Rendering

- **Stars need their own, gentler exaggeration curve** (`exaggerationFor`). One
  global factor can't span a 109× radius ratio — at ×500 the Sun swallows the
  inner system and encloses the camera (back-faces only: it looks _missing_).
  Stars get `∛factor × 2`; rings and the real Sun go through the same helper.
- **Satellites get a third curve, capped against orbital _clearance_.** No
  planet-scale factor makes a tens-of-metres craft visible; `exaggerationFor`
  gives a sublinear boost, `sizeBoost` compresses the 0.08–54 m spread. The cap
  matters: a LEO craft has ~400 km above the surface, so a drawn radius over
  ~1e5 m sinks it into the Earth.
- Default exaggeration ×20 — much higher and an exaggerated Earth spans past
  the Moon's orbit. Default trail length 100 days.
- **Exactly one stage may tone-map.** With `EffectComposer`, `OutputPass` owns
  it and `renderer.toneMapping` must be `NoToneMapping` — double tone-mapping
  made enabling bloom _dim_ the scene.
- **~1px points shimmer through the bloom chain** (resampled differently every
  frame). Keep the starfield below the bloom threshold (0.62) rather than on an
  excluded layer — exclusion costs a second full render pass. Starfield points
  are screen-space sized, not `sizeAttenuation`.
- **Black hole lensing is a screen-space pass; the horizon mesh must hide while
  it runs.** `lensing.ts` warps the frame (β = θ − θ_E²/θ) and draws the shadow
  at √27/2 · r_s; the mesh's disc is a foreground object the warp re-images as
  a dark band on the Einstein ring (symptom: "record groove" rings).
  `sceneManager` hides meshes in `lensPass.activeIds` and restores them when
  the pass drops the hole. The pass forces the composer path even with bloom
  off, so lensed frames always tone-map. On by default (`ui.lensing`); the
  toggle exists because it bends the orbit geometry the sim exists to make
  legible. Toggle-off must go through `lensPass.deactivate()` — a stale
  `activeIds` leaves holes invisible with nothing drawing the silhouette.
  Thumbnails can opt out per shot (`PresetShot.lensing`).
- **`computeLineDistances` walks the whole position attribute** — an
  over-reserved buffer with a draw range injects a huge jump and the dash
  pattern collapses to a solid line. Dash colour is mixed 45% toward white — a
  1px dashed line in a dark body's colour is invisible.
- **Body poles are local +Y, but the ecliptic normal is world +Z.**
  `applyOrientation` stands the pole up with `R_x(π/2 + tilt)`. Tilting about
  +Z — the obvious one-liner — leaves every pole lying _in_ the orbital plane
  (Saturn's rings upright), and looks plausible from the default high camera,
  which is how it shipped broken.
- **A tidally locked moon's facing comes from `rotationPhase`, not its
  period** — the period only holds whatever face the phase chose at t = 0.
  `lockedFacing` aims the texture's central meridian at the parent;
  re-placing a locked moon means re-aiming it.
- **A locked period must be the mean month the sim _integrates_, not the
  catalog's.** Under the Sun's perturbation the integrated mean motion is
  percent-level off the catalog month — with 27.321661 d the locked face
  walked ~44°/yr. The rate also depends on the t = 0 phase against the Sun, so
  re-placing a locked moon means re-_measuring_ its period in the real
  `Simulation` at production dt. The facing tests pin both measured values;
  their ~13° allowed residual is optical libration, which is physical.
- Selection uses screen-space-sized invisible hit spheres (~14 px) — even
  exaggerated planets are sub-pixel from afar.
- **Idle frames skip the render.** Paused with no input for 5 s, the loop in
  `SceneCanvas` stops calling `manager.render`; the last frame stays
  composited. This is sound because every paused-state visual change
  originates from user input — nothing in the scene animates on wall clock
  (bursts/flares age on sim time, the starfield is static). It stays sound
  only while that holds: a feature that changes visuals from a timer or a
  network callback must mark activity itself, and scripted mutations count on
  activity via seek/load generation bumps. Capture runs (`?capture=1`)
  disable the skip — the screenshot script would otherwise photograph a stale
  canvas. Symptom of a missed path: the scene freezes until the next
  mouse-wiggle.
- Import OrbitControls/CSS2DRenderer from `three/addons/...`.

### Body textures

Surfaces are baked offline, not generated in the browser.

- `textureCore.ts` — procedural generators (star, gas, ice, earthlike,
  satellite) plus the size/variant/reference-color tables for **every** type.
  Pure pixel code importable by Node's type-stripping loader: no DOM/Three.js
  imports, no `readonly` parameter properties, no `Math.random()`/`Date`
  (bakes must reproduce).
- **The cratered types (rocky, moon, dwarf, asteroid) are not procedural.**
  Synthetic craters were tuned across many rounds and always read as CG —
  donuts, bubbles, burnt bread. `scripts/remix-textures.mjs` builds their
  variants by remixing the real mosaics in `public/textures/real/` (moon,
  mercury, mars, ceres): per source, wrap-shift a random longitude, maybe
  mirror, normalize luminance to mean 0.5 / std 0.15; composite over a base
  layer through smooth periodic masks feathered out toward the poles; hand the
  poles to the moon layer (mercury's are coverage gaps, mars's are ice caps —
  a mars base hands over early enough to bury its cap entirely); unsharp; then
  gradient-map to the type's `REFERENCE_COLOR` with the midpoint pinned to it,
  which is what keeps the hue-rotation shader working identically to the
  procedural bakes. Ceres is overlay-only (baked-in low-sun shadows at high
  latitude). Deterministic per (type, variant), like everything else.
- `scripts/bake-textures.mjs` renders every (type, variant) to
  `public/textures/` — routing the cratered types through the remixer — and
  writes `textureManifest.json`. Output is committed; re-run when a generator
  changes. Body maps are JPEG (PNG measured 64 MB vs 14.7), panels PNG for
  their texel-wide busbars. Keep `--jobs` at 3 or fewer on this machine.
- `textures.ts` — runtime. Loads maps keyed on (type,
  `hashSeed(body.id) % variants`); applies body colour as a **hue rotation**
  in a shader patch, not a tint multiply — a multiply collapses the maps'
  internal hue relationships. Solar panels are deliberately not hue-rotated.
- **Real bodies use photographic maps, not the bake.** `Body.texture` draws
  `public/textures/real/<key>.jpg` — NASA/USGS mosaics (provenance in
  `SOURCES.md`), committed, _not_ regenerated by `bake-textures` (its cleanup
  skips `real/`). Keys live in `REAL_TEXTURE_KEYS`; imports coerce unknown keys
  to undefined. **No hue rotation** — a photo is already the true colors, so
  `color` tints only trail/label/UI. The remix sources double as real maps —
  editing one changes both the photo body and the next cratered bake.
- **Textures are shared and module-owned: never dispose one from a caller.**
- `THREE.Color` holds **linear** components under colour management — anything
  comparing against the baked sRGB maps must mind the colour space (the
  hue-rotation GLSL converts to sRGB before rotating).
- Judge texture changes by a **magnified crop**, never the un-zoomed map or
  file size. Baked relief shading now applies to earthlike only
  (`RELIEF_SCALE`/`reliefStrength`); the sqrt-of-width factor means a given
  strength shades differently across `TEX_SIZES`, so check a crop at the size
  you shipped.

### Persistence

- **localStorage holds t = 0 definitions only** — never snapshots, never a
  clock. Every read/write is wrapped so a disabled or full localStorage
  degrades to "no persistence", not a crash.
- **Every written file excludes `sim.staleBodyIds`** (autosave, save slots,
  export — all through `currentSystemFile`). See the merged-away-bodies
  invariant.
- **Restoring an autosaved clock was tried and removed.** The sim can't jump,
  so a restored clock means re-integrating from t = 0 — minutes of grinding.
  Worse, the frame tick clamps `simTime` during catch-up, so the debounced
  autosave fired mid-flight and overwrote the destination with a partial time,
  ratcheting the session earlier on every reload.
- **The sim reads the autosave at construction** (`simInstance.ts`), not from a
  component effect — else the scene builds meshes for the default system and
  immediately disposes them.
- **Import validation names the offending field** and coerces cosmetic problems
  rather than rejecting the file. Duplicate ids are re-issued (selection,
  reference frame and mesh keying all look up by id). `JSON.stringify(-0)` is
  `"0"`, so naive `toEqual` round-trip assertions fail.
- **Share links pack the whole system into the URL fragment**
  (`storage/shareUrl.ts`): `#s=1.<base64url of deflate-raw JSON>`, body ids
  stripped (the parser re-issues them), numbers unrounded. A fragment, never a
  query param — it stays out of server logs and server length caps.
  `simInstance.ts` consumes it with top-level await ahead of the autosave (a
  link is an explicit "open this"), and strips the fragment on success so a
  reload resumes the autosave instead of resetting to the link. Decode failures
  fall through to the autosave with a toast, leaving the fragment in place.
- Loading anything clears `selectedBodyId` and `referenceFrame` — they hold
  ids from a roster that no longer exists.

### UI

- **`NumberField` keeps the input's text as local state** — re-deriving per
  keystroke fights the user (`1e` rejected, `1.0` collapses to `1`). Any field
  that commits per keystroke _and_ reads back a recomputed value will fight
  the cursor; commit on blur/Enter instead.
- **`NumberField` evaluates arithmetic on Enter/blur** via `ui/expression.ts`
  (recursive-descent parser, never `eval`): `333030*2` rewrites to the result;
  a leading `+ * / ^` applies to the current value; a leading `-` is a negative
  literal. This is why the input is `type="text"` — a number input can't hold
  `*`. Expressions only commit whole, so a half-typed `333030*` changes
  nothing.
- **Type changes in the editor swap appearance defaults only**, never
  mass/radius/spin — silently rewriting a user's numbers is destructive. The
  _create_ dialog does load full defaults; nothing is at stake yet.
- Popovers close on outside `pointerdown` (beats a canvas drag) and Escape.
- **The system shelf is split across two components** — `SystemMenu.svelte` is
  just the toggle; `SystemShelf.svelte` is the panel, mounted by App at top
  level. The menu bar's `backdrop-filter` makes it a containing block for
  fixed-position descendants — rendered inside, the shelf is trapped in the
  40 px button. Consequences:
  - **The shelf covers its own toggle**, so it can't be closed by clicking the
    button again (a Playwright `click` on it times out while open). Use the
    header's ×, Escape, or an outside click.
  - The shelf is **always mounted**, never gated on `ui.chromeHidden` — it owns
    the autosave `$effect`, and unmounting would stop saving. It closes itself
    via an effect on `chromeHidden` (watched, not handled at the toggle,
    because `ui/capture.ts` sets that flag directly).
- **"Revert system" reloads the _pristine_ copy from `loadSystemIntoUi`, not
  the live roster** — every mirror after a load carries positions rebased to
  the last edit, so reverting from `system.bodies` would restore year-3 state.
  `system.loaded` is null until something is loaded (the boot roster is not a
  load), which hides the menu item. The stored roster is re-cloned on the way
  out — the sim takes ownership of what it's handed, and a second revert needs
  the original. A mission load re-arms via `markLoadedAsMission`.
- **Mission instructions are data** (`MissionStep` in `presets/missions.ts`):
  each step names the control it happens in (`target`) and how the app tells it
  happened (`check`). `state/missionGuide.svelte.ts` derives done/current;
  the current step's target control applies the global `.guide-glow` ring
  _declaratively_ — never via DOM query, so it tracks mount/layout for free.
  Traps: field edits can't be read off the roster (every commit rebases every
  body's state), so `updateBody` _notes_ changed fields through `mission.note`;
  "selected"/"played" latch via `missionGuide.observe()` (an `$effect` in App)
  because reading them live would un-tick "Press Play" on every pause; and a
  checkless step is a watch-finale the current-step pointer parks on, so such
  steps must come last (registry test).
- **Black holes are gated on the mission tally** (`state/unlocks.svelte.ts`).
  The gate is on _offering_, never loading: saved/imported/autosaved files
  still restore their black holes, and `blackHole()` stays callable for the
  screenshot script. `BODY_TYPES` stays whole — pickers filter through
  `unlocks.offeredTypes(current)`, which keeps the edited body's own type
  listed even when locked, or the editor's `<select>` renders blank against a
  loaded black hole and rewrites its type on the next touch.
- **Transition durations live in `ui/motion.ts`** (`duration()`). Svelte
  transitions are JS-driven and never see `prefers-reduced-motion`; hardcoded
  ms opts out of the user's preference.
- **`slide` can't animate a growing flex item** — it animates inline `height`,
  which flex overrides, so the panel snaps. Hence `.panel-slide`: a
  `flex: 0 1 auto` wrapper owns the transition, `.panel-body` inside keeps the
  growing and scrolling. Wrap any new collapsing panel the same way.

### Preset thumbnails

Committed at `public/presets/<id>.jpg`, generated by
`npm run preset-screenshots` (needs a dev server). Mission cards: each mission
carries a `shot`, portraits land in `public/missions/<id>.jpg` via
`--missions`; frame the _subject body_, not the whole system.

- **Framing lives on each `PRESETS` entry as `shot`** — retune by editing it
  and re-running that id, then _look at the image_.
- Three failure modes: `days` too short to close outer orbits (the solar
  system needs a full Saturn period, 30 yr), wrong `zoom` (metres, 9e8–2.9e12
  across presets), and `exaggeration` too high for a close zoom (subject hides
  behind its own disc).
- **A preset must be _played_ before it photographs** — at t = 0 every system
  is a static dot field; trails are history.
- **The script drives `window.__capture`** (`ui/capture.ts`), not the UI — a
  click path would couple thumbnails to the menu markup they render into.
- **Seeking, not playing** — `seekTo` integrates the span with no step budget;
  playing at warp costs as many wall-seconds as the shot has warp-seconds.
- `parentRelativeTrails: false` for systems whose "parent" isn't a point — a
  circumbinary planet relative to one star traces a scalloped rosette.
- **A mission card must pose the question, not answer it.** Sequence:
  load → pre-roll → _edit_ → shoot. `shot.days` runs the **unedited** system
  purely to lay trails; the mission's `setup` lands at the shutter. Both
  neighbours are wrong: no `setup` and every card is the same untouched solar
  system; `setup`-then-integrate and the card shows the outcome the student is
  asked to predict. Keep `days` short of what the mission asks them to
  discover — it's a trail budget. (Dark Sun excepted: its answer is "nothing
  changes".) A registry test fails any mission whose `setup` is missing or
  changes nothing, compared against the same span pre-rolled without it.
- **A mission's `setup` is data (`MissionEdit`), not a mutating function.**
  `presets/` can't import `state/system.svelte.ts` — the cycle (via
  `mission.svelte.ts`) leaves `MISSIONS` undefined at module init. The
  registry _names_ the edit; `ui/capture.ts` applies it through the normal
  mutation path.
  - Targets resolve **by name against the live roster**; positions/velocities
    come from `liveStateOf`, not the roster — after a pre-roll the roster
    still holds t = 0 state, and scaling _that_ velocity by −1 launches a body
    in a months-stale direction. A test pins this.
  - `shot.center` resolves against the **post-setup** roster (Lights Out
    deletes the body it would otherwise name).
- **The standard framing looks at a planet's night side** — `frameBody` places
  the camera opposite the orbit parent, and a photographic map renders
  near-black against the 0.07 ambient. Set `shot.sunward`; no `zoom` retuning
  helps. The sunward swing resolves the star from `sim.bodies`, **not** the
  scene's visuals — on setup frames the visuals still belong to the previous
  system and both failure modes silently produce a zero offset.
- **An escaping body outruns any fixed `zoom`** — shorten `days` until the
  bodies are in frame _with_ their trails.
- **A black hole can't be photographed next to anything, or close.**
  `exaggerationFor` returns 1 for `blackhole` (a supermassive horizon is
  already ~17 solar radii), so raising the factor only inflates everything
  else; a `zoom` in the kilometres is inside the near plane (empty sky). So
  the Dark Sun card is the _orbits_ around a dark center, framed tighter than
  Lights Out.
- **Deleting the heaviest body moves the barycenter** — a barycentric Lights
  Out shot puts the vacated center off to one side; it also needs
  `parentRelativeTrails: false` (every parent _was_ the Sun).

### The user-systems gallery

Curated static data, split so the cold load stays small: eager metadata in
`presets/gallery.ts`; each system's JSON at `public/gallery/<id>.json`, fetched
only when picked and parsed through `parseSystemFile` like any untrusted
import — failures degrade to an error toast. Submissions arrive via a Google
Form (`GALLERY_FORM_URL`), reviewed by hand, added with `npm run gallery-add`
(validates, writes both halves, leaves a placeholder `shot` to tune).
Thumbnails via `npm run preset-screenshots -- --gallery`. `gallery.test.ts`
fails on entries missing JSON or thumbnail, and on orphaned files.
