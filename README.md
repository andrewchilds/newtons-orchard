# Newton’s Orchard

A serverless web app for building and viewing realistic solar systems in 3D:
N-body gravity simulation, time scrubbing, and full control over planet creation
(name, color, type, mass, radius, spin, axial tilt, orbit).

Svelte 5 + Vite + TypeScript + Three.js.

## Development

```sh
npm i
npm run dev
```

Other scripts: `npm run build`, `npm run preview`, `npm run check` (type checking),
`npm test`.

## Using it

- **System menu** (tree icon, top left) — load a preset, save named systems to the browser,
  or export/import a system as JSON.
- **Add** (side panel) — create a body by orbital elements around a parent, or by
  raw position and velocity.
- **Time bar** — play/pause with a warp preset, or drag the shuttle to scrub. The
  shuttle sets a _rate_ of travel through time and springs back to center; while
  it's off center it overrides play/pause entirely.
- **Frame** (top right) — view the system from the barycenter or from any body.
  Picking a body also parks the camera on it, so the Moon's orbit reads as an
  ellipse rather than a helix.
- **Display** (top right) — radius exaggeration, trails, labels, axes, predicted
  orbits, and the star bloom toggle (turn it off on weak GPUs).

Distances are true to scale; body radii are exaggerated for visibility, since at
true scale an Earth radius is ~4e-5 of its orbit.

### Saving

The current system autosaves to `localStorage` and restores on reload. Only body
definitions and the current time are stored — the trajectory is deterministic, so
everything else is recomputed on load. Named save slots and JSON export/import
live in the System menu; exported files are pretty-printed and hand-editable, and
imports are validated with errors that name the offending field.

## Deploying

The build is a static `dist/` directory with no backend, so any static host works.

```sh
npm run build
npm run preview   # serve dist/ locally at http://localhost:5317
```

**Vercel.** [`vercel.json`](vercel.json) is checked in and configures the build,
output directory, and an SPA rewrite. Either import the repo at
[vercel.com/new](https://vercel.com/new) or run `npx vercel --prod`.

**GitHub Pages.** Pages serves from a subpath, so the build needs a matching base
path, otherwise every asset 404s:

```sh
npx vite build --base=/<repo-name>/
```

Then publish `dist/` to the `gh-pages` branch (`npx gh-pages -d dist`) and point
Pages at that branch. A user/organization site served from the domain root needs
no `--base`.

**Netlify / Cloudflare Pages.** Build command `npm run build`, publish directory
`dist`. Add a catch-all redirect to `/index.html` if you add routing later; the
app currently has none.

## Contributing & support

This is a personal project. No support is provided. The repo is public, and while
issues and PRs are welcome, you may not receive a response.

## License

[MIT](LICENSE)
