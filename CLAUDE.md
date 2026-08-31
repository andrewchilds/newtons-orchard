# Newton’s Orchard

A static Svelte 5 + Three.js N-body solar system sim.

**Read `GUIDE.md` before writing code.** It holds the architecture invariants
(several of which cause silent, hard-to-trace bugs when broken), the pitfalls
each subsystem has already cost someone a debugging session, and how to drive
the app in a real browser to verify a change.

## Commands

```bash
npm run dev      # Vite dev server on port 5317
npm run check    # svelte-check + tsc — must pass before committing
npm test         # vitest run — must pass before committing
npm run build    # production build to dist/

npm run preset-screenshots [-- <preset-id>…]  # regenerate preset thumbnails
npm run preset-screenshots -- --missions      # regenerate mission card portraits
npm run preset-screenshots -- --gallery       # regenerate user-gallery thumbnails
npm run bake-textures [-- <type>… --jobs N]   # regenerate public/textures/

npm run gallery-add -- <file.json> --id <id> --by "Name" --from "Place" --blurb "…"
                 # add a reviewed submission to the user-systems gallery
```

## Before committing

`npm run check` and `npm test` must pass. Most changes here have **manual**
acceptance criteria too — typechecking and unit tests don't tell you whether the
scene looks right. Drive it with `driver.py` and _look at the screenshot_; see
"Verifying in the browser" in `GUIDE.md`.

## The short version of the invariants

Full detail and rationale in `GUIDE.md`; these are the ones worth having in
mind constantly:

- Physics state never goes in Svelte reactive state.
- Determinism is a hard requirement: fixed `dt`, never frame delta. Seek
  restores a snapshot and re-integrates — never backward, never interpolated.
- Derive visuals from `simTime`; never accumulate per frame.
- Every mutating body edit goes through `state/system.svelte.ts`.
- Edits apply at the current time, not t = 0.
- SI internally; convert to display units only at the UI edge, in `ui/units.ts`.
- Scene units are 1 unit = 1e9 m, applied at render time only.
- `physics/` and `sim/` import nothing from Svelte or Three.js; `scene/` imports
  nothing from `ui/`.
- TypeScript strict; Svelte 5 runes, never stores or `$:`.
- Comments explain WHY only — gotchas, counter-intuitive choices, lessons from
  bugs. Never restate what the code says, and no doc comments that paraphrase
  a signature. No history in comments (commit ids, "was X before").
